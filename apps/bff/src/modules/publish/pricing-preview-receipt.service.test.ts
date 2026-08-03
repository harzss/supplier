import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CryptoService } from '../../common/crypto.module';
import { PricingPreviewReceiptService } from './pricing-preview-receipt.service';

const INPUT = {
  userId: 7n,
  sourceProductId: '1688-1001',
  pricingStrategy: {
    mode: 'profit_target' as const,
    targetMargin: 0.3,
    estimatedShipping: 4,
    platformFeeRate: 0.05,
  },
  costPrice: 10,
  sourcePricingFingerprint: 'a'.repeat(64),
};

describe('PricingPreviewReceiptService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
  });

  afterEach(() => vi.useRealTimers());

  it('binds a preview to the user, product, pricing inputs and current cost', () => {
    const service = createService();
    const receipt = service.issue(INPUT);

    expect(receipt.pricingPreviewExpiresAt).toBe('2026-08-03T12:30:00.000Z');
    expect(receipt.sourcePricingFingerprint).toBe('a'.repeat(64));
    expect(() => service.assertValid(receipt.pricingPreviewToken, INPUT)).not.toThrow();
    expect(() =>
      service.assertValid(receipt.pricingPreviewToken, { ...INPUT, costPrice: 10.01 }),
    ).toThrow('售价、成本或试算参数已变化');
    expect(() =>
      service.assertValid(receipt.pricingPreviewToken, {
        ...INPUT,
        pricingStrategy: { ...INPUT.pricingStrategy, targetMargin: 0.31 },
      }),
    ).toThrow('售价、成本或试算参数已变化');
    expect(() =>
      service.assertValid(receipt.pricingPreviewToken, { ...INPUT, userId: 8n }),
    ).toThrow('售价、成本或试算参数已变化');
    expect(() =>
      service.assertValid(receipt.pricingPreviewToken, {
        ...INPUT,
        sourcePricingFingerprint: 'b'.repeat(64),
      }),
    ).toThrow('售价、成本或试算参数已变化');
  });

  it('rejects missing, tampered and expired preview receipts', () => {
    const service = createService();
    expect(() => service.assertValid(undefined, INPUT)).toThrow('请先完成售价与利润试算');

    const receipt = service.issue(INPUT);
    const parts = receipt.pricingPreviewToken.split('.');
    parts[2] = `${parts[2]?.startsWith('A') ? 'B' : 'A'}${parts[2]?.slice(1)}`;
    expect(() => service.assertValid(parts.join('.'), INPUT)).toThrow('售价、成本或试算参数已变化');

    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    expect(() => service.assertValid(receipt.pricingPreviewToken, INPUT)).toThrow('利润试算已过期');
  });
});

function createService(): PricingPreviewReceiptService {
  const crypto = new CryptoService({
    get: (key: string) => (key === 'ENCRYPTION_KEY' ? 'pricing-preview-test-secret' : undefined),
  } as ConfigService);
  return new PricingPreviewReceiptService(crypto);
}
