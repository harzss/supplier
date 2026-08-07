import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from './prisma.module';
import { RuntimeStateService } from './runtime-state.service';

function makeService(queryResults: unknown[][] = [], executeResult = 1) {
  const prisma = {
    $queryRaw: vi.fn().mockImplementation(() => Promise.resolve(queryResults.shift() ?? [])),
    $executeRaw: vi.fn().mockResolvedValue(executeResult),
  } as unknown as PrismaService;
  return { service: new RuntimeStateService(prisma), prisma };
}

describe('RuntimeStateService', () => {
  it('stores and atomically consumes a one-time value', async () => {
    const { service } = makeService([[{ key: 'oauth:state:digest' }], [{ value: 'payload' }]]);

    await expect(service.storeIfAbsent('oauth:state:digest', 'payload', 60_000)).resolves.toBe(
      true,
    );
    await expect(service.consume<string>('oauth:state:digest')).resolves.toBe('payload');
  });

  it('does not overwrite an unexpired one-time value', async () => {
    const { service } = makeService([[]]);

    await expect(service.storeIfAbsent('oauth:state:digest', 'payload', 60_000)).resolves.toBe(
      false,
    );
  });

  it('returns only the database-issued lease token and checks ownership on renewal', async () => {
    const token = '6ca0280f-3158-4cbc-a34c-4d957f4a3e7a';
    const { service } = makeService([[{ ownerToken: token }], [{ key: 'lock:7' }], []]);

    await expect(service.acquireLease('lock:7', 60_000)).resolves.toBe(token);
    await expect(service.renewLease('lock:7', token, 60_000)).resolves.toBe(true);
    await expect(service.renewLease('lock:7', token, 60_000)).resolves.toBe(false);
  });

  it('returns a bounded fixed-window decision from the atomic counter result', async () => {
    const { service } = makeService([
      [{ count: 5, retryAfterMs: 700 }],
      [{ count: 6, retryAfterMs: 650 }],
    ]);

    await expect(service.takeFixedWindow('rate:1688', 5, 1_000)).resolves.toEqual({
      allowed: true,
      retryAfterMs: 0,
    });
    await expect(service.takeFixedWindow('rate:1688', 5, 1_000)).resolves.toEqual({
      allowed: false,
      retryAfterMs: 650,
    });
  });

  it('rejects invalid keys, TTLs, limits and database result shapes', async () => {
    const { service } = makeService([[]]);

    await expect(service.store('', 'value', 1)).rejects.toThrow('key is invalid');
    await expect(service.store('key', 'value', 0)).rejects.toThrow('TTL');
    await expect(service.takeFixedWindow('rate', 0, 1_000)).rejects.toThrow('limit');
    await expect(service.takeFixedWindow('rate', 5, 1_000)).rejects.toThrow(
      'fixed-window result is invalid',
    );
  });
});
