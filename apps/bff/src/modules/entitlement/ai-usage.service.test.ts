import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { AlertService } from '../observability/alert.service';
import { AiUsageService, type PlatformUsageReservation } from './ai-usage.service';

const RESERVATION: PlatformUsageReservation = {
  id: 12n,
  module: 'detail',
  pendingModel: 'pending/qwen-max',
  traceId: 'usage-trace',
  quota: {
    key: 'ai.calls.monthly',
    limit: 500,
    used: 8,
    remaining: 492,
    exceeded: false,
  },
};

describe('AiUsageService', () => {
  it('checks quota and creates a platform reservation in one serializable transaction', async () => {
    const fixture = createFixture(7);

    await expect(
      fixture.service.reservePlatform(1n, 'basic', 'detail', 'qwen-max'),
    ).resolves.toMatchObject({
      id: 12n,
      module: 'detail',
      pendingModel: 'pending/qwen-max',
      quota: { used: 8, remaining: 492, exceeded: false },
    });
    expect(fixture.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(fixture.tx.aiUsageLog.count).toHaveBeenCalledWith({
      where: {
        userId: 1n,
        viaByok: false,
        createdAt: { gte: expect.any(Date) },
      },
    });
    expect(fixture.tx.aiUsageLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 1n,
        module: 'detail',
        model: 'pending/qwen-max',
        costCny: 0,
        viaByok: false,
        traceId: expect.any(String),
      }),
      select: { id: true },
    });
  });

  it('does not create a reservation when the monthly quota is exhausted', async () => {
    const fixture = createFixture(500);

    await expect(
      fixture.service.reservePlatform(1n, 'basic', 'detail', 'qwen-max'),
    ).rejects.toMatchObject({ status: 402 });
    expect(fixture.tx.aiUsageLog.create).not.toHaveBeenCalled();
  });

  it('retries a serializable reservation after a transaction conflict', async () => {
    const fixture = createFixture(7);
    const conflict = Object.assign(new Error('transaction conflict'), { code: 'P2034' });
    fixture.prisma.$transaction.mockRejectedValueOnce(conflict);

    await expect(
      fixture.service.reservePlatform(1n, 'basic', 'detail', 'qwen-max'),
    ).resolves.toMatchObject({ id: 12n });
    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('fills actual usage into a reservation and removes failed-call reservations', async () => {
    const fixture = createFixture(7);

    await expect(
      fixture.service.completeLlm(RESERVATION, {
        model: 'qwen-max',
        inputTokens: 120,
        outputTokens: 180,
        costCny: 0.02,
      }),
    ).resolves.toBe(true);
    expect(fixture.prisma.aiUsageLog.updateMany).toHaveBeenCalledWith({
      where: { id: 12n, model: 'pending/qwen-max', viaByok: false },
      data: {
        model: 'qwen-max',
        inputTokens: 120,
        outputTokens: 180,
        imageCount: 0,
        costCny: 0.02,
      },
    });

    await expect(fixture.service.cancel(RESERVATION, 'llm_timeout')).resolves.toBe(true);
    expect(fixture.prisma.aiUsageLog.deleteMany).toHaveBeenCalledWith({
      where: { id: 12n, model: 'pending/qwen-max', viaByok: false },
    });
  });

  it('keeps the reservation counted and raises a critical alert when finalization fails', async () => {
    const fixture = createFixture(7);
    fixture.prisma.aiUsageLog.updateMany.mockRejectedValue(new Error('db unavailable'));

    await expect(
      fixture.service.completeImage(RESERVATION, {
        model: 'gpu-worker/qwen-vl',
        costCny: 0.05,
      }),
    ).resolves.toBe(false);
    expect(fixture.prisma.aiUsageLog.updateMany).toHaveBeenCalledTimes(3);
    expect(fixture.alerts.raise).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'ai_usage.reservation_unresolved',
        type: 'billing',
        severity: 'critical',
        details: expect.objectContaining({
          phase: 'finalize',
          reservationId: '12',
          traceId: 'usage-trace',
          costCny: 0.05,
        }),
      }),
    );
  });
});

function createFixture(used: number) {
  const tx = {
    aiUsageLog: {
      count: vi.fn().mockResolvedValue(used),
      create: vi.fn().mockResolvedValue({ id: 12n }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    aiUsageLog: {
      create: vi.fn().mockResolvedValue({ id: 13n }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const alerts = { raise: vi.fn().mockResolvedValue(undefined) };
  return {
    service: new AiUsageService(
      prisma as unknown as PrismaService,
      alerts as unknown as AlertService,
    ),
    prisma,
    tx,
    alerts,
  };
}
