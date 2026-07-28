import { ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { REDIS_CLIENT } from '../../common/redis.module';

const PLATFORM_PRODUCT_LOCK_TTL_MS = 60_000;

@Injectable()
export class PlatformProductLockService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async acquire(publishedProductId: bigint): Promise<string> {
    const token = randomUUID();
    let stored: unknown;
    try {
      stored = await this.redis.set(
        this.key(publishedProductId),
        token,
        'PX',
        PLATFORM_PRODUCT_LOCK_TTL_MS,
        'NX',
      );
    } catch {
      throw new ServiceUnavailableException('商品平台变更依赖 Redis，不可用时拒绝执行');
    }
    if (stored !== 'OK') {
      throw new ConflictException('商品正在执行其他平台变更，请稍后重试');
    }
    return token;
  }

  async renew(publishedProductId: bigint, token: string): Promise<void> {
    let renewed: unknown;
    try {
      renewed = await this.redis.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end',
        1,
        this.key(publishedProductId),
        token,
        String(PLATFORM_PRODUCT_LOCK_TTL_MS),
      );
    } catch {
      throw new ServiceUnavailableException('商品平台变更依赖 Redis，不可用时拒绝执行');
    }
    if (renewed !== 1) {
      throw new ConflictException('商品平台变更执行权已失效，请刷新后重试');
    }
  }

  async release(publishedProductId: bigint, token: string): Promise<void> {
    try {
      await this.redis.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
        1,
        this.key(publishedProductId),
        token,
      );
    } catch {
      // TTL guarantees eventual recovery; release failure must not overwrite the operation result.
    }
  }

  private key(publishedProductId: bigint): string {
    return `platform-product:mutation:${publishedProductId}`;
  }
}
