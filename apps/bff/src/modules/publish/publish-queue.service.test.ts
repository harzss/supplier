import type { ConfigService } from '@nestjs/config';
import type { PublishJob } from '@supplier/db';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import { PublishQueueService } from './publish-queue.service';

const JOB: PublishJob = {
  id: 7n,
  taskId: 3n,
  status: 'queued',
  attempts: 0,
  maxAttempts: 3,
  nextRunAt: new Date('2026-07-16T10:00:00.000Z'),
  lockedAt: null,
  lockedBy: null,
  lastError: null,
  createdAt: new Date('2026-07-16T10:00:00.000Z'),
  updatedAt: new Date('2026-07-16T10:00:00.000Z'),
};

describe('PublishQueueService', () => {
  it('atomically claims one due job and increments its attempt count', async () => {
    const fixture = createFixture();
    fixture.prisma.publishJob.findFirst.mockResolvedValue(JOB);
    fixture.prisma.publishJob.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    fixture.prisma.publishJob.findUnique.mockResolvedValue({
      ...JOB,
      status: 'running',
      attempts: 1,
      lockedBy: 'worker-1',
    });

    const claimed = await fixture.service.claimNext('worker-1');

    expect(claimed).toMatchObject({ status: 'running', attempts: 1, lockedBy: 'worker-1' });
    expect(fixture.prisma.publishJob.updateMany).toHaveBeenLastCalledWith({
      where: { id: 7n, status: 'queued', attempts: 0 },
      data: expect.objectContaining({
        status: 'running',
        attempts: { increment: 1 },
        lockedBy: 'worker-1',
      }),
    });
  });

  it('only completes a job still owned by the same worker attempt', async () => {
    const fixture = createFixture();
    fixture.prisma.publishJob.updateMany.mockResolvedValue({ count: 1 });
    const running = { ...JOB, status: 'running' as const, attempts: 1, lockedBy: 'worker-1' };

    await expect(fixture.service.complete(running)).resolves.toBeUndefined();
    expect(fixture.prisma.publishJob.updateMany).toHaveBeenCalledWith({
      where: { id: 7n, status: 'running', attempts: 1, lockedBy: 'worker-1' },
      data: {
        status: 'completed',
        lockedAt: null,
        lockedBy: null,
        lastError: null,
      },
    });
  });

  it('renews only the currently owned running attempt', async () => {
    const fixture = createFixture();
    fixture.prisma.publishJob.updateMany.mockResolvedValue({ count: 1 });
    const running = { ...JOB, status: 'running' as const, attempts: 1, lockedBy: 'worker-1' };

    await expect(fixture.service.renew(running)).resolves.toBeUndefined();
    expect(fixture.prisma.publishJob.updateMany).toHaveBeenCalledWith({
      where: { id: 7n, status: 'running', attempts: 1, lockedBy: 'worker-1' },
      data: { lockedAt: expect.any(Date) },
    });
  });

  it('fails renewal after another attempt takes ownership', async () => {
    const fixture = createFixture();
    fixture.prisma.publishJob.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      fixture.service.renew({
        ...JOB,
        status: 'running',
        attempts: 1,
        lockedBy: 'worker-1',
      }),
    ).rejects.toThrow('所有权已变化');
  });

  it('recreates jobs for historical pending tasks left without a queue row', async () => {
    const fixture = createFixture();
    fixture.prisma.publishTask.findMany.mockResolvedValue([{ id: 3n }]);
    fixture.prisma.publishJob.findFirst.mockResolvedValue(null);

    await expect(fixture.service.claimNext('worker-1')).resolves.toBeNull();
    expect(fixture.prisma.publishJob.createMany).toHaveBeenCalledWith({
      data: [{ taskId: 3n, maxAttempts: 3 }],
      skipDuplicates: true,
    });
  });

  it('schedules exponential retry before the maximum attempt count', async () => {
    const fixture = createFixture();
    fixture.prisma.publishJob.updateMany.mockResolvedValue({ count: 1 });
    const status = await fixture.service.fail(
      { ...JOB, status: 'running', attempts: 1 },
      'timeout',
    );

    expect(status).toBe('retry_wait');
    expect(fixture.prisma.publishJob.updateMany).toHaveBeenCalledWith({
      where: { id: 7n, status: 'running', attempts: 1, lockedBy: null },
      data: expect.objectContaining({ status: 'retry_wait', lastError: 'timeout' }),
    });
    expect(fixture.prisma.publishTask.update).toHaveBeenCalledWith({
      where: { id: 3n },
      data: expect.objectContaining({ status: 'pending', errorMsg: 'timeout' }),
    });
  });

  it('moves an exhausted job to dead and leaves the task failed', async () => {
    const fixture = createFixture();
    fixture.prisma.publishJob.updateMany.mockResolvedValue({ count: 1 });
    const status = await fixture.service.fail({ ...JOB, status: 'running', attempts: 3 }, 'bad');

    expect(status).toBe('dead');
    expect(fixture.prisma.publishJob.updateMany).toHaveBeenCalledWith({
      where: { id: 7n, status: 'running', attempts: 3, lockedBy: null },
      data: expect.objectContaining({ status: 'dead', lastError: 'bad' }),
    });
    expect(fixture.prisma.publishTask.update).toHaveBeenCalledWith({
      where: { id: 3n },
      data: expect.objectContaining({ status: 'failed', errorMsg: 'bad' }),
    });
  });

  it('does not overwrite task state after the worker loses job ownership', async () => {
    const fixture = createFixture();
    fixture.prisma.publishJob.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      fixture.service.fail({ ...JOB, status: 'running', attempts: 1 }, 'late failure'),
    ).rejects.toThrow('所有权已变化');
    expect(fixture.prisma.publishTask.update).not.toHaveBeenCalled();
  });

  it('requeues the job and task atomically for a manual retry', async () => {
    const fixture = createFixture();
    fixture.prisma.publishTask.findFirst.mockResolvedValue({ id: 3n, status: 'failed' });

    await expect(fixture.service.manualRetry(1n, '3')).resolves.toEqual({
      taskId: '3',
      queued: true,
    });
    expect(fixture.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
    expect(fixture.prisma.publishJob.upsert).toHaveBeenCalledWith({
      where: { taskId: 3n },
      create: { taskId: 3n, maxAttempts: 3 },
      update: expect.objectContaining({ status: 'queued', attempts: 0, maxAttempts: 3 }),
    });
    expect(fixture.prisma.publishTask.update).toHaveBeenCalledWith({
      where: { id: 3n },
      data: { status: 'pending', errorMsg: null, finishedAt: null },
    });
  });
});

function createFixture() {
  const config = { get: vi.fn() } as unknown as ConfigService;
  const prisma = {
    $transaction: vi.fn(),
    publishJob: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockResolvedValue({}),
      upsert: vi.fn(),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    publishTask: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  prisma.$transaction.mockImplementation(
    async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma),
  );
  return {
    service: new PublishQueueService(config, prisma as unknown as PrismaService),
    prisma,
  };
}
