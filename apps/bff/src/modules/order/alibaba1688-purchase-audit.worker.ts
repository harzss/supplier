import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.module';
import { AlertService } from '../observability/alert.service';
import { Alibaba1688PurchaseService } from './alibaba1688-purchase.service';

@Injectable()
export class Alibaba1688PurchaseAuditWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Alibaba1688PurchaseAuditWorker');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly purchases: Alibaba1688PurchaseService,
    private readonly alerts: AlertService,
  ) {}

  onModuleInit(): void {
    if (
      this.config.get('ALIBABA_1688_PURCHASE_ENABLED') !== 'true' ||
      this.config.get('ALIBABA_1688_PURCHASE_AUDIT_ENABLED') !== 'true'
    ) {
      return;
    }
    const intervalMs = Number(
      this.config.get('ALIBABA_1688_PURCHASE_AUDIT_INTERVAL_MS') ?? 300_000,
    );
    this.timer = setInterval(() => void this.drain(), intervalMs);
    this.timer.unref();
    void this.drain();
    this.logger.log(`1688 已履约采购巡检 worker 已启动，间隔 ${intervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<{
    attempted: number;
    checked: number;
    actionRequired: number;
    skipped: number;
    failed: number;
  }> {
    const now = new Date();
    const intervalMs = Number(
      this.config.get('ALIBABA_1688_PURCHASE_AUDIT_INTERVAL_MS') ?? 300_000,
    );
    const nextAuditAt = new Date(now.getTime() + intervalMs);
    const candidates = await this.prisma.purchaseOrder.findMany({
      where: {
        orderId1688: { not: null },
        everShipped: true,
        order: { status: { in: ['shipped', 'received'] } },
        AND: [
          { OR: [{ settledAuditNextAt: null }, { settledAuditNextAt: { lte: now } }] },
          {
            OR: [
              {
                exceptionStatus: { in: ['none', 'resolved'] },
                status: { in: ['shipped', 'received'] },
                buyerShop: {
                  platform: 'alibaba_1688',
                  role: 'buyer',
                  status: 'active',
                  accessTokenEnc: { not: null },
                  refreshTokenEnc: { not: null },
                  NOT: { platformShopId: { startsWith: 'demo-' } },
                },
              },
              {
                exceptionStatus: 'action_required',
                status: { in: ['shipped', 'received', 'failed'] },
              },
            ],
          },
        ],
      },
      orderBy: [{ settledAuditNextAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: Number(this.config.get('ALIBABA_1688_PURCHASE_AUDIT_BATCH_SIZE') ?? 100),
      select: {
        id: true,
        orderId: true,
        settledAuditNextAt: true,
        exceptionStatus: true,
        exceptionRevision: true,
        order: { select: { shop: { select: { userId: true } } } },
      },
    });

    let attempted = 0;
    let checked = 0;
    let actionRequired = 0;
    let skipped = 0;
    let failed = 0;
    for (const candidate of candidates) {
      const alertKey = `purchase_audit.purchase.${candidate.id}`;
      const claimed = await this.prisma.purchaseOrder.updateMany({
        where: {
          id: candidate.id,
          settledAuditNextAt: candidate.settledAuditNextAt,
          exceptionStatus: candidate.exceptionStatus,
          status: {
            in:
              candidate.exceptionStatus === 'action_required'
                ? ['shipped', 'received', 'failed']
                : ['shipped', 'received'],
          },
          order: { status: { in: ['shipped', 'received'] } },
        },
        data: { settledAuditNextAt: nextAuditAt },
      });
      if (claimed.count !== 1) {
        skipped++;
        continue;
      }
      attempted++;
      try {
        if (candidate.exceptionStatus === 'action_required') {
          if (await this.raiseActionRequired(candidate, alertKey)) actionRequired++;
          else skipped++;
          continue;
        }
        const outcome = await this.purchases.auditSettledPurchase(
          candidate.order.shop.userId,
          candidate.id,
        );
        if (outcome === 'action_required') {
          if (await this.raiseActionRequired(candidate, alertKey)) actionRequired++;
          else skipped++;
        } else if (outcome === 'skipped') {
          skipped++;
        } else {
          checked++;
          await this.alerts.resolve(alertKey, {
            purchaseOrderId: candidate.id,
            orderId: candidate.orderId,
          });
        }
      } catch (error) {
        failed++;
        await this.alerts.raise({
          key: alertKey,
          type: 'purchase_audit',
          severity: 'warning',
          summary: '1688 已履约采购巡检失败',
          details: {
            purchaseOrderId: candidate.id,
            orderId: candidate.orderId,
            userId: candidate.order.shop.userId,
            errorType: error instanceof Error ? error.name : 'unknown',
          },
        });
        this.logger.error(
          `采购单 ${candidate.id} 巡检失败：${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
    return { attempted, checked, actionRequired, skipped, failed };
  }

  private async raiseActionRequired(
    candidate: {
      id: bigint;
      orderId: bigint;
      exceptionRevision: number;
      order: { shop: { userId: bigint } };
    },
    alertKey: string,
  ): Promise<boolean> {
    const current = await this.prisma.purchaseOrder.findUnique({
      where: { id: candidate.id },
      select: { exceptionStatus: true, exceptionRevision: true },
    });
    if (current?.exceptionStatus !== 'action_required') {
      await this.alerts.resolve(alertKey, {
        purchaseOrderId: candidate.id,
        orderId: candidate.orderId,
      });
      return false;
    }
    await this.alerts.raise({
      key: alertKey,
      type: 'purchase_audit',
      severity: 'critical',
      summary: '已发货订单的 1688 采购或物流发生变化',
      details: {
        purchaseOrderId: candidate.id,
        orderId: candidate.orderId,
        userId: candidate.order.shop.userId,
        exceptionRevision: current.exceptionRevision,
      },
    });
    return true;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error(
        `1688 采购巡检 worker 运行失败：${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      this.running = false;
    }
  }
}
