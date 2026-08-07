import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RuntimeStateService } from '../../common/runtime-state.service';

/**
 * 三级缓存中的 L1（精确缓存）：Supabase PostgreSQL 优先，失败时降级到内存。
 * L2（语义缓存，Milvus）将作为单独 Service 接入。
 */
@Injectable()
export class PromptCacheService {
  private readonly logger = new Logger(PromptCacheService.name);
  private readonly memoryFallback = new Map<string, { value: unknown; expireAt: number }>();

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
    return this.memoryGet<T>(key);
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const payload = JSON.stringify(value);
    try {
      await this.runtimeState.store(key, payload, ttlSeconds * 1_000);
      return;
    } catch (err) {
      this.logger.warn(`Runtime state write failed (${key}): ${(err as Error).message}`);
    }
    this.memorySet(key, value, ttlSeconds);
  }

  private memoryGet<T>(key: string): T | null {
    const entry = this.memoryFallback.get(key);
    if (!entry) return null;
    if (entry.expireAt < Date.now()) {
      this.memoryFallback.delete(key);
      return null;
    }
    return entry.value as T;
  }

  private memorySet<T>(key: string, value: T, ttlSeconds: number): void {
    this.memoryFallback.set(key, { value, expireAt: Date.now() + ttlSeconds * 1000 });
  }
}
