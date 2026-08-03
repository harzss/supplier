import { createHash } from 'node:crypto';
import { buildSkuSuggestion } from '../sku/sku-normalizer';

export interface PricingSource {
  price: unknown;
  skuList: unknown;
}

/** 绑定会影响 SKU 售价的货源结构与逐 SKU 采购价；库存变化另走库存快照刷新。 */
export function pricingSourceFingerprint(source: PricingSource): string {
  const suggestion = buildSkuSuggestion(source.skuList, Number(source.price));
  const costs = suggestion.skus
    .map((sku) => ({ sourceSkuId: sku.sourceSkuId, costPrice: sku.costPrice }))
    .sort((left, right) => left.sourceSkuId.localeCompare(right.sourceSkuId));
  return createHash('sha256')
    .update(JSON.stringify({ structure: suggestion.sourceFingerprint, costs }))
    .digest('hex');
}
