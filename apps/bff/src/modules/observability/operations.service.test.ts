import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { AlertService } from './alert.service';
import type { OperationalMonitorService } from './operational-monitor.service';
import { OperationsService } from './operations.service';
import type { RuntimeMetricsService } from './runtime-metrics.service';

describe('OperationsService', () => {
  it('exports financial reconciliation gauges', async () => {
    const prisma = {
      auditLog: { count: vi.fn().mockResolvedValue(0) },
    } as unknown as PrismaService;
    const alerts = { list: vi.fn().mockResolvedValue([]) } as unknown as AlertService;
    const monitor = {
      snapshot: {
        available: true,
        counts: { queued: 0, running: 0, retry_wait: 0, completed: 5, dead: 0 },
        backlog: 0,
        dead: 0,
        staleRunning: 0,
        staleAiUsageReservations: 2,
        purchaseExceptions: 2,
        refundAmountReconciliations: 3,
        financialReconciliations: 4,
        afterSaleHolds: 1,
        oldestBacklogAgeSeconds: 0,
        checkedAt: '2026-07-20T00:00:00.000Z',
      },
    } as unknown as OperationalMonitorService;
    const metrics = {
      snapshot: vi.fn().mockReturnValue({
        totalRequests: 10,
        totalServerErrors: 0,
        totalDurationMs: 100,
        serverErrorRate: 0,
      }),
    } as unknown as RuntimeMetricsService;
    const service = new OperationsService(prisma, alerts, monitor, metrics);

    const output = await service.prometheus();

    expect(output).toContain('supplier_purchase_exceptions 2\n');
    expect(output).toContain('supplier_refund_amount_reconciliations 3\n');
    expect(output).toContain('supplier_financial_reconciliations 4\n');
    expect(output).toContain('supplier_ai_usage_reservations_stale 2\n');
  });
});
