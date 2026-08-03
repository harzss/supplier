import { describe, expect, it } from 'vitest';
import {
  UNLIMITED,
  canUseFeature,
  checkQuota,
  getPlan,
  getQuota,
  isPremiumFeature,
  listPlans,
  requiredPlanFor,
} from './plans';

describe('plans definition', () => {
  it('exposes all five plans in ascending order', () => {
    const plans = listPlans();
    expect(plans.map((p) => p.id)).toEqual(['free', 'basic', 'pro', 'flagship', 'enterprise']);
  });

  it('higher plans are supersets of lower plans (feature monotonicity)', () => {
    const free = new Set(getPlan('free').features);
    const basic = new Set(getPlan('basic').features);
    const pro = new Set(getPlan('pro').features);
    const flagship = new Set(getPlan('flagship').features);
    for (const f of free) expect(basic.has(f)).toBe(true);
    for (const f of basic) expect(pro.has(f)).toBe(true);
    for (const f of pro) expect(flagship.has(f)).toBe(true);
  });

  it('only advertises honest beta billing states', () => {
    const [free, ...unavailable] = listPlans();
    expect(free).toMatchObject({
      name: '内测版',
      billingStatus: 'internal_beta',
      billingLabel: '邀请内测 · ¥0 / 内测期',
    });
    for (const plan of unavailable) {
      expect(plan).toMatchObject({ billingStatus: 'unavailable', billingLabel: '暂未开放' });
    }
  });

  it('describes only implemented capabilities', () => {
    expect(listPlans().map((plan) => plan.highlight)).toEqual([
      '基础选品、AI 标题、单店铺货与批量下架',
      'AI 详情优化与单商品多店铺货',
      '主图处理（需图片服务就绪）、目标毛利与竞品区间定价、经营看板',
      '更高 AI 调用、店铺与铺货额度',
      'AI 调用、店铺与铺货额度不设上限',
    ]);
  });
});

describe('canUseFeature', () => {
  it('free plan can use basic features', () => {
    expect(canUseFeature('free', 'ai.title')).toBe(true);
    expect(canUseFeature('free', 'product.browse')).toBe(true);
    expect(canUseFeature('free', 'publish.single')).toBe(true);
    expect(canUseFeature('free', 'catalog.batch')).toBe(true);
  });

  it('free plan cannot use premium features', () => {
    expect(canUseFeature('free', 'ai.detail')).toBe(false);
    expect(canUseFeature('free', 'ai.image.watermark')).toBe(false);
    expect(canUseFeature('free', 'analytics.dashboard')).toBe(false);
  });

  it('pro unlocks image + analytics and higher plans preserve those features', () => {
    expect(canUseFeature('pro', 'ai.image.watermark')).toBe(true);
    expect(canUseFeature('pro', 'analytics.dashboard')).toBe(true);
    expect(canUseFeature('flagship', 'ai.image.watermark')).toBe(true);
  });

  it('enterprise can use every implemented feature', () => {
    for (const feature of getPlan('pro').features) {
      expect(canUseFeature('enterprise', feature)).toBe(true);
    }
  });
});

describe('isPremiumFeature', () => {
  it('classifies basic vs premium correctly', () => {
    expect(isPremiumFeature('ai.title')).toBe(false);
    expect(isPremiumFeature('product.browse')).toBe(false);
    expect(isPremiumFeature('catalog.batch')).toBe(false);
    expect(isPremiumFeature('ai.detail')).toBe(true);
    expect(isPremiumFeature('publish.batch')).toBe(true);
  });
});

describe('requiredPlanFor', () => {
  it('returns the cheapest plan that grants the feature', () => {
    expect(requiredPlanFor('ai.title')).toBe('free');
    expect(requiredPlanFor('catalog.batch')).toBe('free');
    expect(requiredPlanFor('ai.detail')).toBe('basic');
    expect(requiredPlanFor('publish.batch')).toBe('basic');
    expect(requiredPlanFor('ai.image.watermark')).toBe('pro');
  });
});

describe('getQuota + checkQuota', () => {
  it('reads monthly AI call quotas', () => {
    expect(getQuota('free', 'ai.calls.monthly')).toBe(20);
    expect(getQuota('pro', 'ai.calls.monthly')).toBe(3000);
    expect(getQuota('enterprise', 'ai.calls.monthly')).toBe(UNLIMITED);
  });

  it('flags exceeded when used reaches limit', () => {
    const c = checkQuota('free', 'ai.calls.monthly', 20);
    expect(c.exceeded).toBe(true);
    expect(c.remaining).toBe(0);
  });

  it('computes remaining below limit', () => {
    const c = checkQuota('free', 'ai.calls.monthly', 5);
    expect(c.exceeded).toBe(false);
    expect(c.remaining).toBe(15);
  });

  it('unlimited quota never exceeds', () => {
    const c = checkQuota('enterprise', 'ai.calls.monthly', 999999);
    expect(c.exceeded).toBe(false);
    expect(c.remaining).toBe(UNLIMITED);
  });
});
