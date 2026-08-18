import type { ConfigService } from '@nestjs/config';
import type { PublishJob } from '@supplier/db';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import {
  PUBLISH_JOB_HEARTBEAT_MS,
  PublishJobLeaseError,
  type PublishExecutionLease,
} from './publish-job-lease';
import type { PublishQueueService } from './publish-queue.service';
import { PublishQueueWorker } from './publish-queue.worker';
import type { PublishService } from './publish.service';

const JOB = {
  id: 7n,
  taskId: 3n,
  attempts: 1,
  maxAttempts: 3,
} as PublishJob;

describe('PublishQueueWorker', () => {
  it('completes a successful queued publish', async () => {
    const queue = {
      claimNext: vi.fn().mockResolvedValue(JOB),
      renew: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn(),
      fail: vi.fn(),
    } as unknown as PublishQueueService;
    const publish = {
      executeQueued: vi.fn().mockResolvedValue({ status: 'success', results: [] }),
    } as unknown as PublishService;
    const prisma = { reconnect: vi.fn() } as unknown as PrismaService;
    const worker = new PublishQueueWorker(
      { get: vi.fn() } as unknown as ConfigService,
      queue,
      publish,
      prisma,
    );

    expect(await worker.runOnce()).toBe(true);
    expect(queue.complete).toHaveBeenCalledWith(JOB);
    expect(queue.fail).not.toHaveBeenCalled();
  });

  it('reschedules a partial publish with the shop errors', async () => {
    const queue = {
      claimNext: vi.fn().mockResolvedValue(JOB),
      renew: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn(),
      fail: vi.fn(),
    } as unknown as PublishQueueService;
    const publish = {
      executeQueued: vi.fn().mockResolvedValue({
        status: 'partial',
        results: [{ error: '店铺接口超时' }],
      }),
    } as unknown as PublishService;
    const prisma = { reconnect: vi.fn() } as unknown as PrismaService;
    const worker = new PublishQueueWorker(
      { get: vi.fn() } as unknown as ConfigService,
      queue,
      publish,
      prisma,
    );

    await worker.runOnce();

    expect(queue.fail).toHaveBeenCalledWith(JOB, '店铺接口超时');
    expect(queue.complete).not.toHaveBeenCalled();
  });

  it('reconnects Prisma after the pooler closes the queue connection', async () => {
    const error = Object.assign(new Error('Server has closed the connection.'), { code: 'P1017' });
    const queue = {
      claimNext: vi.fn().mockRejectedValue(error),
    } as unknown as PublishQueueService;
    const prisma = {
      reconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as PrismaService;
    const worker = new PublishQueueWorker(
      { get: vi.fn() } as unknown as ConfigService,
      queue,
      {} as PublishService,
      prisma,
    );

    await expect(worker.runOnce()).rejects.toBe(error);
    expect(prisma.reconnect).toHaveBeenCalledOnce();
  });

  it('keeps renewing the lease while a long publish is running', async () => {
    vi.useFakeTimers();
    try {
      let finishPublish!: (value: { status: string; results: never[] }) => void;
      const publishing = new Promise<{ status: string; results: never[] }>((resolve) => {
        finishPublish = resolve;
      });
      const queue = {
        claimNext: vi.fn().mockResolvedValue(JOB),
        renew: vi.fn().mockResolvedValue(undefined),
        complete: vi.fn(),
        fail: vi.fn(),
      } as unknown as PublishQueueService;
      const publish = {
        executeQueued: vi.fn().mockReturnValue(publishing),
      } as unknown as PublishService;
      const worker = new PublishQueueWorker(
        { get: vi.fn() } as unknown as ConfigService,
        queue,
        publish,
        { reconnect: vi.fn() } as unknown as PrismaService,
      );

      const running = worker.runOnce();
      await vi.advanceTimersByTimeAsync(0);
      expect(publish.executeQueued).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(PUBLISH_JOB_HEARTBEAT_MS);
      expect(queue.renew).toHaveBeenCalledOnce();

      finishPublish({ status: 'success', results: [] });
      await expect(running).resolves.toBe(true);
      expect(queue.complete).toHaveBeenCalledWith(JOB);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not call the platform adapter or change state after suspension loses ownership', async () => {
    const queue = {
      claimNext: vi.fn().mockResolvedValue(JOB),
      renew: vi
        .fn()
        .mockRejectedValue(new PublishJobLeaseError('lost', '铺货队列任务所有权已变化')),
      complete: vi.fn(),
      fail: vi.fn(),
    } as unknown as PublishQueueService;
    const adapterCall = vi.fn();
    const publish = {
      executeQueued: vi
        .fn()
        .mockImplementation(async (_taskId: bigint, lease: PublishExecutionLease) => {
          await lease.assertOwned();
          adapterCall();
          return { status: 'success', results: [] };
        }),
    } as unknown as PublishService;
    const worker = new PublishQueueWorker(
      { get: vi.fn() } as unknown as ConfigService,
      queue,
      publish,
      { reconnect: vi.fn() } as unknown as PrismaService,
    );

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(adapterCall).not.toHaveBeenCalled();
    expect(queue.complete).not.toHaveBeenCalled();
    expect(queue.fail).not.toHaveBeenCalled();
  });
});
