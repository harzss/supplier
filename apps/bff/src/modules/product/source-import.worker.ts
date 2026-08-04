import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hostname } from 'node:os';
import { PrismaService } from '../../common/prisma.module';
import { SourceImportService } from './source-import.service';

@Injectable()
export class SourceImportWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('SourceImport');
  private readonly workerId = `${hostname()}:${process.pid}:source-import`;
  private timer?: NodeJS.Timeout;
  private draining = false;

  constructor(
    private readonly config: ConfigService,
    private readonly imports: SourceImportService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    if (!this.imports.isEnabled()) return;
    const interval = this.pollIntervalMs();
    this.timer = setInterval(() => void this.drain(), interval);
    this.timer.unref();
    void this.drain();
    this.logger.log(`货源采集 worker 已启动，轮询间隔 ${interval}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<boolean> {
    try {
      const item = await this.imports.claimNext(this.workerId);
      if (!item) return false;
      try {
        await this.imports.executeClaimed(item);
      } catch (error) {
        await this.imports.failClaimedItem(item, error);
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
        `货源采集轮询失败：${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      this.draining = false;
    }
  }

  private pollIntervalMs(): number {
    const value = Number(this.config.get<string>('SOURCE_IMPORT_POLL_MS') ?? 2_000);
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
