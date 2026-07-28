import { describe, expect, it } from 'vitest';
import { scoreProduct } from './scorer';
import { scoreProductWithReason } from './reason';
import type { ScoringFeatures } from './types';

const baseFeatures: ScoringFeatures = {
  productId1688: 'mock-1',
  title: '测试商品',
  categoryL1: '女装',
  purchasePrice: 20,
};

describe('scoreProduct', () => {
  it('returns 5 dimensions and a weighted overall', () => {
    const r = scoreProduct(baseFeatures);
    expect(r.productId1688).toBe('mock-1');
    expect(r.overall).toBeGreaterThanOrEqual(0);
    expect(r.overall).toBeLessThanOrEqual(100);
    for (const dim of [r.demand, r.competition, r.profit, r.compliance, r.trend]) {
      expect(dim.score).toBeGreaterThanOrEqual(0);
      expect(dim.score).toBeLessThanOrEqual(100);
    }
  });

  it('rewards high douyin heat (demand)', () => {
    const low = scoreProduct({ ...baseFeatures, douyinHeat7d: 100 });
    const high = scoreProduct({ ...baseFeatures, douyinHeat7d: 80_000 });
    expect(high.demand.score).toBeGreaterThan(low.demand.score);
  });

  it('penalizes high competitor count', () => {
    const blue = scoreProduct({ ...baseFeatures, taobaoSameStyleCount: 50 });
    const red = scoreProduct({ ...baseFeatures, taobaoSameStyleCount: 5_000 });
    expect(blue.competition.score).toBeGreaterThan(red.competition.score);
  });

  it('profit reflects markup margin from competitor median', () => {
    const lowMargin = scoreProduct({
      ...baseFeatures,
      purchasePrice: 20,
      competitorMedianPrice: 22, // 利润率 ~10%
    });
    const fatMargin = scoreProduct({
      ...baseFeatures,
      purchasePrice: 20,
      competitorMedianPrice: 60, // 利润率 ~200%
    });
    expect(fatMargin.profit.score).toBeGreaterThan(lowMargin.profit.score);
    expect(fatMargin.profit.score).toBeGreaterThan(70);
  });

  it('compliance drops with sensitive words and high-risk category', () => {
    const safe = scoreProduct(baseFeatures);
    const risky = scoreProduct({
      ...baseFeatures,
      categoryRiskLevel: 'high',
      sensitiveWordsHit: 3,
    });
    expect(risky.compliance.score).toBeLessThan(safe.compliance.score);
  });

  it('trend score moves with growth rate', () => {
    const flat = scoreProduct({ ...baseFeatures, growthRate30d: 0 });
    const rising = scoreProduct({ ...baseFeatures, growthRate30d: 1.0 });
    const falling = scoreProduct({ ...baseFeatures, growthRate30d: -0.4 });
    expect(rising.trend.score).toBeGreaterThan(flat.trend.score);
    expect(falling.trend.score).toBeLessThan(flat.trend.score);
  });

  it('weights override change ranking', () => {
    const wDemand = scoreProduct(
      { ...baseFeatures, douyinHeat7d: 80_000, taobaoSameStyleCount: 5_000 },
      { demand: 0.8, competition: 0.05, profit: 0.05, compliance: 0.05, trend: 0.05 },
    );
    const wCompetition = scoreProduct(
      { ...baseFeatures, douyinHeat7d: 80_000, taobaoSameStyleCount: 5_000 },
      { demand: 0.05, competition: 0.8, profit: 0.05, compliance: 0.05, trend: 0.05 },
    );
    expect(wDemand.overall).toBeGreaterThan(wCompetition.overall);
  });

  it('is deterministic — same input → same output', () => {
    const a = scoreProduct(baseFeatures);
    const b = scoreProduct(baseFeatures);
    expect(a).toEqual(b);
  });
});

describe('scoreProductWithReason (template fallback)', () => {
  it('produces non-empty reasons without LLM', async () => {
    const r = await scoreProductWithReason(
      {
        ...baseFeatures,
        douyinHeat7d: 50_000,
        monthlySold1688: 8_000,
        taobaoSameStyleCount: 200,
        competitorMedianPrice: 50,
      },
      { forceTemplate: true },
    );
    expect(r.reason.length).toBeGreaterThan(0);
    expect(r.reason.length).toBeLessThanOrEqual(3);
  });
});
