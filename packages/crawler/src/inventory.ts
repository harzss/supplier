import { createHash } from 'node:crypto';
import type { CrawledProduct } from './types';

export type SourceAvailability = 'available' | 'out_of_stock' | 'offline' | 'unknown';

export interface SourceInventorySnapshot {
  availability: SourceAvailability;
  totalStock: number;
  fingerprint: string;
}

/**
 * 只把平台明确返回的 SKU 库存作为可同步库存；没有 SKU 明细时保持 unknown，
 * 避免用猜测库存继续铺货或覆盖销售平台库存。
 */
export function inventorySnapshot(
  product: Pick<CrawledProduct, 'productId1688' | 'skuList'>,
): SourceInventorySnapshot {
  const skus = Array.isArray(product.skuList) ? product.skuList : [];
  if (skus.length === 0) {
    return snapshot(product.productId1688, 'unknown', 0, []);
  }

  const inventory = skus
    .map((sku) => ({
      skuId: sku.skuId.trim(),
      stock: normalizeStock(sku.stock),
    }))
    .sort((left, right) => left.skuId.localeCompare(right.skuId));
  const totalStock = inventory.reduce(
    (total, sku) => Math.min(Number.MAX_SAFE_INTEGER, total + sku.stock),
    0,
  );
  return snapshot(
    product.productId1688,
    totalStock > 0 ? 'available' : 'out_of_stock',
    totalStock,
    inventory,
  );
}

export function offlineInventorySnapshot(productId1688: string): SourceInventorySnapshot {
  return snapshot(productId1688, 'offline', 0, []);
}

function snapshot(
  productId1688: string,
  availability: SourceAvailability,
  totalStock: number,
  inventory: Array<{ skuId: string; stock: number }>,
): SourceInventorySnapshot {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ availability, inventory, productId1688 }))
    .digest('hex');
  return { availability, totalStock, fingerprint };
}

function normalizeStock(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}
