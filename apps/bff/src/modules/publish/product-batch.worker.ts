import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hostname } from 'node:os';
import { PrismaService } from '../../common/prisma.module';
import { ProductBatchService } from './product-batch.service';

@Injectable()
export class ProductBatchWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ProductBatch');
  private readonly workerId = `${hostname()}:${process.pid}`;
  private timer?: NodeJS.Timeout;
  private draining = false;

  constructor(
    private readonly config: ConfigService,
    private readonly batches: ProductBatchService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    if (!this.batches.isEnabled()) return;
    const interval = this.pollIntervalMs();
    this.timer = setInterval(() => void this.drain(), interval);
    this.timer.unref();
    void this.drain();
    this.logger.log(`批量商品 worker 已启动，轮询间隔 ${interval}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<boolean> {
    try {
      const item = await this.batches.claimNext(this.workerId);
      if (!item) return false;
      try {
        await this.batches.executeClaimed(item);
      } catch (error) {
        await this.batches.failClaimedItem(item, error);
      }
      return true;
    } catch (error) {
      if (isDatabaseConnectionError(error)) {
        await this.prisma.reconnect().catch((reconnectError) => {
          this.logger.error(
            `数据库重连失败：${reconnectError instanceof Error ? reconnectError.message : 'unknown error'}`,
          );
        });
      }
      throw error;
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let count = 0; count < 20; count++) {
        if (!(await this.runOnce())) break;
      }
    } catch (error) {
      this.logger.error(
        `批量商品轮询失败：${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      this.draining = false;
    }
  }

  private pollIntervalMs(): number {
    const value = Number(this.config.get<string>('PRODUCT_BATCH_POLL_MS') ?? 2_000);
    return Number.isInteger(value) && value >= 500 && value <= 60_000 ? value : 2_000;
  }
}

function isDatabaseConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'P1001' || code === 'P1017') return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Server has closed the connection') ||
    message.includes("Can't reach database server")
  );
}
