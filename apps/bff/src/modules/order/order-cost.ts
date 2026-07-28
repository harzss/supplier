export function orderQuantity(skuInfo: unknown): number {
  if (Array.isArray(skuInfo)) {
    const total = skuInfo.reduce((sum, item) => sum + itemQuantity(item), 0);
    return total > 0 ? total : 1;
  }
  return Math.max(1, itemQuantity(skuInfo));
}

export function estimatePurchaseCost(costPrice: number | null, skuInfo: unknown): number | null {
  if (costPrice === null || !Number.isFinite(costPrice) || costPrice < 0) return null;
  return roundMoney(costPrice * orderQuantity(skuInfo));
}

function itemQuantity(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const quantity = Number((value as Record<string, unknown>).quantity);
  return Number.isFinite(quantity) && quantity > 0 ? Math.trunc(quantity) : 0;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
