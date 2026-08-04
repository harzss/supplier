import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.module';
import { ExceptionCenterService } from './exception-center.service';

const DEFAULT_INTERVAL_MS = 300_000;
const DEFAULT_BATCH_SIZE = 50;

@Injectable()
export class ExceptionCenterWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ExceptionCenterWorker');
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastUserId: bigint | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly exceptions: ExceptionCenterService,
  ) {}

  onModuleInit(): void {
    if (this.config.get('EXCEPTION_CENTER_SCAN_ENABLED') !== 'true') return;
    const intervalMs = Number(
      this.config.get('EXCEPTION_CENTER_SCAN_INTERVAL_MS') ?? DEFAULT_INTERVAL_MS,
    );
    this.timer = setInterval(() => void this.drain(), intervalMs);
    this.timer.unref();
    void this.drain();
    this.logger.log(`统一异常中心扫描 worker 已启动，间隔 ${intervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<{
    attempted: number;
    completed: number;
    failed: number;
    domainFailures: number;
  }> {
    const users = await this.nextUserBatch();
    let completed = 0;
    let failed = 0;
    let domainFailures = 0;

    for (const user of users) {
      try {
        const result = await this.exceptions.refresh(user.id);
        completed++;
        domainFailures += result.errors.length;
        if (result.errors.length > 0) {
          this.logger.warn(`用户 ${user.id} 的 ${result.errors.length} 个异常域扫描失败`);
        }
      } catch (error) {
        failed++;
        this.logger.error(
          `用户 ${user.id} 异常中心扫描失败：${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }

    return { attempted: users.length, completed, failed, domainFailures };
  }

  private async nextUserBatch(): Promise<Array<{ id: bigint }>> {
    const batchSize = Number(
      this.config.get('EXCEPTION_CENTER_SCAN_BATCH_SIZE') ?? DEFAULT_BATCH_SIZE,
    );
    let users = await this.findUsersAfterCursor(batchSize);
    if (users.length === 0 && this.lastUserId !== null) {
      this.lastUserId = null;
      users = await this.findUsersAfterCursor(batchSize);
    }
    if (users.length > 0) this.lastUserId = users.at(-1)!.id;
    return users;
  }

  private findUsersAfterCursor(take: number): Promise<Array<{ id: bigint }>> {
    return this.prisma.user.findMany({
      where: {
        status: 'active',
        ...(this.lastUserId === null ? {} : { id: { gt: this.lastUserId } }),
      },
      orderBy: { id: 'asc' },
      take,
      select: { id: true },
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error(
        `统一异常中心 worker 运行失败：${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      this.running = false;
    }
  }
}
