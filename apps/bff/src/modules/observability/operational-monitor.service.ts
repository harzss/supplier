import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PublishJobStatus } from '@supplier/db';
import { PrismaService } from '../../common/prisma.module';
import {
  AI_USAGE_RESERVATION_MODEL_PREFIX,
  AI_USAGE_RESERVATION_STALE_MS,
} from '../entitlement/ai-usage.service';
import {
  FINANCIAL_RECONCILIATION_ORDER_WHERE,
  PURCHASE_COST_RECONCILIATION_WHERE,
  REFUND_AMOUNT_RECONCILIATION_WHERE,
} from '../order/financial-reconciliation';
import { runtimeShopWhere } from '../shop/platform-adapter.factory';
import { AlertService } from './alert.service';
import { RuntimeMetricsService } from './runtime-metrics.service';

export interface QueueOperationalSnapshot {
  available: boolean;
  counts: Record<PublishJobStatus, number>;
  backlog: number;
  dead: number;
  staleRunning: number;
  staleAiUsageReservations: number;
  purchaseExceptions: number;
  refundAmountReconciliations: number;
  financialReconciliations: number;
  afterSaleHolds: number;
  oldestBacklogAgeSeconds: number;
  checkedAt: string;
}

const EMPTY_COUNTS: Record<PublishJobStatus, number> = {
  queued: 0,
  running: 0,
  retry_wait: 0,
  completed: 0,
  dead: 0,
};

