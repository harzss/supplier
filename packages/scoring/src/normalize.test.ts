import { describe, expect, it } from 'vitest';
import { clamp, inverseLogScore, logScore, profitMarginScore, tanhCenter } from './normalize';

describe('normalize utils', () => {
  it('clamp bounds the value', () => {
    expect(clamp(-1)).toBe(0);
    expect(clamp(200)).toBe(100);
    expect(clamp(50)).toBe(50);
    expect(clamp(NaN)).toBe(0);
  });

  it('logScore: 0 → 0, scale → 100', () => {
    expect(logScore(0, 1000)).toBe(0);
    expect(logScore(undefined, 1000)).toBe(0);
    expect(logScore(1000, 1000)).toBeCloseTo(100, 0);
  });

  it('inverseLogScore: 0 competitors → 100', () => {
    expect(inverseLogScore(0, 1000)).toBe(100);
    expect(inverseLogScore(undefined, 1000)).toBe(70); // neutral fallback
    expect(inverseLogScore(1000, 1000)).toBeCloseTo(0, 0);
  });

  it('profitMarginScore: monotonic up to 1, flatter beyond', () => {
    expect(profitMarginScore(0)).toBe(0);
    expect(profitMarginScore(0.3)).toBeCloseTo(27, 0);
    expect(profitMarginScore(1)).toBe(90);
    expect(profitMarginScore(2)).toBeGreaterThan(95);
  });

  it('tanhCenter: 0 → 50, large positive → ~100', () => {
    expect(tanhCenter(0)).toBe(50);
    expect(tanhCenter(undefined)).toBe(50);
    expect(tanhCenter(3)).toBeGreaterThan(95);
    expect(tanhCenter(-3)).toBeLessThan(5);
  });
});
