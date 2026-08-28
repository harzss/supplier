import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PublishJob } from '@supplier/db';
import { PrismaService } from '../../common/prisma.module';
import { PUBLISH_JOB_STALE_MS, PublishJobLeaseError } from './publish-job-lease';
import { publishMaxAttempts } from './publish-queue.config';

const ORPHAN_TASK_GRACE_MS = 60_000;

@Injectable()
export class PublishQueueService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  isEnabled(): boolean {
    return this.config.get<string>('PUBLISH_QUEUE_MODE') !== 'inline';
  }

  async claimNext(workerId: string): Promise<PublishJob | null> {
    const now = new Date();
    await this.recoverStale(now);
    await this.recoverOrphanTasks(now);
    for (let index = 0; index < 5; index++) {
      const candidate = await this.prisma.publishJob.findFirst({
        where: {
          status: { in: ['queued', 'retry_wait'] },
          nextRunAt: { lte: now },
          task: { user: { status: 'active', entitlementAccessStatus: 'active' } },
        },
        orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
      });
      if (!candidate) return null;
      const claimed = await this.prisma.publishJob.updateMany({
        where: {
          id: candidate.id,
          status: candidate.status,
          attempts: candidate.attempts,
          task: { user: { status: 'active', entitlementAccessStatus: 'active' } },
        },
        data: {
          status: 'running',
          attempts: { increment: 1 },
          lockedAt: now,
          lockedBy: workerId,
          lastError: null,
        },
      });
      if (claimed.count === 1) {
        return this.prisma.publishJob.findUnique({ where: { id: candidate.id } });
      }
    }
    return null;
  }

  async complete(job: PublishJob): Promise<void> {
    const updated = await this.prisma.publishJob.updateMany({
      where: {
        id: job.id,
        status: 'running',
        attempts: job.attempts,
        lockedBy: job.lockedBy,
      },
      data: {
        status: 'completed',
        lockedAt: null,
        lockedBy: null,
        lastError: null,
      },
    });
    assertOwnedTransition(updated.count);
  }

  async renew(job: PublishJob): Promise<void> {
    const updated = await this.prisma.publishJob.updateMany({
      where: ownedJobWhere(job),
      data: { lockedAt: new Date() },
    });
    assertOwnedTransition(updated.count);
  }

  async fail(job: PublishJob, error: string): Promise<'retry_wait' | 'dead'> {
    const message = error.slice(0, 1000);
    if (job.attempts >= job.maxAttempts) {
      await this.prisma.$transaction(async (tx) => {
        const updated = await tx.publishJob.updateMany({
          where: ownedJobWhere(job),
          data: {
            status: 'dead',
            lockedAt: null,
            lockedBy: null,
            lastError: message,
          },
        });
        assertOwnedTransition(updated.count);
        await tx.publishTask.update({
          where: { id: job.taskId },
          data: { status: 'failed', errorMsg: message, finishedAt: new Date() },
        });
      });
      return 'dead';
    }

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.publishJob.updateMany({
        where: ownedJobWhere(job),
        data: {
          status: 'retry_wait',
          nextRunAt: new Date(Date.now() + retryDelayMs(job.attempts)),
          lockedAt: null,
          lockedBy: null,
          lastError: message,
        },
      });
      assertOwnedTransition(updated.count);
      await tx.publishTask.update({
        where: { id: job.taskId },
        data: { status: 'pending', errorMsg: message, finishedAt: null },
      });
    });
    return 'retry_wait';
  }

  async blockForAccessChange(job: PublishJob, error: string): Promise<void> {
    const message = error.slice(0, 1000);
    const finishedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.publishJob.updateMany({
        where: ownedJobWhere(job),
        data: {
          status: 'dead',
          lockedAt: null,
          lockedBy: null,
          lastError: message,
        },
      });
      assertOwnedTransition(updated.count);
      const publishedCount = await tx.publishedProduct.count({ where: { taskId: job.taskId } });
      await tx.publishTask.update({
        where: { id: job.taskId },
        data: {
          status: publishedCount > 0 ? 'partial' : 'failed',
          errorMsg: message,
          finishedAt,
        },
      });
    });
  }

  async manualRetry(
    userId: bigint,
    taskIdValue: string,
  ): Promise<{ taskId: string; queued: true }> {
    const taskId = parseTaskId(taskIdValue);
    await this.prisma.$transaction(async (tx) => {
      const task = await tx.publishTask.findFirst({
        where: {
          id: taskId,
          userId,
          user: { status: 'active', entitlementAccessStatus: 'active' },
        },
        select: { id: true, status: true },
      });
      if (!task) throw new NotFoundException('铺货任务不存在');
      if (!['failed', 'partial'].includes(task.status)) {
        throw new BadRequestException('只有失败或部分成功的任务可以重试');
      }
      const maxAttempts = publishMaxAttempts(this.config);
      await tx.publishJob.upsert({
        where: { taskId },
        create: { taskId, maxAttempts },
        update: {
          status: 'queued',
          attempts: 0,
          maxAttempts,
          nextRunAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastError: null,
        },
      });
      await tx.publishTask.update({
        where: { id: taskId },
        data: { status: 'pending', errorMsg: null, finishedAt: null },
      });
    });
    return { taskId: taskId.toString(), queued: true };
  }

  private async recoverStale(now: Date): Promise<void> {
    await this.prisma.publishJob.updateMany({
      where: {
        status: 'running',
        lockedAt: { lt: new Date(now.getTime() - PUBLISH_JOB_STALE_MS) },
        task: { user: { status: 'active', entitlementAccessStatus: 'active' } },
      },
      data: {
        status: 'retry_wait',
        nextRunAt: now,
        lockedAt: null,
        lockedBy: null,
        lastError: 'worker 超时，任务已自动恢复',
      },
    });
  }

  private async recoverOrphanTasks(now: Date): Promise<void> {
    const tasks = await this.prisma.publishTask.findMany({
      where: {
        status: 'pending',
        job: { is: null },
        createdAt: { lt: new Date(now.getTime() - ORPHAN_TASK_GRACE_MS) },
        user: { status: 'active', entitlementAccessStatus: 'active' },
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: { id: true },
    });
    if (!tasks.length) return;
    await this.prisma.publishJob.createMany({
      data: tasks.map((task) => ({
        taskId: task.id,
        maxAttempts: publishMaxAttempts(this.config),
      })),
      skipDuplicates: true,
    });
  }
}

function retryDelayMs(attempts: number): number {
  return Math.min(5 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1));
}

function ownedJobWhere(job: PublishJob) {
  // Access eligibility decides whether another external effect may start. It must not revoke the
  // current worker's lease before that worker records an effect which has already returned.
  return {
    id: job.id,
    status: 'running' as const,
    attempts: job.attempts,
    lockedBy: job.lockedBy,
  };
}

function assertOwnedTransition(count: number): void {
  if (count !== 1) {
    throw new PublishJobLeaseError('lost', '铺货队列任务所有权已变化');
  }
}

function parseTaskId(value: string): bigint {
  try {
    const id = BigInt(value);
    if (id <= 0n) throw new Error('invalid');
    return id;
  } catch {
    throw new BadRequestException('无效任务 ID');
  }
}
