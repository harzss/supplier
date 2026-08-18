import { describe, expect, it } from 'vitest';
import {
  constrainAuditTestAiOptions,
  constrainAuditTestShopIds,
  nextAuditTestShopSelection,
} from './audit-test-scope';

describe('audit-test publish scope', () => {
  it('limits restored or submitted targets to one shop only in audit mode', () => {
    expect(constrainAuditTestShopIds(['shop-2', 'shop-1'], true)).toEqual(['shop-2']);
    expect(constrainAuditTestShopIds(['shop-2', 'shop-1'], false)).toEqual(['shop-2', 'shop-1']);
  });

  it('replaces the selected shop in audit mode while preserving normal multi-select behavior', () => {
    expect(nextAuditTestShopSelection(['shop-1'], 'shop-2', true)).toEqual(['shop-2']);
    expect(nextAuditTestShopSelection(['shop-1'], 'shop-1', true)).toEqual([]);
    expect(nextAuditTestShopSelection(['shop-1'], 'shop-2', false)).toEqual(['shop-1', 'shop-2']);
  });

  it('forces every main-image operation off without changing text AI options', () => {
    expect(
      constrainAuditTestAiOptions(
        {
          rewriteTitle: true,
          rewriteDetail: true,
          removeWatermark: true,
          relightImages: true,
          backgroundStyle: 'warm_lifestyle',
        },
        true,
      ),
    ).toEqual({
      rewriteTitle: true,
      rewriteDetail: true,
      removeWatermark: false,
      relightImages: false,
    });
  });

  it('leaves normal-mode AI options unchanged', () => {
    const options = {
      removeWatermark: true,
      relightImages: true,
      backgroundStyle: 'cool_minimal' as const,
    };
    expect(constrainAuditTestAiOptions(options, false)).toBe(options);
  });
});
