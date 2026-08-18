import { ForbiddenException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  UNLIMITED,
  canUseFeature,
  checkQuota,
  getPlan,
  getQuota,
  listPlans,
  type BillingStatus,
  type FeatureId,
  type PlanId,
  type QuotaCheck,
  type QuotaKey,
} from '@supplier/entitlements';
import type { EntitlementAccessStatus, UserPlan } from '@supplier/shared-types';
import { PrismaService } from '../../common/prisma.module';

export interface EntitlementView {
  accessStatus: EntitlementAccessStatus;
  plan: PlanId | null;
  planName: string;
  features: FeatureId[];
  aiUsage: { used: number; limit: number; remaining: number; exceeded: boolean };
  quotas: { shopsMax: number; publishMonthly: number };
  plans: Array<{
    id: PlanId;
    name: string;
    billingStatus: BillingStatus;
    billingLabel: string;
    highlight: string;
    features: FeatureId[];
  }>;
}

@Injectable()
export class EntitlementService {
  private readonly demoMode: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.demoMode = (config.get<string>('AUTH_MODE') ?? 'demo') === 'demo';
  }

  /** 功能门禁：无权限抛 403，不对外暴露内部权限档位。 */
  assertFeature(plan: UserPlan, feature: FeatureId): void {
    if (!canUseFeature(plan, feature)) {
      throw new ForbiddenException({
        code: 'FEATURE_LOCKED',
        feature,
        message: '当前内测账号未开放此能力，请申请内测扩容。',
      });
    }
  }

  /** 本月平台 AI 调用次数；无法可靠计量时必须阻断平台额度调用。 */
  async getMonthlyAiUsage(userId: bigint): Promise<number> {
    // 仅统计平台额度调用；BYOK（用户自付）不计入
    return this.prisma.aiUsageLog.count({
      where: { userId, viaByok: false, createdAt: { gte: startOfMonth() } },
    });
  }

  /** 校验本月 AI 额度（BYOK 调用方需自行跳过本检查） */
  async checkAiQuota(userId: bigint, plan: UserPlan): Promise<QuotaCheck> {
    const used = await this.getMonthlyAiUsage(userId);
    return checkQuota(plan, 'ai.calls.monthly', used);
  }

  /** 通用配额校验：requestedTotal 超过上限则抛 402。 */
  assertWithinQuota(plan: UserPlan, key: QuotaKey, requestedTotal: number): void {
    const limit = getQuota(plan, key);
    if (limit === UNLIMITED || requestedTotal <= limit) return;
    throw new HttpException(
      {
        code: 'QUOTA_EXCEEDED',
        quota: key,
        limit,
        requested: requestedTotal,
        message: `已达当前内测权限上限（${limit}），请申请内测扩容。`,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }

  /** 本月已铺货商品数；无法可靠计量时不能继续创建铺货任务。 */
  async getMonthlyPublishCount(userId: bigint): Promise<number> {
    return this.prisma.publishedProduct.count({
      where: {
        task: { userId },
        publishedAt: { gte: startOfMonth() },
        ...(this.demoMode ? {} : { shop: { NOT: { platformShopId: { startsWith: 'demo-' } } } }),
      },
    });
  }

  /** 供前端展示：当前套餐、功能、用量与套餐开放状态 */
  async buildView(
    userId: bigint,
    plan: UserPlan,
    accessStatus: EntitlementAccessStatus,
  ): Promise<EntitlementView> {
    const p = getPlan(plan);
    const used = await this.getMonthlyAiUsage(userId);
    const active = accessStatus === 'active';
    const ai = active
      ? checkQuota(plan, 'ai.calls.monthly', used)
      : { used, limit: 0, remaining: 0, exceeded: true };
    return {
      accessStatus,
      plan: this.demoMode ? plan : null,
      planName: active ? (this.demoMode ? p.name : '邀请制内测') : '权益已暂停',
      features: active ? p.features : [],
      aiUsage: { used: ai.used, limit: ai.limit, remaining: ai.remaining, exceeded: ai.exceeded },
      quotas: active
        ? { shopsMax: p.quotas['shops.max'], publishMonthly: p.quotas['publish.monthly'] }
        : { shopsMax: 0, publishMonthly: 0 },
      plans:
        active && this.demoMode
          ? listPlans().map((x) => ({
              id: x.id,
              name: x.name,
              billingStatus: x.billingStatus,
              billingLabel: x.billingLabel,
              highlight: x.highlight,
              features: x.features,
            }))
          : [],
    };
  }
}

function startOfMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}
