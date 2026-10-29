import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BindingStore } from './binding-store.ts';
import { SessionBridge, parsePeerKey, peerKeyOf, shortId, type HostSessionSummary, type SessionControllerLike } from './session-bridge.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';

const APP_ID = 'app-1';

const config = { appId: APP_ID, textChunkLimit: 4500 } as unknown as ImQQBotConfig;

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function summary(overrides: Partial<HostSessionSummary> & { sessionId: string }): HostSessionSummary {
  return { updatedAt: 1_000, running: false, blank: false, ...overrides };
}

interface Harness {
  bridge: SessionBridge;
  store: BindingStore;
  sent: Array<{ peerKey: string; text: string }>;
  controller: {
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    rename: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
  };
  dir: string;
}

function harness(opts: {
  items?: HostSessionSummary[];
  sessions?: Map<string, { header?: { cwd?: string }; snapshotEvents?: () => unknown[] }>;
  workspaces?: Array<{ title?: string; sessionIds?: string[] }>;
  withController?: boolean;
} = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-bridge-'));
  const store = new BindingStore({ filePath: join(dir, 'bindings.json') });
  const sent: Array<{ peerKey: string; text: string }> = [];

  const controller = {
    list: vi.fn(async () => ({ items: opts.items ?? [] })),
    create: vi.fn(async () => ({ sessionId: 'session-created' })),
    rename: vi.fn(async ({ title }: { title: string }) => ({ title })),
    prompt: vi.fn(async () => ({ accepted: true as const })),
  };

  const services: Record<string, unknown> = {
    sessions: { get: (id: string) => opts.sessions?.get(id) },
    workspaceRegistry: { list: () => opts.workspaces ?? [] },
  };
  if (opts.withController !== false) services['sessionController'] = controller;

  const bridge = new SessionBridge({
    ctx: { get: (name: string) => services[name] },
    logger,
    store,
    send: async (peerKey, text) => {
      sent.push({ peerKey, text });
    },
  });

  return { bridge, store, sent, controller, dir };
}

describe('SessionBridge 能力探测', () => {
  it('有 sessionController 时 available=true', () => {
    const h = harness();
    expect(h.bridge.available).toBe(true);
  });

  it('缺 sessionController（只装 dsh-base）时 available=false 且给出明确原因', () => {
    const h = harness({ withController: false });
    expect(h.bridge.available).toBe(false);
    expect(h.bridge.unavailableReason).toContain('sessionController');
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('list 在缺服务时抛错而不是返回空列表（避免误导去新建会话）', async () => {
    const h = harness({ withController: false });
    await expect(h.bridge.list()).rejects.toThrow(/sessionController/);
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('setController 注入后即可用（不依赖 ctx.get：cordis 访问守卫下 get 可能是 undefined）', () => {
    const h = harness({ withController: false });
    expect(h.bridge.available).toBe(false);

    h.bridge.setController(h.controller as unknown as SessionControllerLike);
    expect(h.bridge.available).toBe(true);

    h.bridge.setController(undefined);
    expect(h.bridge.available).toBe(false);
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('ctx.get 抛错时按「服务不存在」处理，不把异常抛给命令层', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-bridge-'));
    const bridge = new SessionBridge({
      ctx: {
        get: () => {
          throw new Error('cordis: service not injected');
        },
      },
      logger,
      store: new BindingStore({ filePath: join(dir, 'bindings.json') }),
      send: async () => {},
    });

    expect(bridge.available).toBe(false);
    expect(() => bridge.info('session-x')).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it('inject 注入的空值（服务未就绪）不会让 available 变成 true', () => {
    const h = harness({ withController: false });
    h.bridge.setController(undefined);
    expect(h.bridge.available).toBe(false);
    rmSync(h.dir, { recursive: true, force: true });
  });
});

describe('SessionBridge.list', () => {
  it('按 updatedAt 倒序，取投影标题，标记已绑定', async () => {
    const h = harness({
      items: [
        summary({ sessionId: 'session-old', updatedAt: 100 }),
        summary({ sessionId: 'session-new', updatedAt: 900, projections: { values: { title: '修 QQ 插件' } } }),
      ],
    });
    h.bridge.bind('qqbot:app-1:c2c:p1', 'session-old');

    const list = await h.bridge.list();
    expect(list.map((s) => s.sessionId)).toEqual(['session-new', 'session-old']);
    expect(list[0]?.title).toBe('修 QQ 插件');
    expect(list[0]?.bound).toBe(false);
    expect(list[1]?.bound).toBe(true);
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('无投影标题时回退到工作区标题', async () => {
    const h = harness({
      items: [summary({ sessionId: 'session-abcdef12' })],
      workspaces: [{ title: 'dsh-qqbot', sessionIds: ['session-abcdef12'] }],
    });
    const list = await h.bridge.list();
    expect(list[0]?.title).toContain('dsh-qqbot');
    rmSync(h.dir, { recursive: true, force: true });
  });
});

describe('SessionBridge.resolve', () => {
  const items = [
    summary({ sessionId: 'aaaaaaaa-1111', updatedAt: 300 }),
    summary({ sessionId: 'aabbbb-2222', updatedAt: 200 }),
    summary({ sessionId: 'cccccc-3333', updatedAt: 100 }),
  ];

  it('序号按 list 顺序取（1 起）', async () => {
    const h = harness({ items });
    await h.bridge.list();
    await expect(h.bridge.resolve('1')).resolves.toEqual({ ok: true, sessionId: 'aaaaaaaa-1111' });
    await expect(h.bridge.resolve('3')).resolves.toEqual({ ok: true, sessionId: 'cccccc-3333' });
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('序号越界给出提示', async () => {
    const h = harness({ items });
    await h.bridge.list();
    const result = await h.bridge.resolve('9');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('超出范围');
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('ID 前缀唯一时命中', async () => {
    const h = harness({ items });
    await expect(h.bridge.resolve('cccc')).resolves.toEqual({ ok: true, sessionId: 'cccccc-3333' });
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('前缀匹配多个时要求给长一点', async () => {
    const h = harness({ items });
    const result = await h.bridge.resolve('aa');
    expect(result.ok).toBe(false);
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('前缀过短直接拒绝', async () => {
    const h = harness({ items });
    const result = await h.bridge.resolve('cc');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('至少');
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('没有匹配时提示先 /list', async () => {
    const h = harness({ items });
    const result = await h.bridge.resolve('zzzz');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('/list');
    rmSync(h.dir, { recursive: true, force: true });
  });
});

describe('SessionBridge.prompt', () => {
  it('把文本作为 prompt 投进目标会话，带 queue 模式与永不 abort 的 signal', async () => {
    const h = harness();
    await h.bridge.prompt('session-aaa', '你好');

    expect(h.controller.prompt).toHaveBeenCalledTimes(1);
    const [request, signal] = h.controller.prompt.mock.calls[0] as [
      { requestId: string; sessionId: string; mode: string; content: Array<{ type: string; text: string }> },
      AbortSignal,
    ];
    expect(request.sessionId).toBe('session-aaa');
    expect(request.mode).toBe('queue');
    expect(request.content).toEqual([{ type: 'text', text: '你好' }]);
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('缺服务时抛错（调用方负责回一句人话）', async () => {
    const h = harness({ withController: false });
    await expect(h.bridge.prompt('session-aaa', 'x')).rejects.toThrow(/sessionController/);
    rmSync(h.dir, { recursive: true, force: true });
  });
});

describe('SessionBridge.createSession', () => {
  it('带 cwd 建会话，并按需改标题', async () => {
    const h = harness();
    const id = await h.bridge.createSession({ cwd: 'H:/workspace/x', title: '新任务' });

    expect(id).toBe('session-created');
    expect(h.controller.create).toHaveBeenCalledWith({ cwd: 'H:/workspace/x' });
    expect(h.controller.rename).toHaveBeenCalledWith({ sessionId: 'session-created', title: '新任务' });
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('无 cwd 时传空对象（由宿主决定默认目录）', async () => {
    const h = harness();
    await h.bridge.createSession({});
    expect(h.controller.create).toHaveBeenCalledWith({});
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('改标题失败不影响会话本身（标题只是锦上添花）', async () => {
    const h = harness();
    h.controller.rename.mockRejectedValueOnce(new Error('nope'));
    await expect(h.bridge.createSession({ title: 'x' })).resolves.toBe('session-created');
    rmSync(h.dir, { recursive: true, force: true });
  });
});

describe('SessionBridge 出站转发', () => {
  it('绑定会话的 assistant/message 在 turn/end 时转发给所有订阅 peer', async () => {
    const h = harness();
    h.bridge.bind('qqbot:app-1:c2c:p1', 'session-aaa');
    h.bridge.bind('qqbot:app-1:group:g1', 'session-aaa');

    h.bridge.onSessionEvent('session-aaa', 'assistant/message', {
      content: [{ type: 'text', text: '第一段' }],
    });
    // 尚未轮末：不发送
    expect(h.sent).toEqual([]);

    h.bridge.onSessionEvent('session-aaa', 'assistant/message', {
      content: [{ type: 'text', text: '第二段' }],
    });
    h.bridge.onSessionEvent('session-aaa', 'turn/end', {});

    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    expect(h.sent.map((s) => s.peerKey).sort()).toEqual(['qqbot:app-1:c2c:p1', 'qqbot:app-1:group:g1']);
    expect(h.sent[0]?.text).toBe('第一段\n\n第二段');
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('未绑定的会话不进转发缓冲', async () => {
    const h = harness();
    h.bridge.onSessionEvent('session-other', 'assistant/message', { content: [{ type: 'text', text: 'x' }] });
    h.bridge.onSessionEvent('session-other', 'turn/end', {});
    expect(h.sent).toEqual([]);
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('单个 peer 发送失败不影响其他 peer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-bridge-'));
    const store = new BindingStore({ filePath: join(dir, 'bindings.json') });
    const ok: string[] = [];
    const bridge = new SessionBridge({
      ctx: { get: () => ({ list: async () => ({ items: [] }), create: async () => ({ sessionId: 's' }), prompt: async () => ({ accepted: true }), rename: async () => ({ title: '' }) }) },
      logger,
      store,
      send: async (peerKey) => {
        if (peerKey.endsWith('bad')) throw new Error('boom');
        ok.push(peerKey);
      },
    });

    store.set('qqbot:app-1:c2c:good', 'session-aaa');
    store.set('qqbot:app-1:c2c:bad', 'session-aaa');

    bridge.onSessionEvent('session-aaa', 'assistant/message', { content: [{ type: 'text', text: 'hi' }] });
    bridge.onSessionEvent('session-aaa', 'turn/end', {});

    await vi.waitFor(() => expect(ok).toEqual(['qqbot:app-1:c2c:good']));
    rmSync(dir, { recursive: true, force: true });
  });

  it('turn/end 没有可转发文本时不发空消息', async () => {
    const h = harness();
    h.bridge.bind('qqbot:app-1:c2c:p1', 'session-aaa');
    h.bridge.onSessionEvent('session-aaa', 'turn/end', {});
    expect(h.sent).toEqual([]);
    rmSync(h.dir, { recursive: true, force: true });
  });
});

describe('SessionBridge.info', () => {
  it('从 sessions 服务补齐 cwd 与消息数', async () => {
    const h = harness({
      items: [summary({ sessionId: 'session-aaa', projections: { values: { title: 'T' } } })],
      sessions: new Map([['session-aaa', { header: { cwd: 'H:/workspace/x' }, snapshotEvents: () => [1, 2, 3] }]]),
    });
    await h.bridge.list();

    const info = h.bridge.info('session-aaa');
    expect(info).toMatchObject({ sessionId: 'session-aaa', title: 'T', cwd: 'H:/workspace/x', messageCount: 3 });
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('冷会话（未在 list 里）也能返回，不抛错', () => {
    const h = harness();
    expect(() => h.bridge.info('session-unknown')).not.toThrow();
    expect(h.bridge.info('session-unknown').running).toBe(false);
    rmSync(h.dir, { recursive: true, force: true });
  });
});

describe('shortId', () => {
  it('剥掉 session- 前缀再截 8 位（否则每个会话都显示成 session-）', () => {
    expect(shortId('session-abcdef12-3456')).toBe('abcdef12');
    expect(shortId('abcdef12-3456')).toBe('abcdef12');
    expect(shortId('short')).toBe('short');
  });
});
describe('peerKey 编解码', () => {
  it('peerKeyOf 与 parsePeerKey 互逆', () => {
    const key = peerKeyOf(config, 'group', 'openid-123');
    expect(key).toBe('qqbot:app-1:group:openid-123');
    expect(parsePeerKey(key)).toEqual({ appId: 'app-1', scope: 'group', peerId: 'openid-123' });
  });

  it('peerId 自身含冒号时也能还原', () => {
    const parsed = parsePeerKey('qqbot:app-1:c2c:a:b:c');
    expect(parsed?.peerId).toBe('a:b:c');
  });

  it('非法 key 返回 undefined', () => {
    expect(parsePeerKey('qqbot:app-1:private:x')).toBeUndefined();
    expect(parsePeerKey('other:app-1:c2c:x')).toBeUndefined();
    expect(parsePeerKey('qqbot:app-1:c2c')).toBeUndefined();
  });
});
describe('SessionBridge 订阅（/watch）', () => {
  it('未绑定也能订阅并收到转发', async () => {
    const h = harness();
    expect(h.bridge.watch('qqbot:app-1:c2c:p1', 'session-aaa')).toBe('added');

    h.bridge.onSessionEvent('session-aaa', 'assistant/message', { content: [{ type: 'text', text: '进展' }] });
    h.bridge.onSessionEvent('session-aaa', 'turn/end', {});

    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]).toEqual({ peerKey: 'qqbot:app-1:c2c:p1', text: '进展' });
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('先订阅再绑定同一会话时只转发一次（去重）', async () => {
    const h = harness();
    h.bridge.watch('qqbot:app-1:c2c:p1', 'session-aaa');
    h.bridge.bind('qqbot:app-1:c2c:p1', 'session-aaa');

    h.bridge.onSessionEvent('session-aaa', 'assistant/message', { content: [{ type: 'text', text: '一次' }] });
    h.bridge.onSessionEvent('session-aaa', 'turn/end', {});

    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]?.text).toBe('一次');
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('重复订阅 / 已绑定时给出可解释的结果', () => {
    const h = harness();
    expect(h.bridge.watch('qqbot:app-1:c2c:p1', 'session-aaa')).toBe('added');
    expect(h.bridge.watch('qqbot:app-1:c2c:p1', 'session-aaa')).toBe('dup');

    h.bridge.bind('qqbot:app-1:c2c:p2', 'session-bbb');
    expect(h.bridge.watch('qqbot:app-1:c2c:p2', 'session-bbb')).toBe('bound');
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('unwatch 指定会话只清那一个，不带参数清全部', () => {
    const h = harness();
    h.bridge.watch('qqbot:app-1:c2c:p1', 'session-aaa');
    h.bridge.watch('qqbot:app-1:c2c:p1', 'session-bbb');
    expect(h.bridge.watchedBy('qqbot:app-1:c2c:p1')).toHaveLength(2);

    expect(h.bridge.unwatch('qqbot:app-1:c2c:p1', 'session-aaa')).toBe(1);
    expect(h.bridge.watchedBy('qqbot:app-1:c2c:p1')).toEqual(['session-bbb']);
    expect(h.bridge.watchersFor('session-aaa')).toEqual([]);

    expect(h.bridge.unwatch('qqbot:app-1:c2c:p1')).toBe(1);
    expect(h.bridge.watchedBy('qqbot:app-1:c2c:p1')).toEqual([]);
    expect(h.bridge.unwatch('qqbot:app-1:c2c:p1')).toBe(0);
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('取消订阅后不再转发', async () => {
    const h = harness();
    h.bridge.watch('qqbot:app-1:c2c:p1', 'session-aaa');
    h.bridge.unwatch('qqbot:app-1:c2c:p1');

    h.bridge.onSessionEvent('session-aaa', 'assistant/message', { content: [{ type: 'text', text: 'x' }] });
    h.bridge.onSessionEvent('session-aaa', 'turn/end', {});
    expect(h.sent).toEqual([]);
    rmSync(h.dir, { recursive: true, force: true });
  });
});

describe('SessionBridge resolve：短 id 与编号', () => {
  it('列表展示的短 id 能直接当 ID 前缀用', async () => {
    const h = harness({ items: [summary({ sessionId: 'session-aaa-1111' })] });
    await h.bridge.list();

    expect(await h.bridge.resolve('aaa-1111')).toEqual({ ok: true, sessionId: 'session-aaa-1111' });
    expect(await h.bridge.resolve('session-aaa')).toEqual({ ok: true, sessionId: 'session-aaa-1111' });
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('rememberList 让序号对齐搜索结果', async () => {
    const h = harness({ items: [summary({ sessionId: 'session-aaa-1111' }), summary({ sessionId: 'session-bbb-2222' })] });
    await h.bridge.list();
    h.bridge.rememberList([{ ...summary({ sessionId: 'session-bbb-2222' }), title: 'bbb' }] as never);

    expect(await h.bridge.resolve('1')).toEqual({ ok: true, sessionId: 'session-bbb-2222' });
    rmSync(h.dir, { recursive: true, force: true });
  });
});
describe('失败回合与摘要', () => {
  it('回合以错误结束且没有文本时，把错误转发给绑定方', async () => {
    const h = harness();
    h.bridge.bind('qqbot:app-1:c2c:p1', 'session-aaa');

    h.bridge.onSessionEvent('session-aaa', 'turn/end', {
      reason: { kind: 'error', error: { code: 'MODEL_FAILED', message: '模型调用失败' } },
    });

    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]?.text).toContain('本轮失败');
    expect(h.sent[0]?.text).toContain('模型调用失败');
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('正常回合结束（无 reason）不发失败提示', async () => {
    const h = harness();
    h.bridge.bind('qqbot:app-1:c2c:p1', 'session-aaa');
    h.bridge.onSessionEvent('session-aaa', 'turn/end', { reason: { kind: 'done' } });
    expect(h.sent).toEqual([]);
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('summary 从事件快照里取最近若干轮问答', () => {
    const events = [
      { type: 'user/message', content: [{ type: 'text', text: '第一个问题' }] },
      { type: 'assistant/message', content: [{ type: 'text', text: '第一个回答' }] },
      { type: 'user/message', content: [{ type: 'text', text: '第二个问题' }] },
      { type: 'assistant/message', content: [{ type: 'tool-call', name: 'read' }] },
      { type: 'turn/end', reason: { kind: 'done' } },
      { type: 'user/message', content: [{ type: 'text', text: '第三个问题' }] },
      { type: 'assistant/message', content: [{ type: 'text', text: '第三个回答' }] },
    ];
    const h = harness({
      items: [summary({ sessionId: 'session-aaa', projections: { values: { title: '标题' } } })],
      sessions: new Map([['session-aaa', { snapshotEvents: () => events }]]),
    });
    h.bridge.rememberList([{ ...summary({ sessionId: 'session-aaa' }), title: '标题' }] as never);

    const digest = h.bridge.summary('session-aaa', 3);
    expect(digest.title).toBe('标题');
    expect(digest.totalTurns).toBe(5);
    // 只有工具调用的 assistant 消息没有文本可展示，会被跳过；取最后 3 条有文本的
    expect(digest.turns.map((turn) => turn.role)).toEqual(['user', 'user', 'assistant']);
    expect(digest.turns[0]?.text).toBe('第二个问题');
    expect(digest.turns[2]?.text).toBe('第三个回答');
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('拿不到事件快照时返回空 turns，不抛错', () => {
    const h = harness({ sessions: new Map([['session-aaa', {}]]) });
    expect(h.bridge.summary('session-aaa').turns).toEqual([]);
    rmSync(h.dir, { recursive: true, force: true });
  });
});
describe('已绑定会话的出站轮询（pollBoundSessions）', () => {
  const SESSION = 'session-host-1234';
  const peerKey = peerKeyOf(config, 'c2c', 'user-1');

  /** 建一个可增长的事件表，模拟宿主会话 */
  function pollHarness(): { h: Harness; events: unknown[]; flush: () => void } {
    const events: unknown[] = [];
    const h = harness({
      sessions: new Map([[SESSION, { snapshotEvents: () => events }]]),
    });
    h.store.set(peerKey, SESSION);
    return { h, events, flush: () => h.bridge.pollBoundSessions() };
  }

  const ev = (type: string, data: Record<string, unknown> = {}): unknown => ({ type, data });
  const text = (value: string): Record<string, unknown> => ({ content: [{ type: 'text', text: value }] });

  it('首次轮询只建基线，不把历史整段重发', () => {
    const { h, events, flush } = pollHarness();
    events.push(ev('user/message', text('老问题')), ev('assistant/message', text('老回答')), ev('turn/end'));

    flush();

    expect(h.sent).toEqual([]);
  });

  it('新回合的 assistant 文本在 turn/end 时转发给绑定的 peer', () => {
    const { h, events, flush } = pollHarness();
    events.push(ev('turn/end'));
    flush();

    events.push(ev('user/message', text('新问题')), ev('assistant/message', text('新回答')), ev('turn/end'));
    flush();

    expect(h.sent).toEqual([{ peerKey, text: '新回答' }]);
  });

  it('同一回合被轮询多次只发一次', () => {
    const { h, events, flush } = pollHarness();
    events.push(ev('turn/end'));
    flush();

    events.push(ev('assistant/message', text('只应出现一次')), ev('turn/end'));
    flush();
    flush();
    flush();

    expect(h.sent).toHaveLength(1);
  });

  it('绑定发生在回合中途时，正在进行的那一轮也能转发（基线落在最后一个 turn/end 之后）', () => {
    const { h, events, flush } = pollHarness();
    // 最后一个 turn/end 之后又开始了新一轮：文本已产生但还没收尾
    events.push(ev('turn/end'), ev('user/message', text('进行中的问题')), ev('assistant/message', text('进行中的回答')));

    flush();
    // 回合还没结束，先攒着
    expect(h.sent).toEqual([]);

    events.push(ev('turn/end'));
    flush();

    expect(h.sent).toEqual([{ peerKey, text: '进行中的回答' }]);
  });

  it('多段 assistant 文本合并成一条发送', () => {
    const { h, events, flush } = pollHarness();
    events.push(ev('turn/end'));
    flush();

    events.push(
      ev('assistant/message', text('第一段')),
      ev('assistant/message', text('第二段')),
      ev('turn/end'),
    );
    flush();

    expect(h.sent).toEqual([{ peerKey, text: '第一段\n\n第二段' }]);
  });

  it('回合失败且没有文本时给出失败提示，不让 QQ 侧一声不响', () => {
    const { h, events, flush } = pollHarness();
    events.push(ev('turn/end'));
    flush();

    events.push(ev('turn/end', { reason: { kind: 'error', message: 'MISSING_CREDENTIAL: 没配 key' } }));
    flush();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.text).toContain('MISSING_CREDENTIAL');
  });

  it('事件表变短（会话被重建/压缩）时不抛错，重新对齐基线', () => {
    const { h, events, flush } = pollHarness();
    events.push(ev('turn/end'), ev('turn/end'));
    flush();

    events.length = 1;
    expect(() => { flush(); }).not.toThrow();
    expect(h.sent).toEqual([]);

    events.push(ev('assistant/message', text('重建后的回答')), ev('turn/end'));
    flush();
    expect(h.sent).toEqual([{ peerKey, text: '重建后的回答' }]);
  });

  it('解绑后不再轮询该会话', () => {
    const { h, events, flush } = pollHarness();
    events.push(ev('turn/end'));
    flush();

    h.store.clear(peerKey);
    events.push(ev('assistant/message', text('解绑后的回答')), ev('turn/end'));
    flush();

    expect(h.sent).toEqual([]);
  });

  it('订阅（/watch）的会话同样转发，不需要绑定', () => {
    const events: unknown[] = [];
    const h = harness({ sessions: new Map([[SESSION, { snapshotEvents: () => events }]]) });
    const watcher = peerKeyOf(config, 'c2c', 'watcher-1');
    h.bridge.watch(watcher, SESSION);
    events.push(ev('turn/end'));
    h.bridge.pollBoundSessions();

    events.push(ev('assistant/message', text('订阅到的回答')), ev('turn/end'));
    h.bridge.pollBoundSessions();

    expect(h.sent).toEqual([{ peerKey: watcher, text: '订阅到的回答' }]);
  });

  it('订阅事件与轮询同时命中同一回合时只发一遍', () => {
    const { h, events, flush } = pollHarness();
    events.push(ev('turn/end'));
    flush();

    events.push(ev('assistant/message', text('双通道')), ev('turn/end'));
    // 先走事件通道（同一 fiber 的会话才会这样），再走轮询
    h.bridge.onSessionEvent(SESSION, 'assistant/message', text('双通道'));
    h.bridge.onSessionEvent(SESSION, 'turn/end', {});
    flush();

    expect(h.sent).toHaveLength(1);
  });
});

describe('宿主事件载荷形状（textOfMessage）', () => {
  const SESSION = 'session-host-shape';
  const peerKey = peerKeyOf(config, 'c2c', 'user-shape');

  function shapeHarness(): { h: Harness; events: unknown[] } {
    const events: unknown[] = [];
    const h = harness({ sessions: new Map([[SESSION, { snapshotEvents: () => events }]]) });
    h.store.set(peerKey, SESSION);
    return { h, events };
  }

  /** 宿主真实形状：文本嵌在 message.content 里 */
  const hostEvent = (type: string, text: string): unknown => ({
    type,
    time: Date.now(),
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  });

  it('读 data.message.content（宿主形状）', () => {
    const { h, events } = shapeHarness();
    events.push({ type: 'turn/end', time: Date.now(), data: {} });
    h.bridge.pollBoundSessions();

    events.push(hostEvent('assistant/message', '宿主形状的回复'), { type: 'turn/end', time: Date.now(), data: {} });
    h.bridge.pollBoundSessions();

    expect(h.sent).toEqual([{ peerKey, text: '宿主形状的回复' }]);
  });

  it('兼容 data.content（插件/旧形状）', () => {
    const { h, events } = shapeHarness();
    events.push({ type: 'turn/end', time: Date.now(), data: {} });
    h.bridge.pollBoundSessions();

    events.push(
      { type: 'assistant/message', time: Date.now(), data: { content: [{ type: 'text', text: '旧形状的回复' }] } },
      { type: 'turn/end', time: Date.now(), data: {} },
    );
    h.bridge.pollBoundSessions();

    expect(h.sent).toEqual([{ peerKey, text: '旧形状的回复' }]);
  });

  it('冷启动后回填的历史事件不会重放（按 seq 水位判定）', () => {
    const { h, events } = shapeHarness();
    const now = Date.now();

    events.push({ type: 'turn/end', seq: 1, time: now - 2000, data: {} });
    h.bridge.pollBoundSessions(); // 建基线（水位 seq=1）

    events.push(hostEvent('assistant/message', '新回复'), { type: 'turn/end', seq: 3, time: now, data: {} });
    h.bridge.pollBoundSessions();
    expect(h.sent).toEqual([{ peerKey, text: '新回复' }]);

    // 宿主把更早的历史补进事件表（插在中间）：seq 更小，必须被跳过
    events.splice(1, 0, {
      type: 'turn/end',
      seq: 0,
      time: now - 3_600_000,
      data: { reason: { kind: 'error', message: '一小时前的失败' } },
    });
    h.bridge.pollBoundSessions();

    expect(h.sent).toHaveLength(1);
  });});
