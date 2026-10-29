import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { buildCommandList } from './index.ts';
import type { CategorizedCommand } from './types.ts';
import { BindingStore, SessionBridge, type HostSessionSummary } from '../bridge/index.ts';
import type { SessionManager } from '../session/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const config = { appId: 'app-1', textChunkLimit: 4500 } as unknown as ImQQBotConfig;

/** 命令 handler 返回值归一成可断言的文本 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && 'kind' in value) return '';
  return '';
}

interface Harness {
  commands: CategorizedCommand[];
  bridge: SessionBridge;
  store: BindingStore;
  manager: { remove: ReturnType<typeof vi.fn> };
  controller: {
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    rename: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
  };
  dir: string;
}

function harness(items: HostSessionSummary[] = [], sessions?: Map<string, unknown>): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-cmd-'));
  const store = new BindingStore({ filePath: join(dir, 'bindings.json') });

  const controller = {
    list: vi.fn(async () => ({ items })),
    create: vi.fn(async () => ({ sessionId: 'session-created' })),
    rename: vi.fn(async ({ title }: { title: string }) => ({ title })),
    prompt: vi.fn(async () => ({ accepted: true as const })),
  };

  const bridge = new SessionBridge({
ctx: {
      get: (name: string) => {
        if (name === 'sessionController') return controller;
        if (name === 'workspaceRegistry') return { list: () => [] };
        if (name === 'sessions') return { get: (id: string) => sessions?.get(id) };
        return undefined;
      },
    },
    logger,
    store,
    send: async () => {},
  });
  bridge.setController(controller as never);

  const manager = { remove: vi.fn(async () => undefined) };
  const commands = buildCommandList({
    manager: manager as unknown as SessionManager,
    config,
    bridge,
  });

  return { commands, bridge, store, manager, controller, dir };
}

/** 构造一个假的斜杠命令上下文（bot.sendMarkdown 收集文本） */
function makeCtx(raw = '', kind: 'c2c' | 'group' = 'c2c'): {
  ctx: SlashCommandHandlerContext;
  sent: string[];
} {
  const sent: string[] = [];
  const message: Record<string, unknown> = {
    kind,
    senderId: kind === 'group' ? 'user-in-group' : 'user-1',
    content: 'x',
  };
  if (kind === 'group') message.groupOpenid = 'group-1';

  const ctx = {
    message,
    command: { raw, name: '' },
    replyTarget: { scope: kind, targetId: kind === 'group' ? 'group-1' : 'user-1' },
    bot: {
      sendMarkdown: async (_target: unknown, content: string) => {
        sent.push(content);
      },
    },
  } as unknown as SlashCommandHandlerContext;

  return { ctx, sent };
}

/** 按命令名找到命令并执行 */
async function run(h: Harness, name: string, ctx: SlashCommandHandlerContext): Promise<string> {
  const command = h.commands.find((c) => (Array.isArray(c.name) ? c.name[0] : c.name) === name);
  if (command === undefined) throw new Error(`command not found: ${name}`);
  const handler = command.handler as unknown as (
    ctx: SlashCommandHandlerContext,
  ) => unknown | Promise<unknown>;
  return textOf(await handler(ctx));
}

const twoSessions: HostSessionSummary[] = [
  { sessionId: 'session-aaa-1111', updatedAt: 500, running: true, blank: false, cwd: 'H:\\workspace\\x', projections: { values: { title: '修 QQ 插件' } } },
  { sessionId: 'session-bbb-2222', updatedAt: 400, running: false, blank: false, cwd: 'H:\\workspace\\y' },
];

let active: Harness | undefined;

beforeEach(() => {
  active = undefined;
});

afterEach(() => {
  if (active !== undefined) rmSync(active.dir, { recursive: true, force: true });
});

