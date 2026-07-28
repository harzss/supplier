import {
  DEFAULT_WEIGHTS,
  type DimensionScore,
  type ProductScoreResult,
  type ScoringFeatures,
  type Weights,
} from './types';
import { clamp, inverseLogScore, logScore, profitMarginScore, tanhCenter } from './normalize';

/**
 * 计算单个商品的 5 维分数 + 综合分。
 * 纯函数 —— 同样的输入永远得到同样的输出，便于单测和回放。
 */
export function scoreProduct(
  features: ScoringFeatures,
  weights: Weights = DEFAULT_WEIGHTS,
): Omit<ProductScoreResult, 'reason'> {
  const demand = scoreDemand(features);
  const competition = scoreCompetition(features);
  const profit = scoreProfit(features);
  const compliance = scoreCompliance(features);
  const trend = scoreTrend(features);

  const overall =
    demand.score * weights.demand +
    competition.score * weights.competition +
    profit.score * weights.profit +
    compliance.score * weights.compliance +
    trend.score * weights.trend;

  return {
    productId1688: features.productId1688,
    overall: round(overall),
    demand,
    competition,
    profit,
    compliance,
    trend,
    weights,
  };
}

// ---- 各维度打分 ----

function scoreDemand(f: ScoringFeatures): DimensionScore {
  // 综合三个信号：抖音 7d / 30d 热度 + 1688 月销
  const douyin7 = logScore(f.douyinHeat7d, 100_000);
  const douyin30 = logScore(f.douyinHeat30d, 500_000);
  const sold = logScore(f.monthlySold1688, 50_000);
  const xhs = logScore(f.xhsNoteCount30d, 5_000);
  // 抖音权重最高（决策最相关）
  const score = clamp(douyin7 * 0.35 + douyin30 * 0.25 + sold * 0.25 + xhs * 0.15);

  const notes: string[] = [];
  if (douyin7 >= 70) notes.push(`抖音 7 日热度高（${f.douyinHeat7d ?? 0}）`);
  else if (douyin30 >= 70) notes.push(`抖音 30 日热度稳定`);
  if (sold >= 70) notes.push(`1688 月销 ${f.monthlySold1688} 单`);
  return { score: round(score), notes };
}

function scoreCompetition(f: ScoringFeatures): DimensionScore {
  // 同款越多越红海。淘宝同款 + 抖音达人。
  const tb = inverseLogScore(f.taobaoSameStyleCount, 5_000);
  const dy = inverseLogScore(f.douyinSameStyleCount, 1_000);
  const score = clamp(tb * 0.6 + dy * 0.4);

  const notes: string[] = [];
  if (score >= 75) notes.push('竞争温和，蓝海空间');
  else if (score < 40) notes.push(`同款过多（淘宝 ${f.taobaoSameStyleCount ?? '?'}）`);
  return { score: round(score), notes };
}

function scoreProfit(f: ScoringFeatures): DimensionScore {
  const cost = f.purchasePrice;
  const ship = f.estimatedShipping ?? 0;
  const median = f.competitorMedianPrice;

  // 缺竞品价时退化为按 1688 价的"经验加成倍率"估算
  if (!median || median <= 0) {
    const guessRetail = cost * 2.2; // 经验倍率
    const margin = (guessRetail - cost - ship) / Math.max(cost, 0.01);
    return {
      score: round(profitMarginScore(margin) * 0.85), // 缺真实数据，打 85 折保守化
      notes: ['竞品价缺失，按经验倍率 2.2 估算'],
    };
  }

  const margin = (median - cost - ship) / Math.max(cost, 0.01);
  const score = profitMarginScore(margin);

  const notes: string[] = [];
  const marginPct = (margin * 100).toFixed(0);
  if (margin >= 0.5) notes.push(`利润率约 ${marginPct}%（毛利空间大）`);
  else if (margin <= 0.2) notes.push(`利润率仅 ${marginPct}%，慎选`);
  return { score: round(score), notes };
}

function scoreCompliance(f: ScoringFeatures): DimensionScore {
  let base = 100;
  const risk = f.categoryRiskLevel ?? 'low';
  if (risk === 'medium') base -= 15;
  if (risk === 'high') base -= 35;

  const hits = f.sensitiveWordsHit ?? 0;
  base -= Math.min(hits * 8, 40);

  const score = clamp(base);
  const notes: string[] = [];
  if (risk === 'high') notes.push('类目高风险（食品/医疗/化妆品类）');
  if (hits > 0) notes.push(`命中 ${hits} 个敏感词，需改写`);
  return { score: round(score), notes };
}

function scoreTrend(f: ScoringFeatures): DimensionScore {
  // 30 日增长率：50% → 70 分，100% → 88 分
  const rate = f.growthRate30d ?? 0;
  const score = tanhCenter(rate * 1.5);

  const notes: string[] = [];
  if (rate >= 0.5) notes.push(`30 日热度 +${(rate * 100).toFixed(0)}%`);
  else if (rate <= -0.2) notes.push('热度下滑，已过风口');
  return { score: round(score), notes };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
