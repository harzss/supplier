import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { PrismaService } from '../../common/prisma.module';
import { REDIS_CLIENT } from '../../common/redis.module';
import { AlertService } from '../observability/alert.service';

type DependencyStatus = { status: 'up' } | { status: 'down' };

export const LATEST_REQUIRED_MIGRATION = '20260805040000_harden_workflow_check_null_semantics';

export interface ReadinessResult {
  status: 'ready' | 'unavailable';
  service: 'supplier-bff';
  version: string;
  checks: {
    database: DependencyStatus;
    redis: DependencyStatus;
  };
  timestamp: string;
  durationMs: number;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService,
    private readonly alerts: AlertService,
  ) {
    this.timeoutMs = config.get<number>('HEALTH_CHECK_TIMEOUT_MS') ?? 2_000;
  }

  liveness() {
    return {
      status: 'ok' as const,
      service: 'supplier-bff' as const,
      version: '0.0.1',
      timestamp: new Date().toISOString(),
    };
  }

  async readiness(): Promise<ReadinessResult> {
    const startedAt = Date.now();
    const [database, redis] = await Promise.all([
      this.check('database', () => this.checkDatabase()),
      this.check('redis', () => this.redis.ping()),
    ]);
    const ready = database.status === 'up' && redis.status === 'up';
    void this.updateDependencyAlert('database', database);
    void this.updateDependencyAlert('redis', redis);
    return {
      status: ready ? 'ready' : 'unavailable',
      service: 'supplier-bff',
      version: '0.0.1',
      checks: { database, redis },
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    };
  }

  private async checkDatabase(): Promise<void> {
    const applied = await this.prisma.$queryRaw<Array<{ migration_name: string }>>`
      SELECT "migration_name"
      FROM "_prisma_migrations"
      WHERE "migration_name" = ${LATEST_REQUIRED_MIGRATION}
        AND "finished_at" IS NOT NULL
        AND "rolled_back_at" IS NULL
      LIMIT 1
    `;
    if (applied.length !== 1) {
      throw new Error(`required migration is not applied: ${LATEST_REQUIRED_MIGRATION}`);
    }
  }

  private async updateDependencyAlert(
    name: 'database' | 'redis',
    status: DependencyStatus,
  ): Promise<void> {
    const key = `dependency.${name}.down`;
    if (status.status === 'up') {
      await this.alerts.resolve(key, { status: 'up' });
      return;
    }
    await this.alerts.raise({
      key,
      type: 'dependency',
      severity: 'critical',
      summary: `${name === 'database' ? 'PostgreSQL' : 'Redis'} readiness 检查失败`,
      details: { status: 'down' },
    });
  }

  private async check(name: string, operation: () => Promise<unknown>): Promise<DependencyStatus> {
    try {
      await withTimeout(operation(), this.timeoutMs);
      return { status: 'up' };
    } catch (error) {
      this.logger.warn(`${name} readiness check failed: ${(error as Error).message}`);
      return { status: 'down' };
    }
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
