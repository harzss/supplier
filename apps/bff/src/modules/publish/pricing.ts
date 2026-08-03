import { BadRequestException } from '@nestjs/common';
import type { PricingMode, PricingStrategyDto } from './dto/create-publish-task.dto';

const DEFAULT_SHIPPING_CNY = 4;
const DEFAULT_PLATFORM_FEE_RATE = 0.05;

type StoredPricingStrategy = PricingStrategyDto & {
  finalPrice?: unknown;
};

export interface PricingQuote {
  mode: PricingMode;
  costPrice: number;
  estimatedShipping: number;
  platformFeeRate: number;
  breakEvenPrice: number;
  suggestedPrice: number;
  estimatedProfit: number;
  estimatedMargin: number;
  competitorPriceRange: [number, number] | null;
  warning: string | null;
}

export function calculatePricing(costPrice: number, strategy?: PricingStrategyDto): PricingQuote {
  if (!Number.isFinite(costPrice) || costPrice <= 0) {
    throw new BadRequestException('货源采购价无效，无法计算售价');
  }

  const mode = strategy?.mode ?? 'fixed_markup';
  const estimatedShipping = finiteOrDefault(strategy?.estimatedShipping, DEFAULT_SHIPPING_CNY);
  const platformFeeRate = finiteOrDefault(strategy?.platformFeeRate, DEFAULT_PLATFORM_FEE_RATE);
  if (estimatedShipping < 0) throw new BadRequestException('预估运费不能小于 0');
  if (platformFeeRate < 0 || platformFeeRate >= 1) {
    throw new BadRequestException('平台费率必须在 0% 到 100% 之间');
  }

  const breakEvenPrice = ceil2((costPrice + estimatedShipping) / (1 - platformFeeRate));
  const storedFinalPrice = positiveNumber(
    (strategy as StoredPricingStrategy | undefined)?.finalPrice,
  );
  let suggestedPrice = storedFinalPrice;
  let competitorPriceRange: [number, number] | null = null;
  let warning: string | null = null;

  if (!suggestedPrice) {
    switch (mode) {
      case 'fixed_markup': {
        const markupRatio = finiteOrDefault(strategy?.markupRatio, 0.5);
        if (markupRatio < 0) throw new BadRequestException('加价比例不能小于 0');
        suggestedPrice = round2(costPrice * (1 + markupRatio));
        if (suggestedPrice < breakEvenPrice) {
          warning = '当前售价低于含运费和平台费的保本价';
        }
        break;
      }
      case 'profit_target': {
        const targetMargin = finiteOrDefault(strategy?.targetMargin, 0.3);
        const denominator = 1 - platformFeeRate - targetMargin;
        if (targetMargin <= 0 || denominator <= 0) {
          throw new BadRequestException('目标毛利率与平台费率之和必须小于 100%');
        }
        suggestedPrice = ceil2((costPrice + estimatedShipping) / denominator);
        break;
      }
      case 'competitor_anchor': {
        competitorPriceRange = parseCompetitorRange(strategy?.competitorPriceRange);
        const midpoint = round2((competitorPriceRange[0] + competitorPriceRange[1]) / 2);
        suggestedPrice = Math.max(midpoint, breakEvenPrice);
        if (breakEvenPrice > competitorPriceRange[1]) {
          warning = '保本价高于竞品区间上限，当前货源不具备价格竞争力';
        }
        break;
      }
    }
  } else if (mode === 'competitor_anchor') {
    competitorPriceRange = parseCompetitorRange(strategy?.competitorPriceRange);
    if (breakEvenPrice > competitorPriceRange[1]) {
      warning = '保本价高于竞品区间上限，当前货源不具备价格竞争力';
    }
  }

  const estimatedProfit = round2(
    suggestedPrice * (1 - platformFeeRate) - costPrice - estimatedShipping,
  );
  const estimatedMargin = round4(estimatedProfit / suggestedPrice);

  return {
    mode,
    costPrice: round2(costPrice),
    estimatedShipping: round2(estimatedShipping),
    platformFeeRate: round4(platformFeeRate),
    breakEvenPrice,
    suggestedPrice,
    estimatedProfit,
    estimatedMargin,
    competitorPriceRange,
    warning,
  };
}

export function pricingSnapshot(
  strategy: PricingStrategyDto | undefined,
  quote: PricingQuote,
): Record<string, unknown> {
  return {
    mode: quote.mode,
    ...(strategy ?? {}),
    costPrice: quote.costPrice,
    finalPrice: quote.suggestedPrice,
    breakEvenPrice: quote.breakEvenPrice,
    estimatedProfit: quote.estimatedProfit,
    estimatedMargin: quote.estimatedMargin,
    warning: quote.warning,
  };
}

export function pricingInput(
  strategy: PricingStrategyDto | undefined,
): PricingStrategyDto | undefined {
  if (!strategy) return undefined;
  return {
    mode: strategy.mode,
    markupRatio: strategy.markupRatio,
    targetMargin: strategy.targetMargin,
    competitorPriceRange: strategy.competitorPriceRange,
    estimatedShipping: strategy.estimatedShipping,
    platformFeeRate: strategy.platformFeeRate,
  };
}

function parseCompetitorRange(value: number[] | undefined): [number, number] {
  if (!value || value.length !== 2) {
    throw new BadRequestException('竞品对标需要填写竞品价格下限和上限');
  }
  const low = Number(value[0]);
  const high = Number(value[1]);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high < low) {
    throw new BadRequestException('竞品价格区间无效');
  }
  return [round2(low), round2(high)];
}

function finiteOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function ceil2(value: number): number {
  return Math.ceil((value - Number.EPSILON) * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
