import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RuntimeStateService } from '../../common/runtime-state.service';

/**
 * L1 精确缓存只使用 Supabase PostgreSQL。不可用时按 cache miss 处理，
 * 不在 BFF 进程内保留第二份状态。L2 语义缓存尚未接入。
 */
@Injectable()
export class PromptCacheService {
  private readonly logger = new Logger(PromptCacheService.name);

  constructor(private readonly runtimeState: RuntimeStateService) {}

  buildKey(namespace: string, payload: unknown): string {
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24);
    return `ai:${namespace}:${hash}`;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.runtimeState.read<string>(key);
      if (raw) return JSON.parse(raw) as T;
      return null;
    } catch (err) {
      this.logger.warn(`Runtime state read failed (${key}): ${(err as Error).message}`);
    }
    return null;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const payload = JSON.stringify(value);
    try {
      await this.runtimeState.store(key, payload, ttlSeconds * 1_000);
      return;
    } catch (err) {
      this.logger.warn(`Runtime state write failed (${key}): ${(err as Error).message}`);
    }
  }
}
