import type { PublishAiOptions } from './api';

export function constrainAuditTestShopIds(shopIds: string[], auditTestMode: boolean): string[] {
  return auditTestMode ? shopIds.slice(0, 1) : shopIds;
}

export function nextAuditTestShopSelection(
  current: string[],
  shopId: string,
  auditTestMode: boolean,
): string[] {
  if (auditTestMode) return current.includes(shopId) ? [] : [shopId];
  return current.includes(shopId) ? current.filter((id) => id !== shopId) : [...current, shopId];
}

export function constrainAuditTestAiOptions(
  options: PublishAiOptions,
  auditTestMode: boolean,
): PublishAiOptions {
  if (!auditTestMode) return options;
  const { backgroundStyle: _backgroundStyle, ...safeOptions } = options;
  return { ...safeOptions, removeWatermark: false, relightImages: false };
}
