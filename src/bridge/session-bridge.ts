/**
 * SessionBridge — 把 QQ peer 绑到「已有的 DSH 会话」上
 *
 * 与 SessionManager 的分工：
 *   SessionManager 给每个 QQ peer 造一个**插件私有**的 agent（qqbot:<appId>:<scope>:<peerId>），
 *   它只能看见自己造的会话。
 *   SessionBridge 走宿主的 `sessionController` / `sessions` / `workspaceRegistry`，
 *   能列出宿主进程里真正存在的会话（就是桌面版侧栏里那些），把 QQ 消息投进去，
 *   再把那边的 assistant 输出转发回 QQ。
 *
 * 能力全部按「探测 + 降级」处理：这些服务由 dsh-web-app 组合提供，只装 dsh-base
 * 的 profile 里没有。缺失时 available=false，命令回一句明确原因，而不是静默失败。
 */
import { randomUUID } from 'node:crypto';
import type { ImQQBotConfig } from '../config.ts';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import type { BindingStore } from './binding-store.ts';

/** 宿主 SessionSummary 里我们关心的字段（结构类型，不引入宿主包） */
export interface HostSessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  cwd?: string;
  parentSessionId?: string;
  origin?: string;
  agentAvailable?: boolean;
  projections?: {
    values?: Record<string, unknown>;
  };
}

/** 一条可展示的会话（summary + 绑定信息） */
export interface BridgeSession extends HostSessionSummary {
  /** 会话标题（projection 折叠出来的，冷会话也有） */
  title?: string;
  /** 是否已被某个 QQ peer 绑定 */
  bound: boolean;
}

/** 绑定后的会话摘要（/status 用） */
export interface BoundSessionInfo {
  sessionId: string;
  title?: string;
  cwd?: string;
  running: boolean;
  /** 会话日志条数（sessions.snapshotEvents 拿得到时才有） */
  messageCount?: number;
}

/** resolve() 的结果 */
export type ResolveResult =
  | { ok: true; sessionId: string }
  | { ok: false; message: string };

/** 宿主 sessionController 的最小结构 */
export interface SessionControllerLike {
  list(
    request: { cursor?: string },
    signal: AbortSignal,
  ): Promise<{ items: readonly HostSessionSummary[] }>;
  create(request: { cwd?: string; workspaceId?: string; agentPreset?: string }): Promise<{ sessionId: string }>;
  rename(request: { sessionId: string; title: string }): Promise<{ title: string }>;
  prompt(
    request: {
      requestId: string;
      sessionId: string;
      mode: 'queue' | 'steer';
      content: Array<{ type: 'text'; text: string }>;
    },
    signal: AbortSignal,
  ): Promise<{ accepted: boolean }>;
  cancel?(request: { sessionId: string }): unknown;
}

/** 宿主 sessions 服务的最小结构 */
interface SessionsLike {
  get(sessionId: string):
    | {
        header?: { cwd?: string; origin?: string; parentSessionId?: string };
        snapshotEvents?: () => readonly unknown[];
      }
    | undefined;
}

/** 宿主 workspaceRegistry 的最小结构 */
interface WorkspaceRegistryLike {
  list(): Array<{ title?: string; sessionIds?: readonly string[] }>;
}

/** 从 ctx 取服务的统一入口（cordis 的 ctx.get 是泛型宽松的） */
interface ServiceHost {
  get(name: string): unknown;
}

export interface SessionDigest extends BoundSessionInfo {
  /** 最近若干轮（已按 limit 截取） */
  turns: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** 事件里一共多少轮 */
  totalTurns: number;
}

export interface SessionBridgeDeps {
  ctx: ServiceHost;
  logger: Logger;
  store: BindingStore;
  /** 往 QQ peer 发一段 markdown（由 gateway 层注入，含被动回复兜底） */
  send: (peerKey: string, text: string) => Promise<void>;
}

/** 会话 id 前缀最短长度：太短会撞，8 位足够唯一且好敲 */
const MIN_PREFIX_LEN = 4;