describe('/list 与 /list-all', () => {
  it('渲染列表：序号、标题、目录、运行中标记与可点击绑定入口', async () => {
    const h = harness(twoSessions);
    active = h;
    const { ctx, sent } = makeCtx();

    const result = await run(h, 'list', ctx);
    expect(result).toBe(''); // 走 sendMarkdownChunked
    expect(sent).toHaveLength(1);
    const text = sent[0] as string;
    expect(text).toContain('会话列表（2/2）');
    expect(text).toContain('修 QQ 插件');
    expect(text).toContain('运行中');
    expect(text).toContain('text="/use 1"');
    expect(text).toContain('workspace/x');
  });

  it('没有任何会话时给出引导而不是空列表', async () => {
    const h = harness([]);
    active = h;
    const { ctx } = makeCtx();
    expect(await run(h, 'list', ctx)).toContain('/new');
  });

  it('/list-all 支持条数参数并截断', async () => {
    const h = harness(twoSessions);
    active = h;
    const { ctx, sent } = makeCtx('1');
    await run(h, 'list-all', ctx);
    expect(sent[0]).toContain('会话列表（1/2）');
  });

  it('能力缺失时回一句人话，而不是抛错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-cmd-'));
    const bridge = new SessionBridge({
      ctx: { get: () => undefined },
      logger,
      store: new BindingStore({ filePath: join(dir, 'b.json') }),
      send: async () => {},
    });
    const commands = buildCommandList({
      manager: { remove: vi.fn() } as unknown as SessionManager,
      config,
      bridge,
    });
    const list = commands.find((c) => c.name === 'list') as CategorizedCommand;
    const { ctx } = makeCtx();
    const result = await (list.handler as unknown as (c: SlashCommandHandlerContext) => Promise<string>)(ctx);
    expect(result).toContain('sessionController');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('/use /current /unuse', () => {
  it('/use <序号> 绑定会话并回报', async () => {
    const h = harness(twoSessions);
    active = h;
    const { ctx } = makeCtx('1');
    await run(h, 'list', ctx);

    const result = await run(h, 'use', ctx);
    expect(result).toContain('已绑定会话');
    expect(result).toContain('修 QQ 插件');
    expect(h.store.get('qqbot:app-1:c2c:user-1')).toBe('session-aaa-1111');
  });

  it('/use 带提示词时顺带投递', async () => {
    const h = harness(twoSessions);
    active = h;
    const { ctx } = makeCtx('2 帮我看下这个报错');

    await run(h, 'use', ctx);
    expect(h.controller.prompt).toHaveBeenCalledTimes(1);
    const request = h.controller.prompt.mock.calls[0]?.[0] as { sessionId: string; content: unknown };
    expect(request.sessionId).toBe('session-bbb-2222');
    expect(request.content).toEqual([{ type: 'text', text: '帮我看下这个报错' }]);
  });

  it('/use 序号越界给出可用条数', async () => {
    const h = harness(twoSessions);
    active = h;
    const { ctx } = makeCtx('9');
    expect(await run(h, 'use', ctx)).toContain('超出范围');
  });

  it('/use 切换时报告旧绑定已解除', async () => {
    const h = harness(twoSessions);
    active = h;
    const { ctx } = makeCtx('1');
    await run(h, 'use', ctx);

    const switched = await run(h, 'use', makeCtx('2').ctx);
    expect(switched).toContain('原绑定');
    expect(h.store.get('qqbot:app-1:c2c:user-1')).toBe('session-bbb-2222');
  });

  it('群里按 groupOpenid 建 key（不是发送者 openid）', async () => {
    const h = harness(twoSessions);
    active = h;
    const { ctx } = makeCtx('1', 'group');
    await run(h, 'use', ctx);
    expect(h.store.get('qqbot:app-1:group:group-1')).toBe('session-aaa-1111');
    expect(h.store.get('qqbot:app-1:group:user-in-group')).toBeUndefined();
  });

  it('/current 无绑定时引导先 /list', async () => {
    const h = harness(twoSessions);
    active = h;
    expect(await run(h, 'current', makeCtx().ctx)).toContain('/list');
  });

  it('/current 有绑定时展示会话状态', async () => {
    const h = harness(twoSessions);
    active = h;
    const { ctx } = makeCtx('1');
    await run(h, 'use', ctx);
    await run(h, 'list', ctx);

    const text = await run(h, 'current', ctx);
    expect(text).toContain('会话状态');
    expect(text).toContain('aaa-1111');
    expect(text).toContain('修 QQ 插件');
  });

  it('/unuse 解除绑定，重复调用给出提示', async () => {
    const h = harness(twoSessions);
    active = h;
    const { ctx } = makeCtx('1');
    await run(h, 'use', ctx);

    expect(await run(h, 'unuse', ctx)).toContain('已解除');
    expect(h.store.get('qqbot:app-1:c2c:user-1')).toBeUndefined();
    expect(await run(h, 'unuse', ctx)).toContain('没有绑定');
  });
});

describe('/new', () => {
  it('未绑定且无参数：沿用重置插件会话的语义', async () => {
    const h = harness(twoSessions);
    active = h;
    const result = await run(h, 'new', makeCtx().ctx);
    expect(result).toContain('已开启新会话');
    expect(h.manager.remove).toHaveBeenCalledTimes(1);
    expect(h.controller.create).not.toHaveBeenCalled();
  });

  it('--dir + 标题：新建宿主会话、改名并绑定', async () => {
    const h = harness(twoSessions);
    active = h;
    const dirPath = mkdtempSync(join(tmpdir(), 'qqbot-dir-'));

    const result = await run(h, 'new', makeCtx(`--dir "${dirPath}" 新任务`).ctx);
    expect(result).toContain('已新建并绑定会话');
    expect(h.controller.create).toHaveBeenCalledWith({ cwd: dirPath });
    expect(h.controller.rename).toHaveBeenCalledWith({ sessionId: 'session-created', title: '新任务' });
    expect(h.store.get('qqbot:app-1:c2c:user-1')).toBe('session-created');

    rmSync(dirPath, { recursive: true, force: true });
  });

  it('目录不存在时拒绝并说明', async () => {
    const h = harness(twoSessions);
    active = h;
    const result = await run(h, 'new', makeCtx('--dir H:\\definitely\\missing\\path 标题').ctx);
    expect(result).toContain('目录不存在');
    expect(h.controller.create).not.toHaveBeenCalled();
  });

  it('绑定后再 /new（无参数）走新建宿主会话，不再重置插件会话', async () => {
    const h = harness(twoSessions);
    active = h;
    const { ctx } = makeCtx('1');
    await run(h, 'use', ctx);
    h.controller.create.mockResolvedValueOnce({ sessionId: 'session-next' });

    await run(h, 'new', ctx);
    expect(h.manager.remove).not.toHaveBeenCalled();
    expect(h.store.get('qqbot:app-1:c2c:user-1')).toBe('session-next');
  });
});

describe('/status', () => {
  it('未绑定时提示先 /list', async () => {
    const h = harness(twoSessions);
    active = h;
    expect(await run(h, 'status', makeCtx().ctx)).toContain('没有绑定');
  });

  it('带序号可查看任意会话状态（不影响当前绑定）', async () => {
    const h = harness(twoSessions);
    active = h;
    const { ctx } = makeCtx('2');
    await run(h, 'list', ctx);

    const text = await run(h, 'status', ctx);
    expect(text).toContain('会话状态');
    expect(h.store.get('qqbot:app-1:c2c:user-1')).toBeUndefined();
  });
});
describe('/watch 与 /unwatch', () => {
  it('/watch <序号> 订阅会话，并说明只收转发', async () => {
    const h = harness(twoSessions);
    active = h;
    const { ctx } = makeCtx('1');
    await run(h, 'list', ctx);

    const result = await run(h, 'watch', ctx);
    expect(result).toContain('已订阅');
    expect(result).toContain('不会进这个会话');
    expect(h.bridge.watchersFor('session-aaa-1111')).toEqual(['qqbot:app-1:c2c:user-1']);
  });

  it('已绑定的会话再 /watch 会解释「绑定本身就会转发」', async () => {
    const h = harness(twoSessions);
    active = h;
    const { ctx } = makeCtx('1');
    await run(h, 'use', ctx);

    const result = await run(h, 'watch', ctx);
    expect(result).toContain('绑定本身就会转发');
    expect(h.bridge.watchersFor('session-aaa-1111')).toEqual([]);
  });

  it('/unwatch 清空并统计数量，重复调用给出提示', async () => {
    const h = harness(twoSessions);
    active = h;
    const { ctx } = makeCtx('1');
    await run(h, 'list', ctx);
    await run(h, 'watch', ctx);

    // 不带参数才清空全部（带参数是取消指定会话）
    expect(await run(h, 'unwatch', makeCtx().ctx)).toContain('已取消全部订阅（1 个）');
    expect(await run(h, 'unwatch', makeCtx().ctx)).toContain('没有订阅');
  });
});

describe('/search', () => {
  it('按标题命中，并把序号对齐到搜索结果', async () => {
    const h = harness(twoSessions);
    active = h;
    const { ctx, sent } = makeCtx('插件');
    await run(h, 'search', ctx);

    expect(sent[0]).toContain('搜索「插件」（1/1）');
    expect(sent[0]).toContain('text="/use 1"');

    // 序号对齐搜索结果：/use 1 应该绑定命中的那个，而不是全量列表的第一个
    await run(h, 'use', makeCtx('1').ctx);
    expect(h.store.get('qqbot:app-1:c2c:user-1')).toBe('session-aaa-1111');
  });

  it('无关键词给用法，无命中给提示', async () => {
    const h = harness(twoSessions);
    active = h;
    expect(await run(h, 'search', makeCtx().ctx)).toContain('/search <关键词>');
    expect(await run(h, 'search', makeCtx('不存在的东西').ctx)).toContain('没有匹配');
  });
});
describe('/summary', () => {
  it('展示绑定会话的最近几轮问答', async () => {
    const events = [
      { type: 'user/message', content: [{ type: 'text', text: '第一个问题' }] },
      { type: 'assistant/message', content: [{ type: 'text', text: '第一个回答' }] },
    ];
    const h = harness(twoSessions, new Map([['session-aaa-1111', { snapshotEvents: () => events }]]));
    active = h;
    const { ctx } = makeCtx('1');
    await run(h, 'use', ctx);
    await run(h, 'list', ctx);

    const text = await run(h, 'summary', ctx);
    expect(text).toContain('📝');
    expect(text).toContain('最近 2/2 轮');
    expect(text).toContain('你');
    expect(text).toContain('第一个问题');
    expect(text).toContain('第一个回答');
  });

  it('没有可读事件时给一句人话，而不是空消息', async () => {
    const h = harness(twoSessions);
    active = h;
    const { ctx } = makeCtx('1');
    await run(h, 'use', ctx);
    expect(await run(h, 'summary', ctx)).toContain('还没有可读的对话内容');
  });

  it('未绑定且无参数时给用法', async () => {
    const h = harness(twoSessions);
    active = h;
    expect(await run(h, 'summary', makeCtx().ctx)).toContain('/summary');
  });
});