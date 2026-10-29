/**
 * 会话绑定命令 — /list /list-all /use /current /unuse /new /status
 *
 * 这组命令把 QQ peer 绑到宿主的真实会话上（见 ../bridge/session-bridge.ts），
 * 与 /model /preset 那类「插件私有会话」的命令分开：它们操作的是同一个 agent
 * 会话对象，桌面版侧栏里能看到，QQ 里发的消息会进那个会话，那边的回复也会转回 QQ。
 */
import { existsSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { formatRelativeTime, getScopePeer, sendMarkdownChunked } from '../shared/index.ts';
import { peerKeyOf, shortId, type BridgeSession } from '../bridge/index.ts';

/** /list 默认条数 */
const LIST_LIMIT = 10;
/** /list-all 默认与上限 */
const LIST_ALL_LIMIT = 50;
const LIST_ALL_MAX = 200;
/** /search 结果上限：够定位就行，多了刷屏 */
const SEARCH_LIMIT = 20;

/**
 * 渲染会话列表。
 *
 * 每行带一个可点击的 `/use <序号>`，点一下等于替用户输入该命令；
 * 序号与 `bridge.lastList` 对齐，因此必须先 list 再编号。
 */
function renderList(sessions: BridgeSession[], limit: number, options: { heading?: string; hint?: string } = {}): string {
  const shown = sessions.slice(0, limit);
  const heading = options.heading ?? '会话列表';
  const lines: string[] = [`### 🗂 ${heading}（${shown.length}/${sessions.length}）`, ''];

  shown.forEach((session, index) => {
    const no = index + 1;
    const title = session.title ?? '（无标题）';
    const chips: string[] = [];
    if (session.bound) chips.push('已绑定');
    if (session.running) chips.push('运行中');
    if (session.cwd) chips.push(shortenPath(session.cwd));
    const tail = chips.length > 0 ? ` · ${chips.join(' · ')}` : '';
    lines.push(`<qqbot-cmd-input text="/use ${no}" show="${no}. ${escapeShow(title)}${escapeShow(tail)}"/>`);
    lines.push(`　\`${shortId(session.sessionId)}\` · ${formatRelativeTime(session.updatedAt)}`);
  });

  if (sessions.length > shown.length) {
    lines.push('', `还有 ${sessions.length - shown.length} 个，发 \`/list-all\` 看全部。`);
  }
  lines.push('', options.hint ?? '绑定: `/use <序号|ID前缀>`，看当前绑定: `/current`');
  return lines.join('\n');
}

/** 会话状态详情 */
function renderStatus(
  info: { sessionId: string; title?: string; cwd?: string; running: boolean; messageCount?: number },
  boundHere: boolean,
): string {
  return [
    '📌 会话状态',
    `会话: \`${shortId(info.sessionId)}\`${boundHere ? '（当前绑定）' : ''}`,
    `标题: ${info.title ?? '（无标题）'}`,
    `目录: ${info.cwd ?? '—'}`,
    `状态: ${info.running ? '运行中' : '空闲'}`,
    `消息数: ${info.messageCount ?? '—'}`,
  ].join('\n');
}

/** /list — 最近活动的会话 */
export function listCommand({ bridge, config }: CommandDeps): CategorizedCommand {
  return {
    name: 'list',
    category: 'agent',
    description: '列出最近活动的工作区会话',
    handler: async (cmdCtx) => {
      if (!bridge.available) return bridge.unavailableReason;
      const sessions = await bridge.list();
      if (sessions.length === 0) return '宿主里还没有任何会话。发 `/new` 建一个，或先在桌面版里开一个。';
      await sendMarkdownChunked(cmdCtx, renderList(sessions, LIST_LIMIT), config.textChunkLimit);
      return { kind: 'noop' as const };
    },
  };
}

/** /list-all [n] — 全部会话 */
export function listAllCommand({ bridge, config }: CommandDeps): CategorizedCommand {
  return {
    name: 'list-all',
    category: 'agent',
    description: '列出全部会话（默认 50 条）',
    handler: async (cmdCtx) => {
      if (!bridge.available) return bridge.unavailableReason;
      const raw = (cmdCtx.command?.raw ?? '').trim();
      const parsed = raw === '' ? LIST_ALL_LIMIT : Number(raw);
      const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), LIST_ALL_MAX) : LIST_ALL_LIMIT;

      const sessions = await bridge.list();
      if (sessions.length === 0) return '宿主里还没有任何会话。';
      await sendMarkdownChunked(cmdCtx, renderList(sessions, limit), config.textChunkLimit);
      return { kind: 'noop' as const };
    },
  };
}

/** /use <序号|ID前缀> [提示词] — 绑定会话，可顺带发一句 */
export function useCommand({ bridge, config }: CommandDeps): CategorizedCommand {
  return {
    name: 'use',
    category: 'agent',
    description: '绑定到某个会话（用法: /use <序号|ID前缀> [提示词]）',
    handler: async (cmdCtx) => {
      if (!bridge.available) return bridge.unavailableReason;

      const raw = (cmdCtx.command?.raw ?? '').trim();
      if (raw === '') return '用法: `/use <序号|ID前缀> [提示词]`，序号来自 `/list`。';

      const [ref, ...rest] = raw.split(/\s+/);
      const prompt = rest.join(' ').trim();

      const resolved = await bridge.resolve(ref ?? '');
      if (!resolved.ok) return resolved.message;

      const { scope, peerId } = getScopePeer(cmdCtx);
      const key = peerKeyOf(config, scope, peerId);
      const previous = bridge.current(key);
      bridge.bind(key, resolved.sessionId);

      const info = bridge.info(resolved.sessionId);
      const head = `✅ 已绑定会话 \`${shortId(resolved.sessionId)}\`${info.title ? `「${info.title}」` : ''}`;
      const switched = previous !== undefined && previous !== resolved.sessionId
        ? `\n（原绑定 \`${shortId(previous)}\` 已解除）`
        : '';

      if (prompt !== '') {
        await bridge.prompt(resolved.sessionId, prompt);
        return `${head}${switched}\n已发送提示词，回复会转发到这里。`;
      }
      return `${head}${switched}\n之后直接发消息就会进这个会话；发 \`/unuse\` 解除。`;
    },
  };
}

/** /current — 当前绑定 */
export function currentCommand({ bridge, config }: CommandDeps): CategorizedCommand {
  return {
    name: 'current',
    category: 'agent',
    description: '显示当前绑定的会话',
    handler: async (cmdCtx) => {
      if (!bridge.available) return bridge.unavailableReason;
      const { scope, peerId } = getScopePeer(cmdCtx);
      const key = peerKeyOf(config, scope, peerId);
      const sessionId = bridge.current(key);
      if (sessionId === undefined) {
        return '当前没有绑定会话。发 `/list` 看可选项，再 `/use <序号>`。';
      }
      return renderStatus(bridge.info(sessionId), true);
    },
  };
}

/** /unuse — 解除绑定 */
export function unuseCommand({ bridge, config }: CommandDeps): CategorizedCommand {
  return {
    name: 'unuse',
    category: 'agent',
    description: '取消当前绑定',
    handler: async (cmdCtx) => {
      if (!bridge.available) return bridge.unavailableReason;
      const { scope, peerId } = getScopePeer(cmdCtx);
      const key = peerKeyOf(config, scope, peerId);
      const removed = bridge.unbind(key);
      return removed ? '✅ 已解除绑定' : '当前没有绑定会话。';
    },
  };
}

/** /new [--dir <绝对路径>] [标题] — 新建会话并绑定 */
export function newSessionCommand({ bridge, config, manager }: CommandDeps): CategorizedCommand {
  return {
    name: 'new',
    category: 'agent',
    description: '新建会话并绑定（用法: /new [--dir <绝对路径>] [标题]）',
    handler: async (cmdCtx) => {
      const raw = (cmdCtx.command?.raw ?? '').trim();
      const parsed = parseNewArgs(raw);
      if (!parsed.ok) return parsed.message;

      const { scope, peerId } = getScopePeer(cmdCtx);
      const key = peerKeyOf(config, scope, peerId);

      // 未绑定、也没给目录或标题：沿用「重置插件私有会话」的语义，
      // 老用法 `/new` 在绑定之前行为不变
      if (bridge.current(key) === undefined && parsed.dir === undefined && parsed.title === undefined) {
        await manager.remove(scope, peerId);
        return '已开启新会话 ✓';
      }

      if (!bridge.available) return bridge.unavailableReason;

      if (parsed.dir !== undefined) {
        const absolute = resolvePath(parsed.dir);
        if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
          return `目录不存在: \`${absolute}\`\n工作目录必须是已存在的绝对路径。`;
        }
        parsed.dir = absolute;
      }

      const sessionId = await bridge.createSession(
        parsed.dir === undefined
          ? parsed.title === undefined ? {} : { title: parsed.title }
          : parsed.title === undefined ? { cwd: parsed.dir } : { cwd: parsed.dir, title: parsed.title },
      );

      bridge.bind(key, sessionId);

      const info = bridge.info(sessionId);
      return [
        `✅ 已新建并绑定会话 \`${shortId(sessionId)}\``,
        info.title ? `标题: ${info.title}` : undefined,
        info.cwd ? `目录: ${info.cwd}` : undefined,
        '之后直接发消息就会进这个会话。',
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n');
    },
  };
}

