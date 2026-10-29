/**
 * 凭据预检
 *
 * 平台侧轮换 AppSecret 后，profile 里存的凭据会「看起来正常、实际连不上」：
 * 网关启动只会在 logger 里报一句 invalid appid or secret，桌面宿主里根本看不见，
 * 用户看到的只是「机器人不理我」。
 *
 * 这里在加载网关闭之前先问一次平台：只有明确判定凭据失效（100016）才转入
 * 扫码绑定；网络故障等「说不准」的情况一律不猜，继续按已绑定启动。
 */
import type { Logger } from '../types.ts';

export type CredentialProbeResult = 'ok' | 'invalid' | 'unknown';

/** 官方 access_token 端点（与 @tencent-connect/qqbot-nodejs 使用的同一个） */
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

/** 凭据失效时平台返回的业务码 */
const INVALID_CREDENTIALS_CODE = 100016;

/**
 * 用 appId/appSecret 换一次 access_token，判断这组凭据还有效没。
 *
 * 返回：
 * - `ok`       兑换成功
 * - `invalid`  平台明确说凭据无效（100016）
 * - `unknown`  网络异常、超时、响应不可解析、其它业务错误——不做判断
 */
export async function probeCredentials(
  appId: string,
  appSecret: string,
  logger: Logger,
  timeoutMs = 8000,
): Promise<CredentialProbeResult> {
  if (appId === '' || appSecret === '') return 'invalid';

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: appSecret }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    logger.warn(`凭据预检失败（按已绑定继续）: ${err instanceof Error ? err.message : String(err)}`);
    return 'unknown';
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    logger.warn(`凭据预检响应不可解析（按已绑定继续）: ${err instanceof Error ? err.message : String(err)}`);
    return 'unknown';
  }

  if (typeof payload !== 'object' || payload === null) return 'unknown';
  const record = payload as Record<string, unknown>;

  if (typeof record['access_token'] === 'string' && record['access_token'] !== '') return 'ok';
  if (record['code'] === INVALID_CREDENTIALS_CODE) return 'invalid';

  logger.warn(`凭据预检返回未知结果（按已绑定继续）: ${JSON.stringify(record).slice(0, 200)}`);
  return 'unknown';
}
