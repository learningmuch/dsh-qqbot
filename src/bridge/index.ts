/**
 * 会话桥模块入口
 *
 * 对外只暴露三样东西：绑定存储、桥本体、以及 peerKey 的编解码工具。
 */
export { BindingStore, type BindingEntry } from './binding-store.ts';
export {
  SessionBridge,
  parsePeerKey,
  peerKeyOf,
  shortId,
  type BoundSessionInfo,
  type BridgeSession,
  type HostSessionSummary,
  type ResolveResult,
  type SessionBridgeDeps,
  type SessionControllerLike,
  type SessionDigest,
} from './session-bridge.ts';
