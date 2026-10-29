import { describe, it, expect, vi, afterEach } from 'vitest';
import { probeCredentials } from './credential-probe.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeCredentials', () => {
  it('兑换成功 → ok', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ access_token: 'token', expires_in: 7200 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await probeCredentials('app-1', 'secret-1', logger)).toBe('ok');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('getAppAccessToken');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ appId: 'app-1', clientSecret: 'secret-1' });
  });

  it('平台返回 100016 → invalid（这是唯一会触发重新扫码的信号）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 100016, message: 'invalid appid or secret' })));
    expect(await probeCredentials('app-1', 'bad', logger)).toBe('invalid');
  });

  it('网络异常 → unknown（不能因为断网就把用户踢回扫码）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await probeCredentials('app-1', 'secret-1', logger)).toBe('unknown');
  });

  it('响应不是 JSON → unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 502 })));
    expect(await probeCredentials('app-1', 'secret-1', logger)).toBe('unknown');
  });

  it('其它业务错误码 → unknown（不猜）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 12345, message: 'rate limited' })));
    expect(await probeCredentials('app-1', 'secret-1', logger)).toBe('unknown');
  });

  it('空凭据直接判定 invalid，不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await probeCredentials('', 'secret-1', logger)).toBe('invalid');
    expect(await probeCredentials('app-1', '', logger)).toBe('invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
