/**
 * 网关组装 — 创建 bot、编排中间件、注册事件、出站、生命周期
 *
 * 将 QQ 消息平台作为 dsh 前端协议驱动：入站消息 → handleInbound → dsh agent，
 * dsh session/event → createOutboundHandler → QQ 出站。
 */
import type { Context } from '@deepseek-ai/cordis';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import type { GatewayDisconnect, InteractionEvent, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { SessionManager, type DshAgentRegistry } from '../session/index.ts';
import { handleInbound, createOutboundHandler } from '../transport/index.ts';
import { parseStreamFrame } from '../transport/events.ts';
import { ReplyLimiter } from '../transport/reply-limiter.ts';
import { cacheMsgId, cacheEventId } from '../transport/msgid-cache.ts';
import { resolveReplyTarget, sendResolvedMarkdown } from '../transport/reply-target.ts';
import type { ToolsRegistryLike } from '../transport/tool-presenter.ts';
import type { QQBotSender } from '../transport/outbound-buffer.ts';
import { QuestionChannel } from '../features/question-channel.ts';
import { ApprovalChannel, type ApprovalChannelContext } from '../features/approval-channel.ts';
import { decodeButtonData } from '../features/button-utils.ts';
import { buildUserAgent } from '../shared/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import { setupMiddlewares } from './middleware-setup.ts';
import { startMediaCleanup } from '../media/media-cleaner.ts';
import { ensureVisionInputModal, registerDescribeImageTool } from '../media/vision-tool.ts';
import { registerSendFileTool, type MediaSenderLike } from '../media/send-file-tool.ts';
import { DeliverablesDeliverer } from '../transport/deliverables.ts';
import { BindingStore, SessionBridge, parsePeerKey, type SessionControllerLike } from '../bridge/index.ts';
import { chunkMarkdownText } from '../transport/chunker.ts';

/**
 * 已绑定会话的出站轮询间隔。
 *
 * 500ms 是「够快」与「别空转」的折中：snapshotEvents 是内存数组，几个会话的
 * 轮询成本远低于一次网络请求；再快也不会有收益，慢过 1s 会有明显延迟感。
 */
const RELAY_INTERVAL_MS = 500;

/**
 * interaction 统一分发器：按 button_data 的顶层 `t` 判别字段，路由到对应
 * channel（question / approval）。QQ 只有一个 interaction 入口，集中路由
 * 避免多通道各自 try 导致误判。
 */
function dispatchInteraction(event: InteractionEvent, manager: SessionManager): boolean {
  const raw = event.data?.resolved?.button_data;
  if (!raw) return false;
  const button = decodeButtonData(raw);
  if (!button) return false;
  if (button.t === 'question') return manager.questionChannel?.handleInteraction(event) ?? false;
  if (button.t === 'approval') return manager.approvalChannel?.handleInteraction(event) ?? false;
  return false;
}

export async function bootstrapGateway(
  ctx: Context,
  agents: DshAgentRegistry,
  config: ImQQBotConfig,
  logger: Logger,
): Promise<void> {
  const manager = new SessionManager(ctx, agents, config, logger);

  // ── 会话桥：把 QQ peer 绑到宿主真实会话上（/list /use /new ...） ──
  // sessionController 由 dsh-web-app 组合提供；只装 dsh-base 的 profile 里没有，
  // 此时 bridge.available=false，命令回一句明确原因而不是静默失败。
  const bindingStore = new BindingStore({ debugLog: (message) => logger.debug('bridge: ' + message) });
  const bridge = new SessionBridge({
    ctx: ctx as unknown as { get(name: string): unknown },
    logger,
    store: bindingStore,
    send: async (peerKey, text) => {
      const parsed = parsePeerKey(peerKey);
      if (parsed === undefined) return;
      const target: ReplyTarget = { scope: parsed.scope, targetId: parsed.peerId };
      for (const chunk of chunkMarkdownText(text, config.textChunkLimit)) {
        await sender.sendMarkdown(target, chunk);
      }
    },
  });
  // ── 绑定能力按需注入 ──
  // session-controller 属于 dsh-web-app 组合，且可能晚于本插件注册：apply() 那一刻
  // ctx.get('sessionController') 常常还是 undefined（实测 desktop 组合即如此）。
  // 用 inject 等它出现，服务替换/卸载时回调重跑，状态在终端自曝一次。
  (ctx as unknown as {
    inject(deps: readonly string[], callback: (scoped: Context) => void): unknown;
  }).inject(['sessionController'], (scoped) => {
    const controller = (scoped as unknown as { sessionController?: SessionControllerLike }).sessionController;
    bridge.setController(controller);
    const state = controller === undefined
      ? '会话绑定不可用（sessionController 未就绪）'
      : '会话绑定已启用（sessionController 可用）';
    logger.info(`im-qqbot: ${state}`);
    console.log(`[im-qqbot] ${state}`);
    (scoped as unknown as { effect(fn: () => () => void, name?: string): void }).effect(() => {
      return () => bridge.setController(undefined);
    }, 'im-qqbot.bridge-controller');
  });

  // ── 初始化 QQ Bot SDK ──
  const userAgent = buildUserAgent();
  const bot = new QQBot({
    appId: config.appId,
    appSecret: config.appSecret,
    transport: 'websocket',
    baseUrl: process.env.QQBOT_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
    tokenBaseUrl: process.env.QQBOT_TOKEN_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
    userAgent,
    logger,
  } as ConstructorParameters<typeof QQBot>[0]);
  logger.info(`QQBot SDK initialized (UA: ${userAgent})`);

  // ── 中间件链 ──
  setupMiddlewares(bot, config, manager, logger, bridge);

  // ── 入站：经过中间件链后的消息交给 dsh agent ──
  bot.on('message', async (mCtx: MiddlewareContext) => {
    const msg = mCtx.message;
    // 记录最近 msgId，供无上下文的出站发送（文件发送显式 target、主动推送等）获取被动回复目标
    cacheMsgId(mCtx.replyTarget.scope, mCtx.replyTarget.targetId, mCtx.replyTarget.msgId);
    if (config.debug) {
      logger.debug(`← message (post-middleware): ${JSON.stringify(msg, null, 2).slice(0, 500)}`);
    }
    await handleInbound(mCtx, manager, config, logger, bridge);
  });

  // ── 出站：dsh session/event → QQ 消息 ──
  // 获取 tools 服务（工具结果结构化展示），可选
  let toolsRegistry: ToolsRegistryLike | undefined;
  try {
    toolsRegistry = ctx.get('tools') as ToolsRegistryLike | undefined;
  } catch {
    toolsRegistry = undefined;
  }

  // 发送适配器：将 QQBot 实例适配为 QQBotSender（openStream 参数形态不同）。
  // sendMarkdown 统一做被动回复限额管控：同一 msgId 超限/过期时降级主动推送。
  const replyLimiter = new ReplyLimiter({ limit: 4 });
  const sender: QQBotSender = {
    sendMarkdown: (target, content, opts) => sendResolvedMarkdown(bot, resolveReplyTarget(target, replyLimiter, true), content, opts),
    openStream: (target) => bot.openStream({
      target: {
        scope: target.scope,
        targetId: target.targetId,
        msgId: target.msgId as string,
      },
    }),
  };

  // ── 附件发送适配器（qqbot_send_file 工具与交付物投递共用） ──
  // 包装 bot：让文件发送也走 msgId 兜底 + 被动回复限额管控。
  // 注意：SDK 文件发送暂不支持 event_id，故 allowEvent=false，跳过 event 候选。
  const mediaSender: MediaSenderLike = {
    sendImage: (target, source) => bot.sendImage(resolveReplyTarget(target, replyLimiter, false), source),
    sendVideo: (target, source) => bot.sendVideo(resolveReplyTarget(target, replyLimiter, false), source),
    sendVoice: (target, source) => bot.sendVoice(resolveReplyTarget(target, replyLimiter, false), source),
    sendFile: (target, source, opts) => bot.sendFile(resolveReplyTarget(target, replyLimiter, false), source, opts),
  };

  // 交付物投递：present 声明的文件在轮末发送到当前会话（outbound 路由触发）
  const deliverablesDeliverer = new DeliverablesDeliverer(sender, mediaSender, config, logger);

  const outbound = createOutboundHandler(manager, sender, config, logger, toolsRegistry, deliverablesDeliverer);
  (ctx as unknown as { on(event: string, handler: (...args: unknown[]) => void): void })
    .on('session/event', outbound.routeSessionEvent as (...args: unknown[]) => void);

  // ── 会话桥出站：宿主会话的 assistant 输出转发到订阅它的 QQ peer ──
  (ctx as unknown as { on(event: string, handler: (...args: unknown[]) => void): void })
    .on('session/event', ((session: { header?: { id?: string } }, event: { type?: string; data?: Record<string, unknown> }) => {
      const sessionId = session?.header?.id;
      if (typeof sessionId !== 'string') return;
      // 插件私有会话走 OutboundRouter（带流式与工具卡片），这里跳过避免重复发送
      if (manager.findBySessionId(sessionId) !== undefined) return;
      bridge.onSessionEvent(sessionId, event?.type ?? '', event?.data ?? {});
    }) as (...args: unknown[]) => void);

  // ── 会话桥出站（轮询兜底） ──
  // 上面那个 ctx.on 只对「同 fiber 的插件私有会话」有效：宿主会话在自己的
  // ctx 作用域派发 session/event，兄弟作用域收不到。所以已绑定会话额外用
  // snapshotEvents 轮询补发——这正是 /use 绑到宿主会话后回复不回 QQ 的原因。
  const relayTimer = setInterval(() => bridge.pollBoundSessions(), RELAY_INTERVAL_MS);
  (relayTimer as unknown as { unref?: () => void }).unref?.();
  (ctx as unknown as { effect(fn: () => (() => void) | void, name?: string): void })
    .effect(() => () => {
      clearInterval(relayTimer);
    }, 'im-qqbot.bridge-relay');

  // ── 出站流式：agent/assistant-stream → 流式帧路由 ──
  // 实时流式走瞬态 agent/assistant-stream（chunk 不进 session log）。
  // 该事件按 agent 作用域派发，根作用域监听器不带 global 会被过滤（同
  // approval/request），帧到达后自行按 agent.id 路由，非 QQ 会话在 router 内忽略。
  (ctx as unknown as { on(event: string, handler: (...args: unknown[]) => void, options?: { global?: boolean }): void })
    .on('agent/assistant-stream', (payload: unknown) => {
      const parsed = parseStreamFrame(payload);
      if (parsed !== undefined) outbound.routeStreamFrame(parsed.agentId, parsed.delta);
    }, { global: true });

  // ── 问答通道（ask_user_question → QQ 文本 + 按钮） ──
  const questionChannel = new QuestionChannel(manager, sender, config, logger);
  manager.questionChannel = questionChannel;
  questionChannel.install(ctx);

  // ── 审批通道（approval/request → QQ 两按钮审批） ──
  const approvalChannel = new ApprovalChannel(manager, sender, logger);
  manager.approvalChannel = approvalChannel;
  approvalChannel.install(ctx as unknown as ApprovalChannelContext);

  // ── 按钮点击回调（interaction）：统一分发到问答/审批通道 ──
  bot.on('interaction', async (_iCtx: unknown, event: InteractionEvent) => {
    // scope/targetId 推导对齐消息事件（inbound.ts）：按 scene 判定类型，群用 group_openid，私聊用 user_openid
    const scope: ChatScope = event.scene === 'group' ? 'group' : 'c2c';
    const targetId = scope === 'group' ? (event.group_openid ?? event.user_openid) : event.user_openid;
    // 记录互动事件 id，作为后续被动回复候选（event_id）
    cacheEventId(scope, targetId, event.id);

    const matched = dispatchInteraction(event, manager);
    await bot.acknowledgeInteraction(event.id, matched ? 0 : 3).catch(() => {});
  });

  bot.on('error', (err: unknown) => {
    logger.error(`bot error: ${err instanceof Error ? err.message : String(err)}`);
  });

  // 掉线可观测：willReconnect=false 表示不会再重连（随后 bot.start() 的 Promise 会失败）。
  // disconnected 事件为 SDK 1.0.5+ 新增：旧版 handlers 表缺该键，bot.on 会抛
  // TypeError（profiles 增量安装可能残留旧版 SDK）——降级为跳过监听而非崩溃
  try {
    bot.on('disconnected', (event: GatewayDisconnect) => {
      const detail = `code=${event.code}${event.reason ? ` reason=${event.reason}` : ''}`;
      if (event.willReconnect) {
        logger.warn(`Bot disconnected (${detail}), reconnecting...`);
      } else {
        logger.error(`Bot disconnected permanently (${detail}), giving up`);
      }
    });
  } catch (err) {
    logger.warn(`qqbot-nodejs SDK 不支持 disconnected 事件（请升级 @tencent-connect/qqbot-nodejs 至 1.0.5+）: ${err instanceof Error ? err.message : String(err)}`);
  }

  bot.on('ready', () => {
    console.log(`[im-qqbot] Bot ready! appId=${config.appId}`);
  });

  // ── 富媒体过期清理 ──
  if (config.media.enabled) {
    startMediaCleanup(ctx, config.media.ttlHours, logger);
  }

  // ── 视觉工具注册（qqbot_describe_image，复用 dsh llm + attachments） ──
  ensureVisionInputModal(config.vision, logger);
  registerDescribeImageTool(ctx, config.vision, logger);

  // ── 附件发送工具注册（qqbot_send_file，发送器见上方 mediaSender） ──
  registerSendFileTool(ctx, mediaSender, manager, config, logger);

  // ── 生命周期 ──
  (ctx as unknown as { effect(fn: () => (() => Promise<void>) | void, name?: string): void })
    .effect(() => {
      logger.info(`Starting bot (appId=${config.appId})`);
      bot.start().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`Bot start failed: ${message}`);
        // 连接失败必须在终端可见：静默失败会被误读成「机器人只是不响应」，
        // 而去查网络、查群权限，真正的原因却在凭据上。
        console.error(`[im-qqbot] 机器人连接失败：${message}`);

        if (!isCredentialFailure(message)) return;
        // 这里只负责把话说清楚：真正的自救在 apply() —— 下次启动会用
        // probeCredentials 判定失效并直接转入扫码流程（本轮已过期，无法就地重启）
        console.error('[im-qqbot] 凭据无效（invalid appid or secret）。');
        console.error('[im-qqbot] 修法二选一：① QQ 开放平台 → 开发设置 重置 AppSecret 后写回 profile 的 cordis.patch.yml；');
        console.error('[im-qqbot]             ② 删掉 im-qqbot 下的 appId/appSecret 两行（或 ~/.dsh/.env 里的 QQBOT_*），重启后按提示重新扫码。');
      });

      return async () => {
        logger.info('Shutting down');
        await manager.disposeAll();
        bot.stop();
      };
    }, 'im-qqbot.lifecycle');
}
/**
 * 判断一次启动失败是否属于「凭据失效」。
 *
 * SDK 的报错形如 `Failed to get access_token: {"code":100016,"message":"invalid appid or secret"}`，
 * 平台也偶发改「appid or secret is invalid」之类的措辞，故按关键字匹配而不是精确比对。
 */
function isCredentialFailure(message: string): boolean {
  return /invalid appid or secret|appid or secret is invalid|100016|get access_token/i.test(message);
}