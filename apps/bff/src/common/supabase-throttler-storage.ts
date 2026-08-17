import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { RuntimeStateService } from './runtime-state.service';

/**
 * Cross-instance HTTP throttling backed by Supabase PostgreSQL.
 *
 * The application currently uses equal TTL and block windows, which lets the
 * same atomic fixed-window counter represent both states without a local cache.
 */
export class SupabaseThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly runtimeState: RuntimeStateService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): ReturnType<ThrottlerStorage['increment']> {
    if (blockDuration !== ttl) {
      throw new Error('Supabase throttler requires blockDuration to equal ttl');
    }

    const result = await this.runtimeState.takeFixedWindow(
      `http-rate:${throttlerName}:${key}`,
      limit,
      ttl,
    );
    const timeToExpire = Math.max(1, Math.ceil(result.timeToExpireMs / 1_000));
    return {
      totalHits: result.count,
      timeToExpire,
      isBlocked: !result.allowed,
      timeToBlockExpire: result.allowed ? 0 : Math.max(1, Math.ceil(result.retryAfterMs / 1_000)),
    };
  }
}

export function skipReadOnlyThrottle(context: ExecutionContext): boolean {
  const request = context.switchToHttp().getRequest<{ method?: string }>();
  return ['GET', 'HEAD', 'OPTIONS'].includes(request.method?.toUpperCase() ?? '');
}
