/**
 * BindingStore — QQ 会话（peer）与 DSH 会话的绑定持久化
 *
 * 存储路径与模型偏好一致，都在 ~/.dsh-qqbot/ 下，避免与宿主 profile 混写：
 *   ~/.dsh-qqbot/bindings.json
 *
 * 关系是「多对一」：多个 QQ peer 可以绑定同一个 DSH 会话（群里多人都看同一个
 * 工作副本），但一个 peer 同一时刻只绑定一个会话——再次 /use 会覆盖旧绑定。
 *
 * 写入策略与 model-prefs.json 相同：整体重写 + 目录按需创建，失败只记日志
 * 不抛错（绑定是命令的副作用，失败不该让用户的消息丢失）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

/** 日志回调（可选，debug 模式注入） */
type DebugFn = (msg: string) => void;

/** 隔离绑定文件结构 */
interface BindingsFile {
  /** peerKey → sessionId */
  bindings: Record<string, string>;
}

/** 一条绑定记录（供 /current 与调试展示） */
export interface BindingEntry {
  peerKey: string;
  sessionId: string;
}

/** 构造参数（filePath 供测试注入临时目录，生产用默认位置） */
export interface BindingStoreOptions {
  debugLog?: DebugFn;
  filePath?: string;
}

export class BindingStore {
  /** peerKey → sessionId */
  private bindings = new Map<string, string>();
  /** 隔离绑定文件路径 */
  private readonly bindingsPath: string;
  private readonly debugLog?: DebugFn;

  constructor(options: BindingStoreOptions = {}) {
    this.bindingsPath = options.filePath ?? resolve(homedir(), '.dsh-qqbot', 'bindings.json');
    this.debugLog = options.debugLog;
    this.load();
  }

  /** 当前 peer 绑定的 DSH 会话 id */
  get(peerKey: string): string | undefined {
    return this.bindings.get(peerKey);
  }

  /** 绑定（覆盖旧绑定） */
  set(peerKey: string, sessionId: string): void {
    this.bindings.set(peerKey, sessionId);
    this.write();
  }

  /** 解绑；返回是否真的存在过 */
  clear(peerKey: string): boolean {
    const deleted = this.bindings.delete(peerKey);
    if (deleted) this.write();
    return deleted;
  }

  /**
   * 订阅了某个 DSH 会话的所有 peer。
   *
   * 反向索引按需扫描：绑定表通常只有个位数条目，维护第二份索引得不偿失，
   * 反而多一个可能与主表不一致的状态。
   */
  peersFor(sessionId: string): string[] {
    const peers: string[] = [];
    for (const [peerKey, bound] of this.bindings.entries()) {
      if (bound === sessionId) peers.push(peerKey);
    }
    return peers;
  }

  /** 全部绑定（/list 反查「哪些会话已被绑定」用） */
  entries(): BindingEntry[] {
    return [...this.bindings.entries()].map(([peerKey, sessionId]) => ({ peerKey, sessionId }));
  }

  // ── 私有方法 ──

  private load(): void {
    try {
      if (!existsSync(this.bindingsPath)) return;
      const data = JSON.parse(readFileSync(this.bindingsPath, 'utf8')) as BindingsFile;
      if (!data.bindings || typeof data.bindings !== 'object') return;
      for (const [peerKey, sessionId] of Object.entries(data.bindings)) {
        if (typeof sessionId === 'string' && sessionId) this.bindings.set(peerKey, sessionId);
      }
    } catch (err) {
      this.debugLog?.(`loadBindings failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.bindingsPath), { recursive: true });
      const data: BindingsFile = { bindings: Object.fromEntries(this.bindings.entries()) };
      writeFileSync(this.bindingsPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      this.debugLog?.(`writeBindings failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
