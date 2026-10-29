import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { handleInbound } from './inbound.ts';
import type { SessionManager } from '../session/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import { BindingStore, SessionBridge, peerKeyOf } from '../bridge/index.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const config = { appId: 'app-1', textChunkLimit: 4500, debug: false, historyLimit: 10 } as unknown as ImQQBotConfig;

interface Harness {
  dir: string;
  bridge: SessionBridge;
  controller: { prompt: ReturnType<typeof vi.fn> };
  manager: { getOrCreate: ReturnType<typeof vi.fn> };
  followup: ReturnType<typeof vi.fn>;
  sendMarkdown: ReturnType<typeof vi.fn>;
}

function harness(withController = true): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-inbound-'));
  const store = new BindingStore({ filePath: join(dir, 'bindings.json') });

  const controller = {
    list: vi.fn(async () => ({ items: [] })),
    create: vi.fn(async () => ({ sessionId: 'session-new' })),
    rename: vi.fn(async ({ title }: { title: string }) => ({ title })),
    prompt: vi.fn(async () => ({ accepted: true as const })),
  };

  const bridge = new SessionBridge({
    ctx: { get: (name: string) => (withController && name === 'sessionController' ? controller : undefined) },
    logger,
    store,
    send: async () => {},
  });
  if (withController) bridge.setController(controller as never);

  const followup = vi.fn();
  const whenIdle = vi.fn(async () => undefined);
  const manager = {
    getOrCreate: vi.fn(async () => ({ agent: { followup, whenIdle }, scope: 'c2c', peerId: 'user-1' })),
  };

  const sendMarkdown = vi.fn(async () => undefined);

  return { dir, bridge, controller, manager, followup, sendMarkdown };
}

/** 构造 SDK 中间件上下文（只填 handleInbound 真正用到的部分） */
function makeCtx(sendMarkdown: ReturnType<typeof vi.fn>, kind: 'c2c' | 'group' = 'c2c'): MiddlewareContext {
  const message: Record<string, unknown> = {
    rawEventType: kind === 'group' ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE',
    kind,
    senderId: kind === 'group' ? 'member-1' : 'user-1',
    senderName: '测试用户',
    content: '你好',
    messageId: 'msg-1',
    timestamp: new Date().toISOString(),
  };
  if (kind === 'group') message.groupOpenid = 'group-1';

  return {
    message,
    state: {},
    bot: { sendMarkdown },
  } as unknown as MiddlewareContext;
}

describe('handleInbound — 已绑定宿主会话', () => {
  it('把消息投进绑定的会话，不创建插件私有 agent', async () => {
    const h = harness();
    h.bridge.bind(peerKeyOf(config, 'c2c', 'user-1'), 'session-aaa');

    await handleInbound(makeCtx(h.sendMarkdown), h.manager as unknown as SessionManager, config, logger, h.bridge);

    expect(h.controller.prompt).toHaveBeenCalledTimes(1);
    const request = h.controller.prompt.mock.calls[0]?.[0] as { sessionId: string; content: Array<{ text: string }> };
    expect(request.sessionId).toBe('session-aaa');
    expect(request.content[0]?.text).toContain('你好');

    expect(h.manager.getOrCreate).not.toHaveBeenCalled();
    expect(h.followup).not.toHaveBeenCalled();
    // 投递不是「回复」，用户侧不该先收到任何东西
    expect(h.sendMarkdown).not.toHaveBeenCalled();

    rmSync(h.dir, { recursive: true, force: true });
  });

  it('群聊按 groupOpenid 查找绑定', async () => {
    const h = harness();
    h.bridge.bind(peerKeyOf(config, 'group', 'group-1'), 'session-group');

    await handleInbound(makeCtx(h.sendMarkdown, 'group'), h.manager as unknown as SessionManager, config, logger, h.bridge);

    const request = h.controller.prompt.mock.calls[0]?.[0] as { sessionId: string };
    expect(request.sessionId).toBe('session-group');
    expect(h.manager.getOrCreate).not.toHaveBeenCalled();

    rmSync(h.dir, { recursive: true, force: true });
  });

  it('投递失败时回一句可读的错误，不把异常抛给中间件链', async () => {
    const h = harness();
    h.bridge.bind(peerKeyOf(config, 'c2c', 'user-1'), 'session-aaa');
    h.controller.prompt.mockRejectedValueOnce(new Error('session not found'));

    await expect(
      handleInbound(makeCtx(h.sendMarkdown), h.manager as unknown as SessionManager, config, logger, h.bridge),
    ).resolves.toBeUndefined();

    expect(h.sendMarkdown).toHaveBeenCalledTimes(1);
    const [, text] = h.sendMarkdown.mock.calls[0] as [unknown, string];
    expect(text).toContain('投递到绑定会话失败');
    expect(text).toContain('session not found');

    rmSync(h.dir, { recursive: true, force: true });
  });
});

describe('handleInbound — 未绑定会话', () => {
  it('没有绑定时走原来的 per-peer agent 路径', async () => {
    const h = harness();

    await handleInbound(makeCtx(h.sendMarkdown), h.manager as unknown as SessionManager, config, logger, h.bridge);

    expect(h.manager.getOrCreate).toHaveBeenCalledTimes(1);
    expect(h.followup).toHaveBeenCalledTimes(1);
    expect(h.controller.prompt).not.toHaveBeenCalled();

    rmSync(h.dir, { recursive: true, force: true });
  });

  it('不传 bridge 时（只装 dsh-base 的 profile）行为与旧版一致', async () => {
    const h = harness();

    await handleInbound(makeCtx(h.sendMarkdown), h.manager as unknown as SessionManager, config, logger);

    expect(h.manager.getOrCreate).toHaveBeenCalledTimes(1);
    expect(h.followup).toHaveBeenCalledTimes(1);

    rmSync(h.dir, { recursive: true, force: true });
  });

  it('bridge 不可用（无 sessionController）时即使有绑定也走旧路径', async () => {
    const h = harness(false);
    h.bridge.bind(peerKeyOf(config, 'c2c', 'user-1'), 'session-aaa');

    await handleInbound(makeCtx(h.sendMarkdown), h.manager as unknown as SessionManager, config, logger, h.bridge);

    expect(h.manager.getOrCreate).toHaveBeenCalledTimes(1);
    expect(h.controller.prompt).not.toHaveBeenCalled();

    rmSync(h.dir, { recursive: true, force: true });
  });

  it('空内容消息直接丢弃，两个分支都不触发', async () => {
    const h = harness();
    const ctx = makeCtx(h.sendMarkdown);
    (ctx.message as unknown as Record<string, unknown>).content = '   ';

    await handleInbound(ctx, h.manager as unknown as SessionManager, config, logger, h.bridge);

    expect(h.manager.getOrCreate).not.toHaveBeenCalled();
    expect(h.controller.prompt).not.toHaveBeenCalled();

    rmSync(h.dir, { recursive: true, force: true });
  });
});
