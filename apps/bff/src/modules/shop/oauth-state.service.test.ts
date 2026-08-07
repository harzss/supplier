import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { RuntimeStateService } from '../../common/runtime-state.service';
import { OAuthConfigService } from './oauth-config.service';
import { OAuthStateService, type OAuthResultData } from './oauth-state.service';

const CALLBACK = 'https://supplier.example.com/api/shops/oauth/douyin/callback';
const ALIBABA_1688_CALLBACK = 'https://supplier.example.com/api/shops/oauth/alibaba_1688/callback';
const RETURN_TO = '/products?id=offer%2F1001#publish';
const SUCCESS_RESULT: OAuthResultData = {
  platform: 'douyin',
  result: 'success',
  shopId: '9',
  shopName: '测试店铺',
};

class FakeRuntimeState {
  readonly values = new Map<string, string>();
  readonly storeCalls: Array<{ key: string; ttlMs: number }> = [];
  fail = false;

  async storeIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    if (this.fail) throw new Error('runtime state down');
    if (this.values.has(key)) return false;
    this.storeCalls.push({ key, ttlMs });
    this.values.set(key, value);
    return true;
  }

  async consume<T>(key: string): Promise<T | null> {
    if (this.fail) throw new Error('runtime state down');
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value as T | null;
  }
}

function makeService(runtimeState = new FakeRuntimeState()) {
  const values: Record<string, string> = {
    OAUTH_CALLBACK_ALLOWLIST: `${CALLBACK},${ALIBABA_1688_CALLBACK}`,
    OAUTH_STATE_TTL_SECONDS: '300',
  };
  const config = { get: (key: string) => values[key] } as unknown as ConfigService;
  const oauthConfig = new OAuthConfigService(config);
  return {
    service: new OAuthStateService(runtimeState as unknown as RuntimeStateService, oauthConfig),
    runtimeState,
  };
}