/** 标题最大展示长度（QQ 单行不好看） */
const TITLE_MAX_LEN = 40;

export class SessionBridge {
  private readonly ctx: ServiceHost;
  private readonly logger: Logger;
  readonly store: BindingStore;
  private readonly sendFn: (peerKey: string, text: string) => Promise<void>;
  /** 已绑定会话的流式文本累积（turn/end 时统一转发） */
  private readonly pending = new Map<string, string[]>();
  /** 最近一次 list 的结果，供 /use <序号> 反查 */
  private lastList: BridgeSession[] = [];
  /**
   * 由 ctx.inject(['sessionController']) 注入的实例。
   *
   * 不能只靠 ctx.get：cordis 的访问守卫要求服务先经 inject 声明，且 web-app 的
   * session-controller 可能晚于本插件注册——apply() 那一刻拿到 undefined 是常态。
   * inject 回调会在服务出现/替换时重跑，这里只保存当前实例。
   */
  private injected: SessionControllerLike | undefined;

  /**
   * 订阅关系：sessionId → peerKey 集合（/watch）。
   *
   * 与 /use 的绑定刻意分开：绑定接管输入并转发输出，订阅只转发输出。
   * 订阅是会话级临时视角（「我盯一下那个会话的进展」），不落盘，
   * 进程重启后失效——比把半衰期很短的关注关系写进磁盘更符合直觉。
   */
  private readonly watched = new Map<string, Set<string>>();

  /**
   * 轮询游标：sessionId → 已消费事件的位置与时间。
   *
   * 宿主会话的 session/event 在它自己的作用域里派发，插件 fiber 收不到（兄弟
   * 作用域），所以已绑定会话靠 snapshotEvents 轮询补发。游标保证只看新增事件。
   *
   * 时间戳用于识别「历史回填」：宿主冷启动时事件表可能先只有表头、随后才补齐
   * 整段历史；只按条数记游标会把老事件当成新事件重放（曾经因此把几小时前的
   * 失败提示重新发给用户）。
   */
  private readonly cursor = new Map<string, { index: number; seq: number; length: number }>();

  /** 最近一次转发的 (文本, 时间)，用于订阅/轮询双通道去重 */
  private readonly lastRelayed = new Map<string, { text: string; at: number }>();

  constructor(deps: SessionBridgeDeps) {
    this.ctx = deps.ctx;
    this.logger = deps.logger;
    this.store = deps.store;
    this.sendFn = deps.send;
  }

  /** 宿主是否组合了 sessionController（决定这组命令能不能用） */
  get available(): boolean {
    return this.controller() !== undefined;
  }

  /** 缺失能力时给用户看的原因 */
  get unavailableReason(): string {
    return '当前 profile 没有 sessionController（只装了 dsh-base）。把插件装进 desktop profile 或给 profile 加上 dsh-web-app 组合后可用。';
  }

  // ── 会话查询 ──

  /**
   * 列出宿主会话，最近活动的在前。
   *
   * 失败不吞成空列表：空列表会被当成「没有会话」而被误导去新建一个，
   * 与服务坏了看起来一模一样。
   */
  async list(): Promise<BridgeSession[]> {
    const controller = this.controller();
    if (controller === undefined) throw new Error(this.unavailableReason);

    const value = await controller.list({}, new AbortController().signal);
    const items = Array.isArray(value?.items) ? [...value.items] : [];
    items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

    const boundIds = new Set(this.store.entries().map((e) => e.sessionId));
    const result: BridgeSession[] = items.map((item) => ({
      ...item,
      title: this.titleOf(item),
      bound: boundIds.has(item.sessionId),
    }));

    this.lastList = result;
    return result;
  }

