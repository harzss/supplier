import { createHash } from 'node:crypto';
import { CrawlerError } from './adapter';
import type { CrawledProduct } from './types';

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_SKUS = 100;
const MAX_SKU_ID_LENGTH = 128;

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
  if (skus.length > MAX_SKUS) {
    throw new CrawlerError(`Source inventory cannot contain more than ${MAX_SKUS} SKUs`, 'parse');
  }

  const inventory = skus.map((sku) => ({
    skuId: validSkuId(sku.skuId),
    stock: validStock(sku.stock),
  }));
  if (new Set(inventory.map((sku) => sku.skuId)).size !== inventory.length) {
    throw new CrawlerError('Source inventory contains duplicate SKU IDs', 'parse');
  }
  inventory.sort((left, right) => left.skuId.localeCompare(right.skuId));
  const totalStock = inventory.reduce((total, sku) => {
    const next = total + sku.stock;
    if (!Number.isSafeInteger(next) || next > POSTGRES_INTEGER_MAX) {
      throw new CrawlerError('Source inventory total stock is invalid', 'parse');
    }
    return next;
  }, 0);
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

function validSkuId(value: string): string {
  const skuId = value.trim();
  if (!skuId || skuId.length > MAX_SKU_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(skuId)) {
    throw new CrawlerError('Source inventory SKU ID is invalid', 'parse');
  }
  return skuId;
}

function validStock(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > POSTGRES_INTEGER_MAX) {
    throw new CrawlerError('Source inventory SKU stock is invalid', 'parse');
  }
  return value;
}
