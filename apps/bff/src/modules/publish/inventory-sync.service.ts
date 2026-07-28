import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma, PublishedProduct } from '@supplier/db';
import { PrismaService } from '../../common/prisma.module';
import {
  PlatformAdapterFactory,
  isDemoShop,
  runtimeShopWhere,
} from '../shop/platform-adapter.factory';
import { ShopTokenService } from '../shop/shop-token.service';
import { PlatformProductLockService } from './platform-product-lock.service';

const STALE_LOCK_MS = 5 * 60_000;

type InventoryRecord = Prisma.PublishedProductGetPayload<{
  include: {
    shop: true;
    sourceProduct: true;
    task: { select: { skuSnapshot: true; userId: true } };
  };
}>;

@Injectable()
export class InventorySyncService {
  private readonly demoMode: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly adapters: PlatformAdapterFactory,
    private readonly shopTokens: ShopTokenService,
    private readonly platformProductLocks: PlatformProductLockService,
  ) {
    this.demoMode = (config.get<string>('AUTH_MODE') ?? 'demo') === 'demo';
  }

  isEnabled(): boolean {
    return this.config.get<string>('INVENTORY_SYNC_ENABLED') === 'true';
  }

  async claimNext(workerId: string): Promise<PublishedProduct | null> {
    const now = new Date();
    await this.recoverStale(now);
    for (let index = 0; index < 5; index++) {
      const candidate = await this.prisma.publishedProduct.findFirst({
        where: {
          status: 'online',
          inventorySyncStatus: { in: ['pending', 'retry_wait'] },
          inventoryTargetFingerprint: { not: null },
          inventoryTargetVersion: { gt: 0 },
          inventoryNextRunAt: { lte: now },
          ...(this.demoMode ? {} : { shop: runtimeShopWhere(this.demoMode) }),
        },
        orderBy: [{ inventoryNextRunAt: 'asc' }, { id: 'asc' }],
      });
      if (!candidate) return null;
      const claimed = await this.prisma.publishedProduct.updateMany({
        where: {
          id: candidate.id,
          status: 'online',
          inventorySyncStatus: candidate.inventorySyncStatus,
          inventorySyncAttempts: candidate.inventorySyncAttempts,
          inventoryTargetFingerprint: candidate.inventoryTargetFingerprint,
          inventoryTargetVersion: candidate.inventoryTargetVersion,
          ...(this.demoMode ? {} : { shop: runtimeShopWhere(this.demoMode) }),
        },
        data: {
          inventorySyncStatus: 'syncing',
          inventorySyncAttempts: { increment: 1 },
          inventoryLockedAt: now,
          inventoryLockedBy: workerId,
          inventorySyncError: null,
        },
      });
      if (claimed.count === 1) {
        return this.prisma.publishedProduct.findUnique({ where: { id: candidate.id } });
      }
    }
    return null;
  }

  async execute(job: PublishedProduct): Promise<'processed' | 'stale'> {
    const targetFingerprint = job.inventoryTargetFingerprint;
    const targetVersion = job.inventoryTargetVersion;
    const lockedBy = job.inventoryLockedBy;
    const attempts = job.inventorySyncAttempts;
    if (!targetFingerprint || targetVersion <= 0 || !lockedBy || attempts <= 0) return 'stale';
    const platformLock = await this.platformProductLocks.acquire(job.id);
    try {
      const record = await this.prisma.publishedProduct.findUnique({
        where: { id: job.id },
        include: {
          shop: true,
          sourceProduct: true,
          task: { select: { skuSnapshot: true, userId: true } },
        },
      });
      if (!record) return 'stale';
      if (
        record.inventorySyncStatus !== 'syncing' ||
        record.inventorySyncAttempts !== attempts ||
        record.inventoryLockedBy !== lockedBy ||
        record.inventoryTargetFingerprint !== targetFingerprint ||
        record.inventoryTargetVersion !== targetVersion
      ) {
        return 'stale';
      }
      if (
        record.sourceProduct.inventoryFingerprint !== targetFingerprint ||
        record.sourceProduct.inventoryVersion !== targetVersion
      ) {
        await this.prisma.publishedProduct.updateMany({
          where: {
            id: record.id,
            inventorySyncStatus: 'syncing',
            inventorySyncAttempts: attempts,
            inventoryLockedBy: lockedBy,
            inventoryTargetFingerprint: targetFingerprint,
            inventoryTargetVersion: targetVersion,
          },
          data: {
            inventorySyncStatus: 'pending',
            inventoryTargetFingerprint: record.sourceProduct.inventoryFingerprint,
            inventoryTargetVersion: record.sourceProduct.inventoryVersion,
            inventorySyncAttempts: 0,
            inventoryNextRunAt: new Date(),
            inventoryLockedAt: null,
            inventoryLockedBy: null,
            inventorySyncError: null,
          },
        });
        return 'stale';
      }
      if (!record.platformProductId) throw new Error('已发布商品缺少平台商品 ID');

      const adapter = this.adapters.create(record.shop);
      const token = isDemoShop(record.shop)
        ? 'mock-token'
        : await this.shopTokens.getAccessToken(record.shop.id, record.task.userId);
      await this.platformProductLocks.renew(record.id, platformLock);
      const owned = await this.prisma.publishedProduct.findUnique({
        where: { id: record.id },
        select: {
          inventorySyncStatus: true,
          inventorySyncAttempts: true,
          inventoryLockedBy: true,
          inventoryTargetFingerprint: true,
          inventoryTargetVersion: true,
        },
      });
      if (
        !owned ||
        owned.inventorySyncStatus !== 'syncing' ||
        owned.inventorySyncAttempts !== attempts ||
        owned.inventoryLockedBy !== lockedBy ||
        owned.inventoryTargetFingerprint !== targetFingerprint ||
        owned.inventoryTargetVersion !== targetVersion
      ) {
        return 'stale';
      }

      let reason = 'stock_updated';
      let offline = false;
      if (record.sourceProduct.availability === 'offline') {
        reason = 'source_offline';
        offline = true;
      } else if (record.sourceProduct.availability === 'out_of_stock') {
        reason = 'out_of_stock';
        offline = true;
      } else if (record.sourceProduct.availability === 'unknown') {
        reason = 'inventory_unknown';
        offline = true;
      } else {
        const inventory = inventoryItems(record);
        if (inventory.kind === 'sku_changed') {
          reason = 'source_sku_changed';
          offline = true;
        } else {
          await adapter.syncInventory(token, {
            platformProductId: record.platformProductId,
            idempotencyKey: inventoryIdempotencyKey(record.id, targetVersion, targetFingerprint),
            items: inventory.items,
          });
        }
      }

      if (offline) await adapter.offlineProduct(token, record.platformProductId);
      await this.platformProductLocks.renew(record.id, platformLock);
      const completed = await this.complete(
        record.id,
        targetFingerprint,
        targetVersion,
        attempts,
        lockedBy,
        reason,
        offline,
      );
      return completed ? 'processed' : 'stale';
    } finally {
      await this.platformProductLocks.release(job.id, platformLock);
    }
  }

  async fail(job: PublishedProduct, error: string): Promise<'retry_wait' | 'dead' | 'stale'> {
    const targetFingerprint = job.inventoryTargetFingerprint;
    const targetVersion = job.inventoryTargetVersion;
    const lockedBy = job.inventoryLockedBy;
    if (!targetFingerprint || targetVersion <= 0 || !lockedBy) return 'stale';
    const attempts = job.inventorySyncAttempts;
    const dead = attempts >= this.maxAttempts();
    const updated = await this.prisma.publishedProduct.updateMany({
      where: {
        id: job.id,
        status: 'online',
        inventorySyncStatus: 'syncing',
        inventorySyncAttempts: attempts,
        inventoryLockedBy: lockedBy,
        inventoryTargetFingerprint: targetFingerprint,
        inventoryTargetVersion: targetVersion,
      },
      data: {
        inventorySyncStatus: dead ? 'dead' : 'retry_wait',
        inventoryNextRunAt: dead ? null : new Date(Date.now() + retryDelayMs(attempts)),
        inventoryLockedAt: null,
        inventoryLockedBy: null,
        inventorySyncError: error.slice(0, 1000),
      },
    });
    if (updated.count !== 1) return 'stale';
    return dead ? 'dead' : 'retry_wait';
  }

  async manualRetry(
    userId: bigint,
    publishedProductIdValue: string,
  ): Promise<{ publishedProductId: string; queued: true }> {
    const publishedProductId = parsePositiveId(publishedProductIdValue);
    const product = await this.prisma.publishedProduct.findFirst({
      where: {
        id: publishedProductId,
        task: { userId },
        ...(this.demoMode ? {} : { shop: runtimeShopWhere(this.demoMode) }),
      },
      include: { sourceProduct: true },
    });
    if (!product) throw new NotFoundException('已发布商品不存在');
    if (product.status !== 'online') throw new BadRequestException('已下架商品无需重试库存同步');
    if (!['dead', 'retry_wait'].includes(product.inventorySyncStatus)) {
      throw new BadRequestException('只有库存同步失败的商品可以重试');
    }
    const retried = await this.prisma.publishedProduct.updateMany({
      where: {
        id: product.id,
        status: 'online',
        inventorySyncStatus: product.inventorySyncStatus,
        inventorySyncAttempts: product.inventorySyncAttempts,
        inventoryTargetFingerprint: product.inventoryTargetFingerprint,
        inventoryTargetVersion: product.inventoryTargetVersion,
      },
      data: {
        inventorySyncStatus: 'pending',
        inventoryTargetFingerprint: product.sourceProduct.inventoryFingerprint,
        inventoryTargetVersion: product.sourceProduct.inventoryVersion,
        inventorySyncAttempts: 0,
        inventoryNextRunAt: new Date(),
        inventoryLockedAt: null,
        inventoryLockedBy: null,
        inventorySyncError: null,
      },
    });
    if (retried.count !== 1) {
      throw new ConflictException('库存同步状态已变化，请刷新后重试');
    }
    return { publishedProductId: product.id.toString(), queued: true };
  }

  private async complete(
    publishedProductId: bigint,
    targetFingerprint: string,
    targetVersion: number,
    attempts: number,
    lockedBy: string,
    reason: string,
    offline: boolean,
  ): Promise<boolean> {
    const updated = await this.prisma.publishedProduct.updateMany({
      where: {
        id: publishedProductId,
        inventorySyncStatus: 'syncing',
        inventorySyncAttempts: attempts,
        inventoryLockedBy: lockedBy,
        inventoryTargetFingerprint: targetFingerprint,
        inventoryTargetVersion: targetVersion,
      },
      data: {
        ...(offline ? { status: 'offline' as const } : {}),
        inventorySyncStatus: 'synced',
        inventoryFingerprint: targetFingerprint,
        inventoryTargetFingerprint: targetFingerprint,
        inventoryVersion: targetVersion,
        inventoryTargetVersion: targetVersion,
        inventoryNextRunAt: null,
        inventoryLockedAt: null,
        inventoryLockedBy: null,
        inventoryLastSyncedAt: new Date(),
        inventorySyncReason: reason,
        inventorySyncError: null,
      },
    });
    return updated.count === 1;
  }

  private async recoverStale(now: Date): Promise<void> {
    await this.prisma.publishedProduct.updateMany({
      where: {
        status: 'online',
        inventorySyncStatus: 'syncing',
        inventoryLockedAt: { lt: new Date(now.getTime() - STALE_LOCK_MS) },
        ...(this.demoMode ? {} : { shop: runtimeShopWhere(this.demoMode) }),
      },
      data: {
        inventorySyncStatus: 'retry_wait',
        inventoryNextRunAt: now,
        inventoryLockedAt: null,
        inventoryLockedBy: null,
        inventorySyncError: '库存同步 worker 超时，任务已自动恢复',
      },
    });
  }

  private maxAttempts(): number {
    const value = Number(this.config.get<string>('INVENTORY_SYNC_MAX_ATTEMPTS') ?? 3);
    return Number.isInteger(value) && value >= 1 && value <= 10 ? value : 3;
  }
}

