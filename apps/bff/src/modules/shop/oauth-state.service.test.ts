import type { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { describe, expect, it } from 'vitest';
import { OAuthConfigService } from './oauth-config.service';
import { OAuthStateService } from './oauth-state.service';

const CALLBACK = 'https://supplier.example.com/api/shops/oauth/douyin/callback';
const ALIBABA_1688_CALLBACK = 'https://supplier.example.com/api/shops/oauth/alibaba_1688/callback';

class FakeRedis {
  readonly values = new Map<string, string>();
  fail = false;

  async set(key: string, value: string): Promise<'OK'> {
    if (this.fail) throw new Error('redis down');
    this.values.set(key, value);
    return 'OK';
  }

  async getdel(key: string): Promise<string | null> {
    if (this.fail) throw new Error('redis down');
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }
}

function makeService(redis = new FakeRedis()) {
  const values: Record<string, string> = {
    OAUTH_CALLBACK_ALLOWLIST: `${CALLBACK},${ALIBABA_1688_CALLBACK}`,
    OAUTH_STATE_TTL_SECONDS: '300',
  };
  const config = { get: (key: string) => values[key] } as unknown as ConfigService;
  const oauthConfig = new OAuthConfigService(config);
  return { service: new OAuthStateService(redis as unknown as Redis, oauthConfig), redis };
}

describe('OAuthStateService', () => {
  it('issues a random state bound to user, platform and callback', async () => {
    const { service } = makeService();
    const state = await service.issue(42n, 'douyin', CALLBACK);
    const payload = await service.consume(state, 'douyin', CALLBACK);

    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(payload.userId).toBe('42');
    expect(payload.platform).toBe('douyin');
    expect(payload.callbackUri).toBe(CALLBACK);
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

  it('fails closed when Redis is unavailable', async () => {
    const { service, redis } = makeService();
    redis.fail = true;
    await expect(service.issue(1n, 'douyin', CALLBACK)).rejects.toThrow(
      'OAuth state store is unavailable',
    );
  });
});
