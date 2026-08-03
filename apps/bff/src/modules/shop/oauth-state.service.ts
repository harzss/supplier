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
const RESULT_TOKEN_PATTERN = STATE_PATTERN;

export interface OAuthStatePayload {
  userId: string;
  platform: OAuthPlatform;
  callbackUri: string;
  returnTo: string;
  expiresAt: number;
}

export type OAuthResultData =
  | {
      platform: OAuthPlatform;
      result: 'success';
      shopId: string;
      shopName: string | null;
    }
  | {
      platform: OAuthPlatform;
      result: 'error';
      message: string;
    };

export type OAuthResultPayload = OAuthResultData & {
  userId: string;
  expiresAt: number;
};

@Injectable()
export class OAuthStateService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly oauthConfig: OAuthConfigService,
  ) {}

  async issue(
    userId: bigint,
    platform: OAuthPlatform,
    callbackUri: string,
    returnTo?: string,
  ): Promise<string> {
    const normalizedCallback = this.oauthConfig.assertAllowedCallback(callbackUri);
    const normalizedReturnTo = this.oauthConfig.normalizeReturnTo(returnTo);
    const ttlSeconds = this.oauthConfig.getStateTtlSeconds();
    const state = randomBytes(32).toString('base64url');
    const payload: OAuthStatePayload = {
      userId: userId.toString(),
      platform,
      callbackUri: normalizedCallback,
      returnTo: normalizedReturnTo,
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

  async issueResult(userId: bigint, result: OAuthResultData): Promise<string> {
    const ttlSeconds = this.oauthConfig.getStateTtlSeconds();
    const token = randomBytes(32).toString('base64url');
    const payload: OAuthResultPayload = {
      userId: userId.toString(),
      ...this.normalizeResultData(result),
      expiresAt: Date.now() + ttlSeconds * 1000,
    };

    try {
      const stored = await this.redis.set(
        this.resultKey(token, userId),
        JSON.stringify(payload),
        'EX',
        ttlSeconds,
        'NX',
      );
      if (stored !== 'OK') throw new Error('result token collision');
    } catch {
      throw new ServiceUnavailableException('OAuth result store is unavailable');
    }
    return token;
  }

  async consumeResult(token: string, currentUserId: bigint): Promise<OAuthResultPayload> {
    if (!RESULT_TOKEN_PATTERN.test(token)) {
      throw new BadRequestException('OAuth result is invalid or expired');
    }

    let raw: string | null;
    try {
      raw = await this.redis.getdel(this.resultKey(token, currentUserId));
    } catch {
      throw new ServiceUnavailableException('OAuth result store is unavailable');
    }
    if (!raw) throw new BadRequestException('OAuth result is invalid or expired');

    const payload = this.parseResult(raw);
    if (payload.userId !== currentUserId.toString() || payload.expiresAt <= Date.now()) {
      throw new BadRequestException('OAuth result is invalid or expired');
    }
    return payload;
  }

  private key(state: string): string {
    const digest = createHash('sha256').update(state).digest('hex');
    return `oauth:state:${digest}`;
  }

  private resultKey(token: string, userId: bigint): string {
    const digest = createHash('sha256').update(token).digest('hex');
    return `oauth:result:${userId.toString()}:${digest}`;
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
      if (value.returnTo !== undefined && typeof value.returnTo !== 'string') {
        throw new Error('invalid payload');
      }
      return {
        ...(value as OAuthStatePayload),
        returnTo: this.oauthConfig.normalizeReturnTo(value.returnTo),
      };
    } catch {
      throw new BadRequestException('OAuth state is invalid or expired');
    }
  }

  private parseResult(raw: string): OAuthResultPayload {
    try {
      const value = JSON.parse(raw) as Partial<OAuthResultPayload>;
      if (
        typeof value.userId !== 'string' ||
        !/^\d+$/.test(value.userId) ||
        typeof value.expiresAt !== 'number' ||
        !Number.isFinite(value.expiresAt)
      ) {
        throw new Error('invalid payload');
      }
      return {
        userId: value.userId,
        ...this.normalizeResultData(value),
        expiresAt: value.expiresAt,
      };
    } catch {
      throw new BadRequestException('OAuth result is invalid or expired');
    }
  }

  private normalizeResultData(value: Partial<OAuthResultPayload>): OAuthResultData {
    if (!value.platform || !OAUTH_PLATFORMS_SET.has(value.platform)) {
      throw new BadRequestException('OAuth result payload is invalid');
    }
    if (value.result === 'success') {
      if (
        typeof value.shopId !== 'string' ||
        !/^[1-9]\d{0,18}$/.test(value.shopId) ||
        (value.shopName !== null &&
          (typeof value.shopName !== 'string' || value.shopName.length > 256))
      ) {
        throw new BadRequestException('OAuth result payload is invalid');
      }
      return {
        platform: value.platform,
        result: 'success',
        shopId: value.shopId,
        shopName: value.shopName,
      };
    }
    if (
      value.result !== 'error' ||
      typeof value.message !== 'string' ||
      value.message.length < 1 ||
      value.message.length > 120
    ) {
      throw new BadRequestException('OAuth result payload is invalid');
    }
    return { platform: value.platform, result: 'error', message: value.message };
  }
}

const OAUTH_PLATFORMS_SET = new Set<OAuthPlatform>(OAUTH_PLATFORMS);
