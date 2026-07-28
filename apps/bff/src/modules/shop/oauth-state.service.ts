import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis.module';
import { OAUTH_PLATFORMS, OAuthConfigService, type OAuthPlatform } from './oauth-config.service';

const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface OAuthStatePayload {
  userId: string;
  platform: OAuthPlatform;
  callbackUri: string;
  expiresAt: number;
}

@Injectable()
export class OAuthStateService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly oauthConfig: OAuthConfigService,
  ) {}

  async issue(userId: bigint, platform: OAuthPlatform, callbackUri: string): Promise<string> {
    const normalizedCallback = this.oauthConfig.assertAllowedCallback(callbackUri);
    const ttlSeconds = this.oauthConfig.getStateTtlSeconds();
    const state = randomBytes(32).toString('base64url');
    const payload: OAuthStatePayload = {
      userId: userId.toString(),
      platform,
      callbackUri: normalizedCallback,
      expiresAt: Date.now() + ttlSeconds * 1000,
    };

    try {
      const stored = await this.redis.set(
        this.key(state),
        JSON.stringify(payload),
        'EX',
        ttlSeconds,
        'NX',
      );
      if (stored !== 'OK') throw new Error('state collision');
    } catch {
      throw new ServiceUnavailableException('OAuth state store is unavailable');
    }
    return state;
  }

  async consume(
    state: string,
    expectedPlatform: OAuthPlatform,
    expectedCallbackUri: string,
  ): Promise<OAuthStatePayload> {
    if (!STATE_PATTERN.test(state)) {
      throw new BadRequestException('OAuth state is invalid or expired');
    }

    const normalizedCallback = this.oauthConfig.assertAllowedCallback(expectedCallbackUri);
    let raw: string | null;
    try {
      raw = await this.redis.getdel(this.key(state));
    } catch {
      throw new ServiceUnavailableException('OAuth state store is unavailable');
    }
    if (!raw) throw new BadRequestException('OAuth state is invalid or expired');

    const payload = this.parse(raw);
    if (
      payload.platform !== expectedPlatform ||
      payload.callbackUri !== normalizedCallback ||
      payload.expiresAt <= Date.now()
    ) {
      throw new BadRequestException('OAuth state is invalid or expired');
    }
    return payload;
  }

  private key(state: string): string {
    const digest = createHash('sha256').update(state).digest('hex');
    return `oauth:state:${digest}`;
  }

  private parse(raw: string): OAuthStatePayload {
    try {
      const value = JSON.parse(raw) as Partial<OAuthStatePayload>;
      if (
        typeof value.userId !== 'string' ||
        !/^\d+$/.test(value.userId) ||
        !value.platform ||
        !OAUTH_PLATFORMS_SET.has(value.platform) ||
        typeof value.callbackUri !== 'string' ||
        typeof value.expiresAt !== 'number'
      ) {
        throw new Error('invalid payload');
      }
      return value as OAuthStatePayload;
    } catch {
      throw new BadRequestException('OAuth state is invalid or expired');
    }
  }
}

const OAUTH_PLATFORMS_SET = new Set<OAuthPlatform>(OAUTH_PLATFORMS);
