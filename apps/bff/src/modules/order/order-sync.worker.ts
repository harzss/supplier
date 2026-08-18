import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.module';
import { AlertService } from '../observability/alert.service';
import { OrderSyncService } from './order-sync.service';

@Injectable()
export class OrderSyncWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('OrderSyncWorker');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly orderSync: OrderSyncService,
    private readonly alerts: AlertService,
  ) {}

  onModuleInit(): void {
    if (this.config.get('DOUYIN_ORDER_SYNC_ENABLED') !== 'true') return;
    const intervalMs = Number(this.config.get('DOUYIN_ORDER_SYNC_INTERVAL_MS') ?? 60_000);
    this.timer = setInterval(() => void this.drain(), intervalMs);
    this.timer.unref();
    void this.drain();
    this.logger.log(`抖店订单增量同步 worker 已启动，间隔 ${intervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<{ attempted: number; succeeded: number; busy: number; failed: number }> {
    const shops = await this.prisma.shop.findMany({
      where: {
        platform: 'douyin',
        role: 'seller',
        status: 'active',
        accessTokenEnc: { not: null },
        user: { status: 'active', entitlementAccessStatus: 'active' },
        NOT: { platformShopId: { startsWith: 'demo-' } },
      },
      orderBy: [{ lastOrderSyncAt: 'asc' }, { id: 'asc' }],
      select: { id: true, userId: true, user: { select: { entitlementRevision: true } } },
    });

    let succeeded = 0;
    let busy = 0;
    let failed = 0;
    for (const shop of shops) {
      try {
        const result = await this.orderSync.syncShop(
          shop.userId,
          shop.id,
          shop.user.entitlementRevision,
        );
        await this.alerts.resolve(`order_sync.shop.${shop.id}`, {
          synced: result.synced,
          skipped: result.skipped,
        });
        succeeded++;
      } catch (error) {
        if (isSyncAlreadyRunning(error)) {
          busy++;
          continue;
        }
        failed++;
        await this.alerts.raise({
          key: `order_sync.shop.${shop.id}`,
          type: 'order_sync',
          severity: 'warning',
          summary: '抖店订单增量同步失败',
          details: {
            shopId: shop.id,
            userId: shop.userId,
            errorType: error instanceof Error ? error.name : 'unknown',
          },
        });
        this.logger.error(
          `店铺 ${shop.id} 订单同步失败：${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
    return { attempted: shops.length, succeeded, busy, failed };
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error(
        `订单同步 worker 运行失败：${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      this.running = false;
    }
  }
}

function isSyncAlreadyRunning(error: unknown): boolean {
  return (
    error instanceof ServiceUnavailableException &&
    (error.message.includes('正在同步') || error.message.includes('执行权已失效'))
  );
}