  /**
   * 把 `/use` 的参数解析成会话 id。
   *
   * 支持两种写法：列表序号（1 起，与 /list 输出对齐）和 id 前缀。
   * 序号是给人看的，前缀是给「我知道是哪个」的场景用的。
   */
  async resolve(ref: string): Promise<ResolveResult> {
    const value = ref.trim();
    if (value === '') return { ok: false, message: '用法: /use <序号|ID前缀>' };

    if (/^\d+$/.test(value)) {
      const index = Number(value);
      const sessions = this.lastList.length > 0 ? this.lastList : await this.list();
      const target = sessions[index - 1];
      if (target === undefined) {
        return { ok: false, message: `序号 ${index} 超出范围（共 ${sessions.length} 个会话），先发 /list 看看。` };
      }
      return { ok: true, sessionId: target.sessionId };
    }

    // 列表展示的是去掉 `session-` 前缀的短 id，用户复制过来要能用：
    // 同时按原始 id 与短 id 做前缀匹配
    const hasIdPrefix = value.startsWith('session-');
    const bare = hasIdPrefix ? value.slice('session-'.length) : value;

    // 长度下限只是为了别让 `a` 这种输入碰运气：用户自己带了 `session-`
    // 前缀时（8 个字符的上下文）已经足够具体，不再按短 id 的长度要求它
    if (bare.length < (hasIdPrefix ? 1 : MIN_PREFIX_LEN)) {
      return { ok: false, message: `ID 前缀至少要 ${MIN_PREFIX_LEN} 个字符。` };
    }

    const sessions = this.lastList.length > 0 ? this.lastList : await this.list();
    const matches = sessions.filter(
      (s) => s.sessionId.startsWith(value) || shortId(s.sessionId).startsWith(bare),
    );
    if (matches.length === 1) return { ok: true, sessionId: matches[0]!.sessionId };
    if (matches.length > 1) {
      const shown = matches.slice(0, 5).map((s) => `  ${shortId(s.sessionId)} ${s.title ?? ''}`).join('\n');
      return { ok: false, message: `前缀 \`${value}\` 匹配到 ${matches.length} 个会话，再给长一点：\n${shown}` };
    }
    return { ok: false, message: `没有以 \`${value}\` 开头的会话，先发 /list 看看。` };
  }