describe('OAuthStateService', () => {
  it('issues a random state bound to user, platform, callback and safe return target', async () => {
    const { service } = makeService();
    const state = await service.issue(42n, 'douyin', CALLBACK, RETURN_TO);
    const payload = await service.consume(state, 'douyin', CALLBACK);

    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(payload.userId).toBe('42');
    expect(payload.platform).toBe('douyin');
    expect(payload.callbackUri).toBe(CALLBACK);
    expect(payload.returnTo).toBe(RETURN_TO);
  });

  it('prevents replay by consuming state atomically once', async () => {
    const { service } = makeService();
    const state = await service.issue(1n, 'douyin', CALLBACK);
    await service.consume(state, 'douyin', CALLBACK);
    await expect(service.consume(state, 'douyin', CALLBACK)).rejects.toThrow(
      'OAuth state is invalid or expired',
    );
  });

  it('binds 1688 buyer authorization state to its own callback', async () => {
    const { service } = makeService();
    const state = await service.issue(42n, 'alibaba_1688', ALIBABA_1688_CALLBACK);

    const payload = await service.consume(state, 'alibaba_1688', ALIBABA_1688_CALLBACK);

    expect(payload.platform).toBe('alibaba_1688');
    expect(payload.callbackUri).toBe(ALIBABA_1688_CALLBACK);
  });

  it('rejects a state consumed through another platform or callback', async () => {
    const { service } = makeService();
    const wrongPlatformState = await service.issue(42n, 'douyin', CALLBACK, RETURN_TO);

    await expect(
      service.consume(wrongPlatformState, 'alibaba_1688', ALIBABA_1688_CALLBACK),
    ).rejects.toThrow('OAuth state is invalid or expired');

    const wrongCallbackState = await service.issue(42n, 'douyin', CALLBACK, RETURN_TO);
    await expect(
      service.consume(wrongCallbackState, 'douyin', ALIBABA_1688_CALLBACK),
    ).rejects.toThrow('OAuth state is invalid or expired');
  });

  it('rejects an expired stored state even when the state store still returns it', async () => {
    const { service, runtimeState } = makeService();
    const state = await service.issue(42n, 'douyin', CALLBACK, RETURN_TO);
    const [key, raw] = [...runtimeState.values.entries()][0] ?? [];
    expect(key).toBeDefined();
    expect(raw).toBeDefined();
    runtimeState.values.set(
      key!,
      JSON.stringify({ ...JSON.parse(raw!), expiresAt: Date.now() - 1 }),
    );

    await expect(service.consume(state, 'douyin', CALLBACK)).rejects.toThrow(
      'OAuth state is invalid or expired',
    );
  });

  it('rejects malformed state before reading storage', async () => {
    const { service } = makeService();
    await expect(service.consume('not-valid', 'douyin', CALLBACK)).rejects.toThrow(
      'OAuth state is invalid or expired',
    );
  });

  it('rejects callbacks outside the allowlist', async () => {
    const { service } = makeService();
    await expect(service.issue(1n, 'douyin', 'https://evil.example.com/callback')).rejects.toThrow(
      'OAuth callback URL is not allowed',
    );
  });

  it('rejects a return target that is unsafe when the state is consumed', async () => {
    const { service, runtimeState } = makeService();
    const state = await service.issue(1n, 'douyin', CALLBACK, RETURN_TO);
    const [key, raw] = [...runtimeState.values.entries()][0] ?? [];
    expect(key).toBeDefined();
    expect(raw).toBeDefined();
    runtimeState.values.set(
      key!,
      JSON.stringify({ ...JSON.parse(raw!), returnTo: '//evil.example.com' }),
    );

    await expect(service.consume(state, 'douyin', CALLBACK)).rejects.toThrow(
      'OAuth state is invalid or expired',
    );
  });

  it('falls back safely for a state issued before return targets were stored', async () => {
    const { service, runtimeState } = makeService();
    const state = await service.issue(1n, 'douyin', CALLBACK, RETURN_TO);
    const [key, raw] = [...runtimeState.values.entries()][0] ?? [];
    expect(key).toBeDefined();
    expect(raw).toBeDefined();
    const legacyPayload = JSON.parse(raw!);
    delete legacyPayload.returnTo;
    runtimeState.values.set(key!, JSON.stringify(legacyPayload));

    const payload = await service.consume(state, 'douyin', CALLBACK);

    expect(payload.returnTo).toBe('/settings');
  });

  it('rejects a stored return target with a non-string type', async () => {
    const { service, runtimeState } = makeService();
    const state = await service.issue(1n, 'douyin', CALLBACK, RETURN_TO);
    const [key, raw] = [...runtimeState.values.entries()][0] ?? [];
    expect(key).toBeDefined();
    expect(raw).toBeDefined();
    runtimeState.values.set(key!, JSON.stringify({ ...JSON.parse(raw!), returnTo: 42 }));

    await expect(service.consume(state, 'douyin', CALLBACK)).rejects.toThrow(
      'OAuth state is invalid or expired',
    );
  });

  it('fails closed when runtime state is unavailable', async () => {
    const { service, runtimeState } = makeService();
    runtimeState.fail = true;
    await expect(service.issue(1n, 'douyin', CALLBACK)).rejects.toThrow(
      'OAuth state store is unavailable',
    );
  });

  it('issues a separate 256-bit one-time result token bound to the user and success result', async () => {
    const { service, runtimeState } = makeService();
    const state = await service.issue(42n, 'douyin', CALLBACK, RETURN_TO);
    const token = await service.issueResult(42n, SUCCESS_RESULT);
    const resultSet = runtimeState.storeCalls.find((call) => call.key.startsWith('oauth:result:'));
    expect(runtimeState.storeCalls.some((call) => call.key.startsWith('oauth:state:'))).toBe(true);
    expect(resultSet?.ttlMs).toBe(300_000);
    const payload = await service.consumeResult(token, 42n);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toBe(state);
    expect(payload).toMatchObject({ userId: '42', ...SUCCESS_RESULT });
    expect(payload.expiresAt).toBeGreaterThan(Date.now());
    expect(payload.expiresAt).toBeLessThanOrEqual(Date.now() + 300_000);
  });

  it('stores a bounded safe error result without shop fields', async () => {
    const { service } = makeService();
    const token = await service.issueResult(42n, {
      platform: 'douyin',
      result: 'error',
      message: '授权失败，请重试',
    });

    await expect(service.consumeResult(token, 42n)).resolves.toEqual(
      expect.objectContaining({
        userId: '42',
        platform: 'douyin',
        result: 'error',
        message: '授权失败，请重试',
      }),
    );
  });

  it('rejects forged, cross-user and replayed result tokens', async () => {
    const { service } = makeService();
    await expect(service.consumeResult('b'.repeat(43), 42n)).rejects.toThrow(
      'OAuth result is invalid or expired',
    );

    const crossUserToken = await service.issueResult(42n, SUCCESS_RESULT);
    await expect(service.consumeResult(crossUserToken, 7n)).rejects.toThrow(
      'OAuth result is invalid or expired',
    );
    await expect(service.consumeResult(crossUserToken, 42n)).resolves.toEqual(
      expect.objectContaining({ userId: '42', ...SUCCESS_RESULT }),
    );

    const replayToken = await service.issueResult(42n, SUCCESS_RESULT);
    await service.consumeResult(replayToken, 42n);
    await expect(service.consumeResult(replayToken, 42n)).rejects.toThrow(
      'OAuth result is invalid or expired',
    );
  });

  it('rejects an expired stored result', async () => {
    const { service, runtimeState } = makeService();
    const token = await service.issueResult(42n, SUCCESS_RESULT);
    const [key, raw] = [...runtimeState.values.entries()].find(([entryKey]) =>
      entryKey.startsWith('oauth:result:'),
    ) ?? [undefined, undefined];
    expect(key).toBeDefined();
    expect(raw).toBeDefined();
    runtimeState.values.set(
      key!,
      JSON.stringify({ ...JSON.parse(raw!), expiresAt: Date.now() - 1 }),
    );

    await expect(service.consumeResult(token, 42n)).rejects.toThrow(
      'OAuth result is invalid or expired',
    );
  });

  it('fails closed when the result store is unavailable', async () => {
    const { service, runtimeState } = makeService();
    runtimeState.fail = true;

    await expect(service.issueResult(42n, SUCCESS_RESULT)).rejects.toThrow(
      'OAuth result store is unavailable',
    );
  });
});
