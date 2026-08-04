import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { ExceptionCenterService } from './exception-center.service';
import { ExceptionCenterWorker } from './exception-center.worker';

describe('ExceptionCenterWorker', () => {
  it('scans a bounded active-user batch and isolates user failures', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 1n }, { id: 2n }, { id: 3n }]);
    const refresh = vi
      .fn()
      .mockResolvedValueOnce({ errors: [] })
      .mockRejectedValueOnce(new Error('tenant database failure'))
      .mockResolvedValueOnce({ errors: [{ domain: 'order' }, { domain: 'purchase' }] });
    const worker = createWorker({
      config: {
        EXCEPTION_CENTER_SCAN_BATCH_SIZE: 3,
      },
      findMany,
      refresh,
    });

    await expect(worker.runOnce()).resolves.toEqual({
      attempted: 3,
      completed: 2,
      failed: 1,
      domainFailures: 2,
    });

    expect(findMany).toHaveBeenCalledWith({
      where: { status: 'active' },
      orderBy: { id: 'asc' },
      take: 3,
      select: { id: true },
    });
    expect(refresh.mock.calls.map(([userId]) => userId)).toEqual([1n, 2n, 3n]);
  });

  it('advances a user cursor and wraps without exceeding the configured batch', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([{ id: 4n }, { id: 8n }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 4n }, { id: 8n }]);
    const refresh = vi.fn().mockResolvedValue({ errors: [] });
    const worker = createWorker({
      config: { EXCEPTION_CENTER_SCAN_BATCH_SIZE: 2 },
      findMany,
      refresh,
    });

    await worker.runOnce();
    await worker.runOnce();

    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { status: 'active', id: { gt: 8n } }, take: 2 }),
    );
    expect(findMany).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ where: { status: 'active' }, take: 2 }),
    );
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it('does not overlap drains when a previous scan is still running', async () => {
    let release: (() => void) | undefined;
    const refresh = vi.fn().mockReturnValue(
      new Promise<{ errors: [] }>((resolve) => {
        release = () => resolve({ errors: [] });
      }),
    );
    const worker = createWorker({
      findMany: vi.fn().mockResolvedValue([{ id: 1n }]),
      refresh,
    });
    const drain = worker as unknown as { drain(): Promise<void> };

    const first = drain.drain();
    await Promise.resolve();
    await drain.drain();

    expect(refresh).toHaveBeenCalledTimes(1);
    release?.();
    await first;
  });

  it('keeps scheduled scanning opt-in', () => {
    const worker = createWorker({
      config: { EXCEPTION_CENTER_SCAN_ENABLED: 'false' },
      findMany: vi.fn(),
      refresh: vi.fn(),
    });
    const runOnce = vi.spyOn(worker, 'runOnce');

    worker.onModuleInit();

    expect(runOnce).not.toHaveBeenCalled();
  });

  it('starts one scan immediately when explicitly enabled', async () => {
    const worker = createWorker({
      config: {
        EXCEPTION_CENTER_SCAN_ENABLED: 'true',
        EXCEPTION_CENTER_SCAN_INTERVAL_MS: 60_000,
      },
      findMany: vi.fn().mockResolvedValue([]),
      refresh: vi.fn(),
    });
    const runOnce = vi.spyOn(worker, 'runOnce');

    worker.onModuleInit();
    await Promise.resolve();
    worker.onModuleDestroy();

    expect(runOnce).toHaveBeenCalledTimes(1);
  });
});

function createWorker({
  config = {},
  findMany,
  refresh,
}: {
  config?: Record<string, unknown>;
  findMany: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
}) {
  return new ExceptionCenterWorker(
    { get: (key: string) => config[key] } as ConfigService,
    { user: { findMany } } as unknown as PrismaService,
    { refresh } as unknown as ExceptionCenterService,
  );
}
