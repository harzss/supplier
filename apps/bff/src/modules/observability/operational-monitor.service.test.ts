import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import {
  FINANCIAL_RECONCILIATION_ORDER_WHERE,
  PURCHASE_COST_RECONCILIATION_WHERE,
  REFUND_AMOUNT_RECONCILIATION_WHERE,
} from '../order/financial-reconciliation';
import type { AlertService } from './alert.service';
import { OperationalMonitorService } from './operational-monitor.service';
import type { RuntimeMetricsService } from './runtime-metrics.service';

describe('OperationalMonitorService', () => {
  it('raises deduplicated alerts for dead, backlogged and stale jobs', async () => {
    const now = new Date('2026-07-17T12:00:00.000Z');
    const prisma = {
      publishJob: {
        groupBy: vi.fn().mockResolvedValue([
          { status: 'queued', _count: { _all: 25 } },
          { status: 'dead', _count: { _all: 2 } },
        ]),
        findFirst: vi.fn().mockResolvedValue({
          createdAt: new Date(now.getTime() - 10 * 60_000),
        }),
        count: vi.fn().mockResolvedValue(1),
      },
      purchaseOrder: { count: vi.fn().mockResolvedValue(2) },
      aiUsageLog: { count: vi.fn().mockResolvedValue(2) },
      order: {
        count: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(3).mockResolvedValueOnce(4),
      },
    } as unknown as PrismaService;
    const alerts = { raise: vi.fn(), resolve: vi.fn() } as unknown as AlertService;
    const metrics = {
      snapshot: vi.fn().mockReturnValue({
        requests: 100,
        serverErrors: 10,
        serverErrorRate: 0.1,
      }),
    } as unknown as RuntimeMetricsService;
    const config = {
      get: (key: string) =>
        ({
          ALERT_MONITOR_INTERVAL_MS: 60_000,
          ALERT_QUEUE_BACKLOG_THRESHOLD: 20,
          ALERT_QUEUE_MAX_AGE_SECONDS: 300,
          ALERT_ERROR_RATE_PERCENT: 5,
          ALERT_ERROR_RATE_MIN_REQUESTS: 20,
          AUTH_MODE: 'supabase',
        })[key],
    } as unknown as ConfigService;
    const monitor = new OperationalMonitorService(prisma, alerts, metrics, config);

    await expect(monitor.checkOnce(now)).resolves.toMatchObject({
      available: true,
      backlog: 25,
      dead: 2,
      staleRunning: 1,
      staleAiUsageReservations: 2,
      purchaseExceptions: 2,
      refundAmountReconciliations: 3,
      financialReconciliations: 4,
      afterSaleHolds: 1,
      oldestBacklogAgeSeconds: 600,
    });
    expect(prisma.order.count).toHaveBeenCalledWith({
      where: {
        status: { in: ['paid', 'purchasing'] },
        OR: [
          { afterSaleStatus: 'pending' },
          {
            afterSaleStatus: 'partial_refund',
            partialRefundDisposition: { not: 'continue_remaining' },
          },
        ],
        shop: { NOT: { platformShopId: { startsWith: 'demo-' } } },
      },
    });
    expect(prisma.aiUsageLog.count).toHaveBeenCalledWith({
      where: {
        viaByok: false,
        model: { startsWith: 'pending/' },
        createdAt: { lt: new Date(now.getTime() - 10 * 60_000) },
      },
    });
    expect(prisma.purchaseOrder.count).toHaveBeenCalledWith({
      where: {
        ...PURCHASE_COST_RECONCILIATION_WHERE,
        order: {
          shop: { NOT: { platformShopId: { startsWith: 'demo-' } } },
        },
      },
    });
    expect(prisma.order.count).toHaveBeenCalledWith({
      where: {
        ...REFUND_AMOUNT_RECONCILIATION_WHERE,
        shop: { NOT: { platformShopId: { startsWith: 'demo-' } } },
      },
    });
    expect(prisma.order.count).toHaveBeenCalledWith({
      where: {
        ...FINANCIAL_RECONCILIATION_ORDER_WHERE,
        shop: { NOT: { platformShopId: { startsWith: 'demo-' } } },
      },
    });
    const keys = (alerts.raise as ReturnType<typeof vi.fn>).mock.calls.map(([alert]) => alert.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'publish_queue.dead_jobs',
        'publish_queue.backlog_high',
        'publish_queue.oldest_job_delayed',
        'publish_queue.stale_running',
        'ai_usage.reservations_stale',
        'purchase.refund_action_required',
        'finance.refund_amount_reconciliation_required',
        'order.after_sale_hold',
        'http.server_error_rate_high',
      ]),
    );
  });
});