  /** 会话详情（/status 用） */
  info(sessionId: string): BoundSessionInfo {
    const sessions = this.sessions();
    const summary = this.lastList.find((s) => s.sessionId === sessionId);

    let cwd = summary?.cwd;
    let messageCount: number | undefined;
    const live = sessions?.get(sessionId);
    if (live !== undefined) {
      cwd = live.header?.cwd ?? cwd;
      try {
        const events = live.snapshotEvents?.();
        if (Array.isArray(events)) messageCount = events.length;
      } catch (err) {
        this.logger.debug(`snapshotEvents failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      sessionId,
      title: summary?.title,
      cwd,
      running: summary?.running ?? false,
      messageCount,
    };
  }

  // ── 绑定 ──

  /** 绑定当前 peer 到某个会话（覆盖旧绑定） */
  bind(peerKey: string, sessionId: string): void {
    this.store.set(peerKey, sessionId);
    this.logger.info(`bridge: ${peerKey} → session ${shortId(sessionId)}`);
  }

  /** 解绑当前 peer；返回是否原本有绑定 */
  unbind(peerKey: string): boolean {
    return this.store.clear(peerKey);
  }

  /** 当前 peer 绑定的会话 id */
  current(peerKey: string): string | undefined {
    return this.store.get(peerKey);
  }

  /** 订阅了该会话的 QQ peer */
  peersFor(sessionId: string): string[] {
    return this.store.peersFor(sessionId);
  }

  // ── 订阅（/watch）：只收转发，不接管输入 ──

  /**
   * 订阅某会话的输出。
   *
   * 已绑定的会话无需订阅——绑定本身就会转发，返回 `bound` 让命令层给出人话解释。
   */
  watch(peerKey: string, sessionId: string): 'added' | 'bound' | 'dup' {
    if (this.store.get(peerKey) === sessionId) return 'bound';
    const watchers = this.watched.get(sessionId);
    if (watchers !== undefined && watchers.has(peerKey)) return 'dup';
    if (watchers === undefined) this.watched.set(sessionId, new Set([peerKey]));
    else watchers.add(peerKey);
    return 'added';
  }

  /** 取消订阅；不给 sessionId 时清掉该 peer 的全部订阅，返回清除数量 */
  unwatch(peerKey: string, sessionId?: string): number {
    if (sessionId !== undefined) {
      const watchers = this.watched.get(sessionId);
      if (watchers === undefined || !watchers.delete(peerKey)) return 0;
      if (watchers.size === 0) this.watched.delete(sessionId);
      return 1;
    }

    let removed = 0;
    for (const [id, watchers] of this.watched) {
      if (!watchers.delete(peerKey)) continue;
      removed += 1;
      if (watchers.size === 0) this.watched.delete(id);
    }
    return removed;
  }

  /** 该 peer 订阅的会话 id 列表 */
  watchedBy(peerKey: string): string[] {
    const result: string[] = [];
    for (const [sessionId, watchers] of this.watched) {
      if (watchers.has(peerKey)) result.push(sessionId);
    }
    return result;
  }

  /** 订阅了该会话的 peer（不含绑定，供测试与排障用） */
  watchersFor(sessionId: string): string[] {
    return [...(this.watched.get(sessionId) ?? [])];
  }

  /** 记录一份列表，供 `/use <序号>` 与 `/search` 的编号对齐 */
  rememberList(sessions: BridgeSession[]): void {
    this.lastList = sessions;
  }

  // ── 向会话投递 / 新建 ──

  /**
   * 把一段文本作为提示词投进目标会话。
   *
   * `prompt(request, signal)` 会无条件解引用 signal（signal.throwIfAborted()），
   * 传 undefined 会直接抛 TypeError 且消息丢失；这里给一个永不 abort 的 signal，
   * 因为 QQ 消息没有「调用方取消」的语义。
   */
  async prompt(sessionId: string, text: string): Promise<void> {
    const controller = this.controller();
    if (controller === undefined) throw new Error(this.unavailableReason);
    await controller.prompt(
      {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
      new AbortController().signal,
    );
  }

  /** 新建一个宿主会话（可选工作目录与标题），返回新会话 id */
  async createSession(opts: { cwd?: string; title?: string }): Promise<string> {
    const controller = this.controller();
    if (controller === undefined) throw new Error(this.unavailableReason);

    const created = await controller.create(opts.cwd === undefined ? {} : { cwd: opts.cwd });
    const sessionId = created.sessionId;
    if (opts.title !== undefined && opts.title !== '') {
      try {
        await controller.rename({ sessionId, title: opts.title });
      } catch (err) {
        // 标题是锦上添花，改不动不影响会话本身可用
        this.logger.warn(`bridge: rename ${shortId(sessionId)} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return sessionId;
  }

  /**
   * 会话摘要：最近若干轮问答（`/summary` 用）。
   *
   * 数据来自 `sessions.snapshotEvents()`；事件形态按最小契约读取
   * （`user/message` 与 `assistant/message` 的 content 文本块），
   * 拿不到就返回空数组，让命令层自己给一句人话。
   */
  summary(sessionId: string, limit = 6): SessionDigest {
    const info = this.info(sessionId);
    const live = this.sessions()?.get(sessionId);
    let events: readonly unknown[] = [];
    try {
      const snapshot = live?.snapshotEvents?.();
      if (Array.isArray(snapshot)) events = snapshot;
    } catch (err) {
      this.logger.debug(`bridge: snapshotEvents 失败 ${shortId(sessionId)}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const turns: Array<{ role: 'user' | 'assistant'; text: string }> = [];
    for (const raw of events) {
      if (typeof raw !== 'object' || raw === null) continue;
      const record = raw as Record<string, unknown>;
      const type = record['type'];
      if (type !== 'user/message' && type !== 'assistant/message') continue;
      const text = textOfMessage(record);
      if (text === '') continue;
      turns.push({ role: type === 'user/message' ? 'user' : 'assistant', text });
    }

    return {
      ...info,
      turns: turns.slice(-Math.max(1, limit)),
      totalTurns: turns.length,
    };
  }

  // ── 出站转发 ──

  /**
   * 轮询已绑定/被订阅会话的事件流，补发新产生的输出。
   *
   * 为什么不能只靠 ctx.on('session/event')：宿主会话在自己的 ctx 作用域上派发
   * 事件，插件 fiber 是根 ctx 的另一个子节点，兄弟作用域之间收不到彼此事件。
   * 插件自己造的会话同属一个 fiber，所以早期只测插件会话时「看起来是好的」，
   * 一旦 /use 绑到宿主会话，出站就静默——这里用 snapshotEvents 绕开作用域问题。
   *
   * 首次看到某个会话时以「最后一个 turn/end 之后」为基线：既不会把整段历史
   * 重发一遍，又能接上进行中的那一轮。
   */
  pollBoundSessions(): void {
    const sessions = this.sessions();
    if (sessions === undefined) return;

    const ids = new Set<string>([
      ...this.store.entries().map((entry) => entry.sessionId),
      ...this.watched.keys(),
    ]);

    for (const sessionId of ids) {
      let events: readonly unknown[] = [];
      try {
        const snapshot = sessions.get(sessionId)?.snapshotEvents?.();
        if (Array.isArray(snapshot)) events = snapshot;
      } catch (err) {
        this.logger.debug(`bridge: 轮询 ${shortId(sessionId)} 失败: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const previous = this.cursor.get(sessionId);
      if (previous === undefined) {
        // 首次看到：以「最后一个 turn/end 之后」为基线建游标，不重发历史
        this.cursor.set(sessionId, { index: baselineIndex(events), seq: lastSeqOf(events), length: events.length });
        continue;
      }

      if (events.length === previous.length) continue;

      if (events.length < previous.index) {
        // 会话被重建/压缩后事件表变短，重新对齐基线，避免漏发
        this.cursor.set(sessionId, { index: baselineIndex(events), seq: lastSeqOf(events), length: events.length });
        continue;
      }

      let seq = previous.seq;
      // 有 seq 时从头扫：冷启动后宿主会把历史补进事件表（插在中间），
      // 按索引增量扫会重复消费，按 seq 判定才是稳定水位
      const hasSeq = seq > 0;
      for (let index = hasSeq ? 0 : previous.index; index < events.length; index += 1) {
        const raw = events[index];
        if (typeof raw !== 'object' || raw === null) continue;
        const record = raw as Record<string, unknown>;
        const type = record['type'];
        if (typeof type !== 'string') continue;

        const eventSeq = typeof record['seq'] === 'number' ? record['seq'] : undefined;
        if (hasSeq && eventSeq !== undefined && eventSeq <= seq) continue;

        const data = record['data'];
        this.onSessionEvent(
          sessionId,
          type,
          typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {},
        );
        if (eventSeq !== undefined && eventSeq > seq) seq = eventSeq;
      }
      this.cursor.set(sessionId, { index: events.length, seq, length: events.length });
    }

    // 解绑/取消订阅后释放游标，否则长期运行会一直攒着已无关的会话
    for (const sessionId of [...this.cursor.keys()]) {
      if (!ids.has(sessionId)) this.cursor.delete(sessionId);
    }
  }

  /**
   * 处理一条宿主 session/event。
   *
   * 只转发「已绑定且不是本插件自己造的」会话：插件私有会话由 OutboundRouter
   * 负责（带流式与工具卡片），这里再发一遍会重复。
   */
  onSessionEvent(sessionId: string, type: string, data: Record<string, unknown>): void {
    if (this.store.peersFor(sessionId).length === 0 && (this.watched.get(sessionId)?.size ?? 0) === 0) return;

    if (type === 'assistant/message') {
      const text = textOfMessage(data);
      if (text !== '') {
        const lines = this.pending.get(sessionId) ?? [];
        lines.push(text);
        this.pending.set(sessionId, lines);
      }
      return;
    }

    if (type === 'turn/end') {
      const lines = this.pending.get(sessionId);
      this.pending.delete(sessionId);

      const replied = (lines ?? []).join('\n\n');
      // 没有文本但回合是失败结束的：QQ 侧不能一声不响，
      // 否则用户只看到「发出去没反应」，分不清是排队、卡住还是报错。
      const failure = replied === '' ? turnErrorText(data) : undefined;
      const text = replied !== ''
        ? replied
        : failure !== undefined
          ? `⚠️ 会话本轮失败：${clipLong(failure, 200)}`
          : '';
      if (text === '') return;

      // 订阅与轮询双通道可能在同一回合各触发一次，短窗口内同文只发一遍
      const last = this.lastRelayed.get(sessionId);
      const now = Date.now();
      if (last !== undefined && last.text === text && now - last.at < RELAY_DEDUPE_MS) return;
      this.lastRelayed.set(sessionId, { text, at: now });
      void this.broadcast(sessionId, text);
    }
  }

  /** 转发给订阅该会话的所有 peer（逐个独立，单个失败不影响其他） */
  private async broadcast(sessionId: string, text: string): Promise<void> {
    // 绑定与订阅可能指向同一个 peer，用 Set 去重，避免同一段回复发两遍
    const targets = new Set([
      ...this.store.peersFor(sessionId),
      ...(this.watched.get(sessionId) ?? []),
    ]);
    for (const peerKey of targets) {
      try {
        await this.sendFn(peerKey, text);
      } catch (err) {
        this.logger.warn(
          `bridge: 转发到 ${peerKey} 失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** 用绑定的会话构造一个被动回复目标（主动推送时 msgId 由缓存兜底） */
  replyTargetFor(peerKey: string): ReplyTarget | undefined {
    const parsed = parsePeerKey(peerKey);
    if (parsed === undefined) return undefined;
    return { scope: parsed.scope, targetId: parsed.peerId };
  }

  // ── 私有：服务与标题 ──

  /** inject 回调就绪时登记实例；服务卸载/替换时传 undefined 摘掉 */
  setController(value: SessionControllerLike | undefined): void {
    this.injected = value;
  }

  private controller(): SessionControllerLike | undefined {
    if (this.injected !== undefined) return this.injected;
    const value = this.service('sessionController');
    return typeof value === 'object' && value !== null ? (value as SessionControllerLike) : undefined;
  }

  /**
   * 读一个宿主服务。
   *
   * 访问守卫可能在「未 inject 就 get」时抛错，而这条路径在 /list、/status 里随时会走到；
   * 一个取服务的失败不该变成用户侧的崩溃，按「服务不存在」处理即可。
   */
  private service(name: string): unknown {
    try {
      return this.ctx.get(name);
    } catch {
      return undefined;
    }
  }
  private sessions(): SessionsLike | undefined {
    const value = this.service('sessions');
    return typeof value === 'object' && value !== null ? (value as SessionsLike) : undefined;
  }

  /**
   * 会话标题：优先 summary 里的 projection（冷会话也正确），
   * 退回 workspace 登记，都没有就留空。
   */
  private titleOf(summary: HostSessionSummary): string | undefined {
    const fromProjection = summary.projections?.values?.['title'];
    if (typeof fromProjection === 'string' && fromProjection !== '') return clip(fromProjection);

    const registry = this.service('workspaceRegistry');
    if (typeof registry === 'object' && registry !== null) {
      // 工作区登记是锦上添花：服务形态不符（异步 list、返回非数组）时跳过，
      // 不能因为拿不到标题就让 /list 整体失败
      let list: unknown;
      try {
        list = (registry as WorkspaceRegistryLike).list?.();
      } catch {
        list = undefined;
      }
      if (Array.isArray(list)) {
        for (const workspace of list as Array<{ title?: string; sessionIds?: readonly string[] }>) {
          if (workspace?.sessionIds?.includes(summary.sessionId) && workspace.title) {
            return clip(`${workspace.title} / ${summary.sessionId.slice(0, 8)}`);
          }
        }
      }
    }
    return undefined;
  }
}

/** `qqbot:<appId>:<scope>:<peerId>` → 结构；解析不了返回 undefined */
export function parsePeerKey(peerKey: string): { appId: string; scope: ChatScope; peerId: string } | undefined {
  const parts = peerKey.split(':');
  if (parts.length < 4 || parts[0] !== 'qqbot') return undefined;
  const scope = parts[2];
  if (scope !== 'c2c' && scope !== 'group') return undefined;
  return { appId: parts[1] ?? '', scope, peerId: parts.slice(3).join(':') };
}

/** 构造 peerKey（与 session-manager 的 sessionKey 同构） */
export function peerKeyOf(config: ImQQBotConfig, scope: ChatScope, peerId: string): string {
  return `qqbot:${config.appId}:${scope}:${peerId}`;
}

/** 短 id（列表展示用）：剥掉统一前缀再截，否则每个会话都显示成 `session-` */
export function shortId(sessionId: string): string {
  const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId;
  return bare.slice(0, 8);
}

/** 截断标题 */
function clip(title: string): string {
  return title.length > TITLE_MAX_LEN ? `${title.slice(0, TITLE_MAX_LEN - 1)}…` : title;
}

/**
 * 从消息事件里取文本。
 *
 * 载荷有两种形状，必须都认：
 * - 宿主会话的 `assistant/message`：`{ turn, step, message: { role, content[] } }`
 * - 插件/旧版直接给 `{ content[] }`
 *
 * 曾经只读 `data.content`，于是宿主会话永远取到空串——出站「有事件没文本」，
 * QQ 侧只看到失败提示，看不到任何正常回复。
 */
function textOfMessage(data: Record<string, unknown>): string {
  const nested = data['message'];
  const content = data['content']
    ?? (typeof nested === 'object' && nested !== null ? (nested as Record<string, unknown>)['content'] : undefined);
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record['type'] === 'text' && typeof record['text'] === 'string' && record['text'].trim() !== '') {
      parts.push(record['text']);
    }
  }
  return parts.join('\n').trim();
}

/** 从 turn/end 的失败原因里取一句可读的错误 */
function turnErrorText(data: Record<string, unknown>): string | undefined {
  const reason = data['reason'];
  if (typeof reason !== 'object' || reason === null) return undefined;
  const record = reason as Record<string, unknown>;
  if (record['kind'] !== 'error') return undefined;

  const detail = (record['error'] ?? record['failure']) as Record<string, unknown> | undefined;
  const message = detail?.['message'] ?? record['message'];
  return typeof message === 'string' && message.trim() !== '' ? message.trim() : '未知错误';
}
/** 按长度截断（错误文本用，不套标题的短上限） */
function clipLong(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 订阅/轮询双通道的去重窗口 */
const RELAY_DEDUPE_MS = 5000;

/**
 * 轮询基线：最后一个 turn/end 的下一条。
 *
 * 没有 turn/end 的历史会话按「全部已消费」处理——否则第一次轮询会把整段
 * 历史折叠成一条巨型消息发出去。
 */
function baselineIndex(events: readonly unknown[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const raw = events[index];
    if (typeof raw === 'object' && raw !== null && (raw as Record<string, unknown>)['type'] === 'turn/end') {
      return index + 1;
    }
  }
  return events.length;
}

/** 事件表里最后一条事件的 seq（水位），没有 seq 时返回 0 */
function lastSeqOf(events: readonly unknown[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const raw = events[index];
    if (typeof raw !== 'object' || raw === null) continue;
    const seq = (raw as Record<string, unknown>)['seq'];
    if (typeof seq === 'number') return seq;
  }
  return 0;
}