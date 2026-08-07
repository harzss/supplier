import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma, PublishedProduct } from '@supplier/db';
import type {
  PlatformAdapter,
  PlatformProductInventoryState,
  PlatformProductState,
} from '@supplier/platform-sdk';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma.module';
import {
  PlatformAdapterFactory,
  isDemoShop,
  runtimeShopWhere,
} from '../shop/platform-adapter.factory';
import { ShopTokenService } from '../shop/shop-token.service';
import { PlatformProductLockService } from './platform-product-lock.service';
import {
  OFFLINE_BATCH_ACTIONS,
  UNRESOLVED_OFFLINE_CODES,
  UNRESOLVED_SKU_CODES,
} from './product-batch-fences';
import { parseSourceBindingRoutes, SourceBindingValidationError } from './source-binding';

const STALE_LOCK_MS = 5 * 60_000;
const CURRENT_SOURCE_BINDING_INCLUDE = {
  where: { currentSlot: 1 },
  take: 1,
  include: { sourceProduct: true },
} as const;
const CURRENT_SOURCE_BINDING_GUARD_SELECT = {
  where: { currentSlot: 1 },
  take: 1,
  select: {
    id: true,
    revision: true,
    sourceProductId: true,
    sourceFingerprint: true,
    bindingFingerprint: true,
  },
} as const;

type InventoryRecord = Prisma.PublishedProductGetPayload<{
  include: {
    shop: true;
    sourceProduct: true;
    task: { select: { skuSnapshot: true; userId: true } };
    batchItems: { select: { id: true } };
    sourceBindings: typeof CURRENT_SOURCE_BINDING_INCLUDE;
  };
}>;

interface SourceBindingGuard {
  id: bigint;
  revision: number;
  sourceProductId: bigint;
  sourceFingerprint: string;
  bindingFingerprint: string;
}

interface SourceBindingLike extends SourceBindingGuard {
  skuRoutes?: Prisma.JsonValue;
  sourceProduct?: {
    skuList: Prisma.JsonValue | null;
    totalStock: number;
  };
}

interface SourceInventoryGuard {
  inventoryFingerprint: string;
  inventoryVersion: number;
}

type InventorySyncJob = PublishedProduct & {
  sourceBindingGuard?: SourceBindingGuard | null;
};

type SkuInventoryItem = { sourceSkuId: string; stock: number };

type SkuInventorySnapshot = {
  version: 1;
  items: SkuInventoryItem[];
};

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

  async claimNext(workerId: string): Promise<InventorySyncJob | null> {
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
          batchItems: {
            none: {
              status: { in: ['running', 'retry_wait', 'failed'] },
              OR: [
                {
                  errorCode: { in: [...UNRESOLVED_OFFLINE_CODES] },
                  task: { action: { in: [...OFFLINE_BATCH_ACTIONS] } },
                },
                {
                  errorCode: { in: [...UNRESOLVED_SKU_CODES] },
                  task: { action: 'edit_sku' },
                },
              ],
            },
          },
          ...(this.demoMode ? {} : { shop: runtimeShopWhere(this.demoMode) }),
        },
        orderBy: [{ inventoryNextRunAt: 'asc' }, { id: 'asc' }],
        include: { sourceBindings: CURRENT_SOURCE_BINDING_INCLUDE },
      });
      if (!candidate) return null;
      const sourceBindingGuard = bindingGuard(currentSourceBinding(candidate));
      const claimed = await this.prisma.publishedProduct.updateMany({
        where: {
          id: candidate.id,
          status: 'online',
          inventorySyncStatus: candidate.inventorySyncStatus,
          inventorySyncAttempts: candidate.inventorySyncAttempts,
          inventoryTargetFingerprint: candidate.inventoryTargetFingerprint,
          inventoryTargetVersion: candidate.inventoryTargetVersion,
          batchItems: {
            none: {
              status: { in: ['running', 'retry_wait', 'failed'] },
              OR: [
                {
                  errorCode: { in: [...UNRESOLVED_OFFLINE_CODES] },
                  task: { action: { in: [...OFFLINE_BATCH_ACTIONS] } },
                },
                {
                  errorCode: { in: [...UNRESOLVED_SKU_CODES] },
                  task: { action: 'edit_sku' },
                },
              ],
            },
          },
          ...sourceBindingOwnershipWhere(sourceBindingGuard),
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
        const job = await this.prisma.publishedProduct.findUnique({ where: { id: candidate.id } });
        return job ? { ...job, sourceBindingGuard } : null;
      }
    }
    return null;
  }

  async execute(job: InventorySyncJob): Promise<'processed' | 'stale'> {
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
          sourceBindings: CURRENT_SOURCE_BINDING_INCLUDE,
          batchItems: {
            where: {
              status: { in: ['running', 'retry_wait', 'failed'] },
              OR: [
                {
                  errorCode: { in: [...UNRESOLVED_OFFLINE_CODES] },
                  task: { action: { in: [...OFFLINE_BATCH_ACTIONS] } },
                },
                {
                  errorCode: { in: [...UNRESOLVED_SKU_CODES] },
                  task: { action: 'edit_sku' },
                },
              ],
            },
            take: 1,
            select: { id: true },
          },
        },
      });
      if (!record) return 'stale';
      const sourceBindingGuard = job.sourceBindingGuard ?? null;
      const sourceBinding = currentSourceBinding(record);
      if (
        record.inventorySyncStatus !== 'syncing' ||
        record.inventorySyncAttempts !== attempts ||
        record.inventoryLockedBy !== lockedBy ||
        record.inventoryTargetFingerprint !== targetFingerprint ||
        record.inventoryTargetVersion !== targetVersion ||
        !sameSourceBindingGuard(sourceBinding, sourceBindingGuard)
      ) {
        return 'stale';
      }
      const sourceProduct = sourceBinding?.sourceProduct ?? record.sourceProduct;
      if (record.batchItems.length > 0) {
        await this.prisma.publishedProduct.updateMany({
          where: {
            id: record.id,
            inventorySyncStatus: 'syncing',
            inventorySyncAttempts: attempts,
            inventoryLockedBy: lockedBy,
            inventoryTargetFingerprint: targetFingerprint,
            inventoryTargetVersion: targetVersion,
            ...sourceBindingOwnershipWhere(sourceBindingGuard),
          },
          data: {
            inventorySyncStatus: 'pending',
            inventoryNextRunAt: new Date(Date.now() + 60_000),
            inventoryLockedAt: null,
            inventoryLockedBy: null,
            inventorySyncError: '商品平台写入结果待核验，库存同步已暂停',
          },
        });
        return 'stale';
      }
      if (
        sourceProduct.inventoryFingerprint !== targetFingerprint ||
        sourceProduct.inventoryVersion !== targetVersion
      ) {
        await this.prisma.publishedProduct.updateMany({
          where: {
            id: record.id,
            inventorySyncStatus: 'syncing',
            inventorySyncAttempts: attempts,
            inventoryLockedBy: lockedBy,
            inventoryTargetFingerprint: targetFingerprint,
            inventoryTargetVersion: targetVersion,
            ...sourceBindingOwnershipWhere(sourceBindingGuard),
          },
          data: {
            inventorySyncStatus: 'pending',
            inventoryTargetFingerprint: sourceProduct.inventoryFingerprint,
            inventoryTargetVersion: sourceProduct.inventoryVersion,
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
      if (
        !(await this.isExecutionOwned(
          record.id,
          targetFingerprint,
          targetVersion,
          attempts,
          lockedBy,
          sourceBindingGuard,
        ))
      ) {
        return 'stale';
      }

      let reason = 'stock_updated';
      let offline = false;
      let offlineState: PlatformProductState | null = null;
      let syncedInventory: SkuInventorySnapshot | null = null;
      if (sourceProduct.availability === 'offline') {
        reason = 'source_offline';
        offline = true;
      } else if (sourceProduct.availability === 'out_of_stock') {
        reason = 'out_of_stock';
        offline = true;
      } else if (sourceProduct.availability === 'unknown') {
        reason = 'inventory_unknown';
        offline = true;
      } else {
        const inventory = inventoryItems(record);
        if (inventory.kind === 'sku_changed') {
          reason = 'source_sku_changed';
          offline = true;
        } else {
          if (!adapter.getProductInventory) {
            throw new Error('当前平台无法回读 SKU 库存，拒绝执行库存同步');
          }
          const desired = inventory.items;
          let actual = await readPlatformInventory(
            adapter,
            token,
            record.platformProductId,
            desired,
          );
          const pendingItems = pendingInventoryItems(actual, desired);
          if (pendingItems.length > 0) {
            let syncFailed = false;
            let syncError: unknown;
            try {
              await this.platformProductLocks.renew(record.id, platformLock);
              if (
                !(await this.isExecutionOwned(
                  record.id,
                  targetFingerprint,
                  targetVersion,
                  attempts,
                  lockedBy,
                  sourceBindingGuard,
                ))
              ) {
                return 'stale';
              }
              await adapter.syncInventory(token, {
                platformProductId: record.platformProductId,
                idempotencyKey: inventoryIdempotencyKey(
                  record.id,
                  targetVersion,
                  targetFingerprint,
                  sourceBindingGuard,
                  pendingItems,
                ),
                items: pendingItems,
              });
            } catch (error) {
              if (isPlatformMutationResultUnknown(error)) {
                const quarantined = await this.quarantineUnknownInventoryWrite(
                  record,
                  adapter,
                  token,
                  targetFingerprint,
                  targetVersion,
                  attempts,
                  lockedBy,
                  sourceBindingGuard,
                  platformLock,
                );
                return quarantined ? 'processed' : 'stale';
              }
              syncFailed = true;
              syncError = error;
            }

            try {
              actual = await readPlatformInventory(
                adapter,
                token,
                record.platformProductId,
                desired,
              );
            } catch (readbackError) {
              if (syncFailed) throw syncError;
              throw readbackError;
            }
            if (pendingInventoryItems(actual, desired).length > 0) {
              if (syncFailed) throw syncError;
              throw new Error('平台尚未确认全部 SKU 新库存，将稍后重试');
            }
          }
          syncedInventory = inventorySnapshot(desired);
        }
      }

      if (offline) {
        if (!adapter.getProductState) {
          throw new Error('当前平台无法回读商品状态，拒绝确认自动下架');
        }
        let offlineError: unknown;
        try {
          await this.platformProductLocks.renew(record.id, platformLock);
          if (
            !(await this.isExecutionOwned(
              record.id,
              targetFingerprint,
              targetVersion,
              attempts,
              lockedBy,
              sourceBindingGuard,
            ))
          ) {
            return 'stale';
          }
          await adapter.offlineProduct(token, record.platformProductId);
        } catch (error) {
          offlineError = error;
        }
        await this.platformProductLocks.renew(record.id, platformLock);
        offlineState = await adapter.getProductState(token, record.platformProductId);
        if (!isOfflineState(offlineState.state)) {
          if (offlineError) throw offlineError;
          throw new Error('平台尚未确认商品下架，将稍后重试');
        }
      }
      await this.platformProductLocks.renew(record.id, platformLock);
      const completed = await this.complete(
        record.id,
        targetFingerprint,
        targetVersion,
        attempts,
        lockedBy,
        reason,
        offline,
        offlineState,
        syncedInventory,
        sourceBindingGuard,
      );
      return completed ? 'processed' : 'stale';
    } finally {
      await this.platformProductLocks.release(job.id, platformLock);
    }
  }

  async fail(job: InventorySyncJob, error: string): Promise<'retry_wait' | 'dead' | 'stale'> {
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
        ...sourceBindingOwnershipWhere(job.sourceBindingGuard ?? null),
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
      include: {
        sourceProduct: true,
        sourceBindings: CURRENT_SOURCE_BINDING_INCLUDE,
      },
    });
    if (!product) throw new NotFoundException('已发布商品不存在');
    if (product.status !== 'online') throw new BadRequestException('已下架商品无需重试库存同步');
    if (!['dead', 'retry_wait'].includes(product.inventorySyncStatus)) {
      throw new BadRequestException('只有库存同步失败的商品可以重试');
    }
    const sourceBinding = currentSourceBinding(product);
    const sourceBindingGuard = bindingGuard(sourceBinding);
    const sourceProduct = sourceBinding?.sourceProduct ?? product.sourceProduct;
    const retried = await this.prisma.publishedProduct.updateMany({
      where: {
        id: product.id,
        status: 'online',
        inventorySyncStatus: product.inventorySyncStatus,
        inventorySyncAttempts: product.inventorySyncAttempts,
        inventoryTargetFingerprint: product.inventoryTargetFingerprint,
        inventoryTargetVersion: product.inventoryTargetVersion,
        ...sourceBindingOwnershipWhere(sourceBindingGuard),
      },
      data: {
        inventorySyncStatus: 'pending',
        inventoryTargetFingerprint: sourceProduct.inventoryFingerprint,
        inventoryTargetVersion: sourceProduct.inventoryVersion,
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
    offlineState: PlatformProductState | null,
    syncedInventory: SkuInventorySnapshot | null,
    sourceBindingGuard: SourceBindingGuard | null,
  ): Promise<boolean> {
    const updated = await this.prisma.publishedProduct.updateMany({
      where: {
        id: publishedProductId,
        inventorySyncStatus: 'syncing',
        inventorySyncAttempts: attempts,
        inventoryLockedBy: lockedBy,
        inventoryTargetFingerprint: targetFingerprint,
        inventoryTargetVersion: targetVersion,
        ...sourceBindingOwnershipWhere(sourceBindingGuard, {
          inventoryFingerprint: targetFingerprint,
          inventoryVersion: targetVersion,
        }),
      },
      data: {
        ...(offline ? { status: 'offline' as const } : {}),
        ...(syncedInventory
          ? { skuInventorySnapshot: syncedInventory as unknown as Prisma.InputJsonValue }
          : {}),
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
        ...(offlineState
          ? {
              platformStatusRaw: offlineState.status,
              platformCheckStatusRaw: offlineState.checkStatus,
              platformStatusSyncedAt: new Date(),
              platformStatusError: null,
            }
          : {}),
        mutationRevision: { increment: 1 },
      },
    });
    return updated.count === 1;
  }

  private async quarantineUnknownInventoryWrite(
    record: InventoryRecord,
    adapter: PlatformAdapter,
    token: string,
    targetFingerprint: string,
    targetVersion: number,
    attempts: number,
    lockedBy: string,
    sourceBindingGuard: SourceBindingGuard | null,
    platformLock: string,
  ): Promise<boolean> {
    await this.platformProductLocks.renew(record.id, platformLock);
    if (
      !(await this.isExecutionOwned(
        record.id,
        targetFingerprint,
        targetVersion,
        attempts,
        lockedBy,
        sourceBindingGuard,
      ))
    ) {
      return false;
    }
    let offlineError: unknown;
    try {
      await adapter.offlineProduct(token, record.platformProductId!);
    } catch (error) {
      offlineError = error;
    }
    await this.platformProductLocks.renew(record.id, platformLock);
    const platformState = adapter.getProductState
      ? await adapter.getProductState(token, record.platformProductId!)
      : await adapter.getProductInventory!(token, record.platformProductId!);
    if (!isOfflineState(platformState.state)) {
      if (offlineError) throw offlineError;
      throw new Error('平台库存写入结果未知且尚未确认商品下架，将稍后重试');
    }

    const now = new Date();
    const quarantineData = {
      status: 'offline' as const,
      inventorySyncStatus: 'pending' as const,
      inventorySyncAttempts: 0,
      inventoryNextRunAt: now,
      inventoryLockedAt: null,
      inventoryLockedBy: null,
      inventorySyncReason: 'inventory_result_unknown',
      inventorySyncError: '平台库存写入结果未知，商品已安全下架',
      platformStatusRaw: platformState.status,
      platformCheckStatusRaw: platformState.checkStatus,
      platformStatusSyncedAt: now,
      platformStatusError: null,
      mutationRevision: { increment: 1 },
    };
    const quarantined = await this.prisma.publishedProduct.updateMany({
      where: {
        id: record.id,
        status: 'online',
        inventorySyncStatus: 'syncing',
        inventorySyncAttempts: attempts,
        inventoryLockedBy: lockedBy,
        inventoryTargetFingerprint: targetFingerprint,
        inventoryTargetVersion: targetVersion,
        ...sourceBindingOwnershipWhere(sourceBindingGuard),
      },
      data: quarantineData,
    });
    if (quarantined.count === 1) return true;
    const reconciled = await this.prisma.publishedProduct.updateMany({
      where: {
        id: record.id,
        platformProductId: record.platformProductId,
        status: 'online',
      },
      data: quarantineData,
    });
    if (reconciled.count === 1) return true;
    const latest = await this.prisma.publishedProduct.findUnique({
      where: { id: record.id },
      select: { platformProductId: true, status: true },
    });
    return latest?.platformProductId === record.platformProductId && latest.status === 'offline';
  }

  private async isExecutionOwned(
    publishedProductId: bigint,
    targetFingerprint: string,
    targetVersion: number,
    attempts: number,
    lockedBy: string,
    sourceBindingGuard: SourceBindingGuard | null,
  ): Promise<boolean> {
    const owned = await this.prisma.publishedProduct.findUnique({
      where: { id: publishedProductId },
      select: {
        sourceProductId: true,
        inventorySyncStatus: true,
        inventorySyncAttempts: true,
        inventoryLockedBy: true,
        inventoryTargetFingerprint: true,
        inventoryTargetVersion: true,
        sourceBindings: CURRENT_SOURCE_BINDING_GUARD_SELECT,
      },
    });
    return (
      !!owned &&
      owned.inventorySyncStatus === 'syncing' &&
      owned.inventorySyncAttempts === attempts &&
      owned.inventoryLockedBy === lockedBy &&
      owned.inventoryTargetFingerprint === targetFingerprint &&
      owned.inventoryTargetVersion === targetVersion &&
      sameSourceBindingGuard(currentSourceBinding(owned), sourceBindingGuard)
    );
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

function currentSourceBinding<T extends SourceBindingLike>(record: {
  sourceBindings?: readonly T[];
}): T | null {
  return record.sourceBindings?.[0] ?? null;
}

function bindingGuard(binding: SourceBindingLike | null): SourceBindingGuard | null {
  if (!binding) return null;
  return {
    id: binding.id,
    revision: binding.revision,
    sourceProductId: binding.sourceProductId,
    sourceFingerprint: binding.sourceFingerprint,
    bindingFingerprint: binding.bindingFingerprint,
  };
}

function sameSourceBindingGuard(
  binding: SourceBindingLike | null,
  guard: SourceBindingGuard | null,
): boolean {
  if (!binding || !guard) return binding === null && guard === null;
  return (
    binding.id === guard.id &&
    binding.revision === guard.revision &&
    binding.sourceProductId === guard.sourceProductId &&
    binding.sourceFingerprint === guard.sourceFingerprint &&
    binding.bindingFingerprint === guard.bindingFingerprint
  );
}

function sourceBindingOwnershipWhere(
  guard: SourceBindingGuard | null,
  sourceInventory?: SourceInventoryGuard,
): Prisma.PublishedProductWhereInput {
  if (!guard) {
    return {
      sourceBindings: { none: { currentSlot: 1 } },
      ...(sourceInventory ? { sourceProduct: sourceInventory } : {}),
    };
  }
  return {
    sourceBindings: {
      some: {
        id: guard.id,
        revision: guard.revision,
        currentSlot: 1,
        sourceProductId: guard.sourceProductId,
        sourceFingerprint: guard.sourceFingerprint,
        bindingFingerprint: guard.bindingFingerprint,
        ...(sourceInventory ? { sourceProduct: sourceInventory } : {}),
      },
    },
  };
}

function inventoryItems(
  record: InventoryRecord,
): { kind: 'items'; items: SkuInventoryItem[] } | { kind: 'sku_changed' } {
  const sourceBinding = currentSourceBinding(record);
  if (sourceBinding) return boundInventoryItems(sourceBinding);

  const snapshot = jsonRecord(record.task.skuSnapshot);
  const platformSnapshot = jsonRecord(snapshot?.[record.shop.platform]);
  if (!platformSnapshot || !Array.isArray(platformSnapshot.skus)) return { kind: 'sku_changed' };

  const currentItems = sourceInventoryItems(record.sourceProduct.skuList);
  const publishedSkuIds = publishedSkuIdsValue(platformSnapshot.skus);
  if (!currentItems || !publishedSkuIds || currentItems.length !== publishedSkuIds.length) {
    return { kind: 'sku_changed' };
  }
  const currentSkus = new Map(currentItems.map((item) => [item.sourceSkuId, item.stock]));
  const items = publishedSkuIds.flatMap((sourceSkuId) => {
    const stock = currentSkus.get(sourceSkuId);
    return stock === undefined ? [] : [{ sourceSkuId, stock }];
  });
  if (items.length !== publishedSkuIds.length) return { kind: 'sku_changed' };
  return { kind: 'items', items };
}

function boundInventoryItems(
  binding: SourceBindingLike,
): { kind: 'items'; items: SkuInventoryItem[] } | { kind: 'sku_changed' } {
  if (!binding.sourceProduct || binding.skuRoutes === undefined) return { kind: 'sku_changed' };
  let routes;
  try {
    routes = parseSourceBindingRoutes(binding.skuRoutes);
  } catch (error) {
    if (error instanceof SourceBindingValidationError) return { kind: 'sku_changed' };
    throw error;
  }
  const sourceItems = sourceInventoryItems(binding.sourceProduct.skuList);
  if (routes.length === 0) {
    return { kind: 'sku_changed' };
  }
  if (!sourceItems) {
    const defaultRoute = routes.length === 1 ? routes[0]! : null;
    const totalStock = stockValue(binding.sourceProduct.totalStock);
    return (binding.sourceProduct.skuList === null ||
      (Array.isArray(binding.sourceProduct.skuList) &&
        binding.sourceProduct.skuList.length === 0)) &&
      defaultRoute?.sourceSpecId === null &&
      defaultRoute.sourceSpecRequired === false &&
      totalStock !== null
      ? { kind: 'items', items: [{ sourceSkuId: defaultRoute.platformSkuKey, stock: totalStock }] }
      : { kind: 'sku_changed' };
  }

  const sourceStock = new Map(sourceItems.map((item) => [item.sourceSkuId, item.stock]));
  const routedSourceIds = new Set<string>();
  const items: SkuInventoryItem[] = [];
  for (const route of routes) {
    const sourceSpecId = route.sourceSpecId;
    if (!sourceSpecId || routedSourceIds.has(sourceSpecId)) return { kind: 'sku_changed' };
    const stock = sourceStock.get(sourceSpecId);
    if (stock === undefined) return { kind: 'sku_changed' };
    routedSourceIds.add(sourceSpecId);
    items.push({ sourceSkuId: route.platformSkuKey, stock });
  }
  return { kind: 'items', items };
}

async function readPlatformInventory(
  adapter: PlatformAdapter,
  token: string,
  platformProductId: string,
  desired: SkuInventoryItem[],
): Promise<SkuInventoryItem[]> {
  if (!adapter.getProductInventory) {
    throw new Error('当前平台无法回读 SKU 库存，拒绝执行库存同步');
  }
  const state = await adapter.getProductInventory(token, platformProductId);
  if (state.state !== 'online') {
    throw new Error(`平台商品当前状态为 ${state.state}，无法确认 SKU 库存`);
  }
  const actual = platformInventoryItems(state);
  if (!actual || !sameInventorySkuIds(actual, desired)) {
    throw new Error('平台返回的 SKU 库存不完整，无法确认同步结果');
  }
  return actual;
}

function sourceInventoryItems(value: unknown): SkuInventoryItem[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids = new Set<string>();
  const items: SkuInventoryItem[] = [];
  for (const itemValue of value) {
    const sku = jsonRecord(itemValue);
    const sourceSkuId = skuIdValue(sku?.skuId ?? sku?.id);
    const stock = stockValue(sku?.stock);
    if (!sourceSkuId || stock === null || ids.has(sourceSkuId)) return null;
    ids.add(sourceSkuId);
    items.push({ sourceSkuId, stock });
  }
  return items;
}

function publishedSkuIdsValue(value: unknown[]): string[] | null {
  if (value.length === 0) return null;
  const ids = new Set<string>();
  const sourceSkuIds: string[] = [];
  for (const itemValue of value) {
    const sku = jsonRecord(itemValue);
    const sourceSkuId = skuIdValue(sku?.sourceSkuId);
    if (!sourceSkuId || ids.has(sourceSkuId)) return null;
    ids.add(sourceSkuId);
    sourceSkuIds.push(sourceSkuId);
  }
  return sourceSkuIds;
}

function platformInventoryItems(state: PlatformProductInventoryState): SkuInventoryItem[] | null {
  if (!Array.isArray(state.items) || state.items.length === 0) return null;
  const ids = new Set<string>();
  const items: SkuInventoryItem[] = [];
  for (const itemValue of state.items) {
    const item = jsonRecord(itemValue);
    const sourceSkuId = skuIdValue(item?.sourceSkuId);
    const stock = stockValue(item?.stock);
    if (!sourceSkuId || stock === null || ids.has(sourceSkuId)) return null;
    ids.add(sourceSkuId);
    items.push({ sourceSkuId, stock });
  }
  return items;
}

function sameInventorySkuIds(left: SkuInventoryItem[], right: SkuInventoryItem[]): boolean {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right.map((item) => item.sourceSkuId));
  return left.every((item) => rightIds.has(item.sourceSkuId));
}

function pendingInventoryItems(
  actual: SkuInventoryItem[],
  desired: SkuInventoryItem[],
): SkuInventoryItem[] {
  const actualBySku = new Map(actual.map((item) => [item.sourceSkuId, item.stock]));
  return desired.filter((item) => actualBySku.get(item.sourceSkuId) !== item.stock);
}

function inventorySnapshot(items: SkuInventoryItem[]): SkuInventorySnapshot {
  return {
    version: 1,
    items: [...items].sort((left, right) => left.sourceSkuId.localeCompare(right.sourceSkuId)),
  };
}

function inventoryIdempotencyKey(
  id: bigint,
  version: number,
  fingerprint: string,
  sourceBindingGuard: SourceBindingGuard | null,
  items: SkuInventoryItem[],
): string {
  const remainingFingerprint = createHash('sha256')
    .update(JSON.stringify(items))
    .digest('hex')
    .slice(0, 16);
  const bindingFingerprint = sourceBindingGuard
    ? `-b${sourceBindingGuard.bindingFingerprint.slice(0, 24)}`
    : '';
  return `inventory-${id}-v${version}-${fingerprint.slice(0, 24)}${bindingFingerprint}-${remainingFingerprint}`;
}

function retryDelayMs(attempts: number): number {
  return Math.min(5 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1));
}

function isPlatformMutationResultUnknown(error: unknown): boolean {
  return error instanceof Error && error.name === 'PlatformMutationResultUnknownError';
}

function isOfflineState(state: PlatformProductState['state']): boolean {
  return state === 'offline' || state === 'deleted';
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

function skuIdValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sourceSkuId = value.trim();
  return sourceSkuId && sourceSkuId.length <= 128 ? sourceSkuId : null;
}

function stockValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
