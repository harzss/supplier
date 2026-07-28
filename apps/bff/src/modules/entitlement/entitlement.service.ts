import { ForbiddenException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  UNLIMITED,
  canUseFeature,
  checkQuota,
  getPlan,
  getQuota,
  listPlans,
  planForQuota,
  requiredPlanFor,
  type FeatureId,
  type PlanId,
  type QuotaCheck,
  type QuotaKey,
} from '@supplier/entitlements';
import type { UserPlan } from '@supplier/shared-types';
import { PrismaService } from '../../common/prisma.module';

export interface EntitlementView {
  plan: PlanId;
  planName: string;
  features: FeatureId[];
  aiUsage: { used: number; limit: number; remaining: number; exceeded: boolean };
  quotas: { shopsMax: number; publishMonthly: number };
  plans: Array<{
    id: PlanId;
    name: string;
    priceCnyMonthly: number;
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

  /** 功能门禁：无权限抛 403，附带升级所需套餐 */
  assertFeature(plan: UserPlan, feature: FeatureId): void {
    if (!canUseFeature(plan, feature)) {
      const rp = requiredPlanFor(feature);
      throw new ForbiddenException({
        code: 'FEATURE_LOCKED',
        feature,
        requiredPlan: rp,
        message: rp ? `该功能需要「${getPlan(rp).name}」及以上套餐` : '该功能暂不可用',
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

  /** 通用配额校验：requestedTotal 超过上限则抛 402，并给出可满足的套餐 */
  assertWithinQuota(plan: UserPlan, key: QuotaKey, requestedTotal: number): void {
    const limit = getQuota(plan, key);
    if (limit === UNLIMITED || requestedTotal <= limit) return;
    const suggested = planForQuota(key, requestedTotal);
    throw new HttpException(
      {
        code: 'QUOTA_EXCEEDED',
        quota: key,
        limit,
        requested: requestedTotal,
        requiredPlan: suggested,
        message: suggested
          ? `已达当前套餐上限（${limit}），升级到「${getPlan(suggested).name}」可继续。`
          : `已达上限（${limit}）。`,
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

  /** 供前端展示：当前套餐、功能、用量、可升级套餐列表 */
  async buildView(userId: bigint, plan: UserPlan): Promise<EntitlementView> {
    const p = getPlan(plan);
    const used = await this.getMonthlyAiUsage(userId);
    const ai = checkQuota(plan, 'ai.calls.monthly', used);
    return {
      plan,
      planName: p.name,
      features: p.features,
      aiUsage: { used: ai.used, limit: ai.limit, remaining: ai.remaining, exceeded: ai.exceeded },
      quotas: { shopsMax: p.quotas['shops.max'], publishMonthly: p.quotas['publish.monthly'] },
      plans: listPlans().map((x) => ({
        id: x.id,
        name: x.name,
        priceCnyMonthly: x.priceCnyMonthly,
        highlight: x.highlight,
        features: x.features,
      })),
    };
  }
}

function startOfMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}