@Injectable()
export class OperationalMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('OperationalMonitor');
  private readonly intervalMs: number;
  private readonly backlogThreshold: number;
  private readonly maxAgeSeconds: number;
  private readonly errorRatePercent: number;
  private readonly errorRateMinRequests: number;
  private readonly demoMode: boolean;
  private timer?: NodeJS.Timeout;
  private checking = false;
  private snapshotValue?: QueueOperationalSnapshot;

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertService,
    private readonly metrics: RuntimeMetricsService,
    config: ConfigService,
  ) {
    this.intervalMs = config.get<number>('ALERT_MONITOR_INTERVAL_MS') ?? 60_000;
    this.backlogThreshold = config.get<number>('ALERT_QUEUE_BACKLOG_THRESHOLD') ?? 20;
    this.maxAgeSeconds = config.get<number>('ALERT_QUEUE_MAX_AGE_SECONDS') ?? 300;
    this.errorRatePercent = config.get<number>('ALERT_ERROR_RATE_PERCENT') ?? 5;
    this.errorRateMinRequests = config.get<number>('ALERT_ERROR_RATE_MIN_REQUESTS') ?? 20;
    this.demoMode = (config.get<string>('AUTH_MODE') ?? 'demo') === 'demo';
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.checkOnce(), this.intervalMs);
    this.timer.unref();
    void this.checkOnce();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get snapshot(): QueueOperationalSnapshot | undefined {
    return this.snapshotValue;
  }

  async checkOnce(now = new Date()): Promise<QueueOperationalSnapshot> {
    if (this.checking && this.snapshotValue) return this.snapshotValue;
    this.checking = true;
    try {
      const [
        grouped,
        oldest,
        staleRunning,
        staleAiUsageReservations,
        purchaseExceptions,
        afterSaleHolds,
        refundAmountReconciliations,
        financialReconciliations,
      ] = await Promise.all([
        this.prisma.publishJob.groupBy({ by: ['status'], _count: { _all: true } }),
        this.prisma.publishJob.findFirst({
          where: { status: { in: ['queued', 'retry_wait'] } },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
        this.prisma.publishJob.count({
          where: {
            status: 'running',
            lockedAt: { lt: new Date(now.getTime() - 5 * 60_000) },
          },
        }),
        this.prisma.aiUsageLog.count({
          where: {
            viaByok: false,
            model: { startsWith: AI_USAGE_RESERVATION_MODEL_PREFIX },
            createdAt: { lt: new Date(now.getTime() - AI_USAGE_RESERVATION_STALE_MS) },
          },
        }),
        this.prisma.purchaseOrder.count({
          where: {
            ...PURCHASE_COST_RECONCILIATION_WHERE,
            ...(this.demoMode ? {} : { order: { shop: runtimeShopWhere(this.demoMode) } }),
          },
        }),
        this.prisma.order.count({
          where: {
            status: { in: ['paid', 'purchasing'] },
            ...(this.demoMode ? {} : { shop: runtimeShopWhere(this.demoMode) }),
            OR: [
              { afterSaleStatus: 'pending' },
              {
                afterSaleStatus: 'partial_refund',
                partialRefundDisposition: { not: 'continue_remaining' },
              },
            ],
          },
        }),
        this.prisma.order.count({
          where: {
            ...REFUND_AMOUNT_RECONCILIATION_WHERE,
            ...(this.demoMode ? {} : { shop: runtimeShopWhere(this.demoMode) }),
          },
        }),
        this.prisma.order.count({
          where: {
            ...FINANCIAL_RECONCILIATION_ORDER_WHERE,
            ...(this.demoMode ? {} : { shop: runtimeShopWhere(this.demoMode) }),
          },
        }),
      ]);
      const counts = { ...EMPTY_COUNTS };
      for (const row of grouped) counts[row.status] = row._count._all;
      const backlog = counts.queued + counts.retry_wait;
      const oldestBacklogAgeSeconds = oldest
        ? Math.max(0, Math.floor((now.getTime() - oldest.createdAt.getTime()) / 1_000))
        : 0;
      this.snapshotValue = {
        available: true,
        counts,
        backlog,
        dead: counts.dead,
        staleRunning,
        staleAiUsageReservations,
        purchaseExceptions,
        refundAmountReconciliations,
        financialReconciliations,
        afterSaleHolds,
        oldestBacklogAgeSeconds,
        checkedAt: now.toISOString(),
      };
      await this.evaluateQueue(this.snapshotValue);
      await this.alerts.resolve('monitor.publish_queue.query_failed');
    } catch (error) {
      this.snapshotValue = {
        available: false,
        counts: { ...EMPTY_COUNTS },
        backlog: 0,
        dead: 0,
        staleRunning: 0,
        staleAiUsageReservations: 0,
        purchaseExceptions: 0,
        refundAmountReconciliations: 0,
        financialReconciliations: 0,
        afterSaleHolds: 0,
        oldestBacklogAgeSeconds: 0,
        checkedAt: now.toISOString(),
      };
      this.logger.error(`队列监控查询失败：${error instanceof Error ? error.message : 'unknown'}`);
      await this.alerts.raise({
        key: 'monitor.publish_queue.query_failed',
        type: 'dependency',
        severity: 'critical',
        summary: '铺货队列监控无法读取数据库',
        details: { errorType: error instanceof Error ? error.name : 'unknown' },
      });
    } finally {
      await this.evaluateErrorRate();
      this.checking = false;
    }
    return this.snapshotValue;
  }

  private async evaluateQueue(snapshot: QueueOperationalSnapshot): Promise<void> {
    await transition(
      this.alerts,
      snapshot.dead > 0,
      {
        key: 'publish_queue.dead_jobs',
        type: 'queue',
        severity: 'critical',
        summary: '铺货队列存在死信任务',
        details: { count: snapshot.dead },
      },
      { count: 0 },
    );
    await transition(
      this.alerts,
      snapshot.backlog >= this.backlogThreshold,
      {
        key: 'publish_queue.backlog_high',
        type: 'queue',
        severity: 'warning',
        summary: '铺货队列积压超过阈值',
        details: { backlog: snapshot.backlog, threshold: this.backlogThreshold },
      },
      { backlog: snapshot.backlog },
    );
    await transition(
      this.alerts,
      snapshot.oldestBacklogAgeSeconds >= this.maxAgeSeconds,
      {
        key: 'publish_queue.oldest_job_delayed',
        type: 'queue',
        severity: 'warning',
        summary: '铺货队列最老任务等待时间过长',
        details: {
          ageSeconds: snapshot.oldestBacklogAgeSeconds,
          thresholdSeconds: this.maxAgeSeconds,
        },
      },
      { ageSeconds: snapshot.oldestBacklogAgeSeconds },
    );
    await transition(
      this.alerts,
      snapshot.staleRunning > 0,
      {
        key: 'publish_queue.stale_running',
        type: 'queue',
        severity: 'critical',
        summary: '铺货队列存在超时运行任务',
        details: { count: snapshot.staleRunning },
      },
      { count: 0 },
    );
    await transition(
      this.alerts,
      snapshot.staleAiUsageReservations > 0,
      {
        key: 'ai_usage.reservations_stale',
        type: 'billing',
        severity: 'critical',
        summary: '平台 AI 用量存在超时未收敛的预占记录',
        details: {
          count: snapshot.staleAiUsageReservations,
          staleAfterSeconds: AI_USAGE_RESERVATION_STALE_MS / 1_000,
        },
      },
      { count: 0 },
    );
    await transition(
      this.alerts,
      snapshot.purchaseExceptions > 0,
      {
        key: 'purchase.refund_action_required',
        type: 'order',
        severity: 'critical',
        summary: '退款、部分退款或关闭订单存在待人工处理的 1688 采购单',
        details: { count: snapshot.purchaseExceptions },
      },
      { count: 0 },
    );
    await transition(
      this.alerts,
      snapshot.refundAmountReconciliations > 0,
      {
        key: 'finance.refund_amount_reconciliation_required',
        type: 'order',
        severity: 'warning',
        summary: '存在部分退款或价保退款订单尚未核对实际退款金额',
        details: { count: snapshot.refundAmountReconciliations },
      },
      { count: 0 },
    );
    await transition(
      this.alerts,
      snapshot.afterSaleHolds > 0,
      {
        key: 'order.after_sale_hold',
        type: 'order',
        severity: 'warning',
        summary: '待采购或采购中订单存在售后申请或部分退款，已暂停自动履约',
        details: { count: snapshot.afterSaleHolds },
      },
      { count: 0 },
    );
  }

  private async evaluateErrorRate(): Promise<void> {
    const snapshot = this.metrics.snapshot();
    const ratePercent = snapshot.serverErrorRate * 100;
    await transition(
      this.alerts,
      snapshot.requests >= this.errorRateMinRequests && ratePercent >= this.errorRatePercent,
      {
        key: 'http.server_error_rate_high',
        type: 'http',
        severity: 'critical',
        summary: 'BFF 五分钟 5xx 错误率超过阈值',
        details: {
          requests: snapshot.requests,
          serverErrors: snapshot.serverErrors,
          ratePercent: Number(ratePercent.toFixed(2)),
          thresholdPercent: this.errorRatePercent,
        },
      },
      { requests: snapshot.requests, ratePercent: Number(ratePercent.toFixed(2)) },
    );
  }
}

async function transition(
  alerts: AlertService,
  active: boolean,
  firing: Parameters<AlertService['raise']>[0],
  resolvedDetails: unknown,
): Promise<void> {
  if (active) await alerts.raise(firing);
  else await alerts.resolve(firing.key, resolvedDetails);
}
