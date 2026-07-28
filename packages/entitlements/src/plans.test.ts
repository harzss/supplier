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
});

describe('canUseFeature', () => {
  it('free plan can use basic features', () => {
    expect(canUseFeature('free', 'ai.title')).toBe(true);
    expect(canUseFeature('free', 'product.browse')).toBe(true);
    expect(canUseFeature('free', 'publish.single')).toBe(true);
  });

  it('free plan cannot use premium features', () => {
    expect(canUseFeature('free', 'ai.detail')).toBe(false);
    expect(canUseFeature('free', 'ai.image.watermark')).toBe(false);
    expect(canUseFeature('free', 'analytics.dashboard')).toBe(false);
  });

  it('pro unlocks image + analytics, flagship unlocks customer service', () => {
    expect(canUseFeature('pro', 'ai.image.watermark')).toBe(true);
    expect(canUseFeature('pro', 'analytics.dashboard')).toBe(true);
    expect(canUseFeature('pro', 'ai.customer_service')).toBe(false);
    expect(canUseFeature('flagship', 'ai.customer_service')).toBe(true);
  });

  it('enterprise can use everything', () => {
    expect(canUseFeature('enterprise', 'ai.customer_service')).toBe(true);
    expect(canUseFeature('enterprise', 'crawler.custom')).toBe(true);
  });
});

describe('isPremiumFeature', () => {
  it('classifies basic vs premium correctly', () => {
    expect(isPremiumFeature('ai.title')).toBe(false);
    expect(isPremiumFeature('product.browse')).toBe(false);
    expect(isPremiumFeature('ai.detail')).toBe(true);
    expect(isPremiumFeature('ai.customer_service')).toBe(true);
  });
});

describe('requiredPlanFor', () => {
  it('returns the cheapest plan that grants the feature', () => {
    expect(requiredPlanFor('ai.title')).toBe('free');
    expect(requiredPlanFor('ai.detail')).toBe('basic');
    expect(requiredPlanFor('ai.image.watermark')).toBe('pro');
    expect(requiredPlanFor('ai.customer_service')).toBe('flagship');
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
