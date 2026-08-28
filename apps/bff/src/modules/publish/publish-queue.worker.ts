import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PublishJob } from '@supplier/db';
import { hostname } from 'node:os';
import { PrismaService } from '../../common/prisma.module';
import { entitlementAccessStopMessage } from '../entitlement/entitlement-access.service';
import {
  PUBLISH_JOB_HEARTBEAT_MS,
  PublishJobLeaseError,
  isPublishJobLeaseError,
  type PublishExecutionLease,
} from './publish-job-lease';
import { PublishQueueService } from './publish-queue.service';
import { PublishService } from './publish.service';

@Injectable()
export class PublishQueueWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('PublishQueue');
  private readonly workerId = `${hostname()}:${process.pid}`;
  private timer?: NodeJS.Timeout;
  private draining = false;

  constructor(
    private readonly config: ConfigService,
    private readonly queue: PublishQueueService,
    private readonly publish: PublishService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    if (!this.queue.isEnabled()) return;
    const interval = this.pollIntervalMs();
    this.timer = setInterval(() => void this.drain(), interval);
    this.timer.unref();
    void this.drain();
    this.logger.log(`数据库队列 worker 已启动，轮询间隔 ${interval}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<boolean> {
    try {
      const job = await this.queue.claimNext(this.workerId);
      if (!job) return false;
      const heartbeat = startJobLeaseHeartbeat(this.queue, job, this.logger);
      try {
        const result = await this.publish.executeQueued(job.taskId, heartbeat.lease);
        await heartbeat.lease.assertOwned();
        await heartbeat.stop();
        if (result.status === 'success') {
          await this.queue.complete(job);
        } else {
          const errors = result.results
            .map((item) => item.error)
            .filter(Boolean)
            .join('；');
          await this.queue.fail(job, errors || `铺货状态：${result.status}`);
        }
      } catch (err) {
        await heartbeat.stop();
        const accessFailure = entitlementAccessStopMessage(err);
        if (accessFailure) {
          try {
            await this.queue.blockForAccessChange(job, accessFailure);
          } catch (transitionError) {
            if (isPublishJobLeaseError(transitionError) && transitionError.reason === 'lost') {
              this.logger.warn(`铺货队列任务 ${job.id} 在停权提交前已被接管`);
              return true;
            }
            throw transitionError;
          }
          return true;
        }
        if (isPublishJobLeaseError(err) && err.reason === 'lost') {
          this.logger.warn(`铺货队列任务 ${job.id} 租约已丢失，旧 worker 停止提交`);
          return true;
        }
        const failure =
          isPublishJobLeaseError(err) && err.leaseCause !== undefined ? err.leaseCause : err;
        try {
          await this.queue.fail(
            job,
            failure instanceof Error ? failure.message : '铺货任务执行失败',
          );
        } catch (transitionError) {
          if (isPublishJobLeaseError(transitionError) && transitionError.reason === 'lost') {
            this.logger.warn(`铺货队列任务 ${job.id} 在失败提交前已被接管`);
            return true;
          }
          throw transitionError;
        }
      }
      return true;
    } catch (err) {
      if (isDatabaseConnectionError(err)) {
        await this.prisma.reconnect().catch((reconnectError) => {
          this.logger.error(
            `数据库重连失败：${reconnectError instanceof Error ? reconnectError.message : 'unknown error'}`,
          );
        });
      }
      throw err;
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let count = 0; count < 10; count++) {
        if (!(await this.runOnce())) break;
      }
    } catch (err) {
      this.logger.error(`队列轮询失败：${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      this.draining = false;
    }
  }

  private pollIntervalMs(): number {
    const value = Number(this.config.get<string>('PUBLISH_QUEUE_POLL_MS') ?? 2_000);
    return Number.isInteger(value) && value >= 500 && value <= 60_000 ? value : 2_000;
  }
}

function startJobLeaseHeartbeat(
  queue: PublishQueueService,
  job: PublishJob,
  logger: Logger,
): { lease: PublishExecutionLease; stop: () => Promise<void> } {
  let failure: PublishJobLeaseError | null = null;
  let renewing: Promise<void> | null = null;
  let stopped = false;

  const assertOwned = async (): Promise<void> => {
    if (failure) throw failure;
    if (!renewing) {
      renewing = queue
        .renew(job)
        .catch((error: unknown) => {
          failure = isPublishJobLeaseError(error)
            ? error
            : new PublishJobLeaseError('unavailable', '铺货队列租约无法校验', error);
          throw failure;
        })
        .finally(() => {
          renewing = null;
        });
    }
    await renewing;
    if (failure) throw failure;
  };

  const timer = setInterval(() => {
    if (stopped || failure) return;
    void assertOwned().catch((error: unknown) => {
      logger.warn(`铺货队列任务 ${job.id} 续租失败：${errorMessage(error)}`);
    });
  }, PUBLISH_JOB_HEARTBEAT_MS);
  timer.unref();

  return {
    lease: { assertOwned },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await renewing?.catch(() => undefined);
    },
  };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
