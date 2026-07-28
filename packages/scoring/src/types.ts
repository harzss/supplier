/**
 * 打分输入：来自采集 / 外部数据回流
 * 任何字段缺失时打分器会用保守默认值，不抛错。
 */
export interface ScoringFeatures {
  // ---- 商品基础 ----
  productId1688: string;
  title: string;
  categoryL1?: string;
  categoryL2?: string;
  /** 1688 进货价（元） */
  purchasePrice: number;
  /** 1688 月销量 */
  monthlySold1688?: number;

  // ---- 需求信号 ----
  /** 抖音近 7 日热度（自定义指标，0+） */
  douyinHeat7d?: number;
  /** 抖音近 30 日热度 */
  douyinHeat30d?: number;
  /** 小红书近 30 日笔记数 */
  xhsNoteCount30d?: number;

  // ---- 竞争信号 ----
  /** 淘宝同款数量 */
  taobaoSameStyleCount?: number;
  /** 抖音同款达人数 */
  douyinSameStyleCount?: number;
  /** 销售平台同款价格中位（元） */
  competitorMedianPrice?: number;

  // ---- 利润信号 ----
  /** 预估运费（元） */
  estimatedShipping?: number;

  // ---- 合规信号 ----
  /** 类目风险等级 */
  categoryRiskLevel?: 'low' | 'medium' | 'high';
  /** 标题/详情命中敏感词数 */
  sensitiveWordsHit?: number;

  // ---- 趋势信号 ----
  /** 30 日热度增长率（小数，0.5 = 50%） */
  growthRate30d?: number;
}

/** 单维度分数 + 解释（用于推荐理由生成） */
export interface DimensionScore {
  score: number;
  /** 该维度关键的人话解释，最多两条 */
  notes: string[];
}

export interface ProductScoreResult {
  productId1688: string;
  overall: number;
  demand: DimensionScore;
  competition: DimensionScore;
  profit: DimensionScore;
  compliance: DimensionScore;
  trend: DimensionScore;
  /** 综合推荐理由（人类可读，<=2 句） */
  reason: string[];
  /** 各维度权重快照，便于复现 */
  weights: Weights;
}

export interface Weights {
  demand: number;
  competition: number;
  profit: number;
  compliance: number;
  trend: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  demand: 0.3,
  competition: 0.2,
  profit: 0.25,
  compliance: 0.15,
  trend: 0.1,
};
