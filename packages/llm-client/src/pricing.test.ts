import { describe, expect, it } from 'vitest';
import { calcCostCny } from './pricing';

describe('calcCostCny', () => {
  it('charges deepseek-v3 cheaply', () => {
    // 1000 input, 500 output → 0.0014 + 0.0014 = 0.0028
    expect(calcCostCny('deepseek-v3', 1000, 500)).toBeCloseTo(0.0028, 6);
  });

  it('charges gpt-4o more expensively', () => {
    expect(calcCostCny('gpt-4o', 1000, 500)).toBeCloseTo(0.054, 6);
  });

  it('returns 0 for unknown model', () => {
    // @ts-expect-error testing fallback
    expect(calcCostCny('unknown-model', 1000, 500)).toBe(0);
  });
});
