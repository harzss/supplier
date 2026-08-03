import { BadRequestException, Injectable } from '@nestjs/common';
import { CryptoService } from '../../common/crypto.module';
import type { PricingStrategyDto } from './dto/create-publish-task.dto';
import { pricingInput } from './pricing';

const RECEIPT_PURPOSE = 'publish-pricing-preview';
const RECEIPT_VERSION = 1;
const RECEIPT_TTL_MS = 30 * 60 * 1000;

export interface PricingPreviewReceiptInput {
  userId: bigint;
  sourceProductId: string;
  pricingStrategy?: PricingStrategyDto;
  costPrice: number;
  sourcePricingFingerprint: string;
}

export interface PricingPreviewReceipt {
  pricingPreviewToken: string;
  pricingPreviewExpiresAt: string;
  sourcePricingFingerprint: string;
}

interface ReceiptPayload {
  purpose: typeof RECEIPT_PURPOSE;
  version: typeof RECEIPT_VERSION;
  userId: string;
  sourceProductId: string;
  pricingStrategy: unknown;
  costPrice: number;
  sourcePricingFingerprint: string;
  expiresAt: number;
}

@Injectable()
export class PricingPreviewReceiptService {
  constructor(private readonly crypto: CryptoService) {}

  issue(input: PricingPreviewReceiptInput): PricingPreviewReceipt {
    const expiresAt = Date.now() + RECEIPT_TTL_MS;
    const payload: ReceiptPayload = {
      purpose: RECEIPT_PURPOSE,
      version: RECEIPT_VERSION,
      ...receiptSubject(input),
      expiresAt,
    };
    return {
      pricingPreviewToken: this.crypto.encrypt(JSON.stringify(payload)),
      pricingPreviewExpiresAt: new Date(expiresAt).toISOString(),
      sourcePricingFingerprint: input.sourcePricingFingerprint,
    };
  }

  assertValid(token: string | undefined, input: PricingPreviewReceiptInput): void {
    if (!token) throw previewError('PRICING_PREVIEW_REQUIRED');

    let payload: ReceiptPayload;
    try {
      payload = JSON.parse(this.crypto.decrypt(token)) as ReceiptPayload;
    } catch {
      throw previewError('PRICING_PREVIEW_INVALID');
    }

    if (
      payload.purpose !== RECEIPT_PURPOSE ||
      payload.version !== RECEIPT_VERSION ||
      typeof payload.expiresAt !== 'number' ||
      payload.expiresAt <= Date.now()
    ) {
      throw previewError('PRICING_PREVIEW_EXPIRED');
    }

    const actual = canonicalJson({
      userId: payload.userId,
      sourceProductId: payload.sourceProductId,
      pricingStrategy: payload.pricingStrategy,
      costPrice: payload.costPrice,
      sourcePricingFingerprint: payload.sourcePricingFingerprint,
    });
    if (actual !== canonicalJson(receiptSubject(input))) {
      throw previewError('PRICING_PREVIEW_MISMATCH');
    }
  }
}

function receiptSubject(input: PricingPreviewReceiptInput) {
  return {
    userId: input.userId.toString(),
    sourceProductId: input.sourceProductId,
    pricingStrategy: pricingInput(input.pricingStrategy) ?? null,
    costPrice: input.costPrice,
    sourcePricingFingerprint: input.sourcePricingFingerprint,
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalize(entry)]),
  );
}

function previewError(code: string): BadRequestException {
  const message =
    code === 'PRICING_PREVIEW_REQUIRED'
      ? '请先完成售价与利润试算后再铺货'
      : code === 'PRICING_PREVIEW_EXPIRED'
        ? '利润试算已过期，请重新试算后再铺货'
        : '售价、成本或试算参数已变化，请重新完成利润试算后再铺货';
  return new BadRequestException({
    code,
    message,
  });
}
