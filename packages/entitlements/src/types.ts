import type { UserPlan } from '@supplier/shared-types';

/** 套餐标识，复用 shared-types 的 UserPlan（free/basic/pro/flagship/enterprise） */
export type PlanId = UserPlan;

/**
 * 功能标识。分两类：
 * - 基础功能（免费版即可用，覆盖小店常用场景）
 * - 高级功能（需付费套餐解锁）
 * 命名用 `域.动作` 便于按域批量判断。
 */
export type FeatureId =
  // ---- 基础功能 ----
  | 'product.browse' // 浏览今日推荐
  | 'product.detail' // 查看商品详情与打分
  | 'ai.title' // AI 标题生成
  | 'publish.single' // 单店铺一键铺货
  | 'shops.connect' // 连接店铺
  // ---- 高级功能 ----
  | 'ai.detail' // AI 详情页文案优化
  | 'ai.image.watermark' // 主图去水印
  | 'ai.image.relight' // 主图重打光
  | 'ai.image.compose' // 主图换背景/合成
  | 'ai.customer_service' // AI 客服
  | 'ai.pricing' // 智能定价
  | 'publish.batch' // 批量多店铺铺货
  | 'analytics.dashboard' // 经营数据看板
  | 'crawler.custom'; // 自定义采集任务

/** 额度键。数值为「每自然月上限」或「资源上限」，-1 表示无限。 */
export type QuotaKey =
  | 'ai.calls.monthly' // 每月平台 AI 调用次数（BYOK 调用不计入）
  | 'shops.max' // 可连接店铺数上限
  | 'publish.monthly'; // 每月铺货商品数上限

export interface PlanDefinition {
  id: PlanId;
  /** 展示名 */
  name: string;
  /** 月费（人民币），0=免费，-1=定制（联系销售） */
  priceCnyMonthly: number;
  /** 该套餐授予的功能集合 */
  features: FeatureId[];
  /** 该套餐的额度 */
  quotas: Record<QuotaKey, number>;
  /** 卖点一句话 */
  highlight: string;
}

/** 额度校验结果 */
export interface QuotaCheck {
  key: QuotaKey;
  limit: number; // -1 = 无限
  used: number;
  remaining: number; // -1 = 无限
  exceeded: boolean;
}