/** /status — 当前绑定会话的状态 */
export function sessionStatusCommand({ bridge, config }: CommandDeps): CategorizedCommand {
  return {
    name: 'status',
    category: 'agent',
    description: '查看当前绑定会话的状态',
    handler: async (cmdCtx) => {
      if (!bridge.available) return bridge.unavailableReason;

      const raw = (cmdCtx.command?.raw ?? '').trim();
      const { scope, peerId } = getScopePeer(cmdCtx);
      const key = peerKeyOf(config, scope, peerId);

      // 不带参数看当前绑定；带参数看任意会话（序号/前缀）
      const target = raw === '' ? bridge.current(key) : undefined;
      if (raw === '') {
        if (target === undefined) return '当前没有绑定会话。发 `/list` 看可选项。';
        return renderStatus(bridge.info(target), true);
      }

      const resolved = await bridge.resolve(raw);
      if (!resolved.ok) return resolved.message;
      return renderStatus(bridge.info(resolved.sessionId), resolved.sessionId === bridge.current(key));
    },
  };
}

// ── 订阅与搜索 ──

/** /watch [序号|ID前缀] — 订阅会话输出（只收转发，不接管输入） */
export function watchCommand({ bridge, config }: CommandDeps): CategorizedCommand {
  return {
    name: 'watch',
    category: 'agent',
    description: '订阅会话输出（用法: /watch [序号|ID前缀]）',
    handler: async (cmdCtx) => {
      if (!bridge.available) return bridge.unavailableReason;

      const { scope, peerId } = getScopePeer(cmdCtx);
      const key = peerKeyOf(config, scope, peerId);
      const raw = (cmdCtx.command?.raw ?? '').trim();

      let sessionId: string;
      if (raw === '') {
        // 不带参数时订阅「当前绑定」或「已订阅的第一个」，省一次 /list
        const fallback = bridge.current(key) ?? bridge.watchedBy(key)[0];
        if (fallback === undefined) return '用法: `/watch <序号|ID前缀>`，序号来自 `/list`。';
        sessionId = fallback;
      } else {
        const resolved = await bridge.resolve(raw.split(/\s+/)[0] ?? '');
        if (!resolved.ok) return resolved.message;
        sessionId = resolved.sessionId;
      }

      const outcome = bridge.watch(key, sessionId);
      const info = bridge.info(sessionId);
      const name = `\`${shortId(sessionId)}\`${info.title ? `「${info.title}」` : ''}`;

      if (outcome === 'bound') return `${name} 已经是当前绑定：绑定本身就会转发，不需要再订阅。`;
      if (outcome === 'dup') return `已经订阅了 ${name}。`;
      return `🔔 已订阅 ${name}\n该会话每轮结束的回复会转发到这里；发 \`/unwatch\` 取消。你发的消息不会进这个会话。`;
    },
  };
}

/** /unwatch [序号|ID前缀] — 取消订阅，不带参数清空 */
export function unwatchCommand({ bridge, config }: CommandDeps): CategorizedCommand {
  return {
    name: 'unwatch',
    category: 'agent',
    description: '取消订阅（用法: /unwatch [序号|ID前缀]，不带参数清空）',
    handler: async (cmdCtx) => {
      if (!bridge.available) return bridge.unavailableReason;

      const { scope, peerId } = getScopePeer(cmdCtx);
      const key = peerKeyOf(config, scope, peerId);
      const raw = (cmdCtx.command?.raw ?? '').trim();

      if (raw === '') {
        const removed = bridge.unwatch(key);
        return removed === 0 ? '当前没有订阅。' : `✅ 已取消全部订阅（${removed} 个）。`;
      }

      const resolved = await bridge.resolve(raw.split(/\s+/)[0] ?? '');
      if (!resolved.ok) return resolved.message;
      const removed = bridge.unwatch(key, resolved.sessionId);
      return removed === 0
        ? `没有订阅 \`${shortId(resolved.sessionId)}\`。`
        : `✅ 已取消订阅 \`${shortId(resolved.sessionId)}\`。`;
    },
  };
}

