import type { FeatureId, PlanDefinition, PlanId, QuotaCheck, QuotaKey } from './types';

/** 无限额度标记 */
export const UNLIMITED = -1;

/** 套餐由低到高的排序，用于「满足某功能的最低套餐」推断 */
export const PLAN_ORDER: PlanId[] = ['free', 'basic', 'pro', 'flagship', 'enterprise'];

/** 基础功能：免费版即可用，覆盖小型店铺日常 */
const BASIC_FEATURES: FeatureId[] = [
  'product.browse',
  'product.detail',
  'ai.title',
  'publish.single',
  'shops.connect',
];

/** basic 相比 free 新增 */
const BASIC_PLAN_EXTRA: FeatureId[] = ['ai.detail', 'publish.batch'];

/** pro 相比 basic 新增 */
const PRO_EXTRA: FeatureId[] = [
  'ai.image.watermark',
  'ai.image.relight',
  'ai.image.compose',
  'analytics.dashboard',
  'ai.pricing',
];

/** flagship 相比 pro 新增 */
const FLAGSHIP_EXTRA: FeatureId[] = ['ai.customer_service', 'crawler.custom'];

const FREE_FEATURES = BASIC_FEATURES;
const BASIC_ALL = [...FREE_FEATURES, ...BASIC_PLAN_EXTRA];
const PRO_ALL = [...BASIC_ALL, ...PRO_EXTRA];
const FLAGSHIP_ALL = [...PRO_ALL, ...FLAGSHIP_EXTRA];
const ALL_FEATURES = FLAGSHIP_ALL; // enterprise 拥有全部

export const PLANS: Record<PlanId, PlanDefinition> = {
  free: {
    id: 'free',
    name: '免费版',
    priceCnyMonthly: 0,
    features: [...FREE_FEATURES],
    quotas: { 'ai.calls.monthly': 20, 'shops.max': 1, 'publish.monthly': 50 },
    highlight: '基础选品与铺货，小店起步够用',
  },
  basic: {
    id: 'basic',
    name: '基础版',
    priceCnyMonthly: 39,
    features: [...BASIC_ALL],
    quotas: { 'ai.calls.monthly': 500, 'shops.max': 3, 'publish.monthly': 1000 },
    highlight: '多店铺 + 批量铺货 + AI 详情优化',
  },
  pro: {
    id: 'pro',
    name: '专业版',
    priceCnyMonthly: 99,
    features: [...PRO_ALL],
    quotas: { 'ai.calls.monthly': 3000, 'shops.max': 10, 'publish.monthly': 10000 },
    highlight: 'AI 主图处理 + 智能定价 + 数据看板',
  },
  flagship: {
    id: 'flagship',
    name: '旗舰版',
    priceCnyMonthly: 299,
    features: [...FLAGSHIP_ALL],
    quotas: { 'ai.calls.monthly': 20000, 'shops.max': 50, 'publish.monthly': UNLIMITED },
    highlight: 'AI 客服 + 自定义采集 + 全功能',
  },
  enterprise: {
    id: 'enterprise',
    name: '企业版',
    priceCnyMonthly: UNLIMITED, // 定制报价
    features: [...ALL_FEATURES],
    quotas: { 'ai.calls.monthly': UNLIMITED, 'shops.max': UNLIMITED, 'publish.monthly': UNLIMITED },
    highlight: '无限额度 + 专属供应链 + API 开放',
  },
};

/** 取套餐定义 */
export function getPlan(plan: PlanId): PlanDefinition {
  return PLANS[plan];
}

/** 该套餐是否可用某功能 */
export function canUseFeature(plan: PlanId, feature: FeatureId): boolean {
  return PLANS[plan].features.includes(feature);
}

/** 取某额度上限，-1 表示无限 */
export function getQuota(plan: PlanId, key: QuotaKey): number {
  return PLANS[plan].quotas[key];
}

/** 功能是否属于高级功能（免费版不含即为高级） */
export function isPremiumFeature(feature: FeatureId): boolean {
  return !PLANS.free.features.includes(feature);
}

/** 满足某功能的最低套餐（用于升级引导）；无套餐满足则返回 null */
export function requiredPlanFor(feature: FeatureId): PlanId | null {
  for (const plan of PLAN_ORDER) {
    if (PLANS[plan].features.includes(feature)) return plan;
  }
  return null;
}

/** 满足某额度需求（needed）的最低套餐（用于配额升级引导）；无满足返回 null */
export function planForQuota(key: QuotaKey, needed: number): PlanId | null {
  for (const plan of PLAN_ORDER) {
    const q = getQuota(plan, key);
    if (q === UNLIMITED || q >= needed) return plan;
  }
  return null;
}

/** 按由低到高顺序列出全部套餐 */
export function listPlans(): PlanDefinition[] {
  return PLAN_ORDER.map((id) => PLANS[id]);
}

/**
 * 校验额度使用情况。
 * @param used 当前已使用量（如本月已调用次数）
 */
export function checkQuota(plan: PlanId, key: QuotaKey, used: number): QuotaCheck {
  const limit = getQuota(plan, key);
  if (limit === UNLIMITED) {
    return { key, limit: UNLIMITED, used, remaining: UNLIMITED, exceeded: false };
  }
  const remaining = Math.max(0, limit - used);
  return { key, limit, used, remaining, exceeded: used >= limit };
}
