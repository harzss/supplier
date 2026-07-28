import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hostname } from 'node:os';
import { PrismaService } from '../../common/prisma.module';
import { InventorySyncService } from './inventory-sync.service';

@Injectable()
export class InventorySyncWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('InventorySync');
  private readonly workerId = `${hostname()}:${process.pid}`;
  private timer?: NodeJS.Timeout;
  private draining = false;

  constructor(
    private readonly config: ConfigService,
    private readonly inventory: InventorySyncService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    if (!this.inventory.isEnabled()) return;
    const interval = this.pollIntervalMs();
    this.timer = setInterval(() => void this.drain(), interval);
    this.timer.unref();
    void this.drain();
    this.logger.log(`库存同步 worker 已启动，轮询间隔 ${interval}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<boolean> {
    try {
      const job = await this.inventory.claimNext(this.workerId);
      if (!job) return false;
      try {
        await this.inventory.execute(job);
      } catch (error) {
        await this.inventory.fail(job, error instanceof Error ? error.message : '库存同步失败');
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
        `库存同步轮询失败：${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      this.draining = false;
    }
  }

  private pollIntervalMs(): number {
    const value = Number(this.config.get<string>('INVENTORY_SYNC_POLL_MS') ?? 5_000);
    return Number.isInteger(value) && value >= 500 && value <= 60_000 ? value : 5_000;
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
