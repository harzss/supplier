import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.module';
import { AlertService } from './alert.service';
import { OperationalMonitorService } from './operational-monitor.service';
import { RuntimeMetricsService } from './runtime-metrics.service';

@Injectable()
export class OperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertService,
    private readonly monitor: OperationalMonitorService,
    private readonly metrics: RuntimeMetricsService,
  ) {}

  async status() {
    const queue = this.monitor.snapshot ?? (await this.monitor.checkOnce());
    const [activeAlerts, auditFailures5m] = await Promise.all([
      this.alerts.list('active', 100),
      this.prisma.auditLog.count({
        where: {
          outcome: 'failure',
          createdAt: { gte: new Date(Date.now() - 5 * 60_000) },
        },
      }),
    ]);
    return {
      service: 'supplier-bff',
      status: activeAlerts.some((alert) => alert.severity === 'critical') ? 'degraded' : 'ok',
      queue,
      requests: this.metrics.snapshot(),
      auditFailures5m,
      activeAlerts,
      timestamp: new Date().toISOString(),
    };
  }

  async checkNow() {
    await this.monitor.checkOnce();
    return this.status();
  }

  async prometheus(): Promise<string> {
    const status = await this.status();
    const alertCounts = { warning: 0, critical: 0 };
    for (const alert of status.activeAlerts) alertCounts[alert.severity]++;
    const lines = [
      '# HELP supplier_http_requests_total Total HTTP requests observed by this BFF process.',
      '# TYPE supplier_http_requests_total counter',
      `supplier_http_requests_total ${status.requests.totalRequests}`,
      '# HELP supplier_http_server_errors_total Total HTTP 5xx responses observed by this BFF process.',
      '# TYPE supplier_http_server_errors_total counter',
      `supplier_http_server_errors_total ${status.requests.totalServerErrors}`,
      '# HELP supplier_http_request_duration_ms_sum Sum of observed request durations.',
      '# TYPE supplier_http_request_duration_ms_sum counter',
      `supplier_http_request_duration_ms_sum ${status.requests.totalDurationMs}`,
      '# HELP supplier_http_server_error_rate_5m Five-minute local 5xx error ratio.',
      '# TYPE supplier_http_server_error_rate_5m gauge',
      `supplier_http_server_error_rate_5m ${status.requests.serverErrorRate}`,
      '# HELP supplier_publish_jobs Current publish job count by status.',
      '# TYPE supplier_publish_jobs gauge',
      ...Object.entries(status.queue.counts).map(
        ([jobStatus, count]) => `supplier_publish_jobs{status="${jobStatus}"} ${count}`,
      ),
      '# HELP supplier_publish_queue_oldest_age_seconds Age of the oldest queued/retry job.',
      '# TYPE supplier_publish_queue_oldest_age_seconds gauge',
      `supplier_publish_queue_oldest_age_seconds ${status.queue.oldestBacklogAgeSeconds}`,
      '# HELP supplier_ai_usage_reservations_stale Platform AI usage reservations pending for longer than the allowed window.',
      '# TYPE supplier_ai_usage_reservations_stale gauge',
      `supplier_ai_usage_reservations_stale ${status.queue.staleAiUsageReservations}`,
      '# HELP supplier_purchase_exceptions Current refunded or closed orders requiring manual 1688 purchase action.',
      '# TYPE supplier_purchase_exceptions gauge',
      `supplier_purchase_exceptions ${status.queue.purchaseExceptions}`,
      '# HELP supplier_refund_amount_reconciliations Current orders requiring manual refund amount reconciliation.',
      '# TYPE supplier_refund_amount_reconciliations gauge',
      `supplier_refund_amount_reconciliations ${status.queue.refundAmountReconciliations}`,
      '# HELP supplier_financial_reconciliations Current orders requiring refund amount or purchase cost reconciliation.',
      '# TYPE supplier_financial_reconciliations gauge',
      `supplier_financial_reconciliations ${status.queue.financialReconciliations}`,
      '# HELP supplier_order_after_sale_holds Current paid or purchasing orders paused for an active after-sale request or partial refund.',
      '# TYPE supplier_order_after_sale_holds gauge',
      `supplier_order_after_sale_holds ${status.queue.afterSaleHolds}`,
      '# HELP supplier_operational_alerts Current active alerts by severity.',
      '# TYPE supplier_operational_alerts gauge',
      `supplier_operational_alerts{severity="warning"} ${alertCounts.warning}`,
      `supplier_operational_alerts{severity="critical"} ${alertCounts.critical}`,
      '# HELP supplier_audit_failures_5m Failed audited operations in the last five minutes.',
      '# TYPE supplier_audit_failures_5m gauge',
      `supplier_audit_failures_5m ${status.auditFailures5m}`,
    ];
    return `${lines.join('\n')}\n`;
  }
}
