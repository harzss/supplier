import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.module';
import { AlertService } from './alert.service';

const RETENTION_CHECK_INTERVAL_MS = 24 * 60 * 60_000;

/** 按配置保留审计记录；不提供面向业务用户的更新或删除接口。 */
@Injectable()
export class AuditRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('AuditRetention');
  private readonly retentionDays: number;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertService,
    config: ConfigService,
  ) {
    this.retentionDays = config.get<number>('AUDIT_RETENTION_DAYS') ?? 180;
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.prune(), RETENTION_CHECK_INTERVAL_MS);
    this.timer.unref();
    void this.prune();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async prune(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.retentionDays * 24 * 60 * 60_000);
    try {
      const result = await this.prisma.auditLog.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      if (result.count) this.logger.log(`已清理 ${result.count} 条过期审计记录`);
      await this.alerts.resolve('audit.retention.failed', {
        status: 'ok',
        retentionDays: this.retentionDays,
      });
      return result.count;
    } catch (error) {
      await this.alerts.raise({
        key: 'audit.retention.failed',
        type: 'audit',
        severity: 'warning',
        summary: '审计日志保留策略执行失败',
        details: {
          retentionDays: this.retentionDays,
          errorType: error instanceof Error ? error.name : 'unknown',
        },
      });
      return 0;
    }
  }
}