function inventoryItems(
  record: InventoryRecord,
):
  | { kind: 'items'; items: Array<{ sourceSkuId: string; stock: number }> }
  | { kind: 'sku_changed' } {
  const snapshot = jsonRecord(record.task.skuSnapshot);
  const platformSnapshot = jsonRecord(snapshot?.[record.shop.platform]);
  if (!platformSnapshot || !Array.isArray(platformSnapshot.skus)) return { kind: 'sku_changed' };

  const currentSkus = new Map(
    arrayValue(record.sourceProduct.skuList).flatMap((value) => {
      const sku = jsonRecord(value);
      const sourceSkuId = textValue(sku?.skuId ?? sku?.id);
      const stock = integerStock(sku?.stock);
      return sourceSkuId ? ([[sourceSkuId, stock]] as Array<[string, number]>) : [];
    }),
  );
  const items = platformSnapshot.skus.flatMap((value) => {
    const sku = jsonRecord(value);
    const sourceSkuId = textValue(sku?.sourceSkuId);
    const stock = sourceSkuId ? currentSkus.get(sourceSkuId) : undefined;
    return sourceSkuId && stock !== undefined ? [{ sourceSkuId, stock }] : [];
  });
  if (items.length === 0 || items.length !== platformSnapshot.skus.length) {
    return { kind: 'sku_changed' };
  }
  return { kind: 'items', items };
}

function inventoryIdempotencyKey(id: bigint, version: number, fingerprint: string): string {
  return `inventory-${id}-v${version}-${fingerprint.slice(0, 24)}`;
}

function retryDelayMs(attempts: number): number {
  return Math.min(5 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1));
}

function parsePositiveId(value: string): bigint {
  try {
    const id = BigInt(value);
    if (id <= 0n) throw new Error('invalid');
    return id;
  } catch {
    throw new BadRequestException('无效已发布商品 ID');
  }
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function integerStock(value: unknown): number {
  const stock = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(stock) && stock > 0 ? Math.trunc(stock) : 0;
}
