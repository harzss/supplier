import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { AiModule } from '@supplier/db';
import { checkQuota, type QuotaCheck } from '@supplier/entitlements';
import type { UserPlan } from '@supplier/shared-types';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/prisma.module';
import { AlertService } from '../observability/alert.service';

export const AI_USAGE_RESERVATION_MODEL_PREFIX = 'pending/';
export const AI_USAGE_RESERVATION_STALE_MS = 10 * 60_000;

export interface PlatformUsageReservation {
  id: bigint;
  module: AiModule;
  pendingModel: string;
  traceId: string;
  quota: QuotaCheck;
}

export interface LlmUsageActual {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCny: number;
}

export interface ImageUsageActual {
  model: string;
  costCny: number;
}

/**
 * 平台 AI 用量账本。
 *
 * 付费调用必须先在 Serializable 事务中检查额度并写入预占记录。这样即使外部调用
 * 成功后的数据库回填失败，预占记录仍会消耗一次额度，并可由运维告警人工核对成本。
 */
@Injectable()
export class AiUsageService {
  private readonly logger = new Logger('AiUsage');

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertService,
  ) {}

  async reservePlatform(
    userId: bigint,
    plan: UserPlan,
    module: AiModule,
    requestedModel: string,
  ): Promise<PlatformUsageReservation> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const used = await tx.aiUsageLog.count({
              where: { userId, viaByok: false, createdAt: { gte: startOfMonth() } },
            });
            const quota = checkQuota(plan, 'ai.calls.monthly', used);
            if (quota.exceeded) throw quotaExceeded(quota);

            const pendingModel = `${AI_USAGE_RESERVATION_MODEL_PREFIX}${requestedModel}`.slice(
              0,
              64,
            );
            const traceId = randomUUID();
            const row = await tx.aiUsageLog.create({
              data: {
                userId,
                module,
                model: pendingModel,
                costCny: 0,
                viaByok: false,
                traceId,
              },
              select: { id: true },
            });
            return {
              id: row.id,
              module,
              pendingModel,
              traceId,
              quota: checkQuota(plan, 'ai.calls.monthly', used + 1),
            };
          },
          { isolationLevel: 'Serializable' },
        );
      } catch (error) {
        if (isSerializationConflict(error) && attempt < 3) continue;
        throw error;
      }
    }
    throw new Error('平台 AI 用量预占失败');
  }

  async completeLlm(
    reservation: PlatformUsageReservation,
    usage: LlmUsageActual,
  ): Promise<boolean> {
    return this.complete(reservation, {
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costCny: usage.costCny,
    });
  }

  async completeImage(
    reservation: PlatformUsageReservation,
    usage: ImageUsageActual,
  ): Promise<boolean> {
    return this.complete(reservation, {
      model: usage.model,
      imageCount: 1,
      costCny: usage.costCny,
    });
  }

  async cancel(reservation: PlatformUsageReservation, reason: string): Promise<boolean> {
    try {
      await retryMutation(async () => {
        const result = await this.prisma.aiUsageLog.deleteMany({
          where: {
            id: reservation.id,
            model: reservation.pendingModel,
            viaByok: false,
          },
        });
        if (result.count !== 1) throw new Error('预占记录不存在或已发生变化');
      });
      return true;
    } catch (error) {
      await this.reportReservationFailure('cancel', reservation, error, { reason });
      return false;
    }
  }

  async reportUnknownOutcome(reservation: PlatformUsageReservation, reason: string): Promise<void> {
    await this.reportReservationFailure('unknown_outcome', reservation, new Error(reason), {
      reason,
    });
  }

  /** BYOK 不占平台额度；日志失败只影响内部分析，不阻断用户自付调用。 */
  async recordByok(userId: bigint, module: AiModule, usage: LlmUsageActual): Promise<void> {
    try {
      await this.prisma.aiUsageLog.create({
        data: {
          userId,
          module,
          model: usage.model.slice(0, 64),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costCny: usage.costCny,
          viaByok: true,
        },
      });
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'byok_usage_write_failed',
          module,
          error: error instanceof Error ? error.name : 'unknown',
        }),
      );
    }
  }

  private async complete(
    reservation: PlatformUsageReservation,
    data: {
      model: string;
      inputTokens?: number;
      outputTokens?: number;
      imageCount?: number;
      costCny: number;
    },
  ): Promise<boolean> {
    try {
      await retryMutation(async () => {
        const result = await this.prisma.aiUsageLog.updateMany({
          where: {
            id: reservation.id,
            model: reservation.pendingModel,
            viaByok: false,
          },
          data: {
            model: data.model.slice(0, 64),
            inputTokens: data.inputTokens ?? 0,
            outputTokens: data.outputTokens ?? 0,
            imageCount: data.imageCount ?? 0,
            costCny: data.costCny,
          },
        });
        if (result.count !== 1) throw new Error('预占记录不存在或已发生变化');
      });
      return true;
    } catch (error) {
      await this.reportReservationFailure('finalize', reservation, error, {
        actualModel: data.model,
        inputTokens: data.inputTokens ?? 0,
        outputTokens: data.outputTokens ?? 0,
        imageCount: data.imageCount ?? 0,
        costCny: data.costCny,
      });
      return false;
    }
  }

  private async reportReservationFailure(
    phase: 'finalize' | 'cancel' | 'unknown_outcome',
    reservation: PlatformUsageReservation,
    error: unknown,
    details: Record<string, unknown>,
  ): Promise<void> {
    const errorType = error instanceof Error ? error.name : 'unknown';
    this.logger.error(
      JSON.stringify({
        event: 'ai_usage_reservation_unresolved',
        phase,
        traceId: reservation.traceId,
        module: reservation.module,
        error: errorType,
        ...details,
      }),
    );
    await this.alerts.raise({
      key: 'ai_usage.reservation_unresolved',
      type: 'billing',
      severity: 'critical',
      summary: '平台 AI 用量预占记录未能正常收敛',
      details: {
        phase,
        reservationId: reservation.id.toString(),
        traceId: reservation.traceId,
        module: reservation.module,
        errorType,
        ...details,
      },
    });
  }
}

function quotaExceeded(quota: QuotaCheck): HttpException {
  return new HttpException(
    {
      code: 'QUOTA_EXCEEDED',
      message: `本月 AI 额度已用完（${quota.used}/${quota.limit}）。可升级套餐，或在设置中配置自有 API Key 以继续使用。`,
      limit: quota.limit,
      used: quota.used,
    },
    HttpStatus.PAYMENT_REQUIRED,
  );
}

function isSerializationConflict(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'P2034';
}

async function retryMutation(operation: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function startOfMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}