/** /search <关键词> — 按标题 / 目录 / ID 搜索会话 */
export function searchCommand({ bridge, config }: CommandDeps): CategorizedCommand {
  return {
    name: 'search',
    category: 'agent',
    description: '按关键词搜索会话（用法: /search <关键词>）',
    handler: async (cmdCtx) => {
      if (!bridge.available) return bridge.unavailableReason;

      const keyword = (cmdCtx.command?.raw ?? '').trim();
      if (keyword === '') return '用法: `/search <关键词>`，匹配会话标题、工作目录与 ID。';

      const needle = keyword.toLowerCase();
      const sessions = (await bridge.list()).filter(
        (s) =>
          (s.title ?? '').toLowerCase().includes(needle) ||
          (s.cwd ?? '').toLowerCase().includes(needle) ||
          s.sessionId.toLowerCase().includes(needle),
      );
      if (sessions.length === 0) return `没有匹配「${keyword}」的会话。`;

      // 记住这份结果：列表里的序号要能被 `/use <序号>` 直接解析
      bridge.rememberList(sessions);
      await sendMarkdownChunked(
        cmdCtx,
        renderList(sessions, SEARCH_LIMIT, {
          heading: `搜索「${keyword}」`,
          hint: '找到后用 `/use <序号>` 绑定，`/status <序号>` 看详情',
        }),
        config.textChunkLimit,
      );
      return { kind: 'noop' as const };
    },
  };
}

/** /summary [序号|ID前缀] — 会话最近几轮问答 */
export function summaryCommand({ bridge, config }: CommandDeps): CategorizedCommand {
  return {
    name: 'summary',
    category: 'agent',
    description: '查看会话最近几轮问答（用法: /summary [序号|ID前缀]）',
    handler: async (cmdCtx) => {
      if (!bridge.available) return bridge.unavailableReason;

      const { scope, peerId } = getScopePeer(cmdCtx);
      const key = peerKeyOf(config, scope, peerId);
      const raw = (cmdCtx.command?.raw ?? '').trim();

      let sessionId: string;
      if (raw === '') {
        const fallback = bridge.current(key) ?? bridge.watchedBy(key)[0];
        if (fallback === undefined) return '用法: `/summary <序号|ID前缀>`，或先 `/use` 绑定一个会话。';
        sessionId = fallback;
      } else {
        const resolved = await bridge.resolve(raw.split(/\s+/)[0] ?? '');
        if (!resolved.ok) return resolved.message;
        sessionId = resolved.sessionId;
      }

      const digest = bridge.summary(sessionId);
      const head = `### 📝 \`${shortId(sessionId)}\`${digest.title ? `「${digest.title}」` : ''}`;
      if (digest.turns.length === 0) {
        return `${head}\n还没有可读的对话内容（新会话，或宿主没有暴露事件快照）。`;
      }

      const lines = [head, `最近 ${digest.turns.length}/${digest.totalTurns} 轮：`, ''];
      for (const turn of digest.turns) {
        lines.push(`**${turn.role === 'user' ? '你' : '我'}**：${clipForChat(turn.text)}`, '');
      }
      return lines.join('\n').trim();
    },
  };
}

// ── 参数解析 ──

type NewArgs =
  | { ok: true; dir?: string; title?: string }
  | { ok: false; message: string };

/**
 * 解析 `/new` 参数：`--dir <path>` 取值支持带引号，其余部分拼成标题。
 */
function parseNewArgs(raw: string): NewArgs {
  let rest = raw;
  let dir: string | undefined;

  const match = /--dir\s+(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(rest);
  if (match !== null) {
    dir = match[1] ?? match[2] ?? match[3];
    rest = `${rest.slice(0, match.index)} ${rest.slice(match.index + match[0].length)}`.trim();
  }

  if (dir === '') return { ok: false, message: '`--dir` 需要一个目录路径。' };

  const title = rest.trim() === '' ? undefined : rest.trim();
  return dir === undefined && title === undefined ? { ok: true } : { ok: true, dir, title };
}

/** 聊天里展示一段文本：压成一行并截断 */
function clipForChat(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 列表里的目录短一点：保留末尾两段 */
function shortenPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.slice(-2).join('/');
}

/**
 * 内联按钮的 show 文本转义。
 *
 * 只处理会破坏 `<qqbot-cmd-input text="..." show="..."/>` 结构的字符：
 * 尖括号会被当成标签边界，双引号会提前闭合属性。斜杠和空格是合法内容，保留原样。
 */
function escapeShow(text: string): string {
  return text.replace(/[<>"]/g, ' ');
}
