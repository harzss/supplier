import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type ProductBatchItem } from '@supplier/db';
import type {
  PlatformAdapter,
  PlatformProductInventoryState,
  PlatformProductPriceState,
  PlatformProductSkuItem,
  PlatformProductSkuRules,
  PlatformProductSkuState,
  PlatformProductState,
  PlatformProductTitleState,
  PlatformType,
} from '@supplier/platform-sdk';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma.module';
import { buildSkuSuggestion, type SkuSuggestion } from '../sku/sku-normalizer';
import { validateTitleForPlatform } from '../ai/prompts/title.prompt';
import { EntitlementService } from '../entitlement/entitlement.service';
import type { CurrentUser } from '../entitlement/user-context.service';
import {
  PlatformAdapterFactory,
  isDemoShop,
  runtimeShopWhere,
} from '../shop/platform-adapter.factory';
import { ShopTokenService } from '../shop/shop-token.service';
import type {
  CreateProductBatchPreviewDto,
  ExecuteProductBatchDto,
  ProductBatchPriceRuleDto,
  ProductBatchSkuDimensionDto,
  ProductBatchSkuRowDto,
  ProductBatchSkuTargetDto,
  ProductBatchSourceTargetDto,
  ProductBatchTitleTargetDto,
  ProductBatchCandidateQueryDto,
  ProductBatchTaskListQueryDto,
  RetryProductBatchDto,
} from './dto/product-batch.dto';
import {
  OFFLINE_BATCH_ACTIONS,
  OFFLINE_RESULT_UNKNOWN_CODE,
  OFFLINE_WRITE_STARTED_CODE,
  SKU_RESULT_UNKNOWN_CODE,
  SKU_WRITE_STARTED_CODE,
  UNRESOLVED_SKU_CODES,
  UNRESOLVED_OFFLINE_CODES,
} from './product-batch-fences';
import { PlatformProductLockService } from './platform-product-lock.service';
import {
  parseSourceBindingRoutes,
  sourceBindingFingerprint,
  sourceBindingRoutesFingerprint,
  SourceBindingValidationError,
  type SourceBindingRoute,
} from './source-binding';
import {
  hasValidProductSkuPropertyIdentities,
  normalizeProductSkuRules,
  normalizeProductSkuState,
  parseStoredProductSkuState,
  productSkuCurrentDimensions,
  productSkuFingerprint,
  productSkuPropertyIdentity,
  productSkuRuleValueIdentity,
  productSkuRuleFingerprint,
  productSkuValueIdentity,
  sameProductSkuState,
  skuInventorySnapshot,
  skuPriceSnapshot,
  skuPropertyDisplayValue,
  type StoredProductSkuState,
  type ProductSkuCurrentDimension,
} from './product-sku-state';

const STALE_ITEM_MS = 5 * 60_000;
const TASK_RECONCILE_INTERVAL_MS = 30_000;
const MAX_PRICE_CENTS = 100_000_000;
const DAY_MS = 24 * 60 * 60_000;
const CLEANUP_POLICY_VERSION = 1 as const;
const CLEANUP_WINDOW_DAYS = 30;
const CLEANUP_GRACE_DAYS = 7;
const CLEANUP_MIN_SYNC_AGE_MS = 5 * 60_000;
const SKU_CONTEXT_MAX_AGE_MS = 5 * 60_000;
const TERMINAL_TASK_STATUSES = ['cancelled', 'partial', 'succeeded', 'failed'] as const;
const TITLE_WRITE_STARTED_CODE = 'TITLE_WRITE_STARTED';
const TITLE_RESULT_UNKNOWN_CODE = 'TITLE_RESULT_UNKNOWN';
const UNRESOLVED_TITLE_CODES = [TITLE_WRITE_STARTED_CODE, TITLE_RESULT_UNKNOWN_CODE] as const;
const ONLINE_WRITE_STARTED_CODE = 'ONLINE_WRITE_STARTED';
const ONLINE_RESULT_UNKNOWN_CODE = 'ONLINE_RESULT_UNKNOWN';
const UNRESOLVED_ONLINE_CODES = [ONLINE_WRITE_STARTED_CODE, ONLINE_RESULT_UNKNOWN_CODE] as const;
const RETRYABLE_FAILED_CODES = new Set([
  'ITEM_OWNERSHIP_LOST',
  'PLATFORM_ERROR',
  'PRICE_NOT_CONFIRMED',
  'SOURCE_CHANGE_CONFLICT',
  'STATUS_NOT_OFFLINE',
  'STATUS_NOT_ONLINE',
  'ONLINE_RESULT_NOT_APPLIED',
  'OFFLINE_UPDATE_FAILED',
  'OFFLINE_RESULT_NOT_APPLIED',
  'TITLE_WRITE_GUARD_LOST',
  'TITLE_READBACK_FAILED',
  'SKU_READBACK_FAILED',
  'SKU_RESULT_NOT_APPLIED',
  'SKU_WRITE_GUARD_LOST',
  'WORKER_STALE',
]);

const CURRENT_SOURCE_BINDING_INCLUDE = {
  where: { currentSlot: 1 },
  orderBy: { revision: 'desc' as const },
  take: 2,
};

const TASK_INCLUDE = {
  items: {
    orderBy: { ordinal: 'asc' as const },
    include: {
      publishedProduct: {
        include: {
          shop: true,
          sourceProduct: true,
          sourceBindings: CURRENT_SOURCE_BINDING_INCLUDE,
          task: { select: { skuSnapshot: true } },
        },
      },
    },
  },
} satisfies Prisma.ProductBatchTaskInclude;

const EXECUTION_INCLUDE = {
  task: true,
  publishedProduct: {
    include: {
      shop: true,
      sourceProduct: true,
      sourceBindings: CURRENT_SOURCE_BINDING_INCLUDE,
      task: { select: { userId: true, skuSnapshot: true } },
    },
  },
} satisfies Prisma.ProductBatchItemInclude;

type ProductBatchTaskRecord = Prisma.ProductBatchTaskGetPayload<{ include: typeof TASK_INCLUDE }>;
export type ProductBatchExecutionRecord = Prisma.ProductBatchItemGetPayload<{
  include: typeof EXECUTION_INCLUDE;
}>;

export interface ProductBatchCandidatePage {
  items: Array<{
    publishedProductId: string;
    title: string;
    mainImage: string | null;
    shopId: string;
    shopName: string | null;
    platform: string;
    platformProductId: string;
    status: string;
    salePrice: number;
    priceRange: [number, number] | null;
    skuCount: number;
    priceEditable: boolean;
    priceEditReason: string | null;
    skuEditEligible: boolean;
    skuEditReason: string | null;
    skuVerificationTaskId: string | null;
    skuVerificationItemId: string | null;
    titleEditable: boolean;
    titleEditReason: string | null;
    titleVerificationTaskId: string | null;
    titleVerificationItemId: string | null;
    onlineEligible: boolean;
    onlineReason: string | null;
    onlineVerificationTaskId: string | null;
    onlineVerificationItemId: string | null;
    offlineVerificationTaskId: string | null;
    offlineVerificationItemId: string | null;
    cleanupEligible: boolean;
    cleanupReason: string | null;
    cleanupEvidence: ProductBatchCleanupEvidence;
    sourceChangeEligible: boolean;
    sourceChangeReason: string | null;
    currentSourceRouteCount: number;
    sourceProductId: string;
    sourceAvailability: string;
    sourceTotalStock: number;
    sourceSkuCount: number;
    sourceInventoryVersion: number;
    inventorySyncStatus: string;
    syncedInventoryVersion: number;
    inventoryLastSyncedAt: string | null;
    inventorySyncError: string | null;
    inventorySyncEligible: boolean;
    inventorySyncReason: string | null;
    mutationRevision: number;
    publishedAt: string;
  }>;
  total: number;
  page: number;
  pageSize: number;
}

export interface ProductSkuEditContext {
  publishedProductId: string;
  expectedMutationRevision: number;
  expectedPlatformSkuFingerprint: string;
  expectedRuleFingerprint: string;
  editable: boolean;
  blockers: string[];
  dimensions: ProductSkuCurrentDimension[];
  rows: Array<
    PlatformProductSkuItem & {
      rowId: string;
      sourceSpecId: string | null;
      isNew: false;
    }
  >;
  sourceSkus: Array<{
    sourceSpecId: string | null;
    sourceSpecName: string;
    costPrice: number;
    stock: number;
    usedByPlatformSkuKey: string | null;
  }>;
  rules: PlatformProductSkuRules;
}

export interface ProductBatchTaskView {
  taskId: string;
  clientRequestId: string;
  action: string;
  status: string;
  previewRevision: number;
  cancelRequestedAt: string | null;
  confirmedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  summary: ProductBatchSummary;
  items: ProductBatchItemView[];
}

export interface ProductBatchCleanupEvidence {
  policyVersion: typeof CLEANUP_POLICY_VERSION;
  windowDays: typeof CLEANUP_WINDOW_DAYS;
  graceDays: typeof CLEANUP_GRACE_DAYS;
  observedAt: string;
  windowStartedAt: string;
  daysOnline: number;
  validOrderCount: number;
  lastPaidAt: string | null;
  orderSyncAt: string | null;
}

export interface ProductBatchInventorySnapshot {
  version: 1;
  items: Array<{ sourceSkuId: string; stock: number }>;
}

export interface ProductBatchItemView {
  itemId: string;
  publishedProductId: string;
  title: string;
  mainImage: string | null;
  shopId: string;
  shopName: string | null;
  platform: string;
  platformProductId: string | null;
  beforeStatus: string;
  desiredStatus: string;
  actualStatus: string | null;
  beforeTitle: string;
  desiredTitle: string | null;
  actualTitle: string | null;
  beforePrice: number | null;
  desiredPrice: number | null;
  beforePriceRange: [number, number] | null;
  desiredPriceRange: [number, number] | null;
  actualPriceRange: [number, number] | null;
  beforeSkuSpec: Record<string, unknown> | null;
  desiredSkuSpec: Record<string, unknown> | null;
  actualSkuSpec: Record<string, unknown> | null;
  skuCount: number;
  beforeInventory: ProductBatchInventorySnapshot | null;
  desiredInventory: ProductBatchInventorySnapshot | null;
  actualInventory: ProductBatchInventorySnapshot | null;
  beforeInventoryVersion: number | null;
  desiredInventoryVersion: number | null;
  cleanupEvidence: ProductBatchCleanupEvidence | null;
  beforeSourceProductId: string | null;
  desiredSourceProductId: string | null;
  actualSourceProductId: string | null;
  beforeSourceTitle: string | null;
  desiredSourceTitle: string | null;
  sourceRouteCount: number | null;
  sourceCostRange: [number, number] | null;
  retryable: boolean;
  status: string;
  attempts: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  result: Record<string, unknown> | null;
  startedAt: string | null;
  finishedAt: string | null;
}

interface SkuPriceItem {
  sourceSkuId: string;
  priceCents: number;
}

interface SkuPriceSnapshot {
  version: 1;
  items: SkuPriceItem[];
}

type NormalizedPriceRule =
  | {
      mode: 'percentage';
      direction: 'increase' | 'decrease';
      basisPoints: number;
    }
  | {
      mode: 'targets';
      targets: Array<{ publishedProductId: string; targetStartPriceCents: number }>;
    };

type NormalizedTitleTarget = {
  publishedProductId: string;
  expectedMutationRevision: number;
  targetTitle: string;
};

type NormalizedSourceTarget = {
  publishedProductId: string;
  expectedMutationRevision: number;
  targetSourceProductId: string;
};

type NormalizedSkuProperty = {
  propertyId: string;
  propertyName: string;
  valueId: string;
  valueName: string;
  remark: string | null;
};

type NormalizedSkuDimension = {
  propertyId: string;
  propertyName: string;
  values: Array<{ valueId: string; valueName: string; remark: string | null }>;
};

type NormalizedSkuRow = {
  rowId: string;
  isNew: boolean;
  platformSkuId: string | null;
  platformSkuKey: string | null;
  sourceSpecId: string | null;
  properties: NormalizedSkuProperty[];
  priceCents: number;
  skuPictureUrls: string[];
};

type NormalizedSkuTarget = {
  publishedProductId: string;
  expectedMutationRevision: number;
  expectedPlatformSkuFingerprint: string;
  expectedRuleFingerprint: string;
  dimensions: NormalizedSkuDimension[];
  rows: NormalizedSkuRow[];
};

interface ResolvedSkuEditTarget {
  rules: PlatformProductSkuRules;
  ruleFingerprint: string;
  beforeState: StoredProductSkuState;
  beforeFingerprint: string;
  desiredDimensions: NormalizedSkuDimension[];
  desiredItems: Array<
    Omit<PlatformProductSkuItem, 'platformSkuId'> & {
      platformSkuId?: string;
      sourceSpecId: string | null;
      sourceUnitCost: number;
    }
  >;
  desiredFingerprint: string;
  bindingId: bigint;
  bindingRevision: number;
  bindingFingerprint: string;
  bindingRoutesFingerprint: string;
  sourceProductId: bigint;
  sourceOfferId: string;
  sourceSupplierId: string;
  sourceOnePieceDrop: boolean;
  sourceFingerprint: string;
  sourceInventoryFingerprint: string;
  sourceInventoryVersion: number;
}

interface FrozenSkuEditTarget {
  beforeState: StoredProductSkuState;
  beforeFingerprint: string;
  ruleFingerprint: string;
  desiredDimensions: NormalizedSkuDimension[];
  desiredItems: ResolvedSkuEditTarget['desiredItems'];
  desiredFingerprint: string;
  bindingId: bigint;
  bindingRevision: number;
  bindingFingerprint: string;
  bindingRoutesFingerprint: string;
  sourceProductId: bigint;
  sourceOfferId: string;
  sourceSupplierId: string;
  sourceOnePieceDrop: true;
  sourceFingerprint: string;
  sourceInventoryFingerprint: string;
  sourceInventoryVersion: number;
  nextBindingRevision: number;
}

interface ProductBatchResolvedSourceTarget {
  sourceProductDatabaseId: bigint;
  sourceOfferId: string;
  sourceTitle: string;
  sourceSupplierId: string;
  sourceOnePieceDrop: boolean;
  sourceFingerprint: string;
  inventoryFingerprint: string;
  inventoryVersion: number;
  syncedAt: Date;
  skuRoutes: SourceBindingRoute[];
  bindingFingerprint: string;
  bindingRevision: number;
}

interface FrozenSourceChangeTarget {
  sourceProductDatabaseId: bigint;
  sourceOfferId: string;
  sourceTitle: string;
  sourceSupplierId: string;
  sourceOnePieceDrop: boolean;
  sourceFingerprint: string;
  inventoryFingerprint: string;
  inventoryVersion: number;
  sourceSyncedAt: Date;
  skuRoutes: SourceBindingRoute[];
  bindingFingerprint: string;
  bindingRevision: number;
}

interface ProductBatchCleanupAssessment {
  evidence: ProductBatchCleanupEvidence;
  eligible: boolean;
  reason: string | null;
  code: string | null;
}

interface CleanupOrderAggregateRow {
  publishedProductId: bigint;
  validOrderCount: bigint | number;
  lastPaidAt: Date | null;
}

export interface ProductBatchSummary {
  total: number;
  pending: number;
  running: number;
  retryWait: number;
  succeeded: number;
  failed: number;
  skipped: number;
  cancelled: number;
  completed: number;
  progressPercent: number;
}

@Injectable()
export class ProductBatchService {
  private readonly demoMode: boolean;
  private lastTaskReconcileAt = 0;
  private lastTaskReconcileCursor: bigint | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly entitlement: EntitlementService,
    private readonly adapters: PlatformAdapterFactory,
    private readonly shopTokens: ShopTokenService,
    private readonly platformProductLocks: PlatformProductLockService,
  ) {
    this.demoMode = (config.get<string>('AUTH_MODE') ?? 'demo') === 'demo';
  }

  isEnabled(): boolean {
    return this.config.get<string>('PRODUCT_BATCH_ENABLED') === 'true';
  }

  isSkuEditEnabled(): boolean {
    return this.config.get<string>('PRODUCT_BATCH_SKU_EDIT_ENABLED') === 'true';
  }

  async getSkuEditContext(
    user: CurrentUser,
    publishedProductIdValue: string,
  ): Promise<ProductSkuEditContext> {
    this.entitlement.assertFeature(user.plan, 'catalog.batch');
    const publishedProductId = parsePositiveId(publishedProductIdValue, '已发布商品 ID');
    const findProduct = () =>
      this.prisma.publishedProduct.findFirst({
        where: {
          id: publishedProductId,
          task: { userId: user.userId },
          shop: {
            role: 'seller',
            status: 'active',
            ...runtimeShopWhere(this.demoMode),
          },
        },
        include: {
          shop: true,
          sourceProduct: true,
          sourceBindings: CURRENT_SOURCE_BINDING_INCLUDE,
          task: { select: { userId: true } },
        },
      });
    const initial = await findProduct();
    if (!initial) throw new NotFoundException('已发布商品不存在或目标店铺不可用');
    if (!initial.platformProductId) throw new BadRequestException('平台商品 ID 不存在');
    const unresolvedPlatformMutation = await this.prisma.productBatchItem.findFirst({
      where: {
        publishedProductId: initial.id,
        status: { in: ['running', 'retry_wait', 'failed'] },
        OR: [
          {
            errorCode: { in: [...UNRESOLVED_TITLE_CODES] },
            task: { userId: user.userId, action: 'edit_title' },
          },
          {
            errorCode: { in: [...UNRESOLVED_ONLINE_CODES] },
            task: { userId: user.userId, action: 'online' },
          },
          {
            errorCode: { in: [...UNRESOLVED_OFFLINE_CODES] },
            task: { userId: user.userId, action: { in: [...OFFLINE_BATCH_ACTIONS] } },
          },
          {
            errorCode: { in: [...UNRESOLVED_SKU_CODES] },
            task: { userId: user.userId, action: 'edit_sku' },
          },
        ],
      },
      select: { id: true },
    });
    if (unresolvedPlatformMutation) {
      throw new ConflictException('商品存在结果待核验的平台写入，请在原批量任务完成核验');
    }

    const lock = await this.platformProductLocks.acquire(initial.id);
    try {
      const product = await findProduct();
      if (
        !product?.platformProductId ||
        product.platformProductId !== initial.platformProductId ||
        product.mutationRevision !== initial.mutationRevision
      ) {
        throw new ConflictException('商品已在读取 SKU 编辑上下文期间发生变化，请刷新');
      }
      const unresolvedPlatformMutationAfterLock = await this.prisma.productBatchItem.findFirst({
        where: {
          publishedProductId: product.id,
          status: { in: ['running', 'retry_wait', 'failed'] },
          OR: [
            {
              errorCode: { in: [...UNRESOLVED_TITLE_CODES] },
              task: { userId: user.userId, action: 'edit_title' },
            },
            {
              errorCode: { in: [...UNRESOLVED_ONLINE_CODES] },
              task: { userId: user.userId, action: 'online' },
            },
            {
              errorCode: { in: [...UNRESOLVED_OFFLINE_CODES] },
              task: { userId: user.userId, action: { in: [...OFFLINE_BATCH_ACTIONS] } },
            },
            {
              errorCode: { in: [...UNRESOLVED_SKU_CODES] },
              task: { userId: user.userId, action: 'edit_sku' },
            },
          ],
        },
        select: { id: true },
      });
      if (unresolvedPlatformMutationAfterLock) {
        throw new ConflictException('商品存在结果待核验的平台写入，请在原批量任务完成核验');
      }
      const adapter = this.adapters.create(product.shop);
      if (
        !adapter.getProductSkuState ||
        !adapter.getProductSkuRules ||
        !adapter.replaceProductSkus
      ) {
        throw new BadRequestException('当前平台不支持可回读的完整 SKU 编辑');
      }
      const token = isDemoShop(product.shop)
        ? 'mock-token'
        : await this.shopTokens.getAccessToken(product.shop.id, user.userId);
      const firstState = normalizeProductSkuState(
        await adapter.getProductSkuState(token, product.platformProductId),
      );
      await this.platformProductLocks.renew(product.id, lock);
      const secondState = normalizeProductSkuState(
        await adapter.getProductSkuState(token, product.platformProductId),
      );
      if (!sameProductSkuState(firstState, secondState)) {
        throw new ConflictException('平台 SKU 连续两次回读不一致，请稍后重试');
      }
      let currentDimensions: ProductSkuCurrentDimension[];
      try {
        currentDimensions = productSkuCurrentDimensions(secondState);
      } catch {
        throw new ConflictException('平台 SKU 规格结构不一致，请先在平台修正后重试');
      }
      const rules = normalizeProductSkuRules(
        await adapter.getProductSkuRules(token, { categoryId: secondState.categoryId }),
      );
      const observedAt = new Date();
      const observedFingerprint = productSkuFingerprint(secondState);
      const persistedRevision = await this.persistSkuContextObservation(
        product,
        secondState,
        observedFingerprint,
        observedAt,
      );

      const blockers: string[] = [];
      if (!this.isSkuEditEnabled()) blockers.push('SKU 编辑功能尚未启用');
      if (secondState.state !== 'offline' && secondState.state !== 'draft') {
        blockers.push(`平台商品当前状态为 ${secondState.state}，请先下架后再编辑 SKU`);
      }
      if (rules.unsupportedReasons.length) blockers.push(...rules.unsupportedReasons);
      if (product.inventorySyncStatus === 'syncing') blockers.push('商品库存正在同步，请稍后重试');
      const binding = currentSourceBindingForSkuEdit(product.sourceBindings);
      let routes: SourceBindingRoute[] = [];
      if (!binding || binding.sourceProductId !== product.sourceProductId) {
        blockers.push('商品当前货源绑定缺失、重复或与商品指针不一致');
      } else {
        const sourceSupplierId = product.sourceProduct.supplierId?.trim();
        if (
          !sourceSupplierId ||
          !product.sourceProduct.isOnePieceDrop ||
          binding.sourceOfferId !== product.sourceProduct.productId1688 ||
          binding.sourceSupplierId !== sourceSupplierId ||
          binding.sourceOnePieceDrop !== true
        ) {
          blockers.push('商品当前货源采购身份已变化，不能安全编辑 SKU');
        }
        try {
          routes = parseSourceBindingRoutes(binding.skuRoutes);
        } catch (error) {
          blockers.push(
            error instanceof SourceBindingValidationError
              ? `商品货源 SKU 路由无效：${error.message}`
              : '商品货源 SKU 路由无效',
          );
        }
      }
      if (product.sourceProduct.availability !== 'available') {
        blockers.push(`1688 货源当前状态为 ${product.sourceProduct.availability}`);
      }
      const suggestion = buildSkuSuggestion(
        product.sourceProduct.skuList,
        Number(product.sourceProduct.price),
      );
      if (
        suggestion.warnings.some((warning) =>
          /(格式无效|重复|超过|缺少规格值|已不存在)/.test(warning),
        )
      ) {
        blockers.push('当前 1688 SKU 数据不完整，请重新采集货源');
      }
      const routeByKey = new Map(routes.map((route) => [route.platformSkuKey, route]));
      for (const item of secondState.items) {
        if (!routeByKey.has(item.platformSkuKey)) {
          blockers.push(`平台 SKU ${item.platformSkuKey} 尚未绑定当前 1688 spec`);
        }
      }
      const usedBySourceSpec = new Map(
        routes.flatMap((route) =>
          route.sourceSpecId ? [[route.sourceSpecId, route.platformSkuKey] as const] : [],
        ),
      );
      return {
        publishedProductId: product.id.toString(),
        expectedMutationRevision: persistedRevision,
        expectedPlatformSkuFingerprint: observedFingerprint,
        expectedRuleFingerprint: productSkuRuleFingerprint(rules),
        editable: blockers.length === 0,
        blockers: [...new Set(blockers)],
        dimensions: currentDimensions,
        rows: secondState.items.map((item) => ({
          ...item,
          rowId: `existing:${item.platformSkuKey}`,
          sourceSpecId: routeByKey.get(item.platformSkuKey)?.sourceSpecId ?? null,
          isNew: false,
        })),
        sourceSkus: suggestion.skus.map((sku) => ({
          sourceSpecId: sku.sourceSkuId === 'default' ? null : sku.sourceSkuId,
          sourceSpecName: sku.sourceSpecName,
          costPrice: sku.costPrice,
          stock:
            sourceSkuStock(sku, product.sourceProduct.skuList, product.sourceProduct.totalStock) ??
            sku.stock,
          usedByPlatformSkuKey:
            sku.sourceSkuId === 'default'
              ? (routes.find((route) => route.sourceSpecId === null)?.platformSkuKey ?? null)
              : (usedBySourceSpec.get(sku.sourceSkuId) ?? null),
        })),
        rules,
      };
    } finally {
      await this.platformProductLocks.release(initial.id, lock);
    }
  }

  private async persistSkuContextObservation(
    product: {
      id: bigint;
      platformProductId: string | null;
      mutationRevision: number;
      skuSpecFingerprint: string | null;
      status: string;
      inventorySyncStatus: string;
      inventoryFingerprint: string | null;
      inventoryVersion: number;
      inventoryLastSyncedAt: Date | null;
      sourceProduct: {
        skuList: Prisma.JsonValue | null;
        totalStock: number;
        inventoryFingerprint: string;
        inventoryVersion: number;
      };
      sourceBindings: Array<{
        currentSlot: number | null;
        skuRoutes: Prisma.JsonValue;
      }>;
    },
    state: StoredProductSkuState,
    fingerprint: string,
    observedAt: Date,
  ): Promise<number> {
    if (!product.platformProductId) {
      throw new BadRequestException('平台商品 ID 不存在');
    }
    const prices = skuPriceSnapshot(state);
    const inventory = skuInventorySnapshot(state);
    const binding = currentSourceBindingForSkuEdit(product.sourceBindings);
    const desiredInventory = binding
      ? inventorySnapshotFromBindingRoutes(
          binding.skuRoutes,
          product.sourceProduct.skuList,
          product.sourceProduct.totalStock,
        )
      : null;
    const inventoryMatchesSource =
      desiredInventory !== null && sameSkuInventory(inventory, desiredInventory);
    const semanticChanged = product.skuSpecFingerprint !== fingerprint;
    const status = localStatusFromSkuState(state, product.status);
    const updated = await this.prisma.publishedProduct.updateMany({
      where: {
        id: product.id,
        platformProductId: product.platformProductId,
        mutationRevision: product.mutationRevision,
      },
      data: {
        skuSpecSnapshot: state as unknown as Prisma.InputJsonValue,
        skuSpecFingerprint: fingerprint,
        skuSpecSyncedAt: observedAt,
        skuPriceSnapshot: prices as unknown as Prisma.InputJsonValue,
        priceSyncedAt: observedAt,
        salePrice: snapshotStartPrice(prices),
        skuInventorySnapshot: inventory as unknown as Prisma.InputJsonValue,
        status,
        platformStatusRaw: state.status,
        platformCheckStatusRaw: state.checkStatus,
        platformStatusSyncedAt: observedAt,
        platformStatusError: null,
        ...(product.inventorySyncStatus === 'syncing'
          ? {}
          : {
              inventorySyncStatus: inventoryMatchesSource
                ? ('synced' as const)
                : ('pending' as const),
              inventoryFingerprint: inventoryMatchesSource
                ? product.sourceProduct.inventoryFingerprint
                : product.inventoryFingerprint,
              inventoryTargetFingerprint: product.sourceProduct.inventoryFingerprint,
              inventoryVersion: inventoryMatchesSource
                ? product.sourceProduct.inventoryVersion
                : product.inventoryVersion,
              inventoryTargetVersion: product.sourceProduct.inventoryVersion,
              inventoryNextRunAt: inventoryMatchesSource ? null : observedAt,
              inventoryLastSyncedAt: inventoryMatchesSource
                ? observedAt
                : product.inventoryLastSyncedAt,
              inventorySyncReason: inventoryMatchesSource
                ? 'sku_context_readback'
                : 'sku_context_inventory_drift',
              inventorySyncError: inventoryMatchesSource
                ? null
                : '平台 SKU 库存与当前 1688 货源不一致',
            }),
        ...(semanticChanged ? { mutationRevision: { increment: 1 } } : {}),
      },
    });
    if (updated.count !== 1) {
      throw new ConflictException('商品已在保存 SKU 编辑上下文期间发生变化，请刷新');
    }
    return product.mutationRevision + (semanticChanged ? 1 : 0);
  }

  async listCandidates(
    user: CurrentUser,
    query: ProductBatchCandidateQueryDto,
  ): Promise<ProductBatchCandidatePage> {
    this.entitlement.assertFeature(user.plan, 'catalog.batch');
    const where: Prisma.PublishedProductWhereInput = {
      task: { userId: user.userId },
      platformProductId: { not: null },
      shop: {
        role: 'seller',
        status: 'active',
        ...runtimeShopWhere(this.demoMode),
      },
      ...(query.status ? { status: query.status } : {}),
      ...(query.shopId ? { shopId: BigInt(query.shopId) } : {}),
      ...(query.q?.trim()
        ? { title: { contains: query.q.trim(), mode: 'insensitive' as const } }
        : {}),
    };
    const [total, records] = await Promise.all([
      this.prisma.publishedProduct.count({ where }),
      this.prisma.publishedProduct.findMany({
        where,
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          shop: true,
          sourceProduct: true,
          sourceBindings: CURRENT_SOURCE_BINDING_INCLUDE,
          task: { select: { skuSnapshot: true } },
        },
      }),
    ]);
    const unresolvedTitleItems = await this.prisma.productBatchItem.findMany({
      where: {
        publishedProductId: { in: records.map((record) => record.id) },
        status: { in: ['running', 'retry_wait', 'failed'] },
        errorCode: { in: [...UNRESOLVED_TITLE_CODES] },
        task: { userId: user.userId, action: 'edit_title' },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, taskId: true, publishedProductId: true },
    });
    const unresolvedTitleByProduct = new Map<bigint, (typeof unresolvedTitleItems)[number]>();
    for (const item of unresolvedTitleItems) {
      if (!unresolvedTitleByProduct.has(item.publishedProductId)) {
        unresolvedTitleByProduct.set(item.publishedProductId, item);
      }
    }
    const unresolvedOnlineItems = await this.prisma.productBatchItem.findMany({
      where: {
        publishedProductId: { in: records.map((record) => record.id) },
        status: { in: ['running', 'retry_wait', 'failed'] },
        errorCode: { in: [...UNRESOLVED_ONLINE_CODES] },
        task: { userId: user.userId, action: 'online' },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, taskId: true, publishedProductId: true },
    });
    const unresolvedOnlineByProduct = new Map<bigint, (typeof unresolvedOnlineItems)[number]>();
    for (const item of unresolvedOnlineItems) {
      if (!unresolvedOnlineByProduct.has(item.publishedProductId)) {
        unresolvedOnlineByProduct.set(item.publishedProductId, item);
      }
    }
    const unresolvedOfflineItems = await this.prisma.productBatchItem.findMany({
      where: {
        publishedProductId: { in: records.map((record) => record.id) },
        status: { in: ['running', 'retry_wait', 'failed'] },
        errorCode: { in: [...UNRESOLVED_OFFLINE_CODES] },
        task: { userId: user.userId, action: { in: [...OFFLINE_BATCH_ACTIONS] } },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, taskId: true, publishedProductId: true },
    });
    const unresolvedOfflineByProduct = new Map<bigint, (typeof unresolvedOfflineItems)[number]>();
    for (const item of unresolvedOfflineItems) {
      if (!unresolvedOfflineByProduct.has(item.publishedProductId)) {
        unresolvedOfflineByProduct.set(item.publishedProductId, item);
      }
    }
    const unresolvedSkuItems = await this.prisma.productBatchItem.findMany({
      where: {
        publishedProductId: { in: records.map((record) => record.id) },
        status: { in: ['running', 'retry_wait', 'failed'] },
        errorCode: { in: [...UNRESOLVED_SKU_CODES] },
        task: { userId: user.userId, action: 'edit_sku' },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, taskId: true, publishedProductId: true },
    });
    const unresolvedSkuByProduct = new Map<bigint, (typeof unresolvedSkuItems)[number]>();
    for (const item of unresolvedSkuItems) {
      if (!unresolvedSkuByProduct.has(item.publishedProductId)) {
        unresolvedSkuByProduct.set(item.publishedProductId, item);
      }
    }
    const cleanupAssessments = await this.assessCleanupCandidates(records, new Date());
    return {
      items: records.map((record) => {
        const rawDeleted = isRawDeletedProduct(record);
        const unresolvedTitle = unresolvedTitleByProduct.get(record.id);
        const onlineVerification = unresolvedOnlineByProduct.get(record.id);
        const offlineVerification = unresolvedOfflineByProduct.get(record.id);
        const skuVerification = unresolvedSkuByProduct.get(record.id);
        const unresolvedPlatformMutation =
          Boolean(unresolvedTitle) ||
          Boolean(onlineVerification) ||
          Boolean(offlineVerification) ||
          Boolean(skuVerification);
        const prices =
          parseSkuPriceSnapshot(record.skuPriceSnapshot) ??
          priceSnapshotFromPublishTask(record.task.skuSnapshot, record.shop.platform);
        const priceEditable =
          !rawDeleted && !skuVerification && record.status === 'online' && !!prices;
        const titleEditReason = titleEditUnavailableReason(
          record,
          unresolvedTitleByProduct.has(record.id),
          Boolean(skuVerification),
        );
        const beforeInventory =
          parseSkuInventorySnapshot(record.skuInventorySnapshot) ??
          inventorySnapshotFromPublishTask(record.task.skuSnapshot, record.shop.platform);
        const desiredInventory = inventorySnapshotForProduct(record);
        const inventorySyncReason = skuVerification
          ? '存在结果待核验的 SKU 写入，请先在原批量任务核验'
          : inventorySyncUnavailableReason(record, beforeInventory, desiredInventory);
        const onlineReason = onlineUnavailableReason(
          record,
          beforeInventory,
          desiredInventory,
          unresolvedTitleByProduct.has(record.id),
          Boolean(onlineVerification),
          Boolean(skuVerification),
        );
        const cleanupAssessment = cleanupAssessments.get(record.id)!;
        const cleanupBlockedByMutation = unresolvedPlatformMutation;
        const sourceChangeReason = sourceChangeUnavailableReason(
          record,
          cleanupBlockedByMutation,
          this.sourceChangeSyncUnavailableReason(record.shop, new Date()),
        );
        const currentSourceRouteCount = sourceBindingRouteCountForCandidate(record.sourceBindings);
        return {
          publishedProductId: record.id.toString(),
          title: record.title,
          mainImage: record.mainImage ?? record.sourceProduct.mainImage,
          shopId: record.shopId.toString(),
          shopName: record.shop.shopName,
          platform: record.shop.platform,
          platformProductId: record.platformProductId!,
          status: rawDeleted ? 'rejected' : record.status,
          salePrice: Number(record.salePrice),
          priceRange: prices ? snapshotPriceRange(prices) : null,
          skuCount: prices?.items.length ?? 0,
          priceEditable,
          priceEditReason: priceEditable
            ? null
            : rawDeleted
              ? '平台商品已删除，不能继续操作，请重新铺货'
              : skuVerification
                ? '存在结果待核验的 SKU 写入，请先在原批量任务核验'
                : record.status !== 'online'
                  ? '只有在线商品可以改价'
                  : '缺少可核对的 SKU 价格快照',
          skuEditEligible:
            skuEditUnavailableReason(
              record,
              unresolvedPlatformMutation,
              this.isSkuEditEnabled(),
            ) === null,
          skuEditReason: skuEditUnavailableReason(
            record,
            unresolvedPlatformMutation,
            this.isSkuEditEnabled(),
          ),
          skuVerificationTaskId: skuVerification?.taskId.toString() ?? null,
          skuVerificationItemId: skuVerification?.id.toString() ?? null,
          titleEditable: titleEditReason === null,
          titleEditReason,
          titleVerificationTaskId: unresolvedTitle?.taskId.toString() ?? null,
          titleVerificationItemId: unresolvedTitle?.id.toString() ?? null,
          onlineEligible: onlineReason === null,
          onlineReason,
          onlineVerificationTaskId: onlineVerification?.taskId.toString() ?? null,
          onlineVerificationItemId: onlineVerification?.id.toString() ?? null,
          offlineVerificationTaskId: offlineVerification?.taskId.toString() ?? null,
          offlineVerificationItemId: offlineVerification?.id.toString() ?? null,
          cleanupEligible: cleanupAssessment.eligible && !cleanupBlockedByMutation,
          cleanupReason: cleanupBlockedByMutation
            ? '商品存在结果待核验的平台写入，请先在原批量任务完成核验'
            : cleanupAssessment.reason,
          cleanupEvidence: cleanupAssessment.evidence,
          sourceChangeEligible: sourceChangeReason === null,
          sourceChangeReason,
          currentSourceRouteCount,
          sourceProductId: record.sourceProduct.productId1688,
          sourceAvailability: record.sourceProduct.availability,
          sourceTotalStock: desiredInventory
            ? inventoryTotalStock(desiredInventory)
            : record.sourceProduct.totalStock,
          sourceSkuCount: desiredInventory?.items.length ?? 0,
          sourceInventoryVersion: record.sourceProduct.inventoryVersion,
          inventorySyncStatus: record.inventorySyncStatus,
          syncedInventoryVersion: record.inventoryVersion,
          inventoryLastSyncedAt: record.inventoryLastSyncedAt?.toISOString() ?? null,
          inventorySyncError: record.inventorySyncError,
          inventorySyncEligible: inventorySyncReason === null,
          inventorySyncReason,
          mutationRevision: record.mutationRevision,
          publishedAt: record.publishedAt.toISOString(),
        };
      }),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async createPreview(
    user: CurrentUser,
    dto: CreateProductBatchPreviewDto,
  ): Promise<ProductBatchTaskView> {
    this.entitlement.assertFeature(user.plan, 'catalog.batch');
    const titleTargets = normalizeTitleTargets(
      dto.action,
      dto.publishedProductIds,
      dto.titleTargets,
    );
    const priceRule = normalizePriceRule(dto.action, dto.publishedProductIds, dto.priceRule);
    const sourceTargets = normalizeSourceTargets(
      dto.action,
      dto.publishedProductIds,
      dto.sourceTargets,
    );
    const skuTargets = normalizeSkuTargets(dto.action, dto.publishedProductIds, dto.skuTargets);
    if (dto.action === 'edit_sku' && !this.isSkuEditEnabled()) {
      throw new ServiceUnavailableException('SKU 编辑功能尚未启用');
    }
    const fingerprint = requestFingerprint(
      dto.action,
      dto.publishedProductIds,
      titleTargets,
      priceRule,
      sourceTargets,
      skuTargets,
    );
    const replay = await this.findByClientRequestId(user.userId, dto.clientRequestId);
    if (replay) {
      this.assertSameRequest(replay, dto.action, fingerprint);
      return toTaskView(replay);
    }

    const ids = dto.publishedProductIds.map((id) => BigInt(id));
    const records = await this.prisma.publishedProduct.findMany({
      where: {
        id: { in: ids },
        task: { userId: user.userId },
        shop: {
          role: 'seller',
          status: 'active',
          ...runtimeShopWhere(this.demoMode),
        },
      },
      include: {
        shop: true,
        sourceProduct: true,
        sourceBindings: CURRENT_SOURCE_BINDING_INCLUDE,
        task: { select: { skuSnapshot: true } },
      },
    });
    if (records.length !== ids.length) {
      throw new NotFoundException('部分商品不存在、已失效或不属于当前账号');
    }
    if (dto.action === 'edit_title') {
      const unresolved = await this.prisma.productBatchItem.findFirst({
        where: {
          publishedProductId: { in: ids },
          status: { in: ['running', 'retry_wait', 'failed'] },
          errorCode: { in: [...UNRESOLVED_TITLE_CODES] },
          task: { userId: user.userId, action: 'edit_title' },
        },
        select: { id: true },
      });
      if (unresolved) {
        throw new ConflictException(
          '所选商品存在结果待核验的标题更新，请先在原批量任务核验平台标题',
        );
      }
      const staleTarget = titleTargets?.find(
        (target) =>
          records.find((record) => record.id.toString() === target.publishedProductId)
            ?.mutationRevision !== target.expectedMutationRevision,
      );
      if (staleTarget) {
        throw new ConflictException('商品已在选择后发生变化，请刷新列表并重新确认目标标题');
      }
    }
    if (dto.action === 'change_source') {
      const staleTarget = sourceTargets?.find(
        (target) =>
          records.find((record) => record.id.toString() === target.publishedProductId)
            ?.mutationRevision !== target.expectedMutationRevision,
      );
      if (staleTarget) {
        throw new ConflictException('商品已在选择后发生变化，请刷新列表并重新确认目标货源');
      }
    }
    if (dto.action === 'edit_sku') {
      const staleTarget = skuTargets?.find(
        (target) =>
          records.find((record) => record.id.toString() === target.publishedProductId)
            ?.mutationRevision !== target.expectedMutationRevision,
      );
      if (staleTarget) {
        throw new ConflictException('商品已在选择后发生变化，请重新读取 SKU 编辑上下文');
      }
    }
    if (dto.action === 'online') {
      const unresolved = await this.prisma.productBatchItem.findFirst({
        where: {
          publishedProductId: { in: ids },
          status: { in: ['running', 'retry_wait', 'failed'] },
          OR: [
            {
              errorCode: { in: [...UNRESOLVED_TITLE_CODES] },
              task: { userId: user.userId, action: 'edit_title' },
            },
            {
              errorCode: { in: [...UNRESOLVED_ONLINE_CODES] },
              task: { userId: user.userId, action: 'online' },
            },
          ],
        },
        select: { id: true },
      });
      if (unresolved) {
        throw new ConflictException('所选商品存在结果待核验的平台写入，请先在原批量任务完成核验');
      }
    }
    if (dto.action !== 'online') {
      const unresolvedOtherMutation = await this.prisma.productBatchItem.findFirst({
        where: {
          publishedProductId: { in: ids },
          status: { in: ['running', 'retry_wait', 'failed'] },
          OR: [
            {
              errorCode: { in: [...UNRESOLVED_TITLE_CODES] },
              task: { userId: user.userId, action: 'edit_title' },
            },
            {
              errorCode: { in: [...UNRESOLVED_ONLINE_CODES] },
              task: { userId: user.userId, action: 'online' },
            },
          ],
        },
        select: { id: true },
      });
      if (unresolvedOtherMutation) {
        throw new ConflictException('所选商品存在结果待核验的平台写入，请先在原批量任务完成核验');
      }
    }
    const unresolvedOffline = await this.prisma.productBatchItem.findFirst({
      where: {
        publishedProductId: { in: ids },
        status: { in: ['running', 'retry_wait', 'failed'] },
        errorCode: { in: [...UNRESOLVED_OFFLINE_CODES] },
        task: { userId: user.userId, action: { in: [...OFFLINE_BATCH_ACTIONS] } },
      },
      select: { id: true },
    });
    if (unresolvedOffline) {
      throw new ConflictException('所选商品存在结果待核验的下架操作，请先在原批量任务完成核验');
    }
    const unresolvedSku = await this.prisma.productBatchItem.findFirst({
      where: {
        publishedProductId: { in: ids },
        status: { in: ['running', 'retry_wait', 'failed'] },
        errorCode: { in: [...UNRESOLVED_SKU_CODES] },
        task: { userId: user.userId, action: 'edit_sku' },
      },
      select: { id: true },
    });
    if (unresolvedSku) {
      throw new ConflictException('所选商品存在结果待核验的 SKU 写入，请先在原任务完成核验');
    }
    const cleanupAssessments =
      dto.action === 'cleanup'
        ? await this.assessCleanupCandidates(records, new Date())
        : new Map<bigint, ProductBatchCleanupAssessment>();
    const sourceTargetsByProduct =
      dto.action === 'change_source'
        ? await this.resolveSourceChangeTargets(user.userId, records, sourceTargets ?? [])
        : new Map<bigint, ProductBatchResolvedSourceTarget>();
    const skuTargetsByProduct =
      dto.action === 'edit_sku'
        ? await this.resolveSkuEditTargets(
            user.userId,
            records,
            skuTargets ?? [],
            dto.clientRequestId,
          )
        : new Map<bigint, ResolvedSkuEditTarget>();
    const byId = new Map(records.map((record) => [record.id.toString(), record]));
    const maxAttempts = this.maxAttempts();
    try {
      const task = await this.prisma.productBatchTask.create({
        data: {
          userId: user.userId,
          clientRequestId: dto.clientRequestId,
          requestFingerprint: fingerprint,
          action: dto.action,
          items: {
            create: dto.publishedProductIds.map((id, ordinal) => {
              const record = byId.get(id)!;
              const preview = previewForAction(
                dto.action,
                record,
                titleTargets,
                priceRule,
                cleanupAssessments.get(record.id),
                sourceTargetsByProduct.get(record.id),
                skuTargetsByProduct.get(record.id),
              );
              return {
                publishedProductId: record.id,
                ordinal,
                status: preview.status,
                expectedMutationRevision: record.mutationRevision,
                beforeSnapshot: preview.beforeSnapshot as Prisma.InputJsonValue,
                desiredSnapshot: preview.desiredSnapshot as Prisma.InputJsonValue,
                result: preview.result as Prisma.InputJsonValue | undefined,
                errorCode: preview.errorCode,
                errorMessage: preview.errorMessage,
                maxAttempts,
                ...(preview.status === 'skipped' ? { finishedAt: new Date() } : {}),
              };
            }),
          },
        },
        include: TASK_INCLUDE,
      });
      return toTaskView(task);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const concurrent = await this.findByClientRequestId(user.userId, dto.clientRequestId);
      if (!concurrent) throw error;
      this.assertSameRequest(concurrent, dto.action, fingerprint);
      return toTaskView(concurrent);
    }
  }

  async detail(user: CurrentUser, taskIdValue: string): Promise<ProductBatchTaskView> {
    this.entitlement.assertFeature(user.plan, 'catalog.batch');
    return toTaskView(
      await this.requireTask(user.userId, parsePositiveId(taskIdValue, '批量任务 ID')),
    );
  }

  async listTasks(user: CurrentUser, query: ProductBatchTaskListQueryDto) {
    this.entitlement.assertFeature(user.plan, 'catalog.batch');
    const where = { userId: user.userId };
    const [total, records] = await Promise.all([
      this.prisma.productBatchTask.count({ where }),
      this.prisma.productBatchTask.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: TASK_INCLUDE,
      }),
    ]);
    return {
      items: records.map(toTaskView),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async execute(
    user: CurrentUser,
    taskIdValue: string,
    dto: ExecuteProductBatchDto,
  ): Promise<ProductBatchTaskView> {
    this.assertExecutionEnabled();
    this.entitlement.assertFeature(user.plan, 'catalog.batch');
    const taskId = parsePositiveId(taskIdValue, '批量任务 ID');
    const task = await this.requireTask(user.userId, taskId);
    if (task.previewRevision !== dto.previewRevision) {
      throw new ConflictException('批量预览已变化，请刷新后重新确认');
    }
    if (task.status !== 'preview') return toTaskView(task);
    const pending = task.items.filter((item) => item.status === 'pending').length;
    const now = new Date();
    const updated = await this.prisma.productBatchTask.updateMany({
      where: {
        id: task.id,
        userId: user.userId,
        status: 'preview',
        stateRevision: task.stateRevision,
        previewRevision: dto.previewRevision,
      },
      data: {
        status: pending > 0 ? 'queued' : 'succeeded',
        stateRevision: { increment: 1 },
        confirmedAt: now,
        ...(pending === 0 ? { finishedAt: now } : {}),
      },
    });
    if (updated.count !== 1) throw new ConflictException('批量任务状态已变化，请刷新');
    return toTaskView(await this.requireTask(user.userId, task.id));
  }

  async cancel(user: CurrentUser, taskIdValue: string): Promise<ProductBatchTaskView> {
    this.entitlement.assertFeature(user.plan, 'catalog.batch');
    const taskId = parsePositiveId(taskIdValue, '批量任务 ID');
    const task = await this.requireTask(user.userId, taskId);
    if (TERMINAL_TASK_STATUSES.includes(task.status as (typeof TERMINAL_TASK_STATUSES)[number])) {
      return toTaskView(task);
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const taskUpdated = await tx.productBatchTask.updateMany({
        where: {
          id: task.id,
          userId: user.userId,
          stateRevision: task.stateRevision,
          status: task.status,
        },
        data: {
          cancelRequestedAt: now,
          status: 'cancelling',
          stateRevision: { increment: 1 },
        },
      });
      if (taskUpdated.count !== 1) {
        throw new ConflictException('批量任务状态已变化，请刷新');
      }
      await tx.productBatchItem.updateMany({
        where: { taskId: task.id, status: { in: ['pending', 'retry_wait'] } },
        data: {
          status: 'cancelled',
          finishedAt: now,
          lockedAt: null,
          lockedBy: null,
        },
      });
    });
    await this.refreshTask(task.id);
    return toTaskView(await this.requireTask(user.userId, task.id));
  }

  async retry(
    user: CurrentUser,
    taskIdValue: string,
    dto: RetryProductBatchDto,
  ): Promise<ProductBatchTaskView> {
    this.assertExecutionEnabled();
    this.entitlement.assertFeature(user.plan, 'catalog.batch');
    const taskId = parsePositiveId(taskIdValue, '批量任务 ID');
    const task = await this.requireTask(user.userId, taskId);
    if (!['failed', 'partial'].includes(task.status)) {
      throw new BadRequestException('只有失败或部分完成的批量任务可以重试');
    }
    if (task.action === 'edit_sku' && !this.isSkuEditEnabled()) {
      throw new ServiceUnavailableException('SKU 编辑功能尚未启用');
    }
    const requestedIds = dto.itemIds?.map((id) => BigInt(id));
    const retryItems = task.items.filter(
      (item) =>
        item.status === 'failed' &&
        (!requestedIds || requestedIds.some((requested) => requested === item.id)),
    );
    if (!retryItems.length || (requestedIds && retryItems.length !== requestedIds.length)) {
      throw new BadRequestException('所选条目中包含不可重试项');
    }
    if (retryItems.some((item) => item.errorCode === TITLE_RESULT_UNKNOWN_CODE)) {
      throw new BadRequestException('标题更新结果未知，请先在原批量任务核验平台实际标题');
    }
    if (retryItems.some((item) => item.errorCode === ONLINE_RESULT_UNKNOWN_CODE)) {
      throw new BadRequestException('上架结果未知，请先在原批量任务核验平台状态与库存');
    }
    if (retryItems.some((item) => item.errorCode === OFFLINE_RESULT_UNKNOWN_CODE)) {
      throw new BadRequestException('下架结果未知，请先在原批量任务核验平台实际状态');
    }
    if (
      retryItems.some((item) =>
        UNRESOLVED_SKU_CODES.includes(item.errorCode as (typeof UNRESOLVED_SKU_CODES)[number]),
      )
    ) {
      throw new BadRequestException('SKU 写入结果未知，请先在原批量任务核验平台实际 SKU');
    }
    if (retryItems.some((item) => !isRetryableFailedError(item.errorCode))) {
      throw new BadRequestException('所选条目包含需要重新预览或人工处理的失败项');
    }
    const stale = retryItems.find(
      (item) =>
        item.publishedProduct.mutationRevision !==
        (task.action === 'online'
          ? onlineBaseMutationRevision(item)
          : item.expectedMutationRevision),
    );
    if (stale) {
      throw new ConflictException(`商品「${stale.publishedProduct.title}」已变化，请新建批量预览`);
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const taskUpdated = await tx.productBatchTask.updateMany({
        where: {
          id: task.id,
          userId: user.userId,
          stateRevision: task.stateRevision,
          status: task.status,
        },
        data: {
          status: 'queued',
          stateRevision: { increment: 1 },
          cancelRequestedAt: null,
          startedAt: null,
          finishedAt: null,
        },
      });
      if (taskUpdated.count !== 1) {
        throw new ConflictException('批量任务状态已变化，请刷新');
      }
      const resetData = {
        status: 'pending' as const,
        attempts: 0,
        nextRunAt: now,
        lockedAt: null,
        lockedBy: null,
        errorCode: null,
        errorMessage: null,
        result: Prisma.JsonNull,
        startedAt: null,
        finishedAt: null,
      };
      const updatedCount =
        task.action === 'online'
          ? (
              await Promise.all(
                retryItems.map((item) => {
                  const baseRevision = onlineBaseMutationRevision(item);
                  return tx.productBatchItem.updateMany({
                    where: {
                      id: item.id,
                      status: 'failed',
                      errorCode: item.errorCode,
                      expectedMutationRevision: item.expectedMutationRevision,
                      publishedProduct: { mutationRevision: baseRevision },
                    },
                    data: {
                      ...resetData,
                      expectedMutationRevision: baseRevision,
                    },
                  });
                }),
              )
            ).reduce((total, result) => total + result.count, 0)
          : (
              await tx.productBatchItem.updateMany({
                where: { id: { in: retryItems.map((item) => item.id) }, status: 'failed' },
                data: resetData,
              })
            ).count;
      if (updatedCount !== retryItems.length) {
        throw new ConflictException('失败项状态已变化，请刷新');
      }
    });
    return toTaskView(await this.requireTask(user.userId, task.id));
  }

  async verifyTitleResult(
    user: CurrentUser,
    taskIdValue: string,
    itemIdValue: string,
  ): Promise<ProductBatchTaskView> {
    this.entitlement.assertFeature(user.plan, 'catalog.batch');
    const taskId = parsePositiveId(taskIdValue, '批量任务 ID');
    const itemId = parsePositiveId(itemIdValue, '批量条目 ID');
    const initial = await this.prisma.productBatchItem.findFirst({
      where: {
        id: itemId,
        taskId,
        status: 'failed',
        errorCode: { in: [...UNRESOLVED_TITLE_CODES] },
        task: { userId: user.userId, action: 'edit_title' },
      },
      include: EXECUTION_INCLUDE,
    });
    if (!initial) throw new NotFoundException('待核验的标题批量条目不存在');

    const lock = await this.platformProductLocks.acquire(initial.publishedProductId);
    try {
      const item = await this.prisma.productBatchItem.findFirst({
        where: {
          id: itemId,
          taskId,
          status: 'failed',
          errorCode: { in: [...UNRESOLVED_TITLE_CODES] },
          task: { userId: user.userId, action: 'edit_title' },
        },
        include: EXECUTION_INCLUDE,
      });
      if (!item) throw new ConflictException('标题核验状态已变化，请刷新任务');
      const product = item.publishedProduct;
      if (!product.platformProductId) throw new BadRequestException('平台商品 ID 不存在');
      const beforeTitle = stringValue(jsonRecord(item.beforeSnapshot)?.title)?.trim();
      const desiredTitle = stringValue(jsonRecord(item.desiredSnapshot)?.title)?.trim();
      if (!beforeTitle || !desiredTitle) {
        throw new ConflictException('标题任务快照不完整，无法自动核验');
      }
      const adapter = this.adapters.create(product.shop);
      if (!adapter.getProductTitle) {
        throw new BadRequestException('当前平台无法回读商品标题');
      }
      const token = isDemoShop(product.shop)
        ? 'mock-token'
        : await this.shopTokens.getAccessToken(product.shop.id, user.userId);
      await this.platformProductLocks.renew(product.id, lock);
      const platformState = await adapter.getProductTitle(token, product.platformProductId);
      await this.platformProductLocks.renew(product.id, lock);

      if (shouldWaitForTitleVerification(platformState, beforeTitle, desiredTitle, item.result)) {
        throw new ConflictException(
          platformState.title === beforeTitle &&
            (platformState.state === 'draft' ||
              platformState.state === 'reviewing' ||
              platformState.state === 'approved_pending_online')
            ? '平台仍在处理标题更新，请稍后再次核验'
            : '平台仍未显示目标标题，请在写入开始 5 分钟后再次核验',
        );
      }
      await this.persistVerifiedTitleResult(item, beforeTitle, desiredTitle, platformState);
      return toTaskView(await this.requireTask(user.userId, taskId));
    } finally {
      await this.platformProductLocks.release(initial.publishedProductId, lock);
    }
  }

  async verifyOnlineResult(
    user: CurrentUser,
    taskIdValue: string,
    itemIdValue: string,
  ): Promise<ProductBatchTaskView> {
    this.entitlement.assertFeature(user.plan, 'catalog.batch');
    const taskId = parsePositiveId(taskIdValue, '批量任务 ID');
    const itemId = parsePositiveId(itemIdValue, '批量条目 ID');
    const initial = await this.prisma.productBatchItem.findFirst({
      where: {
        id: itemId,
        taskId,
        status: 'failed',
        errorCode: { in: [...UNRESOLVED_ONLINE_CODES] },
        task: { userId: user.userId, action: 'online' },
      },
      include: EXECUTION_INCLUDE,
    });
    if (!initial) throw new NotFoundException('待核验的上架批量条目不存在');

    const lock = await this.platformProductLocks.acquire(initial.publishedProductId);
    try {
      const item = await this.prisma.productBatchItem.findFirst({
        where: {
          id: itemId,
          taskId,
          status: 'failed',
          errorCode: { in: [...UNRESOLVED_ONLINE_CODES] },
          task: { userId: user.userId, action: 'online' },
        },
        include: EXECUTION_INCLUDE,
      });
      if (!item) throw new ConflictException('上架核验状态已变化，请刷新任务');
      const product = item.publishedProduct;
      if (!product.platformProductId) throw new BadRequestException('平台商品 ID 不存在');
      const desiredRecord = jsonRecord(item.desiredSnapshot);
      const desiredInventory = parseSkuInventorySnapshot(desiredRecord?.skuInventory);
      const desiredFingerprint = inventoryFingerprintValue(desiredRecord?.inventoryFingerprint);
      const desiredVersion = positiveIntegerOrNull(desiredRecord?.inventoryVersion);
      if (!desiredInventory || !desiredFingerprint || !desiredVersion) {
        throw new ConflictException('上架任务快照不完整，无法自动核验');
      }
      const adapter = this.adapters.create(product.shop);
      if (!adapter.getProductState || !adapter.getProductInventory) {
        throw new BadRequestException('当前平台无法回读商品状态与库存');
      }
      const token = isDemoShop(product.shop)
        ? 'mock-token'
        : await this.shopTokens.getAccessToken(product.shop.id, user.userId);
      await this.platformProductLocks.renew(product.id, lock);
      const platformState = await adapter.getProductState(token, product.platformProductId);

      if (platformState.state === 'online') {
        let inventoryState: PlatformProductInventoryState;
        let confirmedState: PlatformProductState;
        let actualInventory: ProductBatchInventorySnapshot;
        try {
          inventoryState = await adapter.getProductInventory(token, product.platformProductId);
          confirmedState = await adapter.getProductState(token, product.platformProductId);
          actualInventory = platformSkuInventorySnapshot(inventoryState);
        } catch {
          await this.quarantineOnlineProduct(item, adapter, token, platformState, lock);
          throw new ConflictException(
            '平台在线结果回读失败，已下架隔离；核验栅栏保持不变，请稍后再次核验',
          );
        }
        if (inventoryState.state !== 'online' || confirmedState.state !== 'online') {
          await this.quarantineOnlineProduct(
            item,
            adapter,
            token,
            confirmedState.state === 'online' ? confirmedState : platformState,
            lock,
          );
          throw new ConflictException(
            '平台状态与库存回读的售卖状态不一致，已下架隔离，请稍后再次核验',
          );
        }
        if (onlineBaseMutationRevision(item) > item.expectedMutationRevision) {
          await this.quarantineOnlineProduct(item, adapter, token, confirmedState, lock);
          await this.platformProductLocks.renew(product.id, lock);
          await this.resolveOnlineVerificationFailure(
            item,
            'ONLINE_LATE_APPLY_QUARANTINED',
            '已隔离的上架请求延迟生效，商品已再次下架，请重新生成预览',
            confirmedState,
            actualInventory,
          );
          return toTaskView(await this.requireTask(user.userId, taskId));
        }
        try {
          await this.platformProductLocks.renew(product.id, lock);
          await this.assertOnlineSnapshotCurrent(
            item,
            desiredInventory,
            desiredFingerprint,
            desiredVersion,
          );
          if (!sameSkuInventory(actualInventory, desiredInventory)) {
            throw new ProductBatchItemError(
              'ONLINE_INVENTORY_DRIFT',
              '平台在线库存与上架目标不一致',
              false,
            );
          }
          await this.persistVerifiedOnlineResult(
            item,
            desiredInventory,
            desiredFingerprint,
            desiredVersion,
            confirmedState,
          );
        } catch (error) {
          await this.quarantineOnlineProduct(item, adapter, token, confirmedState, lock);
          await this.resolveOnlineVerificationFailure(
            item,
            'ONLINE_VERIFICATION_UNSAFE',
            error instanceof Error ? error.message : '平台上架结果不安全，已下架隔离',
            confirmedState,
            actualInventory,
          );
        }
        return toTaskView(await this.requireTask(user.userId, taskId));
      }

      if (platformState.state === 'offline') {
        const inventoryState = await adapter.getProductInventory(token, product.platformProductId);
        const confirmedState = await adapter.getProductState(token, product.platformProductId);
        if (inventoryState.state !== 'offline' || confirmedState.state !== 'offline') {
          if (inventoryState.state === 'online' || confirmedState.state === 'online') {
            await this.quarantineOnlineProduct(
              item,
              adapter,
              token,
              confirmedState.state === 'online' ? confirmedState : inventoryState,
              lock,
            );
          }
          throw new ConflictException('平台状态与库存回读尚未稳定确认下架，请稍后再次核验');
        }
        if (!onlineVerificationWindowElapsed(item.result)) {
          throw new ConflictException('平台仍未显示商品在线，请在写入开始 5 分钟后再次核验');
        }
        await this.platformProductLocks.renew(product.id, lock);
        await this.resolveOnlineVerificationFailure(
          item,
          'ONLINE_RESULT_NOT_APPLIED',
          '平台持续确认商品未上架，可重新执行或新建预览',
          confirmedState,
        );
        return toTaskView(await this.requireTask(user.userId, taskId));
      }

      if (
        platformState.state === 'rejected' ||
        platformState.state === 'blocked' ||
        platformState.state === 'deleted'
      ) {
        const inventoryState = await adapter.getProductInventory(token, product.platformProductId);
        const confirmedState = await adapter.getProductState(token, product.platformProductId);
        if (
          confirmedState.state !== platformState.state ||
          inventoryState.state !== platformState.state
        ) {
          if (inventoryState.state === 'online' || confirmedState.state === 'online') {
            await this.quarantineOnlineProduct(
              item,
              adapter,
              token,
              confirmedState.state === 'online' ? confirmedState : inventoryState,
              lock,
            );
          }
          throw new ConflictException('平台终态尚未稳定，请稍后再次核验');
        }
        await this.platformProductLocks.renew(product.id, lock);
        await this.resolveOnlineVerificationFailure(
          item,
          'ONLINE_RESULT_REJECTED',
          confirmedState.state === 'deleted'
            ? '平台商品已删除，无法重新上架，请重新铺货'
            : `平台商品状态为 ${confirmedState.state}，请按平台提示处理`,
          confirmedState,
        );
        return toTaskView(await this.requireTask(user.userId, taskId));
      }

      throw new ConflictException(
        `平台仍在处理或无法确认上架结果，当前状态为 ${platformState.state}，请稍后再次核验`,
      );
    } finally {
      await this.platformProductLocks.release(initial.publishedProductId, lock);
    }
  }

  async verifyOfflineResult(
    user: CurrentUser,
    taskIdValue: string,
    itemIdValue: string,
  ): Promise<ProductBatchTaskView> {
    this.entitlement.assertFeature(user.plan, 'catalog.batch');
    const taskId = parsePositiveId(taskIdValue, '批量任务 ID');
    const itemId = parsePositiveId(itemIdValue, '批量条目 ID');
    const itemWhere = {
      id: itemId,
      taskId,
      status: 'failed' as const,
      errorCode: { in: [...UNRESOLVED_OFFLINE_CODES] },
      task: { userId: user.userId, action: { in: [...OFFLINE_BATCH_ACTIONS] } },
    };
    const initial = await this.prisma.productBatchItem.findFirst({
      where: itemWhere,
      include: EXECUTION_INCLUDE,
    });
    if (!initial) throw new NotFoundException('待核验的下架批量条目不存在');

    const lock = await this.platformProductLocks.acquire(initial.publishedProductId);
    try {
      const item = await this.prisma.productBatchItem.findFirst({
        where: itemWhere,
        include: EXECUTION_INCLUDE,
      });
      if (!item) throw new ConflictException('下架核验状态已变化，请刷新任务');
      const product = item.publishedProduct;
      if (!product.platformProductId) throw new BadRequestException('平台商品 ID 不存在');
      const adapter = this.adapters.create(product.shop);
      if (!adapter.getProductState) {
        throw new BadRequestException('当前平台无法回读商品状态');
      }
      const token = isDemoShop(product.shop)
        ? 'mock-token'
        : await this.shopTokens.getAccessToken(product.shop.id, user.userId);
      await this.platformProductLocks.renew(product.id, lock);
      const first = await adapter.getProductState(token, product.platformProductId);
      const confirmed = await adapter.getProductState(token, product.platformProductId);
      await this.platformProductLocks.renew(product.id, lock);

      if (sameStableOfflineState(first, confirmed)) {
        const cleanupFailure =
          item.task.action === 'cleanup'
            ? await this.cleanupPostWriteFailure(item).catch(() => ({
                code: 'CLEANUP_POSTCHECK_UNAVAILABLE_AFTER_OFFLINE',
                message: '平台已下架，但订单证据复核失败，请人工复核后决定是否重新上架',
              }))
            : null;
        await this.persistVerifiedOfflineResult(item, confirmed, cleanupFailure);
        return toTaskView(await this.requireTask(user.userId, taskId));
      }

      if (first.state === 'online' && confirmed.state === 'online') {
        if (!offlineVerificationWindowElapsed(item.result)) {
          throw new ConflictException('平台仍显示商品在线，请在写入开始 5 分钟后再次核验');
        }
        let code = 'OFFLINE_RESULT_NOT_APPLIED';
        let message = '平台持续确认商品未下架，可重试原任务或重新生成预览';
        if (item.task.action === 'cleanup') {
          const assessment = (await this.assessCleanupCandidates([product], new Date())).get(
            product.id,
          )!;
          if (!assessment.eligible) {
            code =
              assessment.evidence.validOrderCount > 0
                ? 'CLEANUP_SALE_DETECTED'
                : (assessment.code ?? 'CLEANUP_EVIDENCE_CHANGED');
            message =
              assessment.evidence.validOrderCount > 0
                ? '平台未下架，但商品已出现有效订单，请人工复核并重新生成预览'
                : `平台未下架且滞销证据已失效：${assessment.reason ?? '请重新生成预览'}`;
          }
        }
        const updated = await this.prisma.productBatchItem.updateMany({
          where: itemWhere,
          data: {
            status: 'failed',
            result: {
              ...(jsonRecord(item.result) ?? {}),
              reason: 'offline_not_applied_verified',
              actualStatus: 'online',
              platformState: confirmed,
              verifiedAt: new Date().toISOString(),
            } as unknown as Prisma.InputJsonValue,
            errorCode: code,
            errorMessage: message,
            lockedAt: null,
            lockedBy: null,
            finishedAt: new Date(),
          },
        });
        if (updated.count !== 1) throw new ConflictException('下架核验状态已变化，请刷新任务');
        await this.refreshTask(item.taskId);
        return toTaskView(await this.requireTask(user.userId, taskId));
      }

      throw new ConflictException(
        `平台状态尚未稳定确认，连续回读为 ${first.state} / ${confirmed.state}，请稍后再次核验`,
      );
    } finally {
      await this.platformProductLocks.release(initial.publishedProductId, lock);
    }
  }

  private async persistVerifiedOfflineResult(
    item: ProductBatchExecutionRecord,
    platformState: PlatformProductState,
    failure: { code: string; message: string } | null,
  ): Promise<void> {
    const product = item.publishedProduct;
    const persistedStatus = platformState.state === 'deleted' ? 'rejected' : 'offline';
    const now = new Date();
    const result = {
      ...(jsonRecord(item.result) ?? {}),
      reason: failure ? 'cleanup_requires_manual_review' : 'platform_offline_verified',
      actualStatus: platformState.state,
      platformState,
      verifiedAt: now.toISOString(),
      ...(failure ? { cleanupFailureCode: failure.code } : {}),
    };
    try {
      await this.prisma.$transaction(async (tx) => {
        const updatedProduct = await tx.publishedProduct.updateMany({
          where: {
            id: product.id,
            platformProductId: product.platformProductId,
            mutationRevision: item.expectedMutationRevision,
            status: 'online',
          },
          data: {
            status: persistedStatus,
            mutationRevision: { increment: 1 },
            inventorySyncStatus: 'synced',
            inventoryNextRunAt: null,
            inventoryLockedAt: null,
            inventoryLockedBy: null,
            inventorySyncReason:
              platformState.state === 'deleted'
                ? 'platform_product_deleted'
                : item.task.action === 'cleanup'
                  ? 'slow_sales_cleanup'
                  : 'manual_batch_offline',
            inventorySyncError: null,
            platformStatusRaw: platformState.status,
            platformCheckStatusRaw: platformState.checkStatus,
            platformStatusSyncedAt: now,
            platformStatusError: null,
          },
        });
        if (updatedProduct.count !== 1) {
          const latest = await tx.publishedProduct.findUnique({ where: { id: product.id } });
          if (!latest || latest.platformProductId !== product.platformProductId) {
            throw new ConflictException('商品平台绑定已变化，平台已下架，请人工复核');
          }
          if (latest.status !== persistedStatus) {
            throw new ConflictException('商品本地状态已变化，平台已下架，请人工复核');
          }
        }
        const updatedItem = await tx.productBatchItem.updateMany({
          where: {
            id: item.id,
            taskId: item.taskId,
            status: 'failed',
            errorCode: { in: [...UNRESOLVED_OFFLINE_CODES] },
          },
          data: {
            status: failure ? 'failed' : 'succeeded',
            result: result as unknown as Prisma.InputJsonValue,
            errorCode: failure?.code ?? null,
            errorMessage: failure?.message ?? null,
            lockedAt: null,
            lockedBy: null,
            finishedAt: now,
          },
        });
        if (updatedItem.count !== 1) {
          throw new ConflictException('下架核验状态已变化，请刷新任务');
        }
      });
    } catch (error) {
      if (!(await this.offlineCommitWasPersisted(item, failure?.code ?? null))) throw error;
    }
    await this.refreshTask(item.taskId);
  }

  async verifySkuResult(
    user: CurrentUser,
    taskIdValue: string,
    itemIdValue: string,
  ): Promise<ProductBatchTaskView> {
    this.entitlement.assertFeature(user.plan, 'catalog.batch');
    const taskId = parsePositiveId(taskIdValue, '批量任务 ID');
    const itemId = parsePositiveId(itemIdValue, '批量条目 ID');
    const initial = await this.prisma.productBatchItem.findFirst({
      where: {
        id: itemId,
        taskId,
        status: 'failed',
        errorCode: { in: [...UNRESOLVED_SKU_CODES] },
        task: { userId: user.userId, action: 'edit_sku' },
      },
      include: EXECUTION_INCLUDE,
    });
    if (!initial) throw new NotFoundException('待核验的 SKU 批量条目不存在');

    const lock = await this.platformProductLocks.acquire(initial.publishedProductId);
    try {
      const item = await this.prisma.productBatchItem.findFirst({
        where: {
          id: itemId,
          taskId,
          status: 'failed',
          errorCode: { in: [...UNRESOLVED_SKU_CODES] },
          task: { userId: user.userId, action: 'edit_sku' },
        },
        include: EXECUTION_INCLUDE,
      });
      if (!item) throw new ConflictException('SKU 核验状态已变化，请刷新任务');
      if (!item.publishedProduct.platformProductId) {
        throw new BadRequestException('平台商品 ID 不存在');
      }
      if (item.publishedProduct.mutationRevision !== item.expectedMutationRevision) {
        throw new ConflictException('商品已在 SKU 核验前发生变化，请人工检查原写入');
      }
      const adapter = this.adapters.create(item.publishedProduct.shop);
      if (!adapter.getProductSkuState) {
        throw new BadRequestException('当前平台无法回读完整 SKU');
      }
      const token = isDemoShop(item.publishedProduct.shop)
        ? 'mock-token'
        : await this.shopTokens.getAccessToken(item.publishedProduct.shop.id, user.userId);
      const frozen = parseFrozenSkuEditTarget(item);
      let platformState: StoredProductSkuState;
      try {
        platformState = await this.readStableSkuState(
          adapter,
          token,
          item.publishedProduct.platformProductId,
          item.publishedProductId,
          lock,
        );
      } catch (error) {
        throw new ConflictException(
          error instanceof Error ? error.message : '平台 SKU 连续两次回读未稳定，请稍后重试',
        );
      }
      if (matchesSkuEditTarget(platformState, frozen)) {
        await this.persistSkuEditSuccess(item, frozen, platformState, true, 'failed');
        return toTaskView(await this.requireTask(user.userId, taskId));
      }
      if (productSkuFingerprint(platformState) === frozen.beforeFingerprint) {
        if (!skuVerificationWindowElapsed(item.result)) {
          throw new ConflictException('平台仍显示原 SKU，请在写入开始 5 分钟后再次核验');
        }
        const now = new Date();
        await this.prisma.$transaction(async (tx) => {
          const updatedProduct = await tx.publishedProduct.updateMany({
            where: {
              id: item.publishedProductId,
              platformProductId: item.publishedProduct.platformProductId,
              mutationRevision: item.expectedMutationRevision,
            },
            data: {
              skuSpecSnapshot: platformState as unknown as Prisma.InputJsonValue,
              skuSpecFingerprint: frozen.beforeFingerprint,
              skuSpecSyncedAt: now,
              platformStatusRaw: platformState.status,
              platformCheckStatusRaw: platformState.checkStatus,
              platformStatusSyncedAt: now,
              platformStatusError: null,
              lastEditError: '核验窗口结束后平台仍显示原 SKU，本次写入未生效',
            },
          });
          if (updatedProduct.count !== 1) {
            throw new ConflictException('商品已在 SKU 核验期间发生变化，请刷新');
          }
          const updatedItem = await tx.productBatchItem.updateMany({
            where: {
              id: item.id,
              taskId: item.taskId,
              status: 'failed',
              errorCode: { in: [...UNRESOLVED_SKU_CODES] },
            },
            data: {
              result: {
                reason: 'sku_result_not_applied',
                actualSkuFingerprint: frozen.beforeFingerprint,
                actualSkuState: platformState,
                verifiedAt: now.toISOString(),
              } as unknown as Prisma.InputJsonValue,
              errorCode: 'SKU_RESULT_NOT_APPLIED',
              errorMessage: '平台确认仍为原 SKU，可仅重试本失败项',
              lockedAt: null,
              lockedBy: null,
              finishedAt: now,
            },
          });
          if (updatedItem.count !== 1) {
            throw new ConflictException('SKU 核验状态已变化，请刷新任务');
          }
        });
        await this.refreshTask(item.taskId);
        return toTaskView(await this.requireTask(user.userId, taskId));
      }
      await this.persistSkuPlatformDrift(
        item,
        platformState,
        '平台显示了预览之外的 SKU，已同步实际快照，请重新读取上下文',
        'failed',
      );
      return toTaskView(await this.requireTask(user.userId, taskId));
    } finally {
      await this.platformProductLocks.release(initial.publishedProductId, lock);
    }
  }

  async claimNext(workerId: string): Promise<ProductBatchExecutionRecord | null> {
    await this.recoverStaleItems(new Date());
    await this.reconcileFinishedTasks();
    const now = new Date();
    for (let index = 0; index < 5; index++) {
      const candidate = await this.prisma.productBatchItem.findFirst({
        where: {
          status: { in: ['pending', 'retry_wait'] },
          nextRunAt: { lte: now },
          task: {
            status: { in: ['queued', 'running'] },
            cancelRequestedAt: null,
            ...(this.isSkuEditEnabled() ? {} : { action: { not: 'edit_sku' as const } }),
          },
        },
        orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
      });
      if (!candidate) return null;
      const claimed = await this.prisma.productBatchItem.updateMany({
        where: {
          id: candidate.id,
          status: candidate.status,
          attempts: candidate.attempts,
          task: {
            cancelRequestedAt: null,
            status: { in: ['queued', 'running'] },
            ...(this.isSkuEditEnabled() ? {} : { action: { not: 'edit_sku' as const } }),
          },
        },
        data: {
          status: 'running',
          attempts: { increment: 1 },
          lockedAt: now,
          lockedBy: workerId,
          startedAt: candidate.startedAt ?? now,
          errorCode: null,
          errorMessage: null,
        },
      });
      if (claimed.count !== 1) continue;
      await this.prisma.productBatchTask.updateMany({
        where: { id: candidate.taskId, status: 'queued' },
        data: { status: 'running', stateRevision: { increment: 1 }, startedAt: now },
      });
      return this.prisma.productBatchItem.findUnique({
        where: { id: candidate.id },
        include: EXECUTION_INCLUDE,
      });
    }
    return null;
  }

  async executeClaimed(item: ProductBatchExecutionRecord): Promise<'processed' | 'stale'> {
    if (
      ![
        'online',
        'offline',
        'edit_title',
        'edit_price',
        'edit_sku',
        'sync_inventory',
        'change_source',
        'cleanup',
      ].includes(item.task.action)
    ) {
      throw new ProductBatchItemError('ACTION_UNSUPPORTED', '当前批量动作尚未实现', false);
    }
    if (item.task.cancelRequestedAt) return this.cancelClaimedItem(item);

    const lock = await this.platformProductLocks.acquire(item.publishedProductId);
    try {
      const current = await this.prisma.productBatchItem.findUnique({
        where: { id: item.id },
        include: EXECUTION_INCLUDE,
      });
      if (!current || !ownedItem(current, item)) return 'stale';
      if (current.task.cancelRequestedAt) return this.cancelClaimedItem(current);
      const product = current.publishedProduct;
      if (product.task.userId !== current.task.userId) {
        throw new ProductBatchItemError('TENANT_MISMATCH', '商品不属于当前批量任务账号', false);
      }
      if (!product.platformProductId) {
        throw new ProductBatchItemError('PLATFORM_ID_MISSING', '商品缺少平台商品 ID', false);
      }
      const titleAction = current.task.action === 'edit_title';
      const onlineAction = current.task.action === 'online';
      const skuAction = current.task.action === 'edit_sku';
      const sourceChangeAction = current.task.action === 'change_source';
      const offlineAction = OFFLINE_BATCH_ACTIONS.includes(
        current.task.action as (typeof OFFLINE_BATCH_ACTIONS)[number],
      );
      if (
        (titleAction && product.status !== 'online' && product.status !== 'offline') ||
        (skuAction && product.status !== 'offline' && product.status !== 'draft') ||
        (onlineAction && product.status !== 'offline' && product.status !== 'online') ||
        (sourceChangeAction && product.status !== 'offline') ||
        (offlineAction && product.status !== 'online' && product.status !== 'offline') ||
        (!titleAction &&
          !onlineAction &&
          !skuAction &&
          !sourceChangeAction &&
          !offlineAction &&
          product.status !== 'online')
      ) {
        const actionLabel =
          current.task.action === 'offline'
            ? '下架'
            : onlineAction
              ? '上架'
              : sourceChangeAction
                ? '换源'
                : current.task.action === 'cleanup'
                  ? '滞销清理'
                  : skuAction
                    ? '编辑 SKU'
                    : titleAction
                      ? '改标题'
                      : current.task.action === 'edit_price'
                        ? '改价'
                        : '同步库存';
        throw new ProductBatchItemError(
          titleAction
            ? 'PRODUCT_NOT_PUBLISHED'
            : skuAction
              ? 'PRODUCT_NOT_OFFLINE'
              : onlineAction
                ? 'PRODUCT_NOT_OFFLINE'
                : sourceChangeAction
                  ? 'PRODUCT_NOT_OFFLINE'
                  : 'PRODUCT_NOT_ONLINE',
          `商品当前状态为 ${product.status}，未执行${actionLabel}`,
          false,
        );
      }
      if (product.mutationRevision !== current.expectedMutationRevision) {
        throw new ProductBatchItemError('PRODUCT_CHANGED', '商品已在预览后发生变化', false);
      }
      const unresolvedTitleMutation = await this.prisma.productBatchItem.findFirst({
        where: {
          id: { not: current.id },
          publishedProductId: product.id,
          status: { in: ['running', 'retry_wait', 'failed'] },
          errorCode: { in: [...UNRESOLVED_TITLE_CODES] },
          task: { userId: current.task.userId, action: 'edit_title' },
        },
        select: { id: true },
      });
      if (unresolvedTitleMutation) {
        throw new ProductBatchItemError(
          'TITLE_VERIFICATION_REQUIRED',
          '同一商品存在结果待核验的标题更新，请先核验原任务并重新生成预览',
          false,
        );
      }
      const unresolvedOnlineMutation = await this.prisma.productBatchItem.findFirst({
        where: {
          id: { not: current.id },
          publishedProductId: product.id,
          status: { in: ['running', 'retry_wait', 'failed'] },
          errorCode: { in: [...UNRESOLVED_ONLINE_CODES] },
          task: { userId: current.task.userId, action: 'online' },
        },
        select: { id: true },
      });
      if (unresolvedOnlineMutation) {
        throw new ProductBatchItemError(
          'ONLINE_VERIFICATION_REQUIRED',
          '同一商品存在结果待核验的上架操作，请先核验原任务并重新生成预览',
          false,
        );
      }
      const unresolvedOfflineMutation = await this.prisma.productBatchItem.findFirst({
        where: {
          id: { not: current.id },
          publishedProductId: product.id,
          status: { in: ['running', 'retry_wait', 'failed'] },
          errorCode: { in: [...UNRESOLVED_OFFLINE_CODES] },
          task: { userId: current.task.userId, action: { in: [...OFFLINE_BATCH_ACTIONS] } },
        },
        select: { id: true },
      });
      if (unresolvedOfflineMutation) {
        throw new ProductBatchItemError(
          'OFFLINE_VERIFICATION_REQUIRED',
          '同一商品存在结果待核验的下架操作，请先核验原任务并重新生成预览',
          false,
        );
      }
      const unresolvedSkuMutation = await this.prisma.productBatchItem.findFirst({
        where: {
          id: { not: current.id },
          publishedProductId: product.id,
          status: { in: ['running', 'retry_wait', 'failed'] },
          errorCode: { in: [...UNRESOLVED_SKU_CODES] },
          task: { userId: current.task.userId, action: 'edit_sku' },
        },
        select: { id: true },
      });
      if (unresolvedSkuMutation) {
        throw new ProductBatchItemError(
          'SKU_VERIFICATION_REQUIRED',
          '同一商品存在结果待核验的 SKU 写入，请先核验原任务并重新生成预览',
          false,
        );
      }
      const snapshot = jsonRecord(current.beforeSnapshot);
      if (
        snapshot?.platformProductId !== product.platformProductId ||
        snapshot?.shopId !== product.shopId.toString()
      ) {
        throw new ProductBatchItemError('PRODUCT_CHANGED', '商品平台绑定已变化', false);
      }

      const adapter = this.adapters.create(product.shop);
      const token = isDemoShop(product.shop)
        ? 'mock-token'
        : await this.shopTokens.getAccessToken(product.shop.id, current.task.userId);
      await this.platformProductLocks.renew(product.id, lock);
      if (!(await this.assertItemOwned(current))) return 'stale';

      if (current.task.action === 'edit_title') {
        return this.executeTitleClaimed(current, adapter, token, lock);
      }
      if (current.task.action === 'edit_price') {
        const result = await this.executePriceClaimed(current, adapter, token, lock);
        return result;
      }
      if (skuAction) {
        if (!this.isSkuEditEnabled()) {
          throw new ProductBatchItemError('SKU_EDIT_DISABLED', 'SKU 编辑功能尚未启用', true);
        }
        return this.executeSkuClaimed(current, adapter, token, lock);
      }
      if (current.task.action === 'sync_inventory') {
        const result = await this.executeInventoryClaimed(current, adapter, token, lock);
        return result;
      }
      if (current.task.action === 'online') {
        return this.executeOnlineClaimed(current, adapter, token, lock);
      }
      if (sourceChangeAction) {
        return this.executeSourceChangeClaimed(current, adapter, token, lock);
      }
      if (offlineAction) return this.executeOfflineClaimed(current, adapter, token, lock);
      throw new ProductBatchItemError('ACTION_UNSUPPORTED', '当前批量动作尚未实现', false);
    } finally {
      await this.platformProductLocks.release(item.publishedProductId, lock);
    }
  }

  private async executeSkuClaimed(
    item: ProductBatchExecutionRecord,
    adapter: PlatformAdapter,
    token: string,
    lock: string,
  ): Promise<'processed' | 'stale'> {
    const product = item.publishedProduct;
    if (!adapter.getProductSkuState || !adapter.getProductSkuRules || !adapter.replaceProductSkus) {
      throw new ProductBatchItemError(
        'SKU_EDIT_UNSUPPORTED',
        '当前平台不支持可回读的完整 SKU 编辑',
        false,
      );
    }
    const frozen = parseFrozenSkuEditTarget(item);
    await this.assertSkuExecutionGuards(item, frozen);
    const rules = normalizeProductSkuRules(
      await adapter.getProductSkuRules(token, { categoryId: frozen.beforeState.categoryId }),
    );
    if (productSkuRuleFingerprint(rules) !== frozen.ruleFingerprint) {
      throw new ProductBatchItemError(
        'SKU_RULE_CHANGED',
        '平台 SKU 规则已在预览后变化，请重新读取上下文并预览',
        false,
      );
    }
    const platformBefore = await this.readStableSkuState(
      adapter,
      token,
      product.platformProductId!,
      product.id,
      lock,
    );
    if (matchesSkuEditTarget(platformBefore, frozen)) {
      return this.persistSkuEditSuccess(item, frozen, platformBefore, true, 'running');
    }
    if (productSkuFingerprint(platformBefore) !== frozen.beforeFingerprint) {
      return this.persistSkuPlatformDrift(
        item,
        platformBefore,
        '平台 SKU 已在预览后变化，请重新读取上下文并预览',
        'running',
      );
    }
    if (platformBefore.state !== 'offline' && platformBefore.state !== 'draft') {
      throw new ProductBatchItemError(
        'SKU_PRODUCT_NOT_OFFLINE',
        `平台商品当前状态为 ${platformBefore.state}，拒绝提交 SKU 编辑`,
        false,
      );
    }

    await this.platformProductLocks.renew(product.id, lock);
    if (!(await this.markSkuWriteStarted(item))) return this.cancelClaimedItem(item);
    try {
      await this.platformProductLocks.renew(product.id, lock);
    } catch {
      throw new ProductBatchItemError(
        'SKU_WRITE_GUARD_LOST',
        'SKU 写入前商品锁已失效，平台请求尚未提交，将安全重试',
        true,
      );
    }
    if (!(await this.assertItemOwned(item))) {
      throw new ProductBatchItemError(
        'SKU_WRITE_GUARD_LOST',
        'SKU 写入前任务所有权已变化，平台请求尚未提交',
        true,
      );
    }
    await this.assertSkuExecutionGuards(item, frozen);

    let mutationError: unknown;
    try {
      await adapter.replaceProductSkus(token, {
        platformProductId: product.platformProductId!,
        keepOffline: true,
        dimensions: frozen.desiredDimensions.map((dimension) => ({
          propertyId: dimension.propertyId,
          propertyName: dimension.propertyName,
          values: dimension.values.map((value) => ({
            valueId: value.valueId,
            valueName: value.valueName,
            ...(value.remark ? { remark: value.remark } : {}),
          })),
        })),
        items: frozen.desiredItems.map((target) => ({
          ...(target.platformSkuId ? { platformSkuId: target.platformSkuId } : {}),
          platformSkuKey: target.platformSkuKey,
          properties: target.properties,
          priceCents: target.priceCents,
          stock: target.stock,
          skuStatus: target.skuStatus,
          skuType: target.skuType,
          code: target.code,
          supplierId: target.supplierId,
          stepStock: target.stepStock,
          barcodes: target.barcodes,
          skuPictureUrls: target.skuPictureUrls,
        })),
      });
    } catch (error) {
      mutationError = error;
    }

    try {
      await this.platformProductLocks.renew(product.id, lock);
      if (!(await this.renewClaimedItemLease(item, false))) {
        throw new ProductBatchItemError(
          SKU_RESULT_UNKNOWN_CODE,
          'SKU 写入后任务所有权已变化，请稍后核验平台实际 SKU',
          false,
        );
      }
      const platformAfter = await this.readStableSkuState(
        adapter,
        token,
        product.platformProductId!,
        product.id,
        lock,
      );
      if (matchesSkuEditTarget(platformAfter, frozen)) {
        return this.persistSkuEditSuccess(
          item,
          frozen,
          platformAfter,
          Boolean(mutationError),
          'running',
        );
      }
      if (
        mutationError &&
        !isPlatformMutationResultUnknown(mutationError) &&
        productSkuFingerprint(platformAfter) === frozen.beforeFingerprint
      ) {
        throw new ProductBatchItemError(
          'SKU_UPDATE_FAILED',
          safeErrorMessage(mutationError),
          false,
        );
      }
      throw new ProductBatchItemError(
        SKU_RESULT_UNKNOWN_CODE,
        'SKU 写入已开始，但平台尚未稳定确认完整目标，请稍后核验实际 SKU',
        false,
      );
    } catch (error) {
      if (error instanceof ProductBatchItemError) throw error;
      throw new ProductBatchItemError(
        SKU_RESULT_UNKNOWN_CODE,
        'SKU 写入结果未知且暂时无法完成强回读，请稍后核验平台实际 SKU',
        false,
      );
    }
  }

  private async markSkuWriteStarted(item: ProductBatchExecutionRecord): Promise<boolean> {
    const now = new Date();
    const currentResult = jsonRecord(item.result) ?? {};
    const updated = await this.prisma.productBatchItem.updateMany({
      where: {
        ...ownedItemWhere(item),
        task: { cancelRequestedAt: null },
      },
      data: {
        lockedAt: now,
        result: {
          ...currentResult,
          phase: 'platform_write_started',
          skuWriteStartedAt: now.toISOString(),
        } as Prisma.InputJsonValue,
        errorCode: SKU_WRITE_STARTED_CODE,
        errorMessage: '平台 SKU 全量写入已开始，正在强回读确认结果',
      },
    });
    return updated.count === 1;
  }

  private async readStableSkuState(
    adapter: PlatformAdapter,
    token: string,
    platformProductId: string,
    publishedProductId: bigint,
    lock: string,
  ): Promise<StoredProductSkuState> {
    if (!adapter.getProductSkuState) {
      throw new ProductBatchItemError(
        'SKU_READBACK_UNSUPPORTED',
        '当前平台无法回读完整 SKU',
        false,
      );
    }
    const first = normalizeProductSkuState(
      await adapter.getProductSkuState(token, platformProductId),
    );
    await this.platformProductLocks.renew(publishedProductId, lock);
    const second = normalizeProductSkuState(
      await adapter.getProductSkuState(token, platformProductId),
    );
    if (!sameProductSkuState(first, second)) {
      throw new ProductBatchItemError(
        'SKU_READBACK_UNSTABLE',
        '平台 SKU 连续两次回读不一致，请稍后重试',
        true,
      );
    }
    return second;
  }

  private async assertSkuExecutionGuards(
    item: ProductBatchExecutionRecord,
    frozen: FrozenSkuEditTarget,
  ): Promise<void> {
    const current = await this.prisma.publishedProduct.findFirst({
      where: {
        id: item.publishedProductId,
        task: { userId: item.task.userId },
      },
      include: {
        sourceProduct: true,
        sourceBindings: CURRENT_SOURCE_BINDING_INCLUDE,
      },
    });
    if (
      !current ||
      current.platformProductId !== item.publishedProduct.platformProductId ||
      current.mutationRevision !== item.expectedMutationRevision ||
      (current.status !== 'offline' && current.status !== 'draft') ||
      current.sourceProductId !== frozen.sourceProductId
    ) {
      throw new ProductBatchItemError(
        'SKU_PRODUCT_CHANGED',
        '商品已在 SKU 写入前发生变化，请重新读取上下文并预览',
        false,
      );
    }
    const binding = currentSourceBindingForSkuEdit(current.sourceBindings);
    if (
      !binding ||
      binding.id !== frozen.bindingId ||
      binding.revision !== frozen.bindingRevision ||
      binding.bindingFingerprint !== frozen.bindingFingerprint ||
      binding.sourceOfferId !== frozen.sourceOfferId ||
      binding.sourceSupplierId !== frozen.sourceSupplierId ||
      binding.sourceOnePieceDrop !== frozen.sourceOnePieceDrop ||
      sourceBindingRoutesFingerprint(binding.skuRoutes) !== frozen.bindingRoutesFingerprint
    ) {
      throw new ProductBatchItemError(
        'SKU_BINDING_CHANGED',
        '商品货源绑定已在预览后变化，请重新读取上下文并预览',
        false,
      );
    }
    const suggestion = buildSkuSuggestion(
      current.sourceProduct.skuList,
      Number(current.sourceProduct.price),
    );
    if (
      current.sourceProduct.availability !== 'available' ||
      current.sourceProduct.productId1688 !== frozen.sourceOfferId ||
      current.sourceProduct.supplierId?.trim() !== frozen.sourceSupplierId ||
      current.sourceProduct.isOnePieceDrop !== frozen.sourceOnePieceDrop ||
      suggestion.sourceFingerprint !== frozen.sourceFingerprint ||
      current.sourceProduct.inventoryFingerprint !== frozen.sourceInventoryFingerprint ||
      current.sourceProduct.inventoryVersion !== frozen.sourceInventoryVersion
    ) {
      throw new ProductBatchItemError(
        'SKU_SOURCE_CHANGED',
        '1688 SKU 或库存已在预览后变化，请重新采集并生成预览',
        false,
      );
    }
    const sourceById = new Map(
      suggestion.skus.map((sku) => [sku.sourceSkuId === 'default' ? null : sku.sourceSkuId, sku]),
    );
    for (const target of frozen.desiredItems) {
      const source = sourceById.get(target.sourceSpecId);
      const stock = source
        ? sourceSkuStock(source, current.sourceProduct.skuList, current.sourceProduct.totalStock)
        : null;
      if (
        !source ||
        stock !== target.stock ||
        Math.abs(source.costPrice - target.sourceUnitCost) > 1e-7
      ) {
        throw new ProductBatchItemError(
          'SKU_SOURCE_CHANGED',
          '目标 SKU 对应的 1688 spec 已变化，请重新生成预览',
          false,
        );
      }
    }
  }

  private async persistSkuEditSuccess(
    item: ProductBatchExecutionRecord,
    frozen: FrozenSkuEditTarget,
    platformStateValue: PlatformProductSkuState,
    recovered: boolean,
    itemMode: 'running' | 'failed',
  ): Promise<'processed' | 'stale'> {
    const platformState = normalizeProductSkuState(platformStateValue);
    if (
      !matchesSkuEditTarget(platformState, frozen) ||
      (platformState.state !== 'offline' && platformState.state !== 'draft')
    ) {
      throw new ProductBatchItemError(
        SKU_RESULT_UNKNOWN_CODE,
        '平台尚未稳定确认离线的完整目标 SKU',
        false,
      );
    }
    const actualFingerprint = productSkuFingerprint(platformState);
    const prices = skuPriceSnapshot(platformState);
    const inventory = skuInventorySnapshot(platformState);
    const routes = parseSourceBindingRoutes(
      frozen.desiredItems.map((target) => ({
        platformSkuKey: target.platformSkuKey,
        sourceSpecId: target.sourceSpecId,
        sourceSpecRequired: target.sourceSpecId !== null,
        sourceUnitCost: target.sourceUnitCost,
        values: target.properties.map(skuPropertyDisplayValue),
      })),
    );
    let committed = false;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.prisma.$transaction(
          async (tx) => {
            const current = await tx.publishedProduct.findFirst({
              where: {
                id: item.publishedProductId,
                task: { userId: item.task.userId },
              },
              include: {
                sourceProduct: true,
                sourceBindings: CURRENT_SOURCE_BINDING_INCLUDE,
              },
            });
            if (
              !current ||
              current.platformProductId !== item.publishedProduct.platformProductId ||
              current.mutationRevision !== item.expectedMutationRevision ||
              (current.status !== 'offline' && current.status !== 'draft') ||
              current.sourceProductId !== frozen.sourceProductId
            ) {
              throw new ProductBatchItemError(
                'SKU_PRODUCT_CHANGED',
                '商品已在 SKU 结果提交前发生变化，请人工核验',
                false,
              );
            }
            const binding = currentSourceBindingForSkuEdit(current.sourceBindings);
            if (
              !binding ||
              binding.id !== frozen.bindingId ||
              binding.revision !== frozen.bindingRevision ||
              binding.bindingFingerprint !== frozen.bindingFingerprint ||
              binding.sourceOfferId !== frozen.sourceOfferId ||
              binding.sourceSupplierId !== frozen.sourceSupplierId ||
              binding.sourceOnePieceDrop !== frozen.sourceOnePieceDrop ||
              sourceBindingRoutesFingerprint(binding.skuRoutes) !== frozen.bindingRoutesFingerprint
            ) {
              throw new ProductBatchItemError(
                'SKU_BINDING_CHANGED',
                '商品货源绑定已在 SKU 结果提交前变化，请人工核验',
                false,
              );
            }
            const suggestion = buildSkuSuggestion(
              current.sourceProduct.skuList,
              Number(current.sourceProduct.price),
            );
            if (
              current.sourceProduct.availability !== 'available' ||
              current.sourceProduct.productId1688 !== frozen.sourceOfferId ||
              current.sourceProduct.supplierId?.trim() !== frozen.sourceSupplierId ||
              current.sourceProduct.isOnePieceDrop !== frozen.sourceOnePieceDrop ||
              suggestion.sourceFingerprint !== frozen.sourceFingerprint ||
              current.sourceProduct.inventoryFingerprint !== frozen.sourceInventoryFingerprint ||
              current.sourceProduct.inventoryVersion !== frozen.sourceInventoryVersion
            ) {
              throw new ProductBatchItemError(
                'SKU_SOURCE_CHANGED',
                '1688 SKU 或库存已在 SKU 结果提交前变化，请人工核验',
                false,
              );
            }
            const now = new Date();
            const closed = await tx.publishedProductSourceBinding.updateMany({
              where: {
                id: binding.id,
                publishedProductId: current.id,
                revision: binding.revision,
                currentSlot: 1,
                bindingFingerprint: binding.bindingFingerprint,
                effectiveTo: null,
              },
              data: { currentSlot: null, effectiveTo: now },
            });
            if (closed.count !== 1) {
              throw new ProductBatchItemError(
                'SKU_BINDING_CHANGED',
                '商品货源绑定已并发变化，请人工核验',
                false,
              );
            }
            const nextBindingFingerprint = sourceBindingFingerprint({
              sourceProductId: current.sourceProduct.id,
              sourceOfferId: frozen.sourceOfferId,
              sourceSupplierId: frozen.sourceSupplierId,
              sourceOnePieceDrop: frozen.sourceOnePieceDrop,
              sourceFingerprint: suggestion.sourceFingerprint,
              inventoryFingerprint: current.sourceProduct.inventoryFingerprint,
              inventoryVersion: current.sourceProduct.inventoryVersion,
              skuRoutes: routes,
            });
            const nextBinding = await tx.publishedProductSourceBinding.create({
              data: {
                publishedProductId: current.id,
                sourceProductId: current.sourceProduct.id,
                revision: frozen.nextBindingRevision,
                currentSlot: 1,
                effectiveFrom: now,
                sourceOfferId: frozen.sourceOfferId,
                sourceSupplierId: frozen.sourceSupplierId,
                sourceOnePieceDrop: frozen.sourceOnePieceDrop,
                sourceFingerprint: suggestion.sourceFingerprint,
                inventoryFingerprint: current.sourceProduct.inventoryFingerprint,
                inventoryVersion: current.sourceProduct.inventoryVersion,
                skuRoutes: routes as unknown as Prisma.InputJsonValue,
                bindingFingerprint: nextBindingFingerprint,
              },
            });
            const updatedProduct = await tx.publishedProduct.updateMany({
              where: {
                id: current.id,
                platformProductId: current.platformProductId,
                mutationRevision: item.expectedMutationRevision,
                sourceProductId: frozen.sourceProductId,
              },
              data: {
                skuSpecSnapshot: platformState as unknown as Prisma.InputJsonValue,
                skuSpecFingerprint: actualFingerprint,
                skuSpecSyncedAt: now,
                skuPriceSnapshot: prices as unknown as Prisma.InputJsonValue,
                priceSyncedAt: now,
                salePrice: snapshotStartPrice(prices),
                skuInventorySnapshot: inventory as unknown as Prisma.InputJsonValue,
                costPrice: Math.min(...routes.map((route) => route.sourceUnitCost)),
                inventorySyncStatus: 'synced',
                inventoryFingerprint: current.sourceProduct.inventoryFingerprint,
                inventoryTargetFingerprint: current.sourceProduct.inventoryFingerprint,
                inventoryVersion: current.sourceProduct.inventoryVersion,
                inventoryTargetVersion: current.sourceProduct.inventoryVersion,
                inventorySyncAttempts: 0,
                inventoryNextRunAt: null,
                inventoryLockedAt: null,
                inventoryLockedBy: null,
                inventoryLastSyncedAt: now,
                inventorySyncReason: 'sku_edit',
                inventorySyncError: null,
                status: localStatusFromSkuState(platformState, current.status),
                platformStatusRaw: platformState.status,
                platformCheckStatusRaw: platformState.checkStatus,
                platformStatusSyncedAt: now,
                platformStatusError: null,
                editAttempts: { increment: 1 },
                lastEditAttemptAt: now,
                lastEditedAt: now,
                lastEditError: null,
                mutationRevision: { increment: 1 },
              },
            });
            if (updatedProduct.count !== 1) {
              throw new ProductBatchItemError(
                'SKU_PRODUCT_CHANGED',
                '商品已在 SKU 结果提交时变化，请人工核验',
                false,
              );
            }
            const itemWhere =
              itemMode === 'running'
                ? ownedItemWhere(item)
                : {
                    id: item.id,
                    taskId: item.taskId,
                    status: 'failed' as const,
                    errorCode: { in: [...UNRESOLVED_SKU_CODES] },
                  };
            const updatedItem = await tx.productBatchItem.updateMany({
              where: itemWhere,
              data: {
                status: 'succeeded',
                result: {
                  reason: recovered ? 'platform_skus_recovered' : 'platform_skus_confirmed',
                  recovered,
                  actualSkuFingerprint: actualFingerprint,
                  actualSkuState: platformState,
                  sourceBindingId: nextBinding.id.toString(),
                  sourceBindingRevision: nextBinding.revision,
                  bindingFingerprint: nextBinding.bindingFingerprint,
                  effectiveFrom: now.toISOString(),
                } as unknown as Prisma.InputJsonValue,
                errorCode: null,
                errorMessage: null,
                lockedAt: null,
                lockedBy: null,
                finishedAt: now,
              },
            });
            if (updatedItem.count !== 1) {
              throw new ProductBatchItemError(
                'ITEM_OWNERSHIP_LOST',
                'SKU 结果提交前任务所有权已变化，事务已回滚',
                true,
              );
            }
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        committed = true;
        break;
      } catch (error) {
        if (isSerializationConflict(error) && attempt < 3) continue;
        throw error;
      }
    }
    if (!committed) {
      throw new ProductBatchItemError('SKU_RESULT_COMMIT_FAILED', 'SKU 结果提交失败', true);
    }
    await this.refreshTask(item.taskId);
    return 'processed';
  }

  private async persistSkuPlatformDrift(
    item: ProductBatchExecutionRecord,
    platformStateValue: PlatformProductSkuState,
    message: string,
    itemMode: 'running' | 'failed',
  ): Promise<'processed' | 'stale'> {
    const platformState = normalizeProductSkuState(platformStateValue);
    if (platformState.state !== 'offline' && platformState.state !== 'draft') {
      throw new ProductBatchItemError(
        SKU_RESULT_UNKNOWN_CODE,
        '平台 SKU 漂移且商品不再处于安全离线状态，请人工核验',
        false,
      );
    }
    const fingerprint = productSkuFingerprint(platformState);
    const prices = skuPriceSnapshot(platformState);
    const inventory = skuInventorySnapshot(platformState);
    const now = new Date();
    const itemWhere =
      itemMode === 'running'
        ? ownedItemWhere(item)
        : {
            id: item.id,
            taskId: item.taskId,
            status: 'failed' as const,
            errorCode: { in: [...UNRESOLVED_SKU_CODES] },
          };
    await this.prisma.$transaction(async (tx) => {
      const updatedProduct = await tx.publishedProduct.updateMany({
        where: {
          id: item.publishedProductId,
          platformProductId: item.publishedProduct.platformProductId,
          mutationRevision: item.expectedMutationRevision,
        },
        data: {
          skuSpecSnapshot: platformState as unknown as Prisma.InputJsonValue,
          skuSpecFingerprint: fingerprint,
          skuSpecSyncedAt: now,
          skuPriceSnapshot: prices as unknown as Prisma.InputJsonValue,
          priceSyncedAt: now,
          salePrice: snapshotStartPrice(prices),
          skuInventorySnapshot: inventory as unknown as Prisma.InputJsonValue,
          inventorySyncStatus: 'pending',
          inventoryNextRunAt: now,
          inventorySyncReason: 'platform_sku_drift',
          inventorySyncError: message,
          status: localStatusFromSkuState(platformState, item.publishedProduct.status),
          platformStatusRaw: platformState.status,
          platformCheckStatusRaw: platformState.checkStatus,
          platformStatusSyncedAt: now,
          platformStatusError: null,
          lastEditError: message,
          mutationRevision: { increment: 1 },
        },
      });
      if (updatedProduct.count !== 1) {
        throw new ProductBatchItemError(
          'SKU_PRODUCT_CHANGED',
          '商品已在 SKU 漂移同步期间变化，请人工核验',
          false,
        );
      }
      const updatedItem = await tx.productBatchItem.updateMany({
        where: itemWhere,
        data: {
          status: 'failed',
          result: {
            reason: 'platform_skus_changed',
            actualSkuFingerprint: fingerprint,
            actualSkuState: platformState,
          } as unknown as Prisma.InputJsonValue,
          errorCode: 'PLATFORM_SKU_CHANGED',
          errorMessage: message,
          lockedAt: null,
          lockedBy: null,
          finishedAt: now,
        },
      });
      if (updatedItem.count !== 1) {
        throw new ProductBatchItemError(
          'ITEM_OWNERSHIP_LOST',
          'SKU 漂移同步前任务所有权已变化，事务已回滚',
          true,
        );
      }
    });
    await this.refreshTask(item.taskId);
    return 'processed';
  }

  private async executeSourceChangeClaimed(
    item: ProductBatchExecutionRecord,
    adapter: PlatformAdapter,
    token: string,
    lock: string,
  ): Promise<'processed' | 'stale'> {
    const product = item.publishedProduct;
    if (!adapter.getProductState) {
      throw new ProductBatchItemError(
        'STATUS_READBACK_UNSUPPORTED',
        '当前平台无法回读商品状态，拒绝执行安全换源',
        false,
      );
    }
    const firstState = await adapter.getProductState(token, product.platformProductId!);
    let confirmedState = await adapter.getProductState(token, product.platformProductId!);
    if (
      firstState.state !== 'offline' ||
      confirmedState.state !== 'offline' ||
      !sameStableOfflineState(firstState, confirmedState)
    ) {
      throw new ProductBatchItemError(
        'SOURCE_CHANGE_PLATFORM_NOT_OFFLINE',
        '平台未连续确认商品处于下架状态，拒绝切换采购货源',
        false,
      );
    }
    const frozen = parseFrozenSourceChangeTarget(item.desiredSnapshot);
    const before = jsonRecord(item.beforeSnapshot);
    const beforeSourceProductDatabaseId = positiveIdOrNull(before?.sourceProductDatabaseId);
    const beforeBindingId = positiveIdOrNull(before?.sourceBindingId);
    const beforeBindingRevision = positiveIntegerOrNull(before?.sourceBindingRevision);
    const beforeBindingFingerprint = strictFingerprintOrNull(before?.sourceBindingFingerprint);
    const beforeRoutesFingerprint = strictFingerprintOrNull(before?.sourceRoutesFingerprint);
    if (
      beforeSourceProductDatabaseId === null ||
      beforeBindingId === null ||
      beforeBindingRevision === null ||
      !beforeBindingFingerprint ||
      !beforeRoutesFingerprint
    ) {
      throw new ProductBatchItemError(
        'SOURCE_CHANGE_PREVIEW_INVALID',
        '安全换源预览缺少当前货源绑定证据，请重新生成预览',
        false,
      );
    }
    await this.platformProductLocks.renew(product.id, lock);
    if (!(await this.renewClaimedItemLease(item, false))) return 'stale';

    let committed = false;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.prisma.$transaction(
          async (tx) => {
            const current = await tx.publishedProduct.findUnique({
              where: { id: product.id },
              include: {
                shop: true,
                sourceProduct: true,
                sourceBindings: CURRENT_SOURCE_BINDING_INCLUDE,
              },
            });
            if (
              !current ||
              current.platformProductId !== product.platformProductId ||
              current.status !== 'offline' ||
              current.mutationRevision !== item.expectedMutationRevision ||
              current.sourceProductId !== beforeSourceProductDatabaseId
            ) {
              throw new ProductBatchItemError(
                'SOURCE_CHANGE_PRODUCT_CHANGED',
                '商品已在换源执行前发生变化，请重新生成预览',
                false,
              );
            }
            const syncReason = this.sourceChangeSyncUnavailableReason(current.shop, new Date());
            const unavailableReason = sourceChangeUnavailableReason(current, false, syncReason);
            if (unavailableReason) {
              throw new ProductBatchItemError(
                'SOURCE_CHANGE_UNAVAILABLE',
                unavailableReason,
                false,
              );
            }
            const currentBinding = current.sourceBindings[0]!;
            if (
              currentBinding.id !== beforeBindingId ||
              currentBinding.revision !== beforeBindingRevision ||
              currentBinding.bindingFingerprint !== beforeBindingFingerprint ||
              sourceBindingRoutesFingerprint(currentBinding.skuRoutes) !== beforeRoutesFingerprint
            ) {
              throw new ProductBatchItemError(
                'SOURCE_CHANGE_BINDING_CHANGED',
                '商品当前货源绑定已变化，请重新生成预览',
                false,
              );
            }
            const target = await tx.sourceProduct.findFirst({
              where: {
                id: frozen.sourceProductDatabaseId,
                productId1688: frozen.sourceOfferId,
                userSourceProducts: { some: { userId: item.task.userId } },
              },
            });
            if (!target) {
              throw new ProductBatchItemError(
                'SOURCE_CHANGE_TARGET_MISSING',
                '目标 1688 货源已从采集箱移除或不属于当前账号',
                false,
              );
            }
            const targetSupplierId = target.supplierId?.trim();
            if (!targetSupplierId) {
              throw new ProductBatchItemError(
                'SOURCE_CHANGE_TARGET_CHANGED',
                '目标 1688 货源缺少供应商标识，不能安全采购',
                false,
              );
            }
            if (
              target.availability !== 'available' ||
              !target.isOnePieceDrop ||
              target.totalStock <= 0 ||
              target.inventoryFingerprint !== frozen.inventoryFingerprint ||
              target.inventoryVersion !== frozen.inventoryVersion ||
              target.syncedAt.getTime() !== frozen.sourceSyncedAt.getTime() ||
              targetSupplierId !== frozen.sourceSupplierId ||
              target.title !== frozen.sourceTitle
            ) {
              throw new ProductBatchItemError(
                'SOURCE_CHANGE_TARGET_CHANGED',
                '目标 1688 货源已在预览后变化，请重新采集并生成预览',
                false,
              );
            }
            const suggestion = buildSkuSuggestion(target.skuList, Number(target.price));
            const routes = buildSourceChangeRoutes(
              currentBinding.skuRoutes,
              suggestion,
              target.skuList,
            );
            const recomputedFingerprint = sourceBindingFingerprint({
              sourceProductId: target.id,
              sourceOfferId: target.productId1688,
              sourceSupplierId: targetSupplierId,
              sourceOnePieceDrop: target.isOnePieceDrop,
              sourceFingerprint: suggestion.sourceFingerprint,
              inventoryFingerprint: target.inventoryFingerprint,
              inventoryVersion: target.inventoryVersion,
              skuRoutes: routes,
            });
            if (
              frozen.bindingRevision !== currentBinding.revision + 1 ||
              frozen.sourceFingerprint !== suggestion.sourceFingerprint ||
              frozen.bindingFingerprint !== recomputedFingerprint ||
              sourceBindingRoutesFingerprint(frozen.skuRoutes) !==
                sourceBindingRoutesFingerprint(routes)
            ) {
              throw new ProductBatchItemError(
                'SOURCE_CHANGE_TARGET_CHANGED',
                '目标货源 SKU 路由或指纹已变化，请重新生成预览',
                false,
              );
            }

            const switchedAt = new Date();
            const closed = await tx.publishedProductSourceBinding.updateMany({
              where: {
                id: currentBinding.id,
                publishedProductId: current.id,
                revision: currentBinding.revision,
                currentSlot: 1,
                bindingFingerprint: currentBinding.bindingFingerprint,
                effectiveTo: null,
              },
              data: { currentSlot: null, effectiveTo: switchedAt },
            });
            if (closed.count !== 1) {
              throw new ProductBatchItemError(
                'SOURCE_CHANGE_BINDING_CHANGED',
                '商品当前货源绑定已并发变化，请重新生成预览',
                false,
              );
            }
            const nextBinding = await tx.publishedProductSourceBinding.create({
              data: {
                publishedProductId: current.id,
                sourceProductId: target.id,
                revision: frozen.bindingRevision,
                currentSlot: 1,
                effectiveFrom: switchedAt,
                sourceOfferId: target.productId1688,
                sourceSupplierId: targetSupplierId,
                sourceOnePieceDrop: target.isOnePieceDrop,
                sourceFingerprint: suggestion.sourceFingerprint,
                inventoryFingerprint: target.inventoryFingerprint,
                inventoryVersion: target.inventoryVersion,
                skuRoutes: routes as unknown as Prisma.InputJsonValue,
                bindingFingerprint: recomputedFingerprint,
              },
            });
            const updatedProduct = await tx.publishedProduct.updateMany({
              where: {
                id: current.id,
                status: 'offline',
                sourceProductId: beforeSourceProductDatabaseId,
                mutationRevision: item.expectedMutationRevision,
                inventorySyncStatus: { not: 'syncing' },
              },
              data: {
                sourceProductId: target.id,
                costPrice: Math.min(...routes.map((route) => route.sourceUnitCost)),
                mutationRevision: { increment: 1 },
                inventorySyncStatus: 'pending',
                inventoryTargetFingerprint: target.inventoryFingerprint,
                inventoryTargetVersion: target.inventoryVersion,
                inventoryNextRunAt: switchedAt,
                inventoryLockedAt: null,
                inventoryLockedBy: null,
                inventorySyncReason: 'source_changed_offline',
                inventorySyncError: null,
              },
            });
            if (updatedProduct.count !== 1) {
              throw new ProductBatchItemError(
                'SOURCE_CHANGE_PRODUCT_CHANGED',
                '商品已在换源提交时发生变化，请重新生成预览',
                false,
              );
            }
            const updatedItem = await tx.productBatchItem.updateMany({
              where: ownedItemWhere(item),
              data: {
                status: 'succeeded',
                result: {
                  reason: 'source_binding_switched',
                  actualStatus: 'offline',
                  actualSourceProductId: target.productId1688,
                  sourceBindingId: nextBinding.id.toString(),
                  sourceBindingRevision: nextBinding.revision,
                  bindingFingerprint: nextBinding.bindingFingerprint,
                  effectiveFrom: switchedAt.toISOString(),
                  platformState: confirmedState,
                } as unknown as Prisma.InputJsonValue,
                errorCode: null,
                errorMessage: null,
                lockedAt: null,
                lockedBy: null,
                finishedAt: switchedAt,
              },
            });
            if (updatedItem.count !== 1) {
              throw new ProductBatchItemError(
                'ITEM_OWNERSHIP_LOST',
                '换源提交前任务所有权已变化，事务已回滚',
                true,
              );
            }
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        committed = true;
        break;
      } catch (error) {
        if (isSerializationConflict(error) && attempt < 3) {
          await this.platformProductLocks.renew(product.id, lock);
          const retryState = await adapter.getProductState(token, product.platformProductId!);
          const retryConfirmation = await adapter.getProductState(
            token,
            product.platformProductId!,
          );
          if (
            retryState.state !== 'offline' ||
            retryConfirmation.state !== 'offline' ||
            !sameStableOfflineState(retryState, retryConfirmation)
          ) {
            throw new ProductBatchItemError(
              'SOURCE_CHANGE_PLATFORM_NOT_OFFLINE',
              '并发重试前平台未连续确认商品下架，拒绝切换采购货源',
              false,
            );
          }
          confirmedState = retryConfirmation;
          continue;
        }
        throw error;
      }
    }
    if (!committed) {
      throw new ProductBatchItemError(
        'SOURCE_CHANGE_CONFLICT',
        '换源事务持续发生并发冲突，请刷新后重试',
        true,
      );
    }
    await this.refreshTask(item.taskId);
    return 'processed';
  }

  private async executeOfflineClaimed(
    item: ProductBatchExecutionRecord,
    adapter: PlatformAdapter,
    token: string,
    lock: string,
  ): Promise<'processed' | 'stale'> {
    const product = item.publishedProduct;
    const cleanupAction = item.task.action === 'cleanup';
    if (cleanupAction) await this.assertCleanupStillEligible(item, 'before_write');
    const demoShop = isDemoShop(product.shop);
    if (!demoShop && !adapter.getProductState) {
      throw new ProductBatchItemError(
        'STATUS_READBACK_UNSUPPORTED',
        '当前平台无法回读商品状态，拒绝执行下架',
        false,
      );
    }

    let recovered = false;
    if (adapter.getProductState) {
      const platformBefore = await adapter.getProductState(token, product.platformProductId!);
      if (isOfflineState(platformBefore.state)) {
        const confirmedBefore = await adapter.getProductState(token, product.platformProductId!);
        if (!sameStableOfflineState(platformBefore, confirmedBefore)) {
          throw new ProductBatchItemError(
            OFFLINE_RESULT_UNKNOWN_CODE,
            '平台下架状态连续回读不一致，请稍后核验实际状态',
            false,
          );
        }
        recovered = true;
        const cleanupFailure = cleanupAction
          ? await this.cleanupPostWriteFailure(item).catch(() => ({
              code: 'CLEANUP_POSTCHECK_UNAVAILABLE_AFTER_OFFLINE',
              message: '平台已下架，但订单证据复核失败，请人工复核后决定是否重新上架',
            }))
          : null;
        return this.persistOfflineResult(item, confirmedBefore, recovered, cleanupFailure, lock);
      }
      if (platformBefore.state !== 'online') {
        throw new ProductBatchItemError(
          'OFFLINE_PREFLIGHT_STATE_INVALID',
          `平台商品当前状态为 ${platformBefore.state}，拒绝执行下架`,
          false,
        );
      }
    }

    await this.platformProductLocks.renew(product.id, lock);
    if (!(await this.markOfflineWriteStarted(item))) return this.cancelClaimedItem(item);
    try {
      await this.platformProductLocks.renew(product.id, lock);
    } catch {
      throw new ProductBatchItemError(
        'OFFLINE_WRITE_GUARD_LOST',
        '下架写入前商品锁已失效，平台请求尚未提交',
        true,
      );
    }
    if (!(await this.renewClaimedItemLease(item, false))) {
      throw new ProductBatchItemError(
        'OFFLINE_WRITE_GUARD_LOST',
        '下架写入前任务所有权已变化，平台请求尚未提交',
        true,
      );
    }
    const productBeforeWrite = await this.prisma.publishedProduct.findUnique({
      where: { id: product.id },
      select: { platformProductId: true, mutationRevision: true },
    });
    if (
      productBeforeWrite?.platformProductId !== product.platformProductId ||
      productBeforeWrite.mutationRevision !== item.expectedMutationRevision
    ) {
      throw new ProductBatchItemError(
        'OFFLINE_WRITE_ABORTED_PRODUCT_CHANGED',
        '商品已在下架写入前发生变化，平台请求未提交，请重新生成预览',
        false,
      );
    }
    if (cleanupAction) await this.assertCleanupStillEligible(item, 'immediately_before_write');

    let mutationError: unknown;
    try {
      await adapter.offlineProduct(token, product.platformProductId!);
    } catch (error) {
      mutationError = error;
    }
    try {
      await this.platformProductLocks.renew(product.id, lock);
    } catch {
      if (mutationError && !isPlatformMutationResultUnknown(mutationError)) {
        throw new ProductBatchItemError(
          'OFFLINE_UPDATE_FAILED',
          safeErrorMessage(mutationError),
          true,
        );
      }
      throw new ProductBatchItemError(
        OFFLINE_RESULT_UNKNOWN_CODE,
        '下架请求后商品锁失效，必须核验平台实际状态',
        false,
      );
    }
    if (!(await this.renewClaimedItemLease(item, false))) {
      if (mutationError && !isPlatformMutationResultUnknown(mutationError)) {
        throw new ProductBatchItemError(
          'OFFLINE_UPDATE_FAILED',
          safeErrorMessage(mutationError),
          true,
        );
      }
      throw new ProductBatchItemError(
        OFFLINE_RESULT_UNKNOWN_CODE,
        '下架请求后任务所有权失效，必须核验平台实际状态',
        false,
      );
    }

    let firstAfter: PlatformProductState;
    let confirmedAfter: PlatformProductState;
    try {
      if (!adapter.getProductState) {
        if (mutationError) throw mutationError;
        firstAfter = { state: 'offline', status: null, checkStatus: null };
        confirmedAfter = firstAfter;
      } else {
        firstAfter = await adapter.getProductState(token, product.platformProductId!);
        confirmedAfter = await adapter.getProductState(token, product.platformProductId!);
      }
    } catch {
      if (mutationError && !isPlatformMutationResultUnknown(mutationError)) {
        throw new ProductBatchItemError(
          'OFFLINE_UPDATE_FAILED',
          safeErrorMessage(mutationError),
          true,
        );
      }
      throw new ProductBatchItemError(
        OFFLINE_RESULT_UNKNOWN_CODE,
        '下架写入已经开始但平台状态暂时无法稳定回读，请稍后核验',
        false,
      );
    }
    if (!sameStableOfflineState(firstAfter, confirmedAfter)) {
      if (
        mutationError &&
        !isPlatformMutationResultUnknown(mutationError) &&
        sameStableOnlineState(firstAfter, confirmedAfter)
      ) {
        throw new ProductBatchItemError(
          'OFFLINE_UPDATE_FAILED',
          safeErrorMessage(mutationError),
          true,
        );
      }
      throw new ProductBatchItemError(
        OFFLINE_RESULT_UNKNOWN_CODE,
        mutationError
          ? '下架请求结果未知且平台尚未稳定确认下架，请稍后核验'
          : '平台尚未稳定确认商品下架，请稍后核验',
        false,
      );
    }
    recovered = Boolean(mutationError);
    const cleanupFailure = cleanupAction
      ? await this.cleanupPostWriteFailure(item).catch(() => ({
          code: 'CLEANUP_POSTCHECK_UNAVAILABLE_AFTER_OFFLINE',
          message: '平台已下架，但订单证据复核失败，请人工复核后决定是否重新上架',
        }))
      : null;
    return this.persistOfflineResult(item, confirmedAfter, recovered, cleanupFailure, lock);
  }

  private async markOfflineWriteStarted(item: ProductBatchExecutionRecord): Promise<boolean> {
    const now = new Date();
    const updated = await this.prisma.productBatchItem.updateMany({
      where: {
        ...ownedItemWhere(item),
        task: { cancelRequestedAt: null },
      },
      data: {
        lockedAt: now,
        result: {
          phase: 'platform_write_started',
          operation: item.task.action,
          offlineWriteStartedAt: now.toISOString(),
        } as Prisma.InputJsonValue,
        errorCode: OFFLINE_WRITE_STARTED_CODE,
        errorMessage: '平台下架写入已开始，正在稳定回读实际状态',
      },
    });
    return updated.count === 1;
  }

  private async assertCleanupStillEligible(
    item: ProductBatchExecutionRecord,
    stage: 'before_write' | 'immediately_before_write',
  ): Promise<void> {
    const frozen = parseCleanupEvidence(jsonRecord(item.beforeSnapshot)?.cleanupEvidence);
    if (!frozen || frozen.policyVersion !== CLEANUP_POLICY_VERSION) {
      throw new ProductBatchItemError(
        'CLEANUP_EVIDENCE_INVALID',
        '滞销清理证据缺失或版本无效，请重新生成预览',
        false,
      );
    }
    const currentProduct = await this.prisma.publishedProduct.findUnique({
      where: { id: item.publishedProductId },
      include: { shop: true },
    });
    if (
      !currentProduct ||
      currentProduct.platformProductId !== item.publishedProduct.platformProductId
    ) {
      throw new ProductBatchItemError(
        'CLEANUP_PRODUCT_CHANGED',
        '商品平台绑定已变化，请重新生成滞销清理预览',
        false,
      );
    }
    const assessment = (await this.assessCleanupCandidates([currentProduct], new Date())).get(
      item.publishedProductId,
    )!;
    if (assessment.eligible) return;
    const saleDetected = assessment.evidence.validOrderCount > 0;
    throw new ProductBatchItemError(
      saleDetected ? 'CLEANUP_SALE_DETECTED' : (assessment.code ?? 'CLEANUP_EVIDENCE_CHANGED'),
      saleDetected
        ? '商品在清理预览后出现有效订单，已停止下架，请重新核对'
        : `${stage === 'immediately_before_write' ? '提交前' : '执行前'}滞销证据已失效：${assessment.reason ?? '请重新生成预览'}`,
      false,
    );
  }

  private async cleanupPostWriteFailure(
    item: ProductBatchExecutionRecord,
  ): Promise<{ code: string; message: string } | null> {
    const currentProduct = await this.prisma.publishedProduct.findUnique({
      where: { id: item.publishedProductId },
      include: { shop: true },
    });
    if (
      !currentProduct ||
      currentProduct.platformProductId !== item.publishedProduct.platformProductId
    ) {
      return {
        code: 'CLEANUP_PRODUCT_CHANGED_AFTER_OFFLINE',
        message: '平台已下架，但商品平台绑定已变化，请人工复核',
      };
    }
    const assessment = (await this.assessCleanupCandidates([currentProduct], new Date())).get(
      item.publishedProductId,
    )!;
    if (assessment.eligible) return null;
    if (assessment.evidence.validOrderCount > 0) {
      return {
        code: 'CLEANUP_SALE_DETECTED_AFTER_OFFLINE',
        message: '清理执行期间出现有效订单，平台已安全下架，请人工复核订单后决定是否重新上架',
      };
    }
    return {
      code: 'CLEANUP_EVIDENCE_CHANGED_AFTER_OFFLINE',
      message: `平台已下架，但订单证据在执行期间失效：${assessment.reason ?? '请人工复核'}`,
    };
  }

  private async persistOfflineResult(
    item: ProductBatchExecutionRecord,
    platformState: PlatformProductState,
    recovered: boolean,
    failure: { code: string; message: string } | null,
    lock?: string,
  ): Promise<'processed' | 'stale'> {
    const product = item.publishedProduct;
    if (lock) await this.platformProductLocks.renew(product.id, lock);
    const now = new Date();
    const persistedStatus = platformState.state === 'deleted' ? 'rejected' : 'offline';
    const result = {
      reason: failure
        ? 'cleanup_requires_manual_review'
        : platformState.state === 'deleted'
          ? 'platform_product_deleted'
          : recovered
            ? 'platform_result_recovered'
            : 'offline_confirmed',
      recovered,
      actualStatus: platformState.state,
      platformState,
      ...(failure ? { cleanupFailureCode: failure.code } : {}),
    };
    try {
      await this.prisma.$transaction(async (tx) => {
        const updatedProduct = await tx.publishedProduct.updateMany({
          where: {
            id: product.id,
            platformProductId: product.platformProductId,
            mutationRevision: item.expectedMutationRevision,
            status: 'online',
          },
          data: {
            status: persistedStatus,
            mutationRevision: { increment: 1 },
            inventorySyncStatus: 'synced',
            inventoryNextRunAt: null,
            inventoryLockedAt: null,
            inventoryLockedBy: null,
            inventorySyncReason:
              platformState.state === 'deleted'
                ? 'platform_product_deleted'
                : item.task.action === 'cleanup'
                  ? 'slow_sales_cleanup'
                  : 'manual_batch_offline',
            inventorySyncError: null,
            platformStatusError: null,
            platformStatusRaw: platformState.status,
            platformCheckStatusRaw: platformState.checkStatus,
            platformStatusSyncedAt: now,
          },
        });
        if (updatedProduct.count !== 1) {
          const latest = await tx.publishedProduct.findUnique({ where: { id: product.id } });
          if (!latest || latest.platformProductId !== product.platformProductId) {
            throw new ProductBatchItemError(
              'OFFLINE_COMMIT_CONFLICT',
              '商品平台绑定已变化，平台已下架，请人工复核本地绑定',
              false,
            );
          }
          if (latest.status !== persistedStatus) {
            throw new ProductBatchItemError(
              'OFFLINE_COMMIT_CONFLICT',
              '商品状态已变化，平台已下架，请人工复核',
              false,
            );
          }
        }
        const updatedItem = await tx.productBatchItem.updateMany({
          where: ownedItemWhere(item),
          data: {
            status: failure ? 'failed' : 'succeeded',
            result: result as unknown as Prisma.InputJsonValue,
            errorCode: failure?.code ?? null,
            errorMessage: failure?.message ?? null,
            lockedAt: null,
            lockedBy: null,
            finishedAt: now,
          },
        });
        if (updatedItem.count !== 1) {
          throw new ProductBatchItemError(
            'ITEM_OWNERSHIP_LOST',
            '平台已下架，但批量任务所有权已变化，将由核验流程收敛',
            true,
          );
        }
      });
    } catch (error) {
      if (!(await this.offlineCommitWasPersisted(item, failure?.code ?? null))) throw error;
    }
    await this.refreshTask(item.taskId);
    return 'processed';
  }

  private async offlineCommitWasPersisted(
    item: ProductBatchExecutionRecord,
    expectedFailureCode: string | null,
  ): Promise<boolean> {
    const [storedItem, storedProduct] = await Promise.all([
      this.prisma.productBatchItem.findUnique({ where: { id: item.id } }),
      this.prisma.publishedProduct.findUnique({ where: { id: item.publishedProductId } }),
    ]);
    if (!storedItem || !storedProduct || !['offline', 'rejected'].includes(storedProduct.status)) {
      return false;
    }
    return expectedFailureCode
      ? storedItem.status === 'failed' && storedItem.errorCode === expectedFailureCode
      : storedItem.status === 'succeeded' && storedItem.errorCode === null;
  }

  private async executeOnlineClaimed(
    item: ProductBatchExecutionRecord,
    adapter: PlatformAdapter,
    token: string,
    lock: string,
  ): Promise<'processed' | 'stale'> {
    const product = item.publishedProduct;
    const desiredRecord = jsonRecord(item.desiredSnapshot);
    const desiredInventory = parseSkuInventorySnapshot(desiredRecord?.skuInventory);
    const desiredFingerprint = inventoryFingerprintValue(desiredRecord?.inventoryFingerprint);
    const desiredVersion = positiveIntegerOrNull(desiredRecord?.inventoryVersion);
    if (
      desiredRecord?.status !== 'online' ||
      !desiredInventory ||
      !desiredFingerprint ||
      !desiredVersion ||
      inventoryTotalStock(desiredInventory) <= 0
    ) {
      throw new ProductBatchItemError(
        'ONLINE_SNAPSHOT_INVALID',
        '批量上架快照不完整或没有可售库存，请重新生成预览',
        false,
      );
    }
    if (!adapter.onlineProduct || !adapter.getProductState || !adapter.getProductInventory) {
      throw new ProductBatchItemError(
        'ONLINE_UNSUPPORTED',
        '当前平台不支持库存可回读的安全上架',
        false,
      );
    }

    await this.assertOnlineSnapshotCurrent(
      item,
      desiredInventory,
      desiredFingerprint,
      desiredVersion,
    );
    const platformBefore = await adapter.getProductState(token, product.platformProductId!);
    if (platformBefore.state === 'online') {
      if (!(await this.markOnlineVerificationRequired(item))) {
        await this.quarantineOnlineProduct(item, adapter, token, platformBefore, lock);
        return 'stale';
      }
      let inventoryState: PlatformProductInventoryState;
      let confirmedState: PlatformProductState;
      let actualInventory: ProductBatchInventorySnapshot;
      try {
        inventoryState = await adapter.getProductInventory(token, product.platformProductId!);
        confirmedState = await adapter.getProductState(token, product.platformProductId!);
        actualInventory = platformSkuInventorySnapshot(inventoryState);
      } catch (error) {
        await this.quarantineOnlineWithFence(
          item,
          adapter,
          token,
          '平台在线商品回读失败',
          platformBefore,
          lock,
          true,
        );
        throw new ProductBatchItemError(
          'ONLINE_PLATFORM_READBACK_FAILED_QUARANTINED',
          `平台在线商品回读失败，已下架隔离：${safeErrorMessage(error)}`,
          false,
        );
      }
      if (inventoryState.state !== 'online' || confirmedState.state !== 'online') {
        await this.quarantineOnlineWithFence(
          item,
          adapter,
          token,
          '平台在线商品状态与库存回读不一致',
          confirmedState.state === 'online' ? confirmedState : platformBefore,
          lock,
          true,
        );
        throw new ProductBatchItemError(
          'ONLINE_READBACK_INCONSISTENT',
          '平台状态与库存回读的售卖状态不一致，已下架隔离',
          false,
        );
      }
      if (!sameSkuInventory(actualInventory, desiredInventory)) {
        await this.quarantineOnlineWithFence(
          item,
          adapter,
          token,
          '平台在线商品库存与目标不一致',
          platformBefore,
          lock,
          true,
        );
        throw new ProductBatchItemError(
          'ONLINE_PLATFORM_DRIFT_QUARANTINED',
          '平台商品已意外在线且库存不一致，已重新下架，请核验库存后再预览',
          false,
        );
      }
      try {
        return await this.persistOnlineResult(
          item,
          desiredInventory,
          desiredFingerprint,
          desiredVersion,
          confirmedState,
          true,
          lock,
          adapter,
          token,
        );
      } catch (error) {
        await this.quarantineOnlineWithFence(
          item,
          adapter,
          token,
          '平台在线恢复结果无法安全提交',
          confirmedState,
          lock,
          true,
        );
        throw error;
      }
    }
    if (
      platformBefore.state === 'rejected' ||
      platformBefore.state === 'blocked' ||
      platformBefore.state === 'deleted'
    ) {
      return this.persistRejectedOnlineResult(item, platformBefore, lock);
    }
    if (platformBefore.state !== 'offline') {
      await this.quarantineOnlineWithFence(
        item,
        adapter,
        token,
        `平台商品状态为 ${platformBefore.state}`,
        platformBefore,
        lock,
      );
      throw new ProductBatchItemError(
        'ONLINE_STATE_INVALID',
        `平台商品状态为 ${platformBefore.state}，已下架隔离并停止批量上架`,
        false,
      );
    }

    let platformInventoryState = await adapter.getProductInventory(
      token,
      product.platformProductId!,
    );
    if (platformInventoryState.state !== 'offline') {
      await this.quarantineOnlineWithFence(
        item,
        adapter,
        token,
        '平台状态与库存回读不一致',
        platformInventoryState,
        lock,
      );
      throw new ProductBatchItemError(
        'ONLINE_READBACK_INCONSISTENT',
        '平台状态与库存回读不一致，已下架隔离并停止上架',
        false,
      );
    }
    let actualInventory = platformSkuInventorySnapshot(platformInventoryState);
    if (!sameInventorySkuIds(actualInventory, desiredInventory)) {
      throw new ProductBatchItemError(
        'ONLINE_SKU_MISMATCH',
        '平台与 1688 的 SKU 集合不一致，不能安全上架',
        false,
      );
    }
    const pendingInventory = pendingInventoryItems(actualInventory, desiredInventory);
    if (pendingInventory.length > 0) {
      await this.assertOnlineSnapshotCurrent(
        item,
        desiredInventory,
        desiredFingerprint,
        desiredVersion,
      );
      await this.platformProductLocks.renew(product.id, lock);
      if (!(await this.assertItemOwned(item))) return 'stale';
      let inventoryMutationError: unknown;
      try {
        await adapter.syncInventory(token, {
          platformProductId: product.platformProductId!,
          idempotencyKey: batchOnlineInventoryIdempotencyKey(
            item.id,
            desiredVersion,
            desiredFingerprint,
            pendingInventory,
          ),
          items: pendingInventory,
        });
      } catch (error) {
        inventoryMutationError = error;
      }
      try {
        platformInventoryState = await adapter.getProductInventory(
          token,
          product.platformProductId!,
        );
      } catch (readbackError) {
        if (inventoryMutationError) throw inventoryMutationError;
        throw readbackError;
      }
      if (platformInventoryState.state !== 'offline') {
        await this.quarantineOnlineWithFence(
          item,
          adapter,
          token,
          '库存补齐后平台商品状态发生变化',
          platformInventoryState,
          lock,
        );
        throw new ProductBatchItemError(
          'ONLINE_READBACK_INCONSISTENT',
          '库存同步期间平台商品状态发生变化',
          false,
        );
      }
      actualInventory = platformSkuInventorySnapshot(platformInventoryState);
      if (!sameSkuInventory(actualInventory, desiredInventory)) {
        throw new ProductBatchItemError(
          isPlatformMutationResultUnknown(inventoryMutationError)
            ? 'ONLINE_INVENTORY_RESULT_UNKNOWN'
            : 'ONLINE_INVENTORY_NOT_CONFIRMED',
          isPlatformMutationResultUnknown(inventoryMutationError)
            ? '库存写入结果未知，商品保持下架；请核验库存后重新预览'
            : '平台尚未确认上架所需的全部 SKU 库存，商品保持下架',
          false,
        );
      }
    }

    await this.assertOnlineSnapshotCurrent(
      item,
      desiredInventory,
      desiredFingerprint,
      desiredVersion,
    );
    const stateBeforeWrite = await adapter.getProductState(token, product.platformProductId!);
    if (
      stateBeforeWrite.state === 'rejected' ||
      stateBeforeWrite.state === 'blocked' ||
      stateBeforeWrite.state === 'deleted'
    ) {
      return this.persistRejectedOnlineResult(item, stateBeforeWrite, lock);
    }
    if (stateBeforeWrite.state !== 'offline') {
      await this.quarantineOnlineWithFence(
        item,
        adapter,
        token,
        '上架写入前平台商品状态发生变化',
        stateBeforeWrite,
        lock,
      );
      throw new ProductBatchItemError(
        'ONLINE_STATE_CHANGED',
        '平台商品状态在上架前发生变化，已下架隔离并停止执行',
        false,
      );
    }
    platformInventoryState = await adapter.getProductInventory(token, product.platformProductId!);
    actualInventory = platformSkuInventorySnapshot(platformInventoryState);
    if (platformInventoryState.state !== 'offline') {
      await this.quarantineOnlineWithFence(
        item,
        adapter,
        token,
        '上架写入前平台库存状态未确认',
        platformInventoryState,
        lock,
      );
      throw new ProductBatchItemError(
        'ONLINE_PREFLIGHT_NOT_CONFIRMED',
        '上架前平台离线状态未能再次确认，已停止执行',
        false,
      );
    }
    if (!sameSkuInventory(actualInventory, desiredInventory)) {
      throw new ProductBatchItemError(
        'ONLINE_PREFLIGHT_NOT_CONFIRMED',
        '上架前平台 SKU 库存未能再次确认，已停止执行',
        false,
      );
    }
    await this.platformProductLocks.renew(product.id, lock);
    if (!(await this.markOnlineWriteStarted(item, desiredFingerprint, desiredVersion))) {
      return this.cancelClaimedItem(item);
    }
    try {
      await this.platformProductLocks.renew(product.id, lock);
    } catch (_error) {
      throw new ProductBatchItemError(
        'ONLINE_WRITE_GUARD_LOST',
        '上架写入前商品锁已失效，平台请求尚未提交',
        true,
      );
    }
    if (!(await this.assertItemOwned(item))) {
      throw new ProductBatchItemError(
        'ONLINE_WRITE_GUARD_LOST',
        '上架写入前任务所有权已变化，平台请求尚未提交',
        true,
      );
    }
    await this.assertOnlineSnapshotCurrent(
      item,
      desiredInventory,
      desiredFingerprint,
      desiredVersion,
    );

    let mutationError: unknown;
    try {
      await adapter.onlineProduct(token, product.platformProductId!);
    } catch (error) {
      mutationError = error;
    }

    try {
      await this.platformProductLocks.renew(product.id, lock);
    } catch (_error) {
      return this.quarantineUnknownOnlineResult(item, adapter, token, '上架请求后商品锁失效');
    }
    if (!(await this.renewClaimedItemLease(item, false))) {
      return this.quarantineUnknownOnlineResult(
        item,
        adapter,
        token,
        '上架请求后批量任务执行权失效',
        undefined,
        lock,
      );
    }

    let platformAfter: PlatformProductState;
    let confirmedAfter: PlatformProductState;
    let inventoryState: PlatformProductInventoryState;
    let inventoryAfter: ProductBatchInventorySnapshot;
    try {
      platformAfter = await adapter.getProductState(token, product.platformProductId!);
      inventoryState = await adapter.getProductInventory(token, product.platformProductId!);
      confirmedAfter = await adapter.getProductState(token, product.platformProductId!);
      inventoryAfter = platformSkuInventorySnapshot(inventoryState);
    } catch (_error) {
      return this.quarantineUnknownOnlineResult(
        item,
        adapter,
        token,
        '上架写入后无法可靠回读平台状态与库存',
        undefined,
        lock,
      );
    }
    if (
      platformAfter.state !== confirmedAfter.state ||
      inventoryState.state !== confirmedAfter.state
    ) {
      const knownOnlineState =
        confirmedAfter.state === 'online'
          ? confirmedAfter
          : platformAfter.state === 'online'
            ? platformAfter
            : inventoryState.state === 'online'
              ? inventoryState
              : undefined;
      return this.quarantineUnknownOnlineResult(
        item,
        adapter,
        token,
        '平台状态与库存双回读未稳定收敛',
        knownOnlineState,
        lock,
      );
    }
    platformAfter = confirmedAfter;

    if (platformAfter.state === 'online') {
      try {
        await this.assertOnlineSnapshotCurrent(
          item,
          desiredInventory,
          desiredFingerprint,
          desiredVersion,
        );
        if (!sameSkuInventory(inventoryAfter, desiredInventory)) {
          throw new ProductBatchItemError(
            'ONLINE_INVENTORY_DRIFT',
            '平台上架后的 SKU 库存与 1688 目标不一致',
            false,
          );
        }
        return await this.persistOnlineResult(
          item,
          desiredInventory,
          desiredFingerprint,
          desiredVersion,
          platformAfter,
          Boolean(mutationError),
          lock,
          adapter,
          token,
        );
      } catch (error) {
        await this.quarantineOnlineProduct(item, adapter, token, platformAfter, lock);
        if (error instanceof ProductBatchItemError) throw error;
        throw new ProductBatchItemError(
          'ONLINE_COMMIT_FAILED',
          '平台已上架但本地结果未能安全提交，已重新下架，请重新预览',
          false,
        );
      }
    }
    if (
      platformAfter.state === 'reviewing' ||
      platformAfter.state === 'approved_pending_online' ||
      platformAfter.state === 'draft' ||
      platformAfter.state === 'unknown'
    ) {
      return this.quarantineUnknownOnlineResult(
        item,
        adapter,
        token,
        `平台上架结果尚未收敛，当前状态为 ${platformAfter.state}`,
        platformAfter,
        lock,
      );
    }
    if (platformAfter.state === 'offline') {
      if (mutationError && !isPlatformMutationResultUnknown(mutationError)) {
        throw new ProductBatchItemError(
          'ONLINE_UPDATE_FAILED',
          safeErrorMessage(mutationError),
          false,
        );
      }
      return this.quarantineUnknownOnlineResult(
        item,
        adapter,
        token,
        '平台仍显示商品下架，上架请求结果尚未收敛',
        undefined,
        lock,
      );
    }
    return this.persistRejectedOnlineResult(item, platformAfter, lock);
  }

  private async markOnlineWriteStarted(
    item: ProductBatchExecutionRecord,
    desiredFingerprint: string,
    desiredVersion: number,
  ): Promise<boolean> {
    const now = new Date();
    const updated = await this.prisma.productBatchItem.updateMany({
      where: {
        ...ownedItemWhere(item),
        task: { cancelRequestedAt: null },
      },
      data: {
        lockedAt: now,
        result: {
          phase: 'platform_write_started',
          onlineWriteStartedAt: now.toISOString(),
          inventoryFingerprint: desiredFingerprint,
          inventoryVersion: desiredVersion,
        } as Prisma.InputJsonValue,
        errorCode: ONLINE_WRITE_STARTED_CODE,
        errorMessage: '平台上架写入已开始，正在回读确认状态与库存',
      },
    });
    return updated.count === 1;
  }

  private async markOnlineVerificationRequired(
    item: ProductBatchExecutionRecord,
  ): Promise<boolean> {
    const now = new Date();
    const updated = await this.prisma.productBatchItem.updateMany({
      where: ownedItemWhere(item),
      data: {
        lockedAt: now,
        result: {
          ...(jsonRecord(item.result) ?? {}),
          phase: 'platform_online_detected',
          onlineWriteStartedAt: now.toISOString(),
        } as Prisma.InputJsonValue,
        errorCode: ONLINE_RESULT_UNKNOWN_CODE,
        errorMessage: '平台商品已在线，必须完成状态与库存强回读或下架隔离',
      },
    });
    return updated.count === 1;
  }

  private async quarantineUnknownOnlineResult(
    item: ProductBatchExecutionRecord,
    adapter: PlatformAdapter,
    token: string,
    reason: string,
    knownState?: PlatformProductState,
    lock?: string,
  ): Promise<never> {
    try {
      await this.quarantineOnlineProduct(item, adapter, token, knownState, lock);
    } catch (error) {
      throw new ProductBatchItemError(
        ONLINE_RESULT_UNKNOWN_CODE,
        `${reason}，且自动下架隔离未确认：${safeErrorMessage(error)}`,
        false,
      );
    }
    throw new ProductBatchItemError(
      ONLINE_RESULT_UNKNOWN_CODE,
      `${reason}，已下架隔离；请在核验窗口结束后确认平台实际状态`,
      false,
    );
  }

  private async quarantineOnlineWithFence(
    item: ProductBatchExecutionRecord,
    adapter: PlatformAdapter,
    token: string,
    reason: string,
    knownState: PlatformProductState | undefined,
    lock: string,
    fenceAlreadyMarked = false,
  ): Promise<void> {
    if (!fenceAlreadyMarked && !(await this.markOnlineVerificationRequired(item))) {
      throw new ProductBatchItemError(
        ONLINE_RESULT_UNKNOWN_CODE,
        `${reason}，但批量任务核验栅栏建立失败，请立即人工核验`,
        false,
      );
    }
    try {
      await this.quarantineOnlineProduct(item, adapter, token, knownState, lock);
    } catch (error) {
      throw new ProductBatchItemError(
        ONLINE_RESULT_UNKNOWN_CODE,
        `${reason}，且自动下架隔离未确认：${safeErrorMessage(error)}`,
        false,
      );
    }
  }

  private async assertOnlineSnapshotCurrent(
    item: ProductBatchExecutionRecord,
    desiredInventory: ProductBatchInventorySnapshot,
    desiredFingerprint: string,
    desiredVersion: number,
  ): Promise<void> {
    const expectedRevision = onlineBaseMutationRevision(item);
    const current = await this.prisma.publishedProduct.findUnique({
      where: { id: item.publishedProductId },
      include: { sourceProduct: true },
    });
    const currentInventory = parseSkuInventorySnapshot(current?.skuInventorySnapshot);
    if (
      !current ||
      current.platformProductId !== item.publishedProduct.platformProductId ||
      (current.status !== 'offline' && current.status !== 'online') ||
      current.mutationRevision !== expectedRevision ||
      current.inventorySyncStatus === 'syncing' ||
      current.sourceProduct.availability !== 'available' ||
      current.sourceProduct.inventoryFingerprint !== desiredFingerprint ||
      current.sourceProduct.inventoryVersion !== desiredVersion ||
      !currentInventory ||
      !sameInventorySkuIds(currentInventory, desiredInventory)
    ) {
      throw new ProductBatchItemError(
        'ONLINE_SOURCE_CHANGED',
        '1688 货源、商品状态或库存快照已变化，不能继续上架',
        false,
      );
    }
  }

  private async persistOnlineResult(
    item: ProductBatchExecutionRecord,
    desiredInventory: ProductBatchInventorySnapshot,
    desiredFingerprint: string,
    desiredVersion: number,
    platformState: PlatformProductState,
    recovered: boolean,
    lock: string,
    adapter: PlatformAdapter,
    token: string,
  ): Promise<'processed' | 'stale'> {
    const product = item.publishedProduct;
    const expectedRevision = onlineBaseMutationRevision(item);
    await this.platformProductLocks.renew(product.id, lock);
    if (!(await this.assertItemOwned(item))) {
      await this.quarantineOnlineProduct(item, adapter, token, platformState, lock);
      return 'stale';
    }
    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        const productUpdated = await tx.publishedProduct.updateMany({
          where: {
            id: product.id,
            platformProductId: product.platformProductId,
            mutationRevision: expectedRevision,
            status: { in: ['offline', 'online'] },
            sourceProduct: {
              availability: 'available',
              inventoryFingerprint: desiredFingerprint,
              inventoryVersion: desiredVersion,
            },
          },
          data: {
            status: 'online',
            skuInventorySnapshot: desiredInventory as unknown as Prisma.InputJsonValue,
            inventoryFingerprint: desiredFingerprint,
            inventoryTargetFingerprint: desiredFingerprint,
            inventoryVersion: desiredVersion,
            inventoryTargetVersion: desiredVersion,
            inventorySyncStatus: 'synced',
            inventorySyncReason: 'manual_batch_online',
            inventorySyncError: null,
            inventoryNextRunAt: null,
            inventoryLockedAt: null,
            inventoryLockedBy: null,
            inventoryLastSyncedAt: now,
            mutationRevision: { increment: 1 },
            platformStatusRaw: platformState.status,
            platformCheckStatusRaw: platformState.checkStatus,
            platformStatusSyncedAt: now,
            platformStatusError: null,
          },
        });
        if (productUpdated.count !== 1) {
          throw new ProductBatchItemError(
            'ONLINE_COMMIT_CONFLICT',
            '商品已在上架期间发生变化，不能提交本地结果',
            false,
          );
        }
        const itemUpdated = await tx.productBatchItem.updateMany({
          where: ownedItemWhere(item),
          data: {
            status: 'succeeded',
            result: {
              reason: recovered ? 'platform_online_recovered' : 'online_confirmed',
              recovered,
              actualStatus: 'online',
              actualInventory: desiredInventory,
              platformState,
            } as unknown as Prisma.InputJsonValue,
            errorCode: null,
            errorMessage: null,
            lockedAt: null,
            lockedBy: null,
            finishedAt: now,
          },
        });
        if (itemUpdated.count !== 1) {
          throw new ProductBatchItemError(
            'ONLINE_COMMIT_CONFLICT',
            '批量任务执行权已变化，不能提交上架结果',
            false,
          );
        }
      });
    } catch (error) {
      if (
        !(await this.onlineCommitWasPersisted(
          item,
          desiredInventory,
          desiredFingerprint,
          desiredVersion,
        ))
      ) {
        throw error;
      }
    }
    try {
      await this.refreshTask(item.taskId);
    } catch {
      // 条目与商品已原子提交；后续 worker 对账会修复任务汇总，不能反向下架平台商品。
    }
    return 'processed';
  }

  private async persistRejectedOnlineResult(
    item: ProductBatchExecutionRecord,
    platformState: PlatformProductState,
    lock: string,
  ): Promise<'processed' | 'stale'> {
    const product = item.publishedProduct;
    const expectedRevision = onlineBaseMutationRevision(item);
    await this.platformProductLocks.renew(product.id, lock);
    if (!(await this.assertItemOwned(item))) return 'stale';
    const now = new Date();
    const errorMessage = `平台商品状态为 ${platformState.state}，上架未生效，请按平台提示处理`;
    await this.prisma.$transaction(async (tx) => {
      const productUpdated = await tx.publishedProduct.updateMany({
        where: {
          id: product.id,
          platformProductId: product.platformProductId,
          mutationRevision: expectedRevision,
          status: { in: ['offline', 'online'] },
        },
        data: {
          status: 'rejected',
          mutationRevision: { increment: 1 },
          platformStatusRaw: platformState.status,
          platformCheckStatusRaw: platformState.checkStatus,
          platformStatusSyncedAt: now,
          platformStatusError: errorMessage,
        },
      });
      if (productUpdated.count !== 1) {
        throw new ProductBatchItemError(
          'ONLINE_COMMIT_CONFLICT',
          '商品已在上架驳回结果提交期间发生变化，请刷新后核验',
          false,
        );
      }
      const itemUpdated = await tx.productBatchItem.updateMany({
        where: ownedItemWhere(item),
        data: {
          status: 'failed',
          result: {
            reason: 'platform_online_rejected',
            actualStatus: platformState.state,
            platformState,
          } as unknown as Prisma.InputJsonValue,
          errorCode: 'ONLINE_RESULT_REJECTED',
          errorMessage,
          lockedAt: null,
          lockedBy: null,
          finishedAt: now,
        },
      });
      if (itemUpdated.count !== 1) {
        throw new ProductBatchItemError(
          'ONLINE_COMMIT_CONFLICT',
          '批量任务执行权已变化，不能提交平台驳回结果',
          false,
        );
      }
    });
    try {
      await this.refreshTask(item.taskId);
    } catch {
      // 商品与条目已原子提交，后续 worker 会恢复任务汇总。
    }
    return 'processed';
  }

  private async persistVerifiedOnlineResult(
    item: ProductBatchExecutionRecord,
    desiredInventory: ProductBatchInventorySnapshot,
    desiredFingerprint: string,
    desiredVersion: number,
    platformState: PlatformProductState,
  ): Promise<void> {
    const now = new Date();
    const expectedRevision = onlineBaseMutationRevision(item);
    try {
      await this.prisma.$transaction(async (tx) => {
        const productUpdated = await tx.publishedProduct.updateMany({
          where: {
            id: item.publishedProductId,
            platformProductId: item.publishedProduct.platformProductId,
            mutationRevision: expectedRevision,
            status: { in: ['offline', 'online'] },
            sourceProduct: {
              availability: 'available',
              inventoryFingerprint: desiredFingerprint,
              inventoryVersion: desiredVersion,
            },
          },
          data: {
            status: 'online',
            skuInventorySnapshot: desiredInventory as unknown as Prisma.InputJsonValue,
            inventoryFingerprint: desiredFingerprint,
            inventoryTargetFingerprint: desiredFingerprint,
            inventoryVersion: desiredVersion,
            inventoryTargetVersion: desiredVersion,
            inventorySyncStatus: 'synced',
            inventorySyncReason: 'manual_batch_online_verified',
            inventorySyncError: null,
            inventoryNextRunAt: null,
            inventoryLockedAt: null,
            inventoryLockedBy: null,
            inventoryLastSyncedAt: now,
            mutationRevision: { increment: 1 },
            platformStatusRaw: platformState.status,
            platformCheckStatusRaw: platformState.checkStatus,
            platformStatusSyncedAt: now,
            platformStatusError: null,
          },
        });
        if (productUpdated.count !== 1) {
          throw new ConflictException('商品已在核验期间变化，已停止提交上架结果');
        }
        const itemUpdated = await tx.productBatchItem.updateMany({
          where: {
            id: item.id,
            taskId: item.taskId,
            status: 'failed',
            errorCode: { in: [...UNRESOLVED_ONLINE_CODES] },
          },
          data: {
            status: 'succeeded',
            result: {
              ...(jsonRecord(item.result) ?? {}),
              reason: 'platform_online_verified',
              recovered: true,
              actualStatus: 'online',
              actualInventory: desiredInventory,
              platformState,
            } as unknown as Prisma.InputJsonValue,
            errorCode: null,
            errorMessage: null,
            finishedAt: now,
          },
        });
        if (itemUpdated.count !== 1) throw new ConflictException('上架核验状态已变化，请刷新');
      });
    } catch (error) {
      if (
        !(await this.onlineCommitWasPersisted(
          item,
          desiredInventory,
          desiredFingerprint,
          desiredVersion,
        ))
      ) {
        throw error;
      }
    }
    try {
      await this.refreshTask(item.taskId);
    } catch {
      // 核验结果已原子提交；任务汇总可由后续对账恢复。
    }
  }

  private async onlineCommitWasPersisted(
    item: ProductBatchExecutionRecord,
    desiredInventory: ProductBatchInventorySnapshot,
    desiredFingerprint: string,
    desiredVersion: number,
  ): Promise<boolean> {
    const expectedRevision = onlineBaseMutationRevision(item);
    const [product, batchItem] = await Promise.all([
      this.prisma.publishedProduct.findUnique({ where: { id: item.publishedProductId } }),
      this.prisma.productBatchItem.findUnique({ where: { id: item.id } }),
    ]);
    const actualInventory = parseSkuInventorySnapshot(product?.skuInventorySnapshot);
    const result = jsonRecord(batchItem?.result);
    const resultInventory = parseSkuInventorySnapshot(result?.actualInventory);
    return (
      product?.platformProductId === item.publishedProduct.platformProductId &&
      product.status === 'online' &&
      product.mutationRevision === expectedRevision + 1 &&
      product.inventoryFingerprint === desiredFingerprint &&
      product.inventoryTargetFingerprint === desiredFingerprint &&
      product.inventoryVersion === desiredVersion &&
      product.inventoryTargetVersion === desiredVersion &&
      product.inventorySyncStatus === 'synced' &&
      !!actualInventory &&
      sameSkuInventory(actualInventory, desiredInventory) &&
      batchItem?.taskId === item.taskId &&
      batchItem.status === 'succeeded' &&
      batchItem.errorCode === null &&
      result?.actualStatus === 'online' &&
      !!resultInventory &&
      sameSkuInventory(resultInventory, desiredInventory)
    );
  }

  private async resolveOnlineVerificationFailure(
    item: ProductBatchExecutionRecord,
    errorCode: string,
    errorMessage: string,
    platformState: PlatformProductState,
    actualInventory?: ProductBatchInventorySnapshot,
  ): Promise<void> {
    const now = new Date();
    const expectedRevision = onlineBaseMutationRevision(item);
    const latestItem = await this.prisma.productBatchItem.findUnique({
      where: { id: item.id },
      select: { result: true },
    });
    const existingResult = jsonRecord(latestItem?.result) ?? jsonRecord(item.result) ?? {};
    await this.prisma.$transaction(async (tx) => {
      if (
        platformState.state === 'rejected' ||
        platformState.state === 'blocked' ||
        platformState.state === 'deleted'
      ) {
        const productUpdated = await tx.publishedProduct.updateMany({
          where: {
            id: item.publishedProductId,
            platformProductId: item.publishedProduct.platformProductId,
            mutationRevision: expectedRevision,
          },
          data: {
            status: 'rejected',
            mutationRevision: { increment: 1 },
            platformStatusRaw: platformState.status,
            platformCheckStatusRaw: platformState.checkStatus,
            platformStatusSyncedAt: now,
            platformStatusError: errorMessage,
          },
        });
        if (productUpdated.count !== 1) {
          throw new ConflictException(
            '商品已在上架核验期间发生变化，驳回状态未提交且核验栅栏保持不变',
          );
        }
      }
      const itemUpdated = await tx.productBatchItem.updateMany({
        where: {
          id: item.id,
          taskId: item.taskId,
          status: 'failed',
          errorCode: { in: [...UNRESOLVED_ONLINE_CODES] },
        },
        data: {
          result: {
            ...existingResult,
            actualStatus: platformState.state,
            ...(actualInventory ? { actualInventory } : {}),
            platformState,
          } as unknown as Prisma.InputJsonValue,
          errorCode,
          errorMessage,
          finishedAt: now,
        },
      });
      if (itemUpdated.count !== 1) throw new ConflictException('上架核验状态已变化，请刷新');
    });
    await this.refreshTask(item.taskId);
  }

  private async quarantineOnlineProduct(
    item: ProductBatchExecutionRecord,
    adapter: PlatformAdapter,
    token: string,
    knownState?: PlatformProductState,
    lock?: string,
  ): Promise<number> {
    const product = item.publishedProduct;
    const expectedRevision = onlineBaseMutationRevision(item);
    if (!adapter.getProductState) {
      throw new ProductBatchItemError(
        'ONLINE_QUARANTINE_UNSUPPORTED',
        '平台无法回读商品状态，不能确认安全下架',
        false,
      );
    }
    const quarantineLock = lock ?? (await this.platformProductLocks.acquire(product.id));
    const acquiredQuarantineLock = !lock;
    try {
      await this.platformProductLocks.renew(product.id, quarantineLock);
      const [current, currentItem] = await Promise.all([
        this.prisma.publishedProduct.findUnique({
          where: { id: product.id },
          select: { platformProductId: true, mutationRevision: true, status: true },
        }),
        this.prisma.productBatchItem.findUnique({
          where: { id: item.id },
          select: {
            id: true,
            taskId: true,
            publishedProductId: true,
            status: true,
            errorCode: true,
            result: true,
          },
        }),
      ]);
      if (
        !current ||
        current.platformProductId !== product.platformProductId ||
        current.mutationRevision !== expectedRevision ||
        (current.status !== 'online' && current.status !== 'offline') ||
        !currentItem ||
        currentItem.taskId !== item.taskId ||
        currentItem.publishedProductId !== item.publishedProductId ||
        (currentItem.status !== 'running' && currentItem.status !== 'failed')
      ) {
        throw new ProductBatchItemError(
          'ONLINE_QUARANTINE_GUARD_LOST',
          '商品已由后续操作接管，旧上架任务不能覆盖其平台状态，请立即人工核验',
          false,
        );
      }
      let state = knownState;
      if (!state || !isOfflineState(state.state)) {
        let offlineError: unknown;
        try {
          await adapter.offlineProduct(token, product.platformProductId!);
        } catch (error) {
          offlineError = error;
        }
        state = await adapter.getProductState(token, product.platformProductId!);
        if (!isOfflineState(state.state)) {
          if (offlineError) throw offlineError;
          throw new ProductBatchItemError(
            'ONLINE_QUARANTINE_FAILED',
            '平台未确认商品下架，必须立即人工处理',
            false,
          );
        }
      }
      await this.platformProductLocks.renew(product.id, quarantineLock);
      const quarantinedAt = new Date();
      const quarantineRevision = expectedRevision + 1;
      const quarantinedStatus = state.state === 'deleted' ? 'rejected' : 'offline';
      await this.prisma.$transaction(async (tx) => {
        const productUpdated = await tx.publishedProduct.updateMany({
          where: {
            id: product.id,
            platformProductId: product.platformProductId,
            mutationRevision: expectedRevision,
            status: { in: ['online', 'offline'] },
          },
          data: {
            status: quarantinedStatus,
            mutationRevision: { increment: 1 },
            inventorySyncReason: 'online_result_quarantined',
            platformStatusRaw: state.status,
            platformCheckStatusRaw: state.checkStatus,
            platformStatusSyncedAt: quarantinedAt,
            platformStatusError: null,
          },
        });
        if (productUpdated.count !== 1) {
          throw new ProductBatchItemError(
            'ONLINE_QUARANTINE_COMMIT_CONFLICT',
            '平台已确认下架，但本地商品状态提交冲突，请立即刷新核验',
            false,
          );
        }
        const itemUpdated = await tx.productBatchItem.updateMany({
          where: {
            id: currentItem.id,
            taskId: currentItem.taskId,
            publishedProductId: currentItem.publishedProductId,
            status: currentItem.status,
            errorCode: currentItem.errorCode,
          },
          data: {
            result: {
              ...(jsonRecord(currentItem.result) ?? {}),
              quarantineRevision,
              quarantinedAt: quarantinedAt.toISOString(),
            } as Prisma.InputJsonValue,
          },
        });
        if (itemUpdated.count !== 1) {
          throw new ProductBatchItemError(
            'ONLINE_QUARANTINE_COMMIT_CONFLICT',
            '平台已确认下架，但批量任务隔离版本提交冲突，请立即刷新核验',
            false,
          );
        }
      });
      return quarantineRevision;
    } finally {
      if (acquiredQuarantineLock) {
        await this.platformProductLocks.release(product.id, quarantineLock);
      }
    }
  }

  private async executeTitleClaimed(
    item: ProductBatchExecutionRecord,
    adapter: PlatformAdapter,
    token: string,
    lock: string,
  ): Promise<'processed' | 'stale'> {
    const product = item.publishedProduct;
    const beforeTitle = stringValue(jsonRecord(item.beforeSnapshot)?.title)?.trim();
    const desiredTitle = stringValue(jsonRecord(item.desiredSnapshot)?.title)?.trim();
    if (
      !beforeTitle ||
      !desiredTitle ||
      [...desiredTitle].length > 60 ||
      titleComplianceReason(desiredTitle, product.shop.platform)
    ) {
      throw new ProductBatchItemError(
        'TITLE_SNAPSHOT_INVALID',
        '批量改标题快照不完整或不符合平台规则，请重新生成预览',
        false,
      );
    }
    if (!adapter.getProductTitle || !adapter.updateProductTitle) {
      throw new ProductBatchItemError(
        'TITLE_UPDATE_UNSUPPORTED',
        '当前平台不支持可回读的标题编辑',
        false,
      );
    }

    const platformBefore = await adapter.getProductTitle(token, product.platformProductId!);
    if (platformBefore.title === desiredTitle) {
      return this.persistTitleResult(item, beforeTitle, desiredTitle, platformBefore, true, lock);
    }
    assertTitleEditState(platformBefore, '编辑前');
    if (platformBefore.title !== beforeTitle) {
      return this.persistPlatformTitleDrift(
        item,
        platformBefore,
        '平台商品标题已在预览后变化，请确认后重新生成预览',
      );
    }

    await this.platformProductLocks.renew(product.id, lock);
    if (!(await this.markTitleWriteStarted(item))) return this.cancelClaimedItem(item);
    try {
      await this.platformProductLocks.renew(product.id, lock);
    } catch (_error) {
      throw new ProductBatchItemError(
        'TITLE_WRITE_GUARD_LOST',
        '标题写入前商品锁已失效，平台请求尚未提交，将安全重试',
        true,
      );
    }
    if (!(await this.assertItemOwned(item))) {
      throw new ProductBatchItemError(
        'TITLE_WRITE_GUARD_LOST',
        '标题写入前任务所有权已变化，平台请求尚未提交',
        true,
      );
    }
    const productBeforeWrite = await this.prisma.publishedProduct.findUnique({
      where: { id: product.id },
      select: { platformProductId: true, mutationRevision: true },
    });
    if (
      productBeforeWrite?.platformProductId !== product.platformProductId ||
      productBeforeWrite.mutationRevision !== item.expectedMutationRevision
    ) {
      throw new ProductBatchItemError(
        'TITLE_WRITE_ABORTED_PRODUCT_CHANGED',
        '商品已在标题写入前发生变化，平台请求未提交，请重新生成预览',
        false,
      );
    }
    try {
      await this.platformProductLocks.renew(product.id, lock);
    } catch (_error) {
      throw new ProductBatchItemError(
        'TITLE_WRITE_GUARD_LOST',
        '标题写入前商品锁已失效，平台请求尚未提交，将安全重试',
        true,
      );
    }

    let mutationError: unknown;
    try {
      await adapter.updateProductTitle(token, {
        platformProductId: product.platformProductId!,
        title: desiredTitle,
      });
    } catch (error) {
      mutationError = error;
    }

    await this.platformProductLocks.renew(product.id, lock);
    if (!(await this.renewClaimedItemLease(item, false))) return 'stale';

    let platformAfter: PlatformProductTitleState;
    try {
      platformAfter = await adapter.getProductTitle(token, product.platformProductId!);
    } catch (_error) {
      if (!mutationError || isPlatformMutationResultUnknown(mutationError)) {
        throw new ProductBatchItemError(
          TITLE_RESULT_UNKNOWN_CODE,
          '标题更新结果未知且暂时无法回读，请稍后人工核验平台标题',
          false,
        );
      }
      throw new ProductBatchItemError(
        'TITLE_UPDATE_FAILED',
        safeErrorMessage(mutationError),
        false,
      );
    }

    if (platformAfter.title === desiredTitle) {
      return this.persistTitleResult(
        item,
        beforeTitle,
        desiredTitle,
        platformAfter,
        Boolean(mutationError),
        lock,
      );
    }
    if (platformAfter.title !== beforeTitle) {
      return this.persistPlatformTitleDrift(
        item,
        platformAfter,
        '平台返回了预览之外的商品标题，请确认后重新生成预览',
      );
    }
    if (mutationError) {
      throw new ProductBatchItemError(
        isPlatformMutationResultUnknown(mutationError)
          ? TITLE_RESULT_UNKNOWN_CODE
          : 'TITLE_UPDATE_FAILED',
        isPlatformMutationResultUnknown(mutationError)
          ? '标题更新结果未知，平台仍显示原标题，请稍后人工核验后再操作'
          : safeErrorMessage(mutationError),
        false,
      );
    }
    throw new ProductBatchItemError(
      TITLE_RESULT_UNKNOWN_CODE,
      '平台已受理标题更新，但尚未确认目标标题，请稍后人工核验平台标题',
      false,
    );
  }

  private async markTitleWriteStarted(item: ProductBatchExecutionRecord): Promise<boolean> {
    const now = new Date();
    const updated = await this.prisma.productBatchItem.updateMany({
      where: {
        ...ownedItemWhere(item),
        task: { cancelRequestedAt: null },
      },
      data: {
        lockedAt: now,
        result: {
          phase: 'platform_write_started',
          titleWriteStartedAt: now.toISOString(),
        } as Prisma.InputJsonValue,
        errorCode: TITLE_WRITE_STARTED_CODE,
        errorMessage: '平台标题写入已开始，正在回读确认结果',
      },
    });
    return updated.count === 1;
  }

  private async persistVerifiedTitleResult(
    item: ProductBatchExecutionRecord,
    beforeTitle: string,
    desiredTitle: string,
    platformState: PlatformProductTitleState,
  ): Promise<void> {
    const product = item.publishedProduct;
    const desiredConfirmed = platformState.title === desiredTitle;
    const failure =
      titleResultFailure(platformState) ??
      (desiredConfirmed
        ? null
        : platformState.title === beforeTitle
          ? {
              code: 'TITLE_NOT_APPLIED_VERIFIED',
              message: '核验窗口结束后平台仍显示原标题，本次写入未确认生效，请重新生成预览',
            }
          : {
              code: 'PLATFORM_TITLE_CHANGED',
              message: '平台显示了预览之外的标题，已同步实际状态，请重新生成预览',
            });
    const now = new Date();
    const result = {
      reason: failure
        ? failure.code === 'TITLE_NOT_APPLIED_VERIFIED'
          ? 'title_not_applied_verified'
          : 'platform_title_requires_attention'
        : 'platform_title_verified',
      recovered: desiredConfirmed,
      beforeTitle,
      desiredTitle,
      actualTitle: platformState.title,
      verifiedAt: now.toISOString(),
      platformState: {
        state: platformState.state,
        status: platformState.status,
        checkStatus: platformState.checkStatus,
      },
    };
    await this.prisma.$transaction(async (tx) => {
      const updatedProduct = await tx.publishedProduct.updateMany({
        where: {
          id: product.id,
          platformProductId: product.platformProductId,
          mutationRevision: product.mutationRevision,
        },
        data: {
          title: platformState.title,
          status: localStatusFromTitleState(platformState, product.status),
          lastEditedAt: desiredConfirmed ? now : product.lastEditedAt,
          lastEditError: failure?.message ?? null,
          platformStatusRaw: platformState.status,
          platformCheckStatusRaw: platformState.checkStatus,
          platformStatusSyncedAt: now,
          platformStatusError: null,
          mutationRevision: { increment: 1 },
        },
      });
      if (updatedProduct.count !== 1) {
        throw new ConflictException('商品已在标题核验期间发生变化，请刷新后重试');
      }
      const updatedItem = await tx.productBatchItem.updateMany({
        where: {
          id: item.id,
          taskId: item.taskId,
          status: 'failed',
          errorCode: { in: [...UNRESOLVED_TITLE_CODES] },
        },
        data: {
          status: failure ? 'failed' : 'succeeded',
          result: result as Prisma.InputJsonValue,
          errorCode: failure?.code ?? null,
          errorMessage: failure?.message ?? null,
          lockedAt: null,
          lockedBy: null,
          finishedAt: now,
        },
      });
      if (updatedItem.count !== 1) {
        throw new ConflictException('标题核验状态已变化，请刷新任务');
      }
    });
    await this.refreshTask(item.taskId);
  }

  private async persistTitleResult(
    item: ProductBatchExecutionRecord,
    beforeTitle: string,
    desiredTitle: string,
    platformState: PlatformProductTitleState,
    recovered: boolean,
    lock: string,
  ): Promise<'processed' | 'stale'> {
    const product = item.publishedProduct;
    await this.platformProductLocks.renew(product.id, lock);
    if (!(await this.renewClaimedItemLease(item, false))) return 'stale';
    const now = new Date();
    const failure = titleResultFailure(platformState);
    const result = {
      reason: failure
        ? 'platform_title_state_requires_attention'
        : recovered
          ? 'platform_title_recovered'
          : 'title_confirmed',
      recovered,
      beforeTitle,
      desiredTitle,
      actualTitle: platformState.title,
      platformState: {
        state: platformState.state,
        status: platformState.status,
        checkStatus: platformState.checkStatus,
      },
    };
    await this.prisma.$transaction(async (tx) => {
      const updatedProduct = await tx.publishedProduct.updateMany({
        where: {
          id: product.id,
          platformProductId: product.platformProductId,
          mutationRevision: item.expectedMutationRevision,
        },
        data: {
          title: desiredTitle,
          status: localStatusFromTitleState(platformState, product.status),
          lastEditedAt: now,
          lastEditError: failure?.message ?? null,
          platformStatusRaw: platformState.status,
          platformCheckStatusRaw: platformState.checkStatus,
          platformStatusSyncedAt: now,
          platformStatusError: null,
          mutationRevision: { increment: 1 },
        },
      });
      if (updatedProduct.count !== 1) {
        const latest = await tx.publishedProduct.findUnique({ where: { id: product.id } });
        if (
          latest?.platformProductId !== product.platformProductId ||
          latest.title !== desiredTitle
        ) {
          throw new ProductBatchItemError(
            'PRODUCT_CHANGED',
            '商品已在标题更新期间发生变化，请重新生成预览',
            false,
          );
        }
      }
      const updatedItem = await tx.productBatchItem.updateMany({
        where: ownedItemWhere(item),
        data: {
          status: failure ? 'failed' : 'succeeded',
          result: result as Prisma.InputJsonValue,
          errorCode: failure?.code ?? null,
          errorMessage: failure?.message ?? null,
          lockedAt: null,
          lockedBy: null,
          finishedAt: now,
        },
      });
      if (updatedItem.count !== 1) {
        throw new ProductBatchItemError(
          'ITEM_OWNERSHIP_LOST',
          '批量标题任务所有权已变化，将由新 worker 回读恢复',
          true,
        );
      }
    });
    await this.refreshTask(item.taskId);
    return 'processed';
  }

  private async persistPlatformTitleDrift(
    item: ProductBatchExecutionRecord,
    platformState: PlatformProductTitleState,
    message: string,
  ): Promise<'processed' | 'stale'> {
    const product = item.publishedProduct;
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const updatedProduct = await tx.publishedProduct.updateMany({
        where: {
          id: product.id,
          platformProductId: product.platformProductId,
          mutationRevision: item.expectedMutationRevision,
        },
        data: {
          title: platformState.title,
          status: localStatusFromTitleState(platformState, product.status),
          lastEditError: message,
          platformStatusRaw: platformState.status,
          platformCheckStatusRaw: platformState.checkStatus,
          platformStatusSyncedAt: now,
          platformStatusError: null,
          mutationRevision: { increment: 1 },
        },
      });
      if (updatedProduct.count !== 1) {
        throw new ProductBatchItemError(
          'PRODUCT_CHANGED',
          '商品已在标题核验期间发生变化，请重新生成预览',
          false,
        );
      }
      const updatedItem = await tx.productBatchItem.updateMany({
        where: ownedItemWhere(item),
        data: {
          status: 'failed',
          result: {
            reason: 'platform_title_changed',
            actualTitle: platformState.title,
            platformState: {
              state: platformState.state,
              status: platformState.status,
              checkStatus: platformState.checkStatus,
            },
          } as Prisma.InputJsonValue,
          errorCode: 'PLATFORM_TITLE_CHANGED',
          errorMessage: message,
          lockedAt: null,
          lockedBy: null,
          finishedAt: now,
        },
      });
      if (updatedItem.count !== 1) {
        throw new ProductBatchItemError(
          'ITEM_OWNERSHIP_LOST',
          '批量标题任务所有权已变化，将由新 worker 回读恢复',
          true,
        );
      }
    });
    await this.refreshTask(item.taskId);
    return 'processed';
  }

  private async renewClaimedItemLease(
    item: ProductBatchExecutionRecord,
    requireActiveTask: boolean,
  ): Promise<boolean> {
    const updated = await this.prisma.productBatchItem.updateMany({
      where: {
        ...ownedItemWhere(item),
        ...(requireActiveTask ? { task: { cancelRequestedAt: null } } : {}),
      },
      data: { lockedAt: new Date() },
    });
    return updated.count === 1;
  }

  private async executePriceClaimed(
    item: ProductBatchExecutionRecord,
    adapter: PlatformAdapter,
    token: string,
    lock: string,
  ): Promise<'processed' | 'stale'> {
    const product = item.publishedProduct;
    const before = parseSkuPriceSnapshot(jsonRecord(item.beforeSnapshot)?.skuPrices);
    const desired = parseSkuPriceSnapshot(jsonRecord(item.desiredSnapshot)?.skuPrices);
    if (!before || !desired || !sameSkuIds(before, desired)) {
      throw new ProductBatchItemError(
        'PRICE_SNAPSHOT_INVALID',
        '批量改价快照不完整，请重新生成预览',
        false,
      );
    }
    if (!adapter.updateProductPrice) {
      throw new ProductBatchItemError('PRICE_UPDATE_UNSUPPORTED', '当前平台不支持安全改价', false);
    }

    if (isDemoShop(product.shop)) {
      for (const target of desired.items) {
        const previous = before.items.find((value) => value.sourceSkuId === target.sourceSkuId)!;
        if (previous.priceCents === target.priceCents) continue;
        await this.platformProductLocks.renew(product.id, lock);
        if (!(await this.assertItemOwned(item))) return 'stale';
        await adapter.updateProductPrice(token, {
          platformProductId: product.platformProductId!,
          sourceSkuId: target.sourceSkuId,
          priceCents: target.priceCents,
        });
      }
      return this.persistPriceResult(item, desired, null, false, lock);
    }

    if (!adapter.getProductPrices) {
      throw new ProductBatchItemError(
        'PRICE_READBACK_UNSUPPORTED',
        '当前平台无法回读 SKU 价格，拒绝执行改价',
        false,
      );
    }

    let actualState = await this.readPlatformPrices(adapter, token, product.platformProductId!);
    if (actualState.state !== 'online') {
      throw new ProductBatchItemError(
        'PRODUCT_NOT_ONLINE',
        `平台商品当前状态为 ${actualState.state}，未执行改价`,
        false,
      );
    }
    let actual = platformSkuPriceSnapshot(actualState);
    const initialState = classifyPriceTransition(actual, before, desired);
    if (initialState === 'desired') {
      return this.persistPriceResult(item, desired, actualState, true, lock);
    }
    if (initialState === 'drift') {
      await this.persistPlatformPriceDrift(item, actual, actualState);
      throw new ProductBatchItemError(
        'PLATFORM_PRICE_CHANGED',
        '平台 SKU 价格已在预览后变化，请重新生成预览',
        false,
      );
    }

    for (const target of desired.items) {
      const current = actual.items.find((value) => value.sourceSkuId === target.sourceSkuId)!;
      if (current.priceCents === target.priceCents) continue;
      await this.platformProductLocks.renew(product.id, lock);
      if (!(await this.assertItemOwned(item))) return 'stale';
      try {
        await adapter.updateProductPrice(token, {
          platformProductId: product.platformProductId!,
          sourceSkuId: target.sourceSkuId,
          priceCents: target.priceCents,
        });
      } catch (error) {
        try {
          actualState = await this.readPlatformPrices(adapter, token, product.platformProductId!);
          actual = platformSkuPriceSnapshot(actualState);
          const recovered = classifyPriceTransition(actual, before, desired);
          if (recovered === 'desired') {
            return this.persistPriceResult(item, desired, actualState, true, lock);
          }
          if (recovered === 'drift') {
            await this.persistPlatformPriceDrift(item, actual, actualState);
            throw new ProductBatchItemError(
              'PLATFORM_PRICE_CHANGED',
              '平台 SKU 价格已在执行期间变化，请重新生成预览',
              false,
            );
          }
        } catch (readbackError) {
          if (readbackError instanceof ProductBatchItemError) throw readbackError;
        }
        throw error;
      }
    }

    await this.platformProductLocks.renew(product.id, lock);
    if (!(await this.assertItemOwned(item))) return 'stale';
    actualState = await this.readPlatformPrices(adapter, token, product.platformProductId!);
    actual = platformSkuPriceSnapshot(actualState);
    const finalState = classifyPriceTransition(actual, before, desired);
    if (finalState === 'desired') {
      return this.persistPriceResult(item, desired, actualState, false, lock);
    }
    if (finalState === 'drift') {
      await this.persistPlatformPriceDrift(item, actual, actualState);
      throw new ProductBatchItemError(
        'PLATFORM_PRICE_CHANGED',
        '平台 SKU 价格已在执行期间变化，请重新生成预览',
        false,
      );
    }
    throw new ProductBatchItemError(
      'PRICE_NOT_CONFIRMED',
      '平台尚未确认全部 SKU 新价格，将稍后重试',
      true,
    );
  }

  private async executeInventoryClaimed(
    item: ProductBatchExecutionRecord,
    adapter: PlatformAdapter,
    token: string,
    lock: string,
  ): Promise<'processed' | 'stale'> {
    const product = item.publishedProduct;
    const beforeSnapshotValue = jsonRecord(item.beforeSnapshot);
    const desiredSnapshotValue = jsonRecord(item.desiredSnapshot);
    const before = parseSkuInventorySnapshot(beforeSnapshotValue?.skuInventory);
    const desired = parseSkuInventorySnapshot(desiredSnapshotValue?.skuInventory);
    const desiredFingerprint = inventoryFingerprintValue(
      desiredSnapshotValue?.inventoryFingerprint,
    );
    const desiredVersion = positiveIntegerOrNull(desiredSnapshotValue?.inventoryVersion);
    if (
      !before ||
      !desired ||
      !sameInventorySkuIds(before, desired) ||
      !desiredFingerprint ||
      desiredVersion === null
    ) {
      throw new ProductBatchItemError(
        'INVENTORY_SNAPSHOT_INVALID',
        '批量库存快照不完整，请重新生成预览',
        false,
      );
    }
    if (
      product.sourceProduct.availability !== 'available' ||
      product.sourceProduct.inventoryFingerprint !== desiredFingerprint ||
      product.sourceProduct.inventoryVersion !== desiredVersion
    ) {
      throw new ProductBatchItemError(
        'SOURCE_INVENTORY_CHANGED',
        '1688 货源库存已在预览后变化，请重新生成预览',
        false,
      );
    }
    if (!adapter.getProductInventory) {
      throw new ProductBatchItemError(
        'INVENTORY_READBACK_UNSUPPORTED',
        '当前平台无法回读 SKU 库存，拒绝执行库存同步',
        false,
      );
    }

    let actualState: PlatformProductInventoryState;
    try {
      actualState = await this.readPlatformInventory(adapter, token, product.platformProductId!);
    } catch (error) {
      if (error instanceof ProductBatchItemError && error.code === 'PRODUCT_NOT_ONLINE') {
        await this.quarantineInventoryProduct(
          item,
          adapter,
          token,
          lock,
          '平台商品已不在线，本地状态已安全收敛',
        );
      }
      throw error;
    }
    let actual = platformSkuInventorySnapshot(actualState);
    let transition = classifyInventoryTransition(actual, before, desired);
    if (transition === 'desired') {
      return this.persistInventoryResult(
        item,
        desired,
        desiredFingerprint,
        desiredVersion,
        actualState,
        true,
        lock,
        adapter,
        token,
      );
    }
    if (transition === 'drift') {
      await this.persistPlatformInventoryDrift(item, actual, desiredFingerprint, desiredVersion);
      throw new ProductBatchItemError(
        'PLATFORM_INVENTORY_CHANGED',
        '平台 SKU 库存已在预览后变化，请重新生成预览',
        false,
      );
    }

    await this.assertSourceInventoryCurrent(
      product.sourceProduct.id,
      desiredFingerprint,
      desiredVersion,
    );
    await this.platformProductLocks.renew(product.id, lock);
    if (!(await this.assertItemOwned(item))) return 'stale';
    const pendingItems = pendingInventoryItems(actual, desired);
    try {
      await adapter.syncInventory(token, {
        platformProductId: product.platformProductId!,
        idempotencyKey: batchInventoryIdempotencyKey(
          item.id,
          desiredVersion,
          desiredFingerprint,
          pendingItems,
        ),
        items: pendingItems,
      });
    } catch (error) {
      if (isPlatformMutationResultUnknown(error)) {
        await this.quarantineInventoryProduct(
          item,
          adapter,
          token,
          lock,
          '平台库存写入结果未知，商品已安全下架',
        );
        throw new ProductBatchItemError(
          'INVENTORY_RESULT_UNKNOWN',
          '平台库存写入结果未知，商品已安全下架，请核验后重新上架',
          false,
        );
      }
      try {
        actualState = await this.readPlatformInventory(adapter, token, product.platformProductId!);
        await this.assertSourceInventoryCurrent(
          product.sourceProduct.id,
          desiredFingerprint,
          desiredVersion,
        );
        actual = platformSkuInventorySnapshot(actualState);
      } catch (readbackError) {
        await this.quarantineInventoryProduct(
          item,
          adapter,
          token,
          lock,
          readbackError instanceof ProductBatchItemError &&
            readbackError.code === 'SOURCE_INVENTORY_CHANGED'
            ? '1688 货源在平台写入期间变化，商品已安全下架'
            : '平台库存写入后无法可靠回读，商品已安全下架',
        );
        if (readbackError instanceof ProductBatchItemError) throw readbackError;
        throw new ProductBatchItemError(
          'INVENTORY_RESULT_UNKNOWN',
          '平台库存写入后无法可靠回读，商品已安全下架，请核验后重新上架',
          false,
        );
      }
      transition = classifyInventoryTransition(actual, before, desired);
      if (transition === 'desired') {
        return this.persistInventoryResult(
          item,
          desired,
          desiredFingerprint,
          desiredVersion,
          actualState,
          true,
          lock,
          adapter,
          token,
        );
      }
      if (transition === 'drift') {
        try {
          await this.persistPlatformInventoryDrift(
            item,
            actual,
            desiredFingerprint,
            desiredVersion,
          );
        } catch (driftError) {
          if (
            driftError instanceof ProductBatchItemError &&
            driftError.code === 'SOURCE_INVENTORY_CHANGED'
          ) {
            await this.quarantineInventoryProduct(
              item,
              adapter,
              token,
              lock,
              '1688 货源在平台写入期间变化，商品已安全下架',
            );
          }
          throw driftError;
        }
        throw new ProductBatchItemError(
          'PLATFORM_INVENTORY_CHANGED',
          '平台 SKU 库存已在执行期间变化，请重新生成预览',
          false,
        );
      }
      throw error;
    }

    try {
      await this.assertSourceInventoryCurrent(
        product.sourceProduct.id,
        desiredFingerprint,
        desiredVersion,
      );
    } catch (error) {
      await this.quarantineInventoryProduct(
        item,
        adapter,
        token,
        lock,
        '1688 货源在平台写入期间变化，商品已安全下架',
      );
      throw error;
    }
    await this.platformProductLocks.renew(product.id, lock);
    if (!(await this.assertItemOwned(item))) {
      await this.quarantineInventoryProduct(
        item,
        adapter,
        token,
        lock,
        '批量任务执行权在平台写入后失效，商品已安全下架',
      );
      return 'stale';
    }
    try {
      actualState = await this.readPlatformInventory(adapter, token, product.platformProductId!);
      actual = platformSkuInventorySnapshot(actualState);
      await this.assertSourceInventoryCurrent(
        product.sourceProduct.id,
        desiredFingerprint,
        desiredVersion,
      );
    } catch (error) {
      await this.quarantineInventoryProduct(
        item,
        adapter,
        token,
        lock,
        error instanceof ProductBatchItemError && error.code === 'SOURCE_INVENTORY_CHANGED'
          ? '1688 货源在平台写入期间变化，商品已安全下架'
          : '平台库存写入后无法可靠回读，商品已安全下架',
      );
      if (error instanceof ProductBatchItemError) throw error;
      throw new ProductBatchItemError(
        'INVENTORY_RESULT_UNKNOWN',
        '平台库存写入后无法可靠回读，商品已安全下架，请核验后重新上架',
        false,
      );
    }
    transition = classifyInventoryTransition(actual, before, desired);
    if (transition === 'desired') {
      return this.persistInventoryResult(
        item,
        desired,
        desiredFingerprint,
        desiredVersion,
        actualState,
        false,
        lock,
        adapter,
        token,
      );
    }
    if (transition === 'drift') {
      try {
        await this.persistPlatformInventoryDrift(item, actual, desiredFingerprint, desiredVersion);
      } catch (driftError) {
        if (
          driftError instanceof ProductBatchItemError &&
          driftError.code === 'SOURCE_INVENTORY_CHANGED'
        ) {
          await this.quarantineInventoryProduct(
            item,
            adapter,
            token,
            lock,
            '1688 货源在平台写入期间变化，商品已安全下架',
          );
        }
        throw driftError;
      }
      throw new ProductBatchItemError(
        'PLATFORM_INVENTORY_CHANGED',
        '平台 SKU 库存已在执行期间变化，请重新生成预览',
        false,
      );
    }
    throw new ProductBatchItemError(
      'INVENTORY_NOT_CONFIRMED',
      '平台尚未确认全部 SKU 新库存，将稍后重试',
      true,
    );
  }

  private async assertSourceInventoryCurrent(
    sourceProductId: bigint,
    desiredFingerprint: string,
    desiredVersion: number,
  ): Promise<void> {
    const source = await this.prisma.sourceProduct.findUnique({
      where: { id: sourceProductId },
      select: { inventoryFingerprint: true, inventoryVersion: true },
    });
    if (
      !source ||
      source.inventoryFingerprint !== desiredFingerprint ||
      source.inventoryVersion !== desiredVersion
    ) {
      throw new ProductBatchItemError(
        'SOURCE_INVENTORY_CHANGED',
        '1688 货源库存已在执行期间变化，请重新生成预览',
        false,
      );
    }
  }

  private async readPlatformInventory(
    adapter: PlatformAdapter,
    token: string,
    platformProductId: string,
  ): Promise<PlatformProductInventoryState> {
    if (!adapter.getProductInventory) {
      throw new ProductBatchItemError(
        'INVENTORY_READBACK_UNSUPPORTED',
        '当前平台无法回读 SKU 库存，拒绝执行库存同步',
        false,
      );
    }
    const state = await adapter.getProductInventory(token, platformProductId);
    if (state.state !== 'online') {
      throw new ProductBatchItemError(
        'PRODUCT_NOT_ONLINE',
        `平台商品当前状态为 ${state.state}，未执行库存同步`,
        false,
      );
    }
    return state;
  }

  private async persistInventoryResult(
    item: ProductBatchExecutionRecord,
    desired: ProductBatchInventorySnapshot,
    desiredFingerprint: string,
    desiredVersion: number,
    platformState: PlatformProductInventoryState,
    recovered: boolean,
    lock: string,
    adapter: PlatformAdapter,
    token: string,
  ): Promise<'processed' | 'stale'> {
    const product = item.publishedProduct;
    await this.platformProductLocks.renew(product.id, lock);
    if (!(await this.assertItemOwned(item))) {
      await this.quarantineInventoryProduct(
        item,
        adapter,
        token,
        lock,
        '批量任务执行权在平台确认后失效，商品已安全下架',
      );
      return 'stale';
    }
    const now = new Date();
    const updated = await this.prisma.publishedProduct.updateMany({
      where: {
        id: product.id,
        platformProductId: product.platformProductId,
        mutationRevision: item.expectedMutationRevision,
        status: 'online',
        sourceProduct: {
          inventoryFingerprint: desiredFingerprint,
          inventoryVersion: desiredVersion,
        },
      },
      data: {
        skuInventorySnapshot: desired as unknown as Prisma.InputJsonValue,
        inventorySyncStatus: 'synced',
        inventoryFingerprint: desiredFingerprint,
        inventoryTargetFingerprint: desiredFingerprint,
        inventoryVersion: desiredVersion,
        inventoryTargetVersion: desiredVersion,
        inventorySyncAttempts: 0,
        inventoryNextRunAt: null,
        inventoryLockedAt: null,
        inventoryLockedBy: null,
        inventoryLastSyncedAt: now,
        inventorySyncReason: 'manual_batch_sync',
        inventorySyncError: null,
        mutationRevision: { increment: 1 },
        platformStatusRaw: platformState.status,
        platformCheckStatusRaw: platformState.checkStatus,
        platformStatusSyncedAt: now,
        platformStatusError: null,
      },
    });
    if (updated.count !== 1) {
      const latest = await this.prisma.publishedProduct.findUnique({
        where: { id: product.id },
        include: {
          sourceProduct: { select: { inventoryFingerprint: true, inventoryVersion: true } },
        },
      });
      if (
        latest?.sourceProduct.inventoryFingerprint !== desiredFingerprint ||
        latest.sourceProduct.inventoryVersion !== desiredVersion
      ) {
        await this.quarantineInventoryProduct(
          item,
          adapter,
          token,
          lock,
          '1688 货源在平台写入期间变化，商品已安全下架',
        );
        throw new ProductBatchItemError(
          'SOURCE_INVENTORY_CHANGED',
          '1688 货源库存已在同步期间变化，请重新生成预览',
          false,
        );
      }
      const latestInventory = parseSkuInventorySnapshot(latest?.skuInventorySnapshot);
      if (
        !latestInventory ||
        !sameSkuInventory(latestInventory, desired) ||
        latest?.inventoryFingerprint !== desiredFingerprint ||
        latest.inventoryVersion !== desiredVersion
      ) {
        await this.quarantineInventoryProduct(
          item,
          adapter,
          token,
          lock,
          '商品在平台库存写入期间并发变化，已安全下架',
        );
        throw new ProductBatchItemError(
          'PRODUCT_CHANGED',
          '商品已在库存同步期间发生变化，请重新生成预览',
          false,
        );
      }
    }
    return this.completeClaimedItem(item, {
      reason: recovered ? 'platform_inventory_recovered' : 'inventory_confirmed',
      recovered,
      actualInventory: desired,
    });
  }

  private async quarantineInventoryProduct(
    item: ProductBatchExecutionRecord,
    adapter: PlatformAdapter,
    token: string,
    lock: string,
    reason: string,
  ): Promise<void> {
    const product = item.publishedProduct;
    await this.tryRenewPlatformProductLock(product.id, lock);
    let platformState: PlatformProductState | null = null;
    try {
      await adapter.offlineProduct(token, product.platformProductId!);
    } catch {
      try {
        platformState = await this.readPlatformState(adapter, token, product.platformProductId!);
      } catch {
        throw new ProductBatchItemError(
          'INVENTORY_QUARANTINE_NOT_CONFIRMED',
          '库存结果异常且平台下架状态无法确认，将继续重试',
          true,
        );
      }
      if (!isOfflineState(platformState.state)) {
        throw new ProductBatchItemError(
          'INVENTORY_QUARANTINE_NOT_CONFIRMED',
          '库存结果异常且平台尚未确认商品下架，将继续重试',
          true,
        );
      }
    }
    try {
      platformState ??= await this.readPlatformState(adapter, token, product.platformProductId!);
    } catch {
      throw new ProductBatchItemError(
        'INVENTORY_QUARANTINE_NOT_CONFIRMED',
        '库存结果异常且平台下架状态无法确认，将继续重试',
        true,
      );
    }
    if (!isOfflineState(platformState.state)) {
      throw new ProductBatchItemError(
        'INVENTORY_QUARANTINE_NOT_CONFIRMED',
        '库存结果异常且平台尚未确认商品下架，将继续重试',
        true,
      );
    }

    const ownsPlatformLock = await this.tryRenewPlatformProductLock(product.id, lock);
    const now = new Date();
    const quarantineData = {
      status: platformState.state === 'deleted' ? ('rejected' as const) : ('offline' as const),
      inventorySyncStatus: 'pending' as const,
      inventorySyncAttempts: 0,
      inventoryNextRunAt: now,
      inventoryLockedAt: null,
      inventoryLockedBy: null,
      inventorySyncReason: 'manual_batch_quarantine',
      inventorySyncError: reason,
      mutationRevision: { increment: 1 },
      platformStatusRaw: platformState.status,
      platformCheckStatusRaw: platformState.checkStatus,
      platformStatusSyncedAt: now,
      platformStatusError: null,
    };
    const updated = await this.prisma.publishedProduct.updateMany({
      where: {
        id: product.id,
        platformProductId: product.platformProductId,
        mutationRevision: item.expectedMutationRevision,
        status: 'online',
      },
      data: quarantineData,
    });
    if (updated.count === 1) return;
    if (ownsPlatformLock) {
      const reconciled = await this.prisma.publishedProduct.updateMany({
        where: {
          id: product.id,
          platformProductId: product.platformProductId,
          status: 'online',
        },
        data: quarantineData,
      });
      if (reconciled.count === 1) return;
    }
    const latest = await this.prisma.publishedProduct.findUnique({
      where: { id: product.id },
      select: { platformProductId: true, status: true },
    });
    if (latest?.platformProductId !== product.platformProductId || latest.status !== 'offline') {
      throw new ProductBatchItemError(
        'INVENTORY_QUARANTINE_STATE_CHANGED',
        '库存结果异常，但商品状态已并发变化，请立即人工核验',
        false,
      );
    }
  }

  private async tryRenewPlatformProductLock(publishedProductId: bigint, lock: string) {
    try {
      await this.platformProductLocks.renew(publishedProductId, lock);
      return true;
    } catch {
      return false;
    }
  }

  private async readPlatformState(
    adapter: PlatformAdapter,
    token: string,
    platformProductId: string,
  ) {
    if (adapter.getProductState) return adapter.getProductState(token, platformProductId);
    if (adapter.getProductInventory) return adapter.getProductInventory(token, platformProductId);
    throw new ProductBatchItemError(
      'STATUS_READBACK_UNSUPPORTED',
      '当前平台无法回读商品状态，不能确认安全下架',
      false,
    );
  }

  private async persistPlatformInventoryDrift(
    item: ProductBatchExecutionRecord,
    actual: ProductBatchInventorySnapshot,
    desiredFingerprint: string,
    desiredVersion: number,
  ): Promise<void> {
    const updated = await this.prisma.publishedProduct.updateMany({
      where: {
        id: item.publishedProductId,
        platformProductId: item.publishedProduct.platformProductId,
        mutationRevision: item.expectedMutationRevision,
        sourceProduct: {
          inventoryFingerprint: desiredFingerprint,
          inventoryVersion: desiredVersion,
        },
      },
      data: {
        skuInventorySnapshot: actual as unknown as Prisma.InputJsonValue,
        inventorySyncStatus: 'dead',
        inventoryNextRunAt: null,
        inventoryLockedAt: null,
        inventoryLockedBy: null,
        inventorySyncError: '平台 SKU 库存已在批量预览后变化',
        mutationRevision: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new ProductBatchItemError(
        'SOURCE_INVENTORY_CHANGED',
        '1688 货源库存或商品状态已变化，请重新生成预览',
        false,
      );
    }
  }

  private async readPlatformPrices(
    adapter: PlatformAdapter,
    token: string,
    platformProductId: string,
  ): Promise<PlatformProductPriceState> {
    if (!adapter.getProductPrices) {
      throw new ProductBatchItemError(
        'PRICE_READBACK_UNSUPPORTED',
        '当前平台无法回读 SKU 价格，拒绝执行改价',
        false,
      );
    }
    return adapter.getProductPrices(token, platformProductId);
  }

  private async persistPriceResult(
    item: ProductBatchExecutionRecord,
    desired: SkuPriceSnapshot,
    platformState: PlatformProductPriceState | null,
    recovered: boolean,
    lock: string,
  ): Promise<'processed' | 'stale'> {
    const product = item.publishedProduct;
    await this.platformProductLocks.renew(product.id, lock);
    if (!(await this.assertItemOwned(item))) return 'stale';
    const now = new Date();
    const updated = await this.prisma.publishedProduct.updateMany({
      where: {
        id: product.id,
        platformProductId: product.platformProductId,
        mutationRevision: item.expectedMutationRevision,
        status: 'online',
      },
      data: {
        salePrice: snapshotStartPrice(desired),
        skuPriceSnapshot: desired as unknown as Prisma.InputJsonValue,
        priceSyncedAt: now,
        lastEditedAt: now,
        lastEditError: null,
        mutationRevision: { increment: 1 },
        ...(platformState
          ? {
              platformStatusRaw: platformState.status,
              platformCheckStatusRaw: platformState.checkStatus,
              platformStatusSyncedAt: now,
              platformStatusError: null,
            }
          : {}),
      },
    });
    if (updated.count !== 1) {
      const latest = await this.prisma.publishedProduct.findUnique({ where: { id: product.id } });
      const latestPrices = parseSkuPriceSnapshot(latest?.skuPriceSnapshot);
      if (!latestPrices || !sameSkuPrices(latestPrices, desired)) {
        throw new ProductBatchItemError(
          'PRODUCT_CHANGED',
          '商品已在改价期间发生变化，请重新生成预览',
          false,
        );
      }
    }
    return this.completeClaimedItem(item, {
      reason: recovered ? 'platform_price_recovered' : 'price_confirmed',
      recovered,
      actualPrices: desired,
    });
  }

  private async persistPlatformPriceDrift(
    item: ProductBatchExecutionRecord,
    actual: SkuPriceSnapshot,
    platformState: PlatformProductPriceState,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.publishedProduct.updateMany({
      where: {
        id: item.publishedProductId,
        platformProductId: item.publishedProduct.platformProductId,
        mutationRevision: item.expectedMutationRevision,
      },
      data: {
        salePrice: snapshotStartPrice(actual),
        skuPriceSnapshot: actual as unknown as Prisma.InputJsonValue,
        priceSyncedAt: now,
        lastEditError: '平台 SKU 价格已在批量预览后变化',
        mutationRevision: { increment: 1 },
        platformStatusRaw: platformState.status,
        platformCheckStatusRaw: platformState.checkStatus,
        platformStatusSyncedAt: now,
        platformStatusError: null,
      },
    });
  }

  async failClaimedItem(
    item: ProductBatchExecutionRecord,
    error: unknown,
  ): Promise<'retry_wait' | 'failed' | 'cancelled' | 'stale'> {
    if (
      item.task.action === 'edit_sku' &&
      (isUnknownSkuExecutionError(error) || !isResolvedSkuExecutionError(error))
    ) {
      const unknown = await this.prisma.productBatchItem.updateMany({
        where: {
          ...ownedItemWhere(item),
          errorCode: { in: [...UNRESOLVED_SKU_CODES] },
        },
        data: {
          status: 'failed',
          lockedAt: null,
          lockedBy: null,
          errorCode: SKU_RESULT_UNKNOWN_CODE,
          errorMessage: 'SKU 写入已经开始，但未能可靠收敛平台结果，请稍后核验实际 SKU',
          finishedAt: new Date(),
        },
      });
      if (unknown.count === 1) {
        await this.refreshTask(item.taskId);
        return 'failed';
      }
    }
    if (
      item.task.action === 'edit_title' &&
      (isUnknownTitleExecutionError(error) || !isResolvedTitleExecutionError(error))
    ) {
      const unknown = await this.prisma.productBatchItem.updateMany({
        where: {
          ...ownedItemWhere(item),
          errorCode: { in: [...UNRESOLVED_TITLE_CODES] },
        },
        data: {
          status: 'failed',
          lockedAt: null,
          lockedBy: null,
          errorCode: TITLE_RESULT_UNKNOWN_CODE,
          errorMessage: '标题写入已经开始，但未能可靠收敛平台结果，请稍后核验实际标题',
          finishedAt: new Date(),
        },
      });
      if (unknown.count === 1) {
        await this.refreshTask(item.taskId);
        return 'failed';
      }
    }
    if (
      item.task.action === 'online' &&
      (isUnknownOnlineExecutionError(error) || !isResolvedOnlineExecutionError(error))
    ) {
      const unknown = await this.prisma.productBatchItem.updateMany({
        where: {
          ...ownedItemWhere(item),
          errorCode: { in: [...UNRESOLVED_ONLINE_CODES] },
        },
        data: {
          status: 'failed',
          lockedAt: null,
          lockedBy: null,
          errorCode: ONLINE_RESULT_UNKNOWN_CODE,
          errorMessage: '上架写入已经开始，但未能可靠收敛平台结果，请稍后核验状态与库存',
          finishedAt: new Date(),
        },
      });
      if (unknown.count === 1) {
        await this.refreshTask(item.taskId);
        return 'failed';
      }
    }
    if (
      OFFLINE_BATCH_ACTIONS.includes(item.task.action as (typeof OFFLINE_BATCH_ACTIONS)[number]) &&
      (isUnknownOfflineExecutionError(error) || !isResolvedOfflineExecutionError(error))
    ) {
      const unknown = await this.prisma.productBatchItem.updateMany({
        where: {
          ...ownedItemWhere(item),
          errorCode: { in: [...UNRESOLVED_OFFLINE_CODES] },
        },
        data: {
          status: 'failed',
          lockedAt: null,
          lockedBy: null,
          errorCode: OFFLINE_RESULT_UNKNOWN_CODE,
          errorMessage: '下架写入已经开始，但未能可靠收敛平台状态，请稍后核验实际状态',
          finishedAt: new Date(),
        },
      });
      if (unknown.count === 1) {
        await this.refreshTask(item.taskId);
        return 'failed';
      }
    }
    const cancelled = await this.prisma.productBatchItem.updateMany({
      where: {
        ...ownedItemWhere(item),
        task: { cancelRequestedAt: { not: null } },
      },
      data: {
        status: 'cancelled',
        lockedAt: null,
        lockedBy: null,
        errorCode: null,
        errorMessage: null,
        finishedAt: new Date(),
      },
    });
    if (cancelled.count === 1) {
      await this.refreshTask(item.taskId);
      return 'cancelled';
    }
    const retryable = !(error instanceof ProductBatchItemError) || error.retryable;
    const failed = !retryable || item.attempts >= item.maxAttempts;
    const code =
      error instanceof ProductBatchItemError ? error.code : safeErrorCode(error, 'PLATFORM_ERROR');
    const message = safeErrorMessage(error).slice(0, 1000);
    const updated = await this.prisma.productBatchItem.updateMany({
      where: ownedItemWhere(item),
      data: {
        status: failed ? 'failed' : 'retry_wait',
        nextRunAt: failed ? item.nextRunAt : new Date(Date.now() + retryDelayMs(item.attempts)),
        lockedAt: null,
        lockedBy: null,
        errorCode: code,
        errorMessage: message,
        ...(failed ? { finishedAt: new Date() } : {}),
      },
    });
    if (updated.count !== 1) return 'stale';
    await this.refreshTask(item.taskId);
    return failed ? 'failed' : 'retry_wait';
  }

  private async completeClaimedItem(
    item: ProductBatchExecutionRecord,
    result: Record<string, unknown>,
  ): Promise<'processed' | 'stale'> {
    const updated = await this.prisma.productBatchItem.updateMany({
      where: ownedItemWhere(item),
      data: {
        status: 'succeeded',
        result: result as Prisma.InputJsonValue,
        errorCode: null,
        errorMessage: null,
        lockedAt: null,
        lockedBy: null,
        finishedAt: new Date(),
      },
    });
    if (updated.count !== 1) return 'stale';
    await this.refreshTask(item.taskId);
    return 'processed';
  }

  private async cancelClaimedItem(
    item: ProductBatchExecutionRecord,
  ): Promise<'processed' | 'stale'> {
    const updated = await this.prisma.productBatchItem.updateMany({
      where: ownedItemWhere(item),
      data: {
        status: 'cancelled',
        lockedAt: null,
        lockedBy: null,
        finishedAt: new Date(),
      },
    });
    if (updated.count !== 1) return 'stale';
    await this.refreshTask(item.taskId);
    return 'processed';
  }

  private async assertItemOwned(item: ProductBatchExecutionRecord): Promise<boolean> {
    return (await this.prisma.productBatchItem.count({ where: ownedItemWhere(item) })) === 1;
  }

  private async recoverStaleItems(now: Date): Promise<void> {
    const stale = await this.prisma.productBatchItem.findMany({
      where: { status: 'running', lockedAt: { lt: new Date(now.getTime() - STALE_ITEM_MS) } },
      orderBy: { lockedAt: 'asc' },
      take: 100,
      include: { task: true },
    });
    const taskIds = new Set<bigint>();
    for (const item of stale) {
      const cancelled = Boolean(item.task.cancelRequestedAt);
      const titleResultUnknown =
        item.task.action === 'edit_title' &&
        UNRESOLVED_TITLE_CODES.includes(item.errorCode as (typeof UNRESOLVED_TITLE_CODES)[number]);
      const onlineResultUnknown =
        item.task.action === 'online' &&
        UNRESOLVED_ONLINE_CODES.includes(
          item.errorCode as (typeof UNRESOLVED_ONLINE_CODES)[number],
        );
      const offlineResultUnknown =
        OFFLINE_BATCH_ACTIONS.includes(
          item.task.action as (typeof OFFLINE_BATCH_ACTIONS)[number],
        ) &&
        UNRESOLVED_OFFLINE_CODES.includes(
          item.errorCode as (typeof UNRESOLVED_OFFLINE_CODES)[number],
        );
      const skuResultUnknown =
        item.task.action === 'edit_sku' &&
        UNRESOLVED_SKU_CODES.includes(item.errorCode as (typeof UNRESOLVED_SKU_CODES)[number]);
      const unresolvedMutation =
        titleResultUnknown || onlineResultUnknown || offlineResultUnknown || skuResultUnknown;
      const failed = unresolvedMutation || (!cancelled && item.attempts >= item.maxAttempts);
      const updated = await this.prisma.productBatchItem.updateMany({
        where: {
          id: item.id,
          status: 'running',
          attempts: item.attempts,
          lockedBy: item.lockedBy,
        },
        data: {
          status: unresolvedMutation
            ? 'failed'
            : cancelled
              ? 'cancelled'
              : failed
                ? 'failed'
                : 'retry_wait',
          nextRunAt: now,
          lockedAt: null,
          lockedBy: null,
          errorCode: unresolvedMutation
            ? titleResultUnknown
              ? TITLE_RESULT_UNKNOWN_CODE
              : onlineResultUnknown
                ? ONLINE_RESULT_UNKNOWN_CODE
                : offlineResultUnknown
                  ? OFFLINE_RESULT_UNKNOWN_CODE
                  : SKU_RESULT_UNKNOWN_CODE
            : cancelled
              ? null
              : 'WORKER_STALE',
          errorMessage: unresolvedMutation
            ? titleResultUnknown
              ? '标题写入期间 worker 中断，请核验平台实际标题'
              : onlineResultUnknown
                ? '上架写入期间 worker 中断，请核验平台实际状态与库存'
                : offlineResultUnknown
                  ? '下架写入期间 worker 中断，请核验平台实际状态'
                  : 'SKU 写入期间 worker 中断，请核验平台实际 SKU'
            : cancelled
              ? null
              : '批量任务 worker 超时，已安全恢复',
          ...((cancelled || failed || unresolvedMutation) && { finishedAt: now }),
        },
      });
      if (updated.count === 1) taskIds.add(item.taskId);
    }
    for (const taskId of taskIds) await this.refreshTask(taskId);
  }

  private async refreshTask(taskId: bigint): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const task = await this.prisma.productBatchTask.findUnique({
        where: { id: taskId },
        include: { items: { select: { status: true } } },
      });
      if (!task || (!task.confirmedAt && task.status === 'preview')) return;
      const summary = summarizeStatuses(task.items.map((item) => item.status));
      const active = summary.pending + summary.running + summary.retryWait;
      let status: Prisma.ProductBatchTaskUpdateInput['status'];
      let finishedAt: Date | null = null;
      if (active > 0) {
        status = task.cancelRequestedAt ? 'cancelling' : summary.running > 0 ? 'running' : 'queued';
      } else {
        finishedAt = new Date();
        if (summary.failed === 0 && summary.cancelled === 0) status = 'succeeded';
        else if (
          task.cancelRequestedAt &&
          summary.succeeded === 0 &&
          summary.skipped === 0 &&
          summary.failed === 0
        )
          status = 'cancelled';
        else if (summary.failed > 0 && summary.succeeded === 0 && summary.skipped === 0)
          status = 'failed';
        else status = 'partial';
      }
      const finishedStateMatches =
        finishedAt === null ? task.finishedAt == null : task.finishedAt != null;
      if (task.status === status && finishedStateMatches) return;
      const updated = await this.prisma.productBatchTask.updateMany({
        where: { id: task.id, stateRevision: task.stateRevision },
        data: { status, stateRevision: { increment: 1 }, finishedAt },
      });
      if (updated.count === 1) return;
    }
  }

  private async reconcileFinishedTasks(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTaskReconcileAt < TASK_RECONCILE_INTERVAL_MS) return;
    this.lastTaskReconcileAt = now;
    const tasks = await this.prisma.productBatchTask.findMany({
      where: {
        ...(this.lastTaskReconcileCursor ? { id: { gt: this.lastTaskReconcileCursor } } : {}),
        confirmedAt: { not: null },
        status: {
          in: ['queued', 'running', 'cancelling', ...TERMINAL_TASK_STATUSES],
        },
      },
      orderBy: { id: 'asc' },
      take: 100,
      select: { id: true },
    });
    for (const task of tasks) await this.refreshTask(task.id);
    this.lastTaskReconcileCursor = tasks.length === 100 ? (tasks.at(-1)?.id ?? null) : null;
  }

  private async assessCleanupCandidates(
    records: Array<{
      id: bigint;
      status: string;
      platformProductId: string | null;
      platformStatusRaw: number | null;
      platformCheckStatusRaw: number | null;
      publishedAt: Date;
      shop: {
        platform: string;
        platformShopId: string;
        lastOrderSyncAt: Date | null;
        orderSyncAttemptAt: Date | null;
        orderSyncError: string | null;
      };
    }>,
    observedAt: Date,
  ): Promise<Map<bigint, ProductBatchCleanupAssessment>> {
    if (!records.length) return new Map();
    const windowStartedAt = new Date(observedAt.getTime() - CLEANUP_WINDOW_DAYS * DAY_MS);
    const rows = await this.prisma.$queryRaw<CleanupOrderAggregateRow[]>(Prisma.sql`
      SELECT
        oi."published_product_id" AS "publishedProductId",
        COUNT(DISTINCT o."id") AS "validOrderCount",
        MAX(o."paid_at") AS "lastPaidAt"
      FROM "order_items" oi
      INNER JOIN "orders" o ON o."id" = oi."order_id"
      WHERE oi."published_product_id" IN (${Prisma.join(records.map((record) => record.id))})
        AND o."status" IN ('paid', 'purchasing', 'shipped', 'received')
        AND (
          o."paid_at" IS NULL
          OR (o."paid_at" >= ${windowStartedAt} AND o."paid_at" <= ${observedAt})
        )
      GROUP BY oi."published_product_id"
    `);
    const aggregates = new Map(
      rows.map((row) => [
        row.publishedProductId,
        {
          validOrderCount: Number(row.validOrderCount),
          lastPaidAt:
            row.lastPaidAt instanceof Date
              ? row.lastPaidAt
              : row.lastPaidAt
                ? new Date(row.lastPaidAt)
                : null,
        },
      ]),
    );
    return new Map(
      records.map((record) => {
        const aggregate = aggregates.get(record.id) ?? { validOrderCount: 0, lastPaidAt: null };
        const daysOnline = Math.max(
          0,
          Math.floor((observedAt.getTime() - record.publishedAt.getTime()) / DAY_MS),
        );
        const syncReason = this.cleanupSyncUnavailableReason(record.shop, observedAt);
        const evidence: ProductBatchCleanupEvidence = {
          policyVersion: CLEANUP_POLICY_VERSION,
          windowDays: CLEANUP_WINDOW_DAYS,
          graceDays: CLEANUP_GRACE_DAYS,
          observedAt: observedAt.toISOString(),
          windowStartedAt: windowStartedAt.toISOString(),
          daysOnline,
          validOrderCount: aggregate.validOrderCount,
          lastPaidAt:
            aggregate.lastPaidAt && Number.isFinite(aggregate.lastPaidAt.getTime())
              ? aggregate.lastPaidAt.toISOString()
              : null,
          orderSyncAt:
            record.shop.lastOrderSyncAt?.toISOString() ??
            (this.demoMode || isDemoShop(record.shop) ? observedAt.toISOString() : null),
        };
        let code: string | null = null;
        let reason: string | null = null;
        if (!record.platformProductId) {
          code = 'PLATFORM_ID_MISSING';
          reason = '商品缺少平台商品 ID，不能执行滞销清理';
        } else if (isRawDeletedProduct(record)) {
          code = 'PRODUCT_DELETED';
          reason = '平台商品已删除，无需执行滞销清理';
        } else if (record.status !== 'online') {
          code = 'PRODUCT_NOT_ONLINE';
          reason = '只有在线商品可以执行滞销清理';
        } else if (daysOnline < CLEANUP_GRACE_DAYS) {
          code = 'CLEANUP_GRACE_PERIOD';
          reason = `商品上架未满 ${CLEANUP_GRACE_DAYS} 天，不能作为滞销商品清理`;
        } else if (syncReason) {
          code = 'CLEANUP_ORDER_SYNC_UNAVAILABLE';
          reason = syncReason;
        } else if (aggregate.validOrderCount > 0) {
          code = 'CLEANUP_RECENT_SALES';
          reason = `最近 ${CLEANUP_WINDOW_DAYS} 天已有有效订单，不能作为滞销商品清理`;
        }
        return [record.id, { evidence, eligible: reason === null, reason, code }] as const;
      }),
    );
  }

  private cleanupSyncUnavailableReason(
    shop: {
      platform: string;
      platformShopId: string;
      lastOrderSyncAt: Date | null;
      orderSyncAttemptAt: Date | null;
      orderSyncError: string | null;
    },
    now: Date,
  ): string | null {
    if (this.demoMode || isDemoShop(shop)) return null;
    if (shop.platform !== 'douyin') return '当前仅支持基于抖店订单证据执行滞销清理';
    if (this.config.get<string>('DOUYIN_ORDER_SYNC_ENABLED') !== 'true') {
      return '抖店订单同步未启用，不能安全判断滞销商品';
    }
    const lookbackDays = Number(this.config.get<string>('DOUYIN_ORDER_SYNC_LOOKBACK_DAYS') ?? 30);
    if (!Number.isInteger(lookbackDays) || lookbackDays < CLEANUP_WINDOW_DAYS) {
      return `抖店订单同步回溯不足 ${CLEANUP_WINDOW_DAYS} 天，不能安全判断滞销商品`;
    }
    const historyVerifiedAtValue = this.config
      .get<string>('DOUYIN_ORDER_SYNC_HISTORY_VERIFIED_AT')
      ?.trim();
    const historyVerifiedAt = historyVerifiedAtValue ? Date.parse(historyVerifiedAtValue) : NaN;
    if (!Number.isFinite(historyVerifiedAt) || historyVerifiedAt > now.getTime()) {
      return `${CLEANUP_WINDOW_DAYS} 天历史订单回补尚未确认，不能安全判断滞销商品`;
    }
    if (shop.orderSyncError) return '店铺订单同步存在错误，请先完成同步再清理';
    if (
      shop.orderSyncAttemptAt &&
      (!shop.lastOrderSyncAt || shop.orderSyncAttemptAt.getTime() > shop.lastOrderSyncAt.getTime())
    ) {
      return '店铺订单正在同步，请等待同步完成后再清理';
    }
    if (!shop.lastOrderSyncAt) return '店铺尚未完成订单同步，不能安全判断滞销商品';
    if (shop.lastOrderSyncAt.getTime() < historyVerifiedAt) {
      return '店铺尚未在历史订单回补后完成增量同步，不能安全判断滞销商品';
    }
    const intervalMs = Number(this.config.get<string>('DOUYIN_ORDER_SYNC_INTERVAL_MS') ?? 60_000);
    const maxAgeMs = Math.max(
      CLEANUP_MIN_SYNC_AGE_MS,
      (Number.isInteger(intervalMs) && intervalMs > 0 ? intervalMs : 60_000) * 3,
    );
    const ageMs = now.getTime() - shop.lastOrderSyncAt.getTime();
    if (ageMs < 0 || ageMs > maxAgeMs) {
      return '店铺订单同步水位已过期，请先同步最新订单再清理';
    }
    return null;
  }

  private sourceChangeSyncUnavailableReason(
    shop: {
      platform: string;
      platformShopId: string;
      lastOrderSyncAt: Date | null;
      orderSyncAttemptAt: Date | null;
      orderSyncError: string | null;
    },
    now: Date,
  ): string | null {
    const reason = this.cleanupSyncUnavailableReason(shop, now);
    return (
      reason
        ?.replace('判断滞销商品', '执行安全换源')
        .replace('执行滞销清理', '执行安全换源')
        .replace('再清理', '再换源') ?? null
    );
  }

  private async resolveSkuEditTargets(
    userId: bigint,
    records: Array<{
      id: bigint;
      platformProductId: string | null;
      status: string;
      platformStatusRaw: number | null;
      mutationRevision: number;
      skuSpecSnapshot: Prisma.JsonValue | null;
      skuSpecFingerprint: string | null;
      skuSpecSyncedAt: Date | null;
      inventorySyncStatus: string;
      sourceProductId: bigint;
      shop: {
        id: bigint;
        platform: PlatformType;
        platformShopId: string;
        accessTokenEnc: string | null;
      };
      sourceProduct: {
        id: bigint;
        productId1688: string;
        supplierId: string | null;
        isOnePieceDrop: boolean;
        availability: string;
        price: Prisma.Decimal;
        skuList: Prisma.JsonValue | null;
        totalStock: number;
        inventoryFingerprint: string;
        inventoryVersion: number;
      };
      sourceBindings?: Array<{
        id: bigint;
        sourceProductId: bigint;
        revision: number;
        currentSlot: number | null;
        sourceOfferId: string;
        sourceSupplierId: string | null;
        sourceOnePieceDrop: boolean;
        sourceFingerprint: string;
        inventoryFingerprint: string;
        inventoryVersion: number;
        bindingFingerprint: string;
        skuRoutes: Prisma.JsonValue;
      }>;
    }>,
    skuTargets: NormalizedSkuTarget[],
    clientRequestId: string,
  ): Promise<Map<bigint, ResolvedSkuEditTarget>> {
    const requestedByProduct = new Map(
      skuTargets.map((target) => [target.publishedProductId, target] as const),
    );
    const rulePromises = new Map<string, Promise<PlatformProductSkuRules>>();
    const resolved = new Map<bigint, ResolvedSkuEditTarget>();
    const now = Date.now();

    for (const record of records) {
      const requested = requestedByProduct.get(record.id.toString());
      if (!requested) throw new BadRequestException('逐项 SKU 目标缺少所选商品');
      if (!record.platformProductId) throw new BadRequestException('商品缺少平台商品 ID');
      if (record.status !== 'offline' && record.status !== 'draft') {
        throw new BadRequestException('只有已下架或草稿商品可以编辑 SKU');
      }
      if (record.platformStatusRaw === 2) {
        throw new BadRequestException('平台商品已删除，不能编辑 SKU');
      }
      if (record.inventorySyncStatus === 'syncing') {
        throw new ConflictException('商品库存正在同步，请稍后重新读取 SKU 编辑上下文');
      }
      const beforeState = parseStoredProductSkuState(record.skuSpecSnapshot);
      if (
        !beforeState ||
        !record.skuSpecFingerprint ||
        productSkuFingerprint(beforeState) !== record.skuSpecFingerprint
      ) {
        throw new ConflictException('商品缺少可信的平台 SKU 快照，请重新读取 SKU 编辑上下文');
      }
      if (
        !record.skuSpecSyncedAt ||
        now - record.skuSpecSyncedAt.getTime() < 0 ||
        now - record.skuSpecSyncedAt.getTime() > SKU_CONTEXT_MAX_AGE_MS
      ) {
        throw new ConflictException('平台 SKU 快照已过期，请重新读取 SKU 编辑上下文');
      }
      if (requested.expectedPlatformSkuFingerprint !== record.skuSpecFingerprint) {
        throw new ConflictException('平台 SKU 已变化，请重新读取 SKU 编辑上下文');
      }
      const binding = currentSourceBindingForSkuEdit(record.sourceBindings);
      if (!binding || binding.sourceProductId !== record.sourceProductId) {
        throw new ConflictException('商品当前货源绑定缺失、重复或与商品指针不一致');
      }
      if (record.sourceProduct.availability !== 'available') {
        throw new BadRequestException(`1688 货源当前状态为 ${record.sourceProduct.availability}`);
      }
      const suggestion = buildSkuSuggestion(
        record.sourceProduct.skuList,
        Number(record.sourceProduct.price),
      );
      if (
        suggestion.warnings.some((warning) =>
          /(格式无效|重复|超过|缺少规格值|已不存在)/.test(warning),
        )
      ) {
        throw new BadRequestException('当前 1688 SKU 数据不完整，请重新采集货源');
      }
      const sourceSupplierId = record.sourceProduct.supplierId?.trim();
      if (
        !sourceSupplierId ||
        !record.sourceProduct.isOnePieceDrop ||
        binding.sourceOfferId !== record.sourceProduct.productId1688 ||
        binding.sourceSupplierId !== sourceSupplierId ||
        binding.sourceOnePieceDrop !== true
      ) {
        throw new ConflictException('商品当前货源采购身份已变化，不能安全编辑 SKU');
      }
      const adapter = this.adapters.create(record.shop);
      if (
        !adapter.getProductSkuRules ||
        !adapter.getProductSkuState ||
        !adapter.replaceProductSkus
      ) {
        throw new BadRequestException('当前平台不支持可回读的完整 SKU 编辑');
      }
      const ruleKey = `${record.shop.id}:${beforeState.categoryId}`;
      let rulePromise = rulePromises.get(ruleKey);
      if (!rulePromise) {
        rulePromise = (async () => {
          const token = isDemoShop(record.shop)
            ? 'mock-token'
            : await this.shopTokens.getAccessToken(record.shop.id, userId);
          return normalizeProductSkuRules(
            await adapter.getProductSkuRules!(token, { categoryId: beforeState.categoryId }),
          );
        })();
        rulePromises.set(ruleKey, rulePromise);
      }
      const rules = await rulePromise;
      const ruleFingerprint = productSkuRuleFingerprint(rules);
      if (ruleFingerprint !== requested.expectedRuleFingerprint) {
        throw new ConflictException('平台 SKU 规则已变化，请重新读取 SKU 编辑上下文');
      }
      validateSkuTargetAgainstRules(requested, rules);

      const existingByKey = new Map(
        beforeState.items.map((item) => [item.platformSkuKey, item] as const),
      );
      const sourceById = new Map(
        suggestion.skus.map((sku) => [sku.sourceSkuId === 'default' ? null : sku.sourceSkuId, sku]),
      );
      const usedSourceSpecs = new Set<string | null>();
      const desiredItems = requested.rows.map((row) => {
        const sourceSpecId = row.sourceSpecId;
        const source = sourceById.get(sourceSpecId);
        if (!source) throw new BadRequestException('目标 SKU 未一对一映射当前 1688 spec');
        const stock = sourceSkuStock(
          source,
          record.sourceProduct.skuList,
          record.sourceProduct.totalStock,
        );
        if (stock === null) throw new BadRequestException('当前 1688 默认规格库存无效');
        if (usedSourceSpecs.has(sourceSpecId)) {
          throw new BadRequestException('同一个 1688 spec 不能映射多个目标 SKU');
        }
        usedSourceSpecs.add(sourceSpecId);
        let platformSkuId: string | undefined;
        let platformSkuKey: string;
        let sideFields: Pick<
          PlatformProductSkuItem,
          | 'skuStatus'
          | 'skuType'
          | 'code'
          | 'supplierId'
          | 'stepStock'
          | 'barcodes'
          | 'skuPictureUrls'
        >;
        if (row.isNew) {
          if (row.platformSkuId || row.platformSkuKey) {
            throw new BadRequestException('新增 SKU 不能提交平台 SKU ID 或 key');
          }
          platformSkuKey = generatedPlatformSkuKey(
            clientRequestId,
            record.id.toString(),
            row.rowId,
          );
          sideFields = {
            skuStatus: true,
            skuType: 0,
            code: null,
            supplierId: null,
            stepStock: 0,
            barcodes: [],
            skuPictureUrls: row.skuPictureUrls,
          };
        } else {
          if (!row.platformSkuId || !row.platformSkuKey) {
            throw new BadRequestException('既有 SKU 必须携带原平台 SKU ID 与 key');
          }
          const existing = existingByKey.get(row.platformSkuKey);
          if (!existing || existing.platformSkuId !== row.platformSkuId) {
            throw new ConflictException('既有平台 SKU ID 或 key 已变化，请重新读取上下文');
          }
          if (row.priceCents !== existing.priceCents) {
            throw new BadRequestException('当前 SKU 编辑不能修改既有 SKU 价格');
          }
          platformSkuId = existing.platformSkuId;
          platformSkuKey = existing.platformSkuKey;
          if (
            row.skuPictureUrls.length > 0 &&
            !sameStringSet(row.skuPictureUrls, existing.skuPictureUrls)
          ) {
            throw new BadRequestException('当前 SKU 编辑不能修改既有 SKU 图片');
          }
          sideFields = {
            skuStatus: existing.skuStatus,
            skuType: existing.skuType,
            code: existing.code,
            supplierId: existing.supplierId,
            stepStock: existing.stepStock,
            barcodes: existing.barcodes,
            skuPictureUrls: existing.skuPictureUrls,
          };
        }
        return {
          ...(platformSkuId ? { platformSkuId } : {}),
          platformSkuKey,
          sourceSpecId,
          sourceUnitCost: source.costPrice,
          properties: row.properties,
          priceCents: row.isNew ? row.priceCents : existingByKey.get(platformSkuKey)!.priceCents,
          stock,
          ...sideFields,
        };
      });
      const desiredFingerprint = skuEditTargetFingerprint({
        categoryId: beforeState.categoryId,
        productType: beforeState.productType,
        startSaleType: beforeState.startSaleType,
        dimensions: requested.dimensions,
        items: desiredItems,
      });
      resolved.set(record.id, {
        rules,
        ruleFingerprint,
        beforeState,
        beforeFingerprint: record.skuSpecFingerprint,
        desiredDimensions: requested.dimensions,
        desiredItems,
        desiredFingerprint,
        bindingId: binding.id,
        bindingRevision: binding.revision,
        bindingFingerprint: binding.bindingFingerprint,
        bindingRoutesFingerprint: sourceBindingRoutesFingerprint(binding.skuRoutes),
        sourceProductId: record.sourceProduct.id,
        sourceOfferId: binding.sourceOfferId,
        sourceSupplierId,
        sourceOnePieceDrop: true,
        sourceFingerprint: suggestion.sourceFingerprint,
        sourceInventoryFingerprint: record.sourceProduct.inventoryFingerprint,
        sourceInventoryVersion: record.sourceProduct.inventoryVersion,
      });
    }
    return resolved;
  }

  private async resolveSourceChangeTargets(
    userId: bigint,
    records: Array<{
      id: bigint;
      status: string;
      platformProductId: string | null;
      platformStatusRaw: number | null;
      platformCheckStatusRaw: number | null;
      mutationRevision: number;
      sourceProductId: bigint;
      inventorySyncStatus: string;
      shop: {
        platform: string;
        platformShopId: string;
        lastOrderSyncAt: Date | null;
        orderSyncAttemptAt: Date | null;
        orderSyncError: string | null;
      };
      sourceProduct: { productId1688: string };
      sourceBindings?: Array<{
        id: bigint;
        sourceProductId: bigint;
        revision: number;
        currentSlot: number | null;
        sourceOfferId: string;
        bindingFingerprint: string;
        skuRoutes: Prisma.JsonValue;
      }>;
    }>,
    sourceTargets: NormalizedSourceTarget[],
  ): Promise<Map<bigint, ProductBatchResolvedSourceTarget>> {
    const requestedOfferIds = [
      ...new Set(sourceTargets.map((target) => target.targetSourceProductId)),
    ];
    const targetProducts = await this.prisma.sourceProduct.findMany({
      where: {
        productId1688: { in: requestedOfferIds },
        userSourceProducts: { some: { userId } },
      },
    });
    const targetsByOfferId = new Map(
      targetProducts.map((target) => [target.productId1688, target] as const),
    );
    const sourceTargetByProduct = new Map(
      sourceTargets.map((target) => [target.publishedProductId, target] as const),
    );
    const resolved = new Map<bigint, ProductBatchResolvedSourceTarget>();
    const now = new Date();

    for (const record of records) {
      const requested = sourceTargetByProduct.get(record.id.toString());
      if (!requested) throw new BadRequestException('逐项目标货源缺少所选商品');
      const unavailableReason = sourceChangeUnavailableReason(
        record,
        false,
        this.sourceChangeSyncUnavailableReason(record.shop, now),
      );
      if (unavailableReason) throw new BadRequestException(unavailableReason);
      const currentBinding = record.sourceBindings![0]!;
      if (requested.targetSourceProductId === record.sourceProduct.productId1688) {
        throw new BadRequestException('目标 1688 货源与当前货源相同');
      }
      const target = targetsByOfferId.get(requested.targetSourceProductId);
      if (!target) throw new BadRequestException('目标 1688 货源尚未采集或不属于当前账号');
      if (target.availability !== 'available') {
        throw new BadRequestException(`目标 1688 货源当前状态为 ${target.availability}`);
      }
      if (!target.isOnePieceDrop) throw new BadRequestException('目标 1688 货源不支持一件代发');
      const targetSupplierId = target.supplierId?.trim();
      if (!targetSupplierId) {
        throw new BadRequestException('目标 1688 货源缺少供应商标识，不能安全采购');
      }
      if (target.totalStock <= 0) throw new BadRequestException('目标 1688 货源当前没有可售库存');
      if (!Array.isArray(target.skuList) || target.skuList.length === 0) {
        throw new BadRequestException('目标 1688 货源缺少可核对的 SKU 库存，不能安全换源');
      }
      const inventoryFingerprint = inventoryFingerprintValue(target.inventoryFingerprint);
      if (!inventoryFingerprint || target.inventoryVersion <= 0) {
        throw new BadRequestException('目标 1688 货源库存版本无效，请重新采集后再换源');
      }
      const suggestion = buildSkuSuggestion(target.skuList, Number(target.price));
      const skuRoutes = buildSourceChangeRoutes(
        currentBinding.skuRoutes,
        suggestion,
        target.skuList,
      );
      const bindingFingerprint = sourceBindingFingerprint({
        sourceProductId: target.id,
        sourceOfferId: target.productId1688,
        sourceSupplierId: targetSupplierId,
        sourceOnePieceDrop: target.isOnePieceDrop,
        sourceFingerprint: suggestion.sourceFingerprint,
        inventoryFingerprint,
        inventoryVersion: target.inventoryVersion,
        skuRoutes,
      });
      resolved.set(record.id, {
        sourceProductDatabaseId: target.id,
        sourceOfferId: target.productId1688,
        sourceTitle: target.title,
        sourceSupplierId: targetSupplierId,
        sourceOnePieceDrop: target.isOnePieceDrop,
        sourceFingerprint: suggestion.sourceFingerprint,
        inventoryFingerprint,
        inventoryVersion: target.inventoryVersion,
        syncedAt: target.syncedAt,
        skuRoutes,
        bindingFingerprint,
        bindingRevision: currentBinding.revision + 1,
      });
    }
    return resolved;
  }

  private async requireTask(userId: bigint, taskId: bigint): Promise<ProductBatchTaskRecord> {
    const task = await this.prisma.productBatchTask.findFirst({
      where: { id: taskId, userId },
      include: TASK_INCLUDE,
    });
    if (!task) throw new NotFoundException('批量任务不存在');
    return task;
  }

  private async findByClientRequestId(
    userId: bigint,
    clientRequestId: string,
  ): Promise<ProductBatchTaskRecord | null> {
    return this.prisma.productBatchTask.findUnique({
      where: { uk_product_batch_user_client_request: { userId, clientRequestId } },
      include: TASK_INCLUDE,
    });
  }

  private assertSameRequest(
    task: ProductBatchTaskRecord,
    action: string,
    fingerprint: string,
  ): void {
    if (task.action === action && task.requestFingerprint === fingerprint) return;
    throw new ConflictException('该请求标识已用于不同的批量操作，请生成新标识');
  }

  private assertExecutionEnabled(): void {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException('批量执行 worker 尚未启用，请联系管理员');
    }
  }

  private maxAttempts(): number {
    const value = Number(this.config.get<string>('PRODUCT_BATCH_MAX_ATTEMPTS') ?? 3);
    return Number.isInteger(value) && value >= 1 && value <= 10 ? value : 3;
  }
}

class ProductBatchItemError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function toTaskView(task: ProductBatchTaskRecord): ProductBatchTaskView {
  return {
    taskId: task.id.toString(),
    clientRequestId: task.clientRequestId,
    action: task.action,
    status: task.status,
    previewRevision: task.previewRevision,
    cancelRequestedAt: task.cancelRequestedAt?.toISOString() ?? null,
    confirmedAt: task.confirmedAt?.toISOString() ?? null,
    startedAt: task.startedAt?.toISOString() ?? null,
    finishedAt: task.finishedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    summary: summarizeStatuses(task.items.map((item) => item.status)),
    items: task.items.map((item) => {
      const before = jsonRecord(item.beforeSnapshot);
      const desired = jsonRecord(item.desiredSnapshot);
      const result = jsonRecord(item.result);
      const beforePrices = parseSkuPriceSnapshot(before?.skuPrices);
      const desiredPrices = parseSkuPriceSnapshot(desired?.skuPrices);
      const actualPrices = parseSkuPriceSnapshot(result?.actualPrices);
      const beforeInventory = parseSkuInventorySnapshot(before?.skuInventory);
      const desiredInventory = parseSkuInventorySnapshot(desired?.skuInventory);
      const actualInventory = parseSkuInventorySnapshot(result?.actualInventory);
      const beforeSkuSpec = jsonRecord(before?.skuState);
      const desiredSkuSpec =
        desired?.dimensions || desired?.items
          ? {
              dimensions: desired.dimensions ?? [],
              items: desired.items ?? [],
              fingerprint: desired.skuFingerprint ?? null,
            }
          : null;
      const actualSkuSpec = jsonRecord(result?.actualSkuState);
      const cleanupEvidence = parseCleanupEvidence(before?.cleanupEvidence);
      const beforeSourceRoutes = parseSourceBindingRoutesOrNull(before?.sourceRoutes);
      const desiredSourceRoutes = parseSourceBindingRoutesOrNull(desired?.sourceRoutes);
      const beforeStatus = stringValue(before?.status) ?? item.publishedProduct.status;
      const beforeTitle = stringValue(before?.title) ?? item.publishedProduct.title;
      return {
        itemId: item.id.toString(),
        publishedProductId: item.publishedProductId.toString(),
        title: item.publishedProduct.title,
        mainImage: item.publishedProduct.mainImage ?? item.publishedProduct.sourceProduct.mainImage,
        shopId: item.publishedProduct.shopId.toString(),
        shopName: item.publishedProduct.shop.shopName,
        platform: item.publishedProduct.shop.platform,
        platformProductId: item.publishedProduct.platformProductId,
        beforeStatus,
        desiredStatus: stringValue(desired?.status) ?? beforeStatus,
        actualStatus:
          stringValue(result?.actualStatus) ??
          stringValue(jsonRecord(result?.platformState)?.state),
        beforeTitle,
        desiredTitle: stringValue(desired?.title),
        actualTitle: stringValue(result?.actualTitle),
        beforePrice: beforePrices ? snapshotStartPrice(beforePrices) : null,
        desiredPrice: desiredPrices ? snapshotStartPrice(desiredPrices) : null,
        beforePriceRange: beforePrices ? snapshotPriceRange(beforePrices) : null,
        desiredPriceRange: desiredPrices ? snapshotPriceRange(desiredPrices) : null,
        actualPriceRange: actualPrices ? snapshotPriceRange(actualPrices) : null,
        beforeSkuSpec,
        desiredSkuSpec,
        actualSkuSpec,
        skuCount: beforePrices?.items.length ?? beforeInventory?.items.length ?? 0,
        beforeInventory,
        desiredInventory,
        actualInventory,
        beforeInventoryVersion: integerOrNull(before?.inventoryVersion),
        desiredInventoryVersion: integerOrNull(desired?.inventoryVersion),
        cleanupEvidence,
        beforeSourceProductId: stringValue(before?.sourceProductId),
        desiredSourceProductId: stringValue(desired?.sourceProductId),
        actualSourceProductId: stringValue(result?.actualSourceProductId),
        beforeSourceTitle: stringValue(before?.sourceTitle),
        desiredSourceTitle: stringValue(desired?.sourceTitle),
        sourceRouteCount: desiredSourceRoutes?.length ?? beforeSourceRoutes?.length ?? null,
        sourceCostRange: desiredSourceRoutes
          ? sourceRouteCostRange(desiredSourceRoutes)
          : beforeSourceRoutes
            ? sourceRouteCostRange(beforeSourceRoutes)
            : null,
        retryable: item.status === 'failed' && isRetryableFailedError(item.errorCode),
        status: item.status,
        attempts: item.attempts,
        maxAttempts: item.maxAttempts,
        errorCode: item.errorCode,
        errorMessage: item.errorMessage,
        result,
        startedAt: item.startedAt?.toISOString() ?? null,
        finishedAt: item.finishedAt?.toISOString() ?? null,
      };
    }),
  };
}

function summarizeStatuses(statuses: string[]): ProductBatchSummary {
  const count = (status: string) => statuses.filter((value) => value === status).length;
  const summary = {
    total: statuses.length,
    pending: count('pending'),
    running: count('running'),
    retryWait: count('retry_wait'),
    succeeded: count('succeeded'),
    failed: count('failed'),
    skipped: count('skipped'),
    cancelled: count('cancelled'),
    completed: 0,
    progressPercent: 0,
  };
  summary.completed = summary.succeeded + summary.failed + summary.skipped + summary.cancelled;
  summary.progressPercent = summary.total
    ? Math.round((summary.completed / summary.total) * 100)
    : 100;
  return summary;
}

function beforeSnapshot(record: {
  status: string;
  title: string;
  salePrice: Prisma.Decimal;
  platformProductId: string | null;
  shopId: bigint;
  mutationRevision: number;
}) {
  return {
    status: record.status,
    title: record.title,
    salePrice: Number(record.salePrice),
    platformProductId: record.platformProductId,
    shopId: record.shopId.toString(),
    mutationRevision: record.mutationRevision,
  };
}

function previewForAction(
  action: string,
  record: {
    id: bigint;
    status: string;
    title: string;
    salePrice: Prisma.Decimal;
    platformProductId: string | null;
    shopId: bigint;
    sourceProductId: bigint;
    mutationRevision: number;
    skuPriceSnapshot: Prisma.JsonValue | null;
    skuInventorySnapshot: Prisma.JsonValue | null;
    inventoryFingerprint: string | null;
    inventoryTargetFingerprint: string | null;
    inventoryVersion: number;
    inventoryTargetVersion: number;
    inventorySyncStatus: string;
    platformStatusRaw: number | null;
    platformCheckStatusRaw: number | null;
    shop: { platform: string; platformShopId: string };
    task: { skuSnapshot: Prisma.JsonValue | null };
    sourceProduct: {
      id: bigint;
      productId1688: string;
      title: string;
      availability: string;
      skuList: Prisma.JsonValue | null;
      totalStock: number;
      inventoryFingerprint: string;
      inventoryVersion: number;
    };
    sourceBindings?: Array<{
      id: bigint;
      sourceProductId: bigint;
      revision: number;
      currentSlot: number | null;
      sourceOfferId: string;
      bindingFingerprint: string;
      skuRoutes: Prisma.JsonValue;
    }>;
  },
  titleTargets: NormalizedTitleTarget[] | null,
  priceRule: NormalizedPriceRule | null,
  cleanupAssessment?: ProductBatchCleanupAssessment,
  sourceTarget?: ProductBatchResolvedSourceTarget,
  skuTarget?: ResolvedSkuEditTarget,
) {
  const before = beforeSnapshot(record);
  if (action === 'edit_sku') {
    if (!skuTarget) throw new BadRequestException('逐项 SKU 目标缺少所选商品');
    const beforeSnapshotValue = {
      ...before,
      productFingerprint: productBatchProductFingerprint(record),
      skuState: skuTarget.beforeState,
      skuFingerprint: skuTarget.beforeFingerprint,
      ruleFingerprint: skuTarget.ruleFingerprint,
      sourceProductDatabaseId: skuTarget.sourceProductId.toString(),
      sourceProductId: skuTarget.sourceOfferId,
      sourceSupplierId: skuTarget.sourceSupplierId,
      sourceOnePieceDrop: skuTarget.sourceOnePieceDrop,
      sourceFingerprint: skuTarget.sourceFingerprint,
      sourceInventoryFingerprint: skuTarget.sourceInventoryFingerprint,
      sourceInventoryVersion: skuTarget.sourceInventoryVersion,
      sourceBindingId: skuTarget.bindingId.toString(),
      sourceBindingRevision: skuTarget.bindingRevision,
      sourceBindingFingerprint: skuTarget.bindingFingerprint,
      sourceRoutesFingerprint: skuTarget.bindingRoutesFingerprint,
      skuPriceFingerprint: skuPriceFingerprint(skuTarget.beforeState),
      skuInventoryFingerprint: skuInventoryFingerprint(skuTarget.beforeState),
    };
    const desiredSnapshot = {
      status: record.status,
      categoryId: skuTarget.beforeState.categoryId,
      productType: skuTarget.beforeState.productType,
      startSaleType: skuTarget.beforeState.startSaleType,
      dimensions: skuTarget.desiredDimensions,
      items: skuTarget.desiredItems,
      skuFingerprint: skuTarget.desiredFingerprint,
      ruleFingerprint: skuTarget.ruleFingerprint,
      sourceProductDatabaseId: skuTarget.sourceProductId.toString(),
      sourceProductId: skuTarget.sourceOfferId,
      sourceSupplierId: skuTarget.sourceSupplierId,
      sourceOnePieceDrop: skuTarget.sourceOnePieceDrop,
      sourceFingerprint: skuTarget.sourceFingerprint,
      sourceInventoryFingerprint: skuTarget.sourceInventoryFingerprint,
      sourceInventoryVersion: skuTarget.sourceInventoryVersion,
      nextSourceBindingRevision: skuTarget.bindingRevision + 1,
    };
    return {
      status: 'pending' as const,
      result: undefined,
      errorCode: null,
      errorMessage: null,
      beforeSnapshot: beforeSnapshotValue,
      desiredSnapshot,
    };
  }
  if (action === 'change_source') {
    if (!sourceTarget) throw new BadRequestException('逐项目标货源缺少所选商品');
    const currentBinding = record.sourceBindings?.[0];
    if (!currentBinding) throw new BadRequestException('商品缺少当前货源绑定，不能安全换源');
    const beforeRoutes = parseSourceBindingRoutes(currentBinding.skuRoutes);
    const beforeWithSource = {
      ...before,
      sourceProductDatabaseId: record.sourceProduct.id.toString(),
      sourceProductId: record.sourceProduct.productId1688,
      sourceTitle: record.sourceProduct.title,
      sourceBindingId: currentBinding.id.toString(),
      sourceBindingRevision: currentBinding.revision,
      sourceBindingFingerprint: currentBinding.bindingFingerprint,
      sourceRoutesFingerprint: sourceBindingRoutesFingerprint(beforeRoutes),
      sourceRoutes: beforeRoutes,
    };
    const desiredSnapshot = {
      status: 'offline',
      sourceProductDatabaseId: sourceTarget.sourceProductDatabaseId.toString(),
      sourceProductId: sourceTarget.sourceOfferId,
      sourceTitle: sourceTarget.sourceTitle,
      sourceSupplierId: sourceTarget.sourceSupplierId,
      sourceOnePieceDrop: sourceTarget.sourceOnePieceDrop,
      sourceFingerprint: sourceTarget.sourceFingerprint,
      inventoryFingerprint: sourceTarget.inventoryFingerprint,
      inventoryVersion: sourceTarget.inventoryVersion,
      sourceSyncedAt: sourceTarget.syncedAt.toISOString(),
      sourceBindingRevision: sourceTarget.bindingRevision,
      sourceBindingFingerprint: sourceTarget.bindingFingerprint,
      sourceRoutesFingerprint: sourceBindingRoutesFingerprint(sourceTarget.skuRoutes),
      sourceRoutes: sourceTarget.skuRoutes,
    };
    return {
      status: 'pending' as const,
      result: undefined,
      errorCode: null,
      errorMessage: null,
      beforeSnapshot: beforeWithSource,
      desiredSnapshot,
    };
  }
  if (action === 'online') {
    const beforeInventory =
      parseSkuInventorySnapshot(record.skuInventorySnapshot) ??
      inventorySnapshotFromPublishTask(record.task.skuSnapshot, record.shop.platform);
    const desiredInventory = inventorySnapshotForProduct(record);
    const beforeWithInventory = {
      ...before,
      inventoryFingerprint: record.inventoryFingerprint,
      inventoryVersion: record.inventoryVersion,
      ...(beforeInventory ? { skuInventory: beforeInventory } : {}),
    };
    const desiredSnapshot = {
      status: 'online',
      inventoryFingerprint: record.sourceProduct.inventoryFingerprint,
      inventoryVersion: record.sourceProduct.inventoryVersion,
      ...(desiredInventory ? { skuInventory: desiredInventory } : {}),
    };
    if (record.status === 'online') {
      return {
        status: 'skipped' as const,
        result: { reason: 'already_online', actualStatus: 'online' },
        errorCode: null,
        errorMessage: null,
        beforeSnapshot: beforeWithInventory,
        desiredSnapshot,
      };
    }
    const unavailableReason = onlineUnavailableReason(record, beforeInventory, desiredInventory);
    if (unavailableReason) {
      return {
        status: 'skipped' as const,
        result: { reason: 'online_unavailable', status: record.status },
        errorCode: 'ONLINE_UNAVAILABLE',
        errorMessage: unavailableReason,
        beforeSnapshot: beforeWithInventory,
        desiredSnapshot,
      };
    }
    return {
      status: 'pending' as const,
      result: undefined,
      errorCode: null,
      errorMessage: null,
      beforeSnapshot: beforeWithInventory,
      desiredSnapshot,
    };
  }
  if (action === 'offline') {
    const status = previewOfflineStatus(record);
    return {
      ...status,
      beforeSnapshot: before,
      desiredSnapshot: { status: 'offline' },
    };
  }
  if (action === 'cleanup') {
    if (!cleanupAssessment) {
      throw new ServiceUnavailableException('滞销清理证据生成失败，请刷新后重试');
    }
    const beforeWithEvidence = {
      ...before,
      cleanupEvidence: cleanupAssessment.evidence,
    };
    const desiredSnapshot = { status: 'offline', reason: 'slow_sales_cleanup' };
    if (!cleanupAssessment.eligible) {
      return {
        status: 'skipped' as const,
        result: { reason: cleanupAssessment.code?.toLowerCase() ?? 'cleanup_ineligible' },
        errorCode: cleanupAssessment.code ?? 'CLEANUP_INELIGIBLE',
        errorMessage: cleanupAssessment.reason ?? '商品不符合滞销清理条件',
        beforeSnapshot: beforeWithEvidence,
        desiredSnapshot,
      };
    }
    return {
      status: 'pending' as const,
      result: undefined,
      errorCode: null,
      errorMessage: null,
      beforeSnapshot: beforeWithEvidence,
      desiredSnapshot,
    };
  }
  if (action === 'edit_title') {
    const target = titleTargets?.find((value) => value.publishedProductId === record.id.toString());
    if (!target) throw new BadRequestException('逐项目标标题缺少所选商品');
    const desiredSnapshot = { status: record.status, title: target.targetTitle };
    const unavailableReason = titleEditUnavailableReason(record);
    if (unavailableReason) {
      return skippedTitlePreview(
        before,
        desiredSnapshot,
        'TITLE_EDIT_UNAVAILABLE',
        unavailableReason,
      );
    }
    const complianceReason = titleComplianceReason(target.targetTitle, record.shop.platform);
    if (complianceReason) {
      return skippedTitlePreview(
        before,
        desiredSnapshot,
        'TITLE_COMPLIANCE_BLOCKED',
        complianceReason,
      );
    }
    if (record.title === target.targetTitle) {
      return {
        status: 'skipped' as const,
        result: { reason: 'title_unchanged', actualTitle: record.title },
        errorCode: null,
        errorMessage: null,
        beforeSnapshot: before,
        desiredSnapshot,
      };
    }
    return {
      status: 'pending' as const,
      result: undefined,
      errorCode: null,
      errorMessage: null,
      beforeSnapshot: before,
      desiredSnapshot,
    };
  }
  if (action === 'sync_inventory') {
    const beforeInventory =
      parseSkuInventorySnapshot(record.skuInventorySnapshot) ??
      inventorySnapshotFromPublishTask(record.task.skuSnapshot, record.shop.platform);
    const desiredInventory = inventorySnapshotForProduct(record);
    const beforeWithInventory = {
      ...before,
      inventoryFingerprint: record.inventoryFingerprint,
      inventoryVersion: record.inventoryVersion,
      ...(beforeInventory ? { skuInventory: beforeInventory } : {}),
    };
    const desiredSnapshot = {
      status: record.status,
      inventoryFingerprint: record.sourceProduct.inventoryFingerprint,
      inventoryVersion: record.sourceProduct.inventoryVersion,
      ...(desiredInventory ? { skuInventory: desiredInventory } : {}),
    };
    if (!record.platformProductId) {
      return skippedInventoryPreview(
        beforeWithInventory,
        desiredSnapshot,
        'PLATFORM_ID_MISSING',
        '商品缺少平台商品 ID，不能同步库存',
      );
    }
    if (isRawDeletedProduct(record)) {
      return skippedInventoryPreview(
        beforeWithInventory,
        desiredSnapshot,
        'PRODUCT_DELETED',
        '平台商品已删除，不能同步库存，请重新铺货',
      );
    }
    if (record.status !== 'online') {
      return skippedInventoryPreview(
        beforeWithInventory,
        desiredSnapshot,
        'PRODUCT_NOT_ONLINE',
        `商品当前状态为 ${record.status}，不能同步库存`,
      );
    }
    if (record.sourceProduct.availability !== 'available') {
      return skippedInventoryPreview(
        beforeWithInventory,
        desiredSnapshot,
        'SOURCE_INVENTORY_UNAVAILABLE',
        `1688 货源当前状态为 ${record.sourceProduct.availability}，请先核验或下架商品`,
      );
    }
    if (record.inventorySyncStatus === 'syncing') {
      return skippedInventoryPreview(
        beforeWithInventory,
        desiredSnapshot,
        'INVENTORY_SYNC_RUNNING',
        '商品库存正在由后台任务同步，请稍后再试',
      );
    }
    if (!beforeInventory) {
      return skippedInventoryPreview(
        beforeWithInventory,
        desiredSnapshot,
        'INVENTORY_SNAPSHOT_MISSING',
        '商品缺少已确认的 SKU 库存快照，不能安全同步',
      );
    }
    if (
      !desiredInventory ||
      !sameInventorySkuIds(beforeInventory, desiredInventory) ||
      !inventoryFingerprintValue(record.sourceProduct.inventoryFingerprint) ||
      record.sourceProduct.inventoryVersion <= 0
    ) {
      return skippedInventoryPreview(
        beforeWithInventory,
        desiredSnapshot,
        'SOURCE_SKU_CHANGED',
        '1688 货源 SKU 结构已变化，请先换源或下架商品',
      );
    }
    return {
      status: 'pending' as const,
      result: undefined,
      errorCode: null,
      errorMessage: null,
      beforeSnapshot: beforeWithInventory,
      desiredSnapshot,
    };
  }
  if (action !== 'edit_price' || !priceRule) {
    throw new BadRequestException('当前批量动作尚未实现');
  }
  if (!record.platformProductId) {
    return skippedPricePreview(before, record.status, 'PLATFORM_ID_MISSING', '商品缺少平台商品 ID');
  }
  if (isRawDeletedProduct(record)) {
    return skippedPricePreview(
      before,
      'rejected',
      'PRODUCT_DELETED',
      '平台商品已删除，不能改价，请重新铺货',
    );
  }
  if (record.status !== 'online') {
    return skippedPricePreview(
      before,
      record.status,
      'PRODUCT_NOT_ONLINE',
      `商品当前状态为 ${record.status}，不能改价`,
    );
  }
  const currentPrices =
    parseSkuPriceSnapshot(record.skuPriceSnapshot) ??
    priceSnapshotFromPublishTask(record.task.skuSnapshot, record.shop.platform);
  if (!currentPrices) {
    return skippedPricePreview(
      before,
      record.status,
      'PRICE_SNAPSHOT_MISSING',
      '商品缺少可核对的 SKU 价格快照，不能安全改价',
    );
  }
  const desiredPrices = desiredPriceSnapshot(record.id.toString(), currentPrices, priceRule);
  if (!desiredPrices) {
    return skippedPricePreview(
      { ...before, skuPrices: currentPrices },
      record.status,
      'PRICE_OUT_OF_RANGE',
      '调整后的 SKU 价格超出 ¥0.01～¥1,000,000.00',
    );
  }
  const beforeWithPrices = {
    ...before,
    salePrice: snapshotStartPrice(currentPrices),
    skuPrices: currentPrices,
  };
  const desiredSnapshot = {
    status: record.status,
    salePrice: snapshotStartPrice(desiredPrices),
    skuPrices: desiredPrices,
    priceRule,
  };
  if (sameSkuPrices(currentPrices, desiredPrices)) {
    return {
      status: 'skipped' as const,
      result: { reason: 'price_unchanged' },
      errorCode: null,
      errorMessage: null,
      beforeSnapshot: beforeWithPrices,
      desiredSnapshot,
    };
  }
  return {
    status: 'pending' as const,
    result: undefined,
    errorCode: null,
    errorMessage: null,
    beforeSnapshot: beforeWithPrices,
    desiredSnapshot,
  };
}

function skippedTitlePreview(
  beforeSnapshotValue: Record<string, unknown>,
  desiredSnapshotValue: Record<string, unknown>,
  errorCode: string,
  errorMessage: string,
) {
  return {
    status: 'skipped' as const,
    result: { reason: errorCode.toLowerCase() },
    errorCode,
    errorMessage,
    beforeSnapshot: beforeSnapshotValue,
    desiredSnapshot: desiredSnapshotValue,
  };
}

function skippedInventoryPreview(
  beforeSnapshotValue: Record<string, unknown>,
  desiredSnapshotValue: Record<string, unknown>,
  errorCode: string,
  errorMessage: string,
) {
  return {
    status: 'skipped' as const,
    result: { reason: errorCode.toLowerCase() },
    errorCode,
    errorMessage,
    beforeSnapshot: beforeSnapshotValue,
    desiredSnapshot: desiredSnapshotValue,
  };
}

function skippedPricePreview(
  beforeSnapshotValue: Record<string, unknown>,
  status: string,
  errorCode: string,
  errorMessage: string,
) {
  return {
    status: 'skipped' as const,
    result: { reason: errorCode.toLowerCase(), status },
    errorCode,
    errorMessage,
    beforeSnapshot: beforeSnapshotValue,
    desiredSnapshot: { status },
  };
}

function previewOfflineStatus(record: {
  status: string;
  platformProductId: string | null;
  platformStatusRaw: number | null;
  platformCheckStatusRaw: number | null;
}) {
  if (!record.platformProductId) {
    return {
      status: 'skipped' as const,
      result: { reason: 'platform_id_missing' },
      errorCode: 'PLATFORM_ID_MISSING',
      errorMessage: '商品缺少平台商品 ID，已跳过',
    };
  }
  if (isRawDeletedProduct(record)) {
    return {
      status: 'skipped' as const,
      result: { reason: 'product_deleted', actualStatus: 'deleted' },
      errorCode: 'PRODUCT_DELETED',
      errorMessage: '平台商品已删除，无需下架且不能重新上架，请重新铺货',
    };
  }
  if (record.status === 'offline') {
    return {
      status: 'skipped' as const,
      result: { reason: 'already_offline' },
      errorCode: null,
      errorMessage: null,
    };
  }
  if (record.status !== 'online') {
    return {
      status: 'skipped' as const,
      result: { reason: 'status_not_online', status: record.status },
      errorCode: 'PRODUCT_NOT_ONLINE',
      errorMessage: `商品当前状态为 ${record.status}，无需执行下架`,
    };
  }
  return {
    status: 'pending' as const,
    result: undefined,
    errorCode: null,
    errorMessage: null,
  };
}

function normalizePriceRule(
  action: string,
  ids: string[],
  value: ProductBatchPriceRuleDto | undefined,
): NormalizedPriceRule | null {
  if (action !== 'edit_price') {
    if (value) {
      const message =
        action === 'offline'
          ? '批量下架不能携带改价规则'
          : action === 'online'
            ? '批量上架不能携带改价规则'
            : action === 'sync_inventory'
              ? '库存同步不能携带改价规则'
              : '批量改标题不能携带改价规则';
      throw new BadRequestException(message);
    }
    return null;
  }
  if (!value) {
    throw new BadRequestException('批量改价必须提供价格规则');
  }
  if (value.mode === 'percentage') {
    const basisPoints = value.basisPoints;
    if (
      !value.direction ||
      !Number.isInteger(basisPoints) ||
      basisPoints! < 1 ||
      basisPoints! > 100_000
    ) {
      throw new BadRequestException('百分比改价必须提供方向和基点');
    }
    if (value.targets?.length) {
      throw new BadRequestException('百分比改价不能同时提供逐项目标价');
    }
    if (value.direction === 'decrease' && basisPoints! >= 10_000) {
      throw new BadRequestException('降价比例必须小于 100%');
    }
    return {
      mode: 'percentage',
      direction: value.direction,
      basisPoints: basisPoints!,
    };
  }
  if (value.mode !== 'targets' || !value.targets?.length) {
    throw new BadRequestException('逐项改价必须提供目标起售价');
  }
  if (value.direction || value.basisPoints !== undefined) {
    throw new BadRequestException('逐项改价不能同时提供百分比规则');
  }
  const selected = new Set(ids);
  const targetIds = new Set(value.targets.map((target) => target.publishedProductId));
  if (
    selected.size !== targetIds.size ||
    [...selected].some((id) => !targetIds.has(id)) ||
    [...targetIds].some((id) => !selected.has(id))
  ) {
    throw new BadRequestException('逐项目标价必须与所选商品完全一致');
  }
  return {
    mode: 'targets',
    targets: value.targets
      .map((target) => ({
        publishedProductId: target.publishedProductId,
        targetStartPriceCents: parsePriceCents(target.targetStartPrice),
      }))
      .sort((left, right) => left.publishedProductId.localeCompare(right.publishedProductId)),
  };
}

function normalizeTitleTargets(
  action: string,
  ids: string[],
  value: ProductBatchTitleTargetDto[] | undefined,
): NormalizedTitleTarget[] | null {
  if (action !== 'edit_title') {
    if (value) throw new BadRequestException('当前批量动作不能携带目标标题');
    return null;
  }
  if (!value?.length) throw new BadRequestException('批量改标题必须提供逐项目标标题');
  const selected = new Set(ids);
  const normalized = value.map((target) => ({
    publishedProductId: target.publishedProductId,
    expectedMutationRevision: target.expectedMutationRevision,
    targetTitle: typeof target.targetTitle === 'string' ? target.targetTitle.trim() : '',
  }));
  const targetIds = new Set(normalized.map((target) => target.publishedProductId));
  if (
    normalized.some(
      (target) =>
        !target.targetTitle ||
        [...target.targetTitle].length > 60 ||
        !Number.isInteger(target.expectedMutationRevision) ||
        target.expectedMutationRevision < 1,
    ) ||
    targetIds.size !== normalized.length ||
    selected.size !== targetIds.size ||
    [...selected].some((id) => !targetIds.has(id)) ||
    [...targetIds].some((id) => !selected.has(id))
  ) {
    throw new BadRequestException('逐项目标标题必须有效并与所选商品完全一致');
  }
  return normalized.sort((left, right) =>
    left.publishedProductId.localeCompare(right.publishedProductId),
  );
}

function normalizeSourceTargets(
  action: string,
  ids: string[],
  value: ProductBatchSourceTargetDto[] | undefined,
): NormalizedSourceTarget[] | null {
  if (action !== 'change_source') {
    if (value) throw new BadRequestException('当前批量动作不能携带目标货源');
    return null;
  }
  if (!value?.length) throw new BadRequestException('安全换源必须提供逐项目标 1688 offerId');
  const selected = new Set(ids);
  const normalized = value.map((target) => ({
    publishedProductId: target.publishedProductId,
    expectedMutationRevision: target.expectedMutationRevision,
    targetSourceProductId:
      typeof target.targetSourceProductId === 'string' ? target.targetSourceProductId.trim() : '',
  }));
  const targetIds = new Set(normalized.map((target) => target.publishedProductId));
  if (
    normalized.some(
      (target) =>
        !/^[1-9]\d{0,31}$/.test(target.targetSourceProductId) ||
        !Number.isInteger(target.expectedMutationRevision) ||
        target.expectedMutationRevision < 1,
    ) ||
    targetIds.size !== normalized.length ||
    selected.size !== targetIds.size ||
    [...selected].some((id) => !targetIds.has(id)) ||
    [...targetIds].some((id) => !selected.has(id))
  ) {
    throw new BadRequestException('逐项目标货源必须有效并与所选商品完全一致');
  }
  return normalized.sort((left, right) =>
    left.publishedProductId.localeCompare(right.publishedProductId),
  );
}

function normalizeSkuTargets(
  action: string,
  ids: string[],
  value: ProductBatchSkuTargetDto[] | undefined,
): NormalizedSkuTarget[] | null {
  if (action !== 'edit_sku') {
    if (value) throw new BadRequestException('当前批量动作不能携带目标 SKU');
    return null;
  }
  if (!value?.length) throw new BadRequestException('批量 SKU 编辑必须提供逐项目标');
  const selected = new Set(ids);
  const normalized = value.map((target) => {
    const dimensions = target.dimensions.map(normalizeSkuDimension);
    const rows = target.rows.map(normalizeSkuRow);
    return {
      publishedProductId: target.publishedProductId,
      expectedMutationRevision: target.expectedMutationRevision,
      expectedPlatformSkuFingerprint: target.expectedPlatformSkuFingerprint,
      expectedRuleFingerprint: target.expectedRuleFingerprint,
      dimensions,
      rows: rows.sort((left, right) => left.rowId.localeCompare(right.rowId)),
    };
  });
  const targetIds = new Set(normalized.map((target) => target.publishedProductId));
  if (
    normalized.some(
      (target) =>
        !Number.isInteger(target.expectedMutationRevision) ||
        target.expectedMutationRevision < 1 ||
        !/^[a-f0-9]{64}$/.test(target.expectedPlatformSkuFingerprint) ||
        !/^[a-f0-9]{64}$/.test(target.expectedRuleFingerprint) ||
        target.dimensions.length > 3 ||
        target.rows.length < 1 ||
        target.rows.length > 100 ||
        !hasValidProductSkuPropertyIdentities(target.dimensions) ||
        new Set(target.rows.map((row) => row.rowId)).size !== target.rows.length,
    ) ||
    targetIds.size !== normalized.length ||
    selected.size !== targetIds.size ||
    [...selected].some((id) => !targetIds.has(id)) ||
    [...targetIds].some((id) => !selected.has(id))
  ) {
    throw new BadRequestException('逐项目标 SKU 必须有效并与所选商品完全一致');
  }
  return normalized.sort((left, right) =>
    left.publishedProductId.localeCompare(right.publishedProductId),
  );
}

function normalizeSkuDimension(value: ProductBatchSkuDimensionDto): NormalizedSkuDimension {
  const propertyId = strictSkuText(value.propertyId, 64, 'SKU 属性 ID');
  const propertyName = strictSkuText(value.propertyName, 64, 'SKU 属性名');
  const values = value.values.map((item) => ({
    valueId: strictSkuText(item.valueId, 64, 'SKU 规格值 ID'),
    valueName: strictSkuText(item.valueName, 64, 'SKU 规格值'),
    remark: nullableSkuText(item.remark, 64, 'SKU 自定义规格值'),
  }));
  if (values.length < 1 || values.length > 100 || !hasValidSkuDimensionValues(values)) {
    throw new BadRequestException('SKU 维度规格值无效或重复');
  }
  return { propertyId, propertyName, values };
}

function hasValidSkuDimensionValues(
  values: Array<{ valueId: string; valueName: string; remark: string | null }>,
): boolean {
  const identities = new Set<string>();
  const nonCustomIds = new Set<string>();
  const nonCustomNames = new Set<string>();
  const displayNames = new Set<string>();
  for (const value of values) {
    const identity = productSkuValueIdentity(value.valueId, value.valueName, value.remark);
    const displayName = value.remark ?? value.valueName;
    if (
      identities.has(identity) ||
      displayNames.has(displayName) ||
      (value.valueId !== '0' &&
        (nonCustomIds.has(value.valueId) || nonCustomNames.has(value.valueName)))
    ) {
      return false;
    }
    identities.add(identity);
    displayNames.add(displayName);
    if (value.valueId !== '0') {
      nonCustomIds.add(value.valueId);
      nonCustomNames.add(value.valueName);
    }
  }
  return true;
}

function normalizeSkuRow(value: ProductBatchSkuRowDto): NormalizedSkuRow {
  const properties = value.properties.map((property) => ({
    propertyId: strictSkuText(property.propertyId, 64, 'SKU 属性 ID'),
    propertyName: strictSkuText(property.propertyName, 64, 'SKU 属性名'),
    valueId: strictSkuText(property.valueId, 64, 'SKU 规格值 ID'),
    valueName: strictSkuText(property.valueName, 64, 'SKU 规格值'),
    remark: nullableSkuText(property.remark, 64, 'SKU 自定义规格值'),
  }));
  if (
    properties.length > 3 ||
    !hasValidProductSkuPropertyIdentities(properties) ||
    !Number.isSafeInteger(value.priceCents) ||
    value.priceCents < 1 ||
    value.priceCents > MAX_PRICE_CENTS
  ) {
    throw new BadRequestException('目标 SKU 规格或价格无效');
  }
  return {
    rowId: strictSkuText(value.rowId, 128, 'SKU 行 ID'),
    isNew: value.isNew === true,
    platformSkuId: nullableSkuText(value.platformSkuId, 64, '平台 SKU ID'),
    platformSkuKey: nullableSkuText(value.platformSkuKey, 128, '平台 SKU key'),
    sourceSpecId: nullableSkuText(value.sourceSpecId, 128, '1688 specId'),
    properties,
    priceCents: value.priceCents,
    skuPictureUrls: [...new Set(value.skuPictureUrls ?? [])].sort(),
  };
}

function requestFingerprint(
  action: string,
  ids: string[],
  titleTargets: NormalizedTitleTarget[] | null,
  priceRule: NormalizedPriceRule | null,
  sourceTargets: NormalizedSourceTarget[] | null = null,
  skuTargets: NormalizedSkuTarget[] | null = null,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        action,
        publishedProductIds: [...ids].sort(),
        ...(titleTargets ? { titleTargets } : {}),
        ...(priceRule ? { priceRule } : {}),
        ...(sourceTargets ? { sourceTargets } : {}),
        ...(skuTargets ? { skuTargets } : {}),
      }),
    )
    .digest('hex');
}

function parsePriceCents(value: string): number {
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(value)) {
    throw new BadRequestException('目标起售价必须是最多两位小数的金额');
  }
  const [whole, fraction = ''] = value.split('.');
  const cents = Number(BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')));
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > MAX_PRICE_CENTS) {
    throw new BadRequestException('目标起售价必须在 ¥0.01～¥1,000,000.00 之间');
  }
  return cents;
}

function desiredPriceSnapshot(
  publishedProductId: string,
  current: SkuPriceSnapshot,
  rule: NormalizedPriceRule,
): SkuPriceSnapshot | null {
  let numerator: number;
  let denominator: number;
  if (rule.mode === 'percentage') {
    numerator = 10_000 + (rule.direction === 'increase' ? rule.basisPoints : -rule.basisPoints);
    denominator = 10_000;
  } else {
    const target = rule.targets.find((value) => value.publishedProductId === publishedProductId);
    if (!target) throw new BadRequestException('逐项目标价缺少所选商品');
    numerator = target.targetStartPriceCents;
    denominator = snapshotStartPriceCents(current);
  }
  const items = current.items.map((item) => ({
    sourceSkuId: item.sourceSkuId,
    priceCents: Math.round((item.priceCents * numerator) / denominator),
  }));
  if (
    items.some(
      (item) =>
        !Number.isSafeInteger(item.priceCents) ||
        item.priceCents < 1 ||
        item.priceCents > MAX_PRICE_CENTS,
    )
  ) {
    return null;
  }
  return normalizeSkuPriceSnapshot(items);
}

function priceSnapshotFromPublishTask(
  value: Prisma.JsonValue | null,
  platform: string,
): SkuPriceSnapshot | null {
  const root = jsonRecord(value);
  const entry = jsonRecord(root?.[platform]);
  if (!entry || !Array.isArray(entry.skus)) return null;
  const items = entry.skus.map((skuValue) => {
    const sku = jsonRecord(skuValue);
    const sourceSkuId = stringValue(sku?.sourceSkuId)?.trim();
    const price = typeof sku?.price === 'number' ? sku.price : Number(sku?.price);
    const priceCents = Math.round(price * 100);
    return sourceSkuId ? { sourceSkuId, priceCents } : null;
  });
  if (items.some((item) => !item)) return null;
  return normalizeSkuPriceSnapshot(items as SkuPriceItem[]);
}

function parseSkuPriceSnapshot(value: unknown): SkuPriceSnapshot | null {
  const snapshot = jsonRecord(value);
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.items)) return null;
  const items = snapshot.items.map((itemValue) => {
    const item = jsonRecord(itemValue);
    const sourceSkuId = stringValue(item?.sourceSkuId)?.trim();
    const priceCents = item?.priceCents;
    return sourceSkuId && Number.isInteger(priceCents)
      ? { sourceSkuId, priceCents: priceCents as number }
      : null;
  });
  if (items.some((item) => !item)) return null;
  return normalizeSkuPriceSnapshot(items as SkuPriceItem[]);
}

function normalizeSkuPriceSnapshot(items: SkuPriceItem[]): SkuPriceSnapshot | null {
  if (!items.length || items.length > 100) return null;
  const ids = new Set<string>();
  const normalized: SkuPriceItem[] = [];
  for (const item of items) {
    const sourceSkuId = item.sourceSkuId.trim();
    if (
      !sourceSkuId ||
      sourceSkuId.length > 128 ||
      ids.has(sourceSkuId) ||
      !Number.isSafeInteger(item.priceCents) ||
      item.priceCents < 1 ||
      item.priceCents > MAX_PRICE_CENTS
    ) {
      return null;
    }
    ids.add(sourceSkuId);
    normalized.push({ sourceSkuId, priceCents: item.priceCents });
  }
  normalized.sort((left, right) => left.sourceSkuId.localeCompare(right.sourceSkuId));
  return { version: 1, items: normalized };
}

function platformSkuPriceSnapshot(state: PlatformProductPriceState): SkuPriceSnapshot {
  const snapshot = normalizeSkuPriceSnapshot(state.items);
  if (!snapshot) {
    throw new ProductBatchItemError(
      'PRICE_READBACK_INVALID',
      '平台返回的 SKU 价格不完整，已停止改价',
      false,
    );
  }
  return snapshot;
}

function sameSkuIds(left: SkuPriceSnapshot, right: SkuPriceSnapshot): boolean {
  return (
    left.items.length === right.items.length &&
    left.items.every((item, index) => item.sourceSkuId === right.items[index]?.sourceSkuId)
  );
}

function sameSkuPrices(left: SkuPriceSnapshot, right: SkuPriceSnapshot): boolean {
  return (
    sameSkuIds(left, right) &&
    left.items.every((item, index) => item.priceCents === right.items[index]?.priceCents)
  );
}

function classifyPriceTransition(
  actual: SkuPriceSnapshot,
  before: SkuPriceSnapshot,
  desired: SkuPriceSnapshot,
): 'before' | 'partial' | 'desired' | 'drift' {
  if (!sameSkuIds(actual, before) || !sameSkuIds(actual, desired)) return 'drift';
  if (sameSkuPrices(actual, desired)) return 'desired';
  if (sameSkuPrices(actual, before)) return 'before';
  const compatible = actual.items.every((item, index) => {
    const beforePrice = before.items[index]!.priceCents;
    const desiredPrice = desired.items[index]!.priceCents;
    return item.priceCents === beforePrice || item.priceCents === desiredPrice;
  });
  return compatible ? 'partial' : 'drift';
}

function snapshotStartPriceCents(snapshot: SkuPriceSnapshot): number {
  return Math.min(...snapshot.items.map((item) => item.priceCents));
}

function snapshotStartPrice(snapshot: SkuPriceSnapshot): number {
  return snapshotStartPriceCents(snapshot) / 100;
}

function snapshotPriceRange(snapshot: SkuPriceSnapshot): [number, number] {
  const prices = snapshot.items.map((item) => item.priceCents);
  return [Math.min(...prices) / 100, Math.max(...prices) / 100];
}

function inventorySnapshotFromPublishTask(
  value: Prisma.JsonValue | null,
  platform: string,
): ProductBatchInventorySnapshot | null {
  const root = jsonRecord(value);
  const entry = jsonRecord(root?.[platform]);
  if (!entry || !Array.isArray(entry.skus)) return null;
  const items = entry.skus.map((skuValue) => {
    const sku = jsonRecord(skuValue);
    const sourceSkuId = stringValue(sku?.sourceSkuId)?.trim();
    const stock = nonNegativeIntegerOrNull(sku?.stock);
    return sourceSkuId && stock !== null ? { sourceSkuId, stock } : null;
  });
  if (items.some((item) => !item)) return null;
  return normalizeSkuInventorySnapshot(items as Array<{ sourceSkuId: string; stock: number }>);
}

function inventorySnapshotForProduct(record: {
  sourceProductId: bigint;
  task: { skuSnapshot: Prisma.JsonValue | null };
  shop: { platform: string };
  sourceProduct: { skuList: Prisma.JsonValue | null; totalStock: number };
  sourceBindings?: Array<{
    sourceProductId: bigint;
    currentSlot: number | null;
    skuRoutes: Prisma.JsonValue;
  }>;
}): ProductBatchInventorySnapshot | null {
  const bindings = record.sourceBindings ?? [];
  if (bindings.length === 0) {
    return inventorySnapshotFromSource(
      record.task.skuSnapshot,
      record.shop.platform,
      record.sourceProduct.skuList,
    );
  }
  if (
    bindings.length !== 1 ||
    bindings[0]!.currentSlot !== 1 ||
    bindings[0]!.sourceProductId !== record.sourceProductId
  ) {
    return null;
  }
  return inventorySnapshotFromBindingRoutes(
    bindings[0]!.skuRoutes,
    record.sourceProduct.skuList,
    record.sourceProduct.totalStock,
  );
}

function inventorySnapshotFromBindingRoutes(
  routesValue: unknown,
  sourceSkuListValue: Prisma.JsonValue | null,
  sourceTotalStock: number,
): ProductBatchInventorySnapshot | null {
  const routes = parseSourceBindingRoutesOrNull(routesValue);
  if (!routes?.length) return null;
  if (
    sourceSkuListValue === null ||
    (Array.isArray(sourceSkuListValue) && sourceSkuListValue.length === 0)
  ) {
    const route = routes.length === 1 ? routes[0]! : null;
    return route &&
      route.sourceSpecId === null &&
      route.sourceSpecRequired === false &&
      Number.isSafeInteger(sourceTotalStock) &&
      sourceTotalStock >= 0
      ? normalizeSkuInventorySnapshot([
          { sourceSkuId: route.platformSkuKey, stock: sourceTotalStock },
        ])
      : null;
  }
  if (!Array.isArray(sourceSkuListValue)) return null;
  const sourceStocks = new Map<string, number>();
  for (const value of sourceSkuListValue) {
    const sku = jsonRecord(value);
    const sourceSkuId = stringValue(sku?.skuId ?? sku?.id)?.trim();
    const stock = nonNegativeIntegerOrNull(sku?.stock);
    if (!sourceSkuId || stock === null || sourceStocks.has(sourceSkuId)) return null;
    sourceStocks.set(sourceSkuId, stock);
  }
  const usedSpecs = new Set<string>();
  const items = routes.map((route) => {
    const specId = route.sourceSpecId?.trim();
    if (!specId || usedSpecs.has(specId)) return null;
    const stock = sourceStocks.get(specId);
    if (stock === undefined) return null;
    usedSpecs.add(specId);
    return { sourceSkuId: route.platformSkuKey, stock };
  });
  if (items.some((item) => !item)) return null;
  return normalizeSkuInventorySnapshot(items as Array<{ sourceSkuId: string; stock: number }>);
}

function inventorySnapshotFromSource(
  publishSnapshotValue: Prisma.JsonValue | null,
  platform: string,
  sourceSkuListValue: Prisma.JsonValue | null,
): ProductBatchInventorySnapshot | null {
  const published = inventorySnapshotFromPublishTask(publishSnapshotValue, platform);
  if (!published || !Array.isArray(sourceSkuListValue)) return null;
  const sourceStocks = new Map<string, number>();
  for (const value of sourceSkuListValue) {
    const sku = jsonRecord(value);
    const sourceSkuId = stringValue(sku?.skuId ?? sku?.id)?.trim();
    const stock = nonNegativeIntegerOrNull(sku?.stock);
    if (!sourceSkuId || stock === null || sourceStocks.has(sourceSkuId)) return null;
    sourceStocks.set(sourceSkuId, stock);
  }
  const items = published.items.map((item) => {
    const stock = sourceStocks.get(item.sourceSkuId);
    return stock === undefined ? null : { sourceSkuId: item.sourceSkuId, stock };
  });
  if (items.some((item) => !item)) return null;
  return normalizeSkuInventorySnapshot(items as Array<{ sourceSkuId: string; stock: number }>);
}

function parseSkuInventorySnapshot(value: unknown): ProductBatchInventorySnapshot | null {
  const snapshot = jsonRecord(value);
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.items)) return null;
  const items = snapshot.items.map((itemValue) => {
    const item = jsonRecord(itemValue);
    const sourceSkuId = stringValue(item?.sourceSkuId)?.trim();
    const stock = nonNegativeIntegerOrNull(item?.stock);
    return sourceSkuId && stock !== null ? { sourceSkuId, stock } : null;
  });
  if (items.some((item) => !item)) return null;
  return normalizeSkuInventorySnapshot(items as Array<{ sourceSkuId: string; stock: number }>);
}

function parseSourceBindingRoutesOrNull(value: unknown): SourceBindingRoute[] | null {
  if (value === undefined || value === null) return null;
  try {
    return parseSourceBindingRoutes(value);
  } catch {
    return null;
  }
}

function parseFrozenSourceChangeTarget(value: unknown): FrozenSourceChangeTarget {
  const record = jsonRecord(value);
  const sourceProductDatabaseId = positiveIdOrNull(record?.sourceProductDatabaseId);
  const sourceOfferId = stringValue(record?.sourceProductId)?.trim() ?? '';
  const sourceTitle = stringValue(record?.sourceTitle)?.trim() ?? '';
  const sourceSupplierId = stringValue(record?.sourceSupplierId)?.trim() ?? '';
  const sourceOnePieceDrop = record?.sourceOnePieceDrop;
  const sourceFingerprint = strictFingerprintOrNull(record?.sourceFingerprint);
  const inventoryFingerprint = strictFingerprintOrNull(record?.inventoryFingerprint);
  const inventoryVersion = positiveIntegerOrNull(record?.inventoryVersion);
  const sourceSyncedAtValue = stringValue(record?.sourceSyncedAt);
  const sourceSyncedAt = sourceSyncedAtValue ? new Date(sourceSyncedAtValue) : new Date(NaN);
  const bindingFingerprint = strictFingerprintOrNull(record?.sourceBindingFingerprint);
  const bindingRevision = positiveIntegerOrNull(record?.sourceBindingRevision);
  const routesFingerprint = strictFingerprintOrNull(record?.sourceRoutesFingerprint);
  let skuRoutes: SourceBindingRoute[];
  try {
    skuRoutes = parseSourceBindingRoutes(record?.sourceRoutes);
  } catch (error) {
    throw new ProductBatchItemError(
      'SOURCE_CHANGE_PREVIEW_INVALID',
      error instanceof Error ? error.message : '目标货源 SKU 路由无效',
      false,
    );
  }
  if (
    record?.status !== 'offline' ||
    sourceProductDatabaseId === null ||
    !/^[1-9]\d{0,31}$/.test(sourceOfferId) ||
    !sourceTitle ||
    sourceTitle.length > 255 ||
    !sourceSupplierId ||
    sourceSupplierId.length > 32 ||
    sourceOnePieceDrop !== true ||
    !sourceFingerprint ||
    !inventoryFingerprint ||
    inventoryVersion === null ||
    !Number.isFinite(sourceSyncedAt.getTime()) ||
    !bindingFingerprint ||
    bindingRevision === null ||
    !routesFingerprint ||
    !skuRoutes.length ||
    sourceBindingRoutesFingerprint(skuRoutes) !== routesFingerprint
  ) {
    throw new ProductBatchItemError(
      'SOURCE_CHANGE_PREVIEW_INVALID',
      '安全换源目标快照无效，请重新生成预览',
      false,
    );
  }
  const recomputed = sourceBindingFingerprint({
    sourceProductId: sourceProductDatabaseId,
    sourceOfferId,
    sourceSupplierId,
    sourceOnePieceDrop,
    sourceFingerprint,
    inventoryFingerprint,
    inventoryVersion,
    skuRoutes,
  });
  if (recomputed !== bindingFingerprint) {
    throw new ProductBatchItemError(
      'SOURCE_CHANGE_PREVIEW_INVALID',
      '安全换源绑定指纹不一致，请重新生成预览',
      false,
    );
  }
  return {
    sourceProductDatabaseId,
    sourceOfferId,
    sourceTitle,
    sourceSupplierId,
    sourceOnePieceDrop,
    sourceFingerprint,
    inventoryFingerprint,
    inventoryVersion,
    sourceSyncedAt,
    skuRoutes,
    bindingFingerprint,
    bindingRevision,
  };
}

function sourceRouteCostRange(routes: SourceBindingRoute[]): [number, number] | null {
  if (!routes.length) return null;
  const costs = routes.map((route) => route.sourceUnitCost);
  return [Math.min(...costs), Math.max(...costs)];
}

function parseCleanupEvidence(value: unknown): ProductBatchCleanupEvidence | null {
  const record = jsonRecord(value);
  if (!record) return null;
  const policyVersion = integerOrNull(record.policyVersion);
  const windowDays = integerOrNull(record.windowDays);
  const graceDays = integerOrNull(record.graceDays);
  const daysOnline = integerOrNull(record.daysOnline);
  const validOrderCount = integerOrNull(record.validOrderCount);
  const observedAt = stringValue(record.observedAt);
  const windowStartedAt = stringValue(record.windowStartedAt);
  const lastPaidAt = record.lastPaidAt === null ? null : stringValue(record.lastPaidAt);
  const orderSyncAt = record.orderSyncAt === null ? null : stringValue(record.orderSyncAt);
  if (
    policyVersion !== CLEANUP_POLICY_VERSION ||
    windowDays !== CLEANUP_WINDOW_DAYS ||
    graceDays !== CLEANUP_GRACE_DAYS ||
    daysOnline === null ||
    daysOnline < 0 ||
    validOrderCount === null ||
    validOrderCount < 0 ||
    !observedAt ||
    !windowStartedAt ||
    !Number.isFinite(Date.parse(observedAt)) ||
    !Number.isFinite(Date.parse(windowStartedAt)) ||
    (lastPaidAt !== null && (!lastPaidAt || !Number.isFinite(Date.parse(lastPaidAt)))) ||
    (orderSyncAt !== null && (!orderSyncAt || !Number.isFinite(Date.parse(orderSyncAt))))
  ) {
    return null;
  }
  return {
    policyVersion,
    windowDays,
    graceDays,
    observedAt,
    windowStartedAt,
    daysOnline,
    validOrderCount,
    lastPaidAt,
    orderSyncAt,
  };
}

function normalizeSkuInventorySnapshot(
  items: Array<{ sourceSkuId: string; stock: number }>,
): ProductBatchInventorySnapshot | null {
  if (!items.length || items.length > 100) return null;
  const ids = new Set<string>();
  const normalized: Array<{ sourceSkuId: string; stock: number }> = [];
  let total = 0;
  for (const item of items) {
    const sourceSkuId = item.sourceSkuId.trim();
    if (
      !sourceSkuId ||
      sourceSkuId.length > 128 ||
      ids.has(sourceSkuId) ||
      !Number.isSafeInteger(item.stock) ||
      item.stock < 0 ||
      !Number.isSafeInteger(total + item.stock)
    ) {
      return null;
    }
    ids.add(sourceSkuId);
    total += item.stock;
    normalized.push({ sourceSkuId, stock: item.stock });
  }
  normalized.sort((left, right) => left.sourceSkuId.localeCompare(right.sourceSkuId));
  return { version: 1, items: normalized };
}

function platformSkuInventorySnapshot(
  state: PlatformProductInventoryState,
): ProductBatchInventorySnapshot {
  const snapshot = normalizeSkuInventorySnapshot(state.items);
  if (!snapshot) {
    throw new ProductBatchItemError(
      'INVENTORY_READBACK_INVALID',
      '平台返回的 SKU 库存不完整，已停止同步',
      false,
    );
  }
  return snapshot;
}

function sameInventorySkuIds(
  left: ProductBatchInventorySnapshot,
  right: ProductBatchInventorySnapshot,
): boolean {
  return (
    left.items.length === right.items.length &&
    left.items.every((item, index) => item.sourceSkuId === right.items[index]?.sourceSkuId)
  );
}

function sameSkuInventory(
  left: ProductBatchInventorySnapshot,
  right: ProductBatchInventorySnapshot,
): boolean {
  return (
    sameInventorySkuIds(left, right) &&
    left.items.every((item, index) => item.stock === right.items[index]?.stock)
  );
}

function classifyInventoryTransition(
  actual: ProductBatchInventorySnapshot,
  before: ProductBatchInventorySnapshot,
  desired: ProductBatchInventorySnapshot,
): 'before' | 'partial' | 'desired' | 'drift' {
  if (!sameInventorySkuIds(actual, before) || !sameInventorySkuIds(actual, desired)) return 'drift';
  if (sameSkuInventory(actual, desired)) return 'desired';
  if (sameSkuInventory(actual, before)) return 'before';
  const compatible = actual.items.every((item, index) => {
    const beforeStock = before.items[index]!.stock;
    const desiredStock = desired.items[index]!.stock;
    return item.stock === beforeStock || item.stock === desiredStock;
  });
  return compatible ? 'partial' : 'drift';
}

function pendingInventoryItems(
  actual: ProductBatchInventorySnapshot,
  desired: ProductBatchInventorySnapshot,
): Array<{ sourceSkuId: string; stock: number }> {
  if (!sameInventorySkuIds(actual, desired)) {
    throw new ProductBatchItemError(
      'INVENTORY_SNAPSHOT_INVALID',
      '平台与目标 SKU 集合不一致，已停止库存同步',
      false,
    );
  }
  return desired.items.filter((item, index) => item.stock !== actual.items[index]?.stock);
}

function inventoryTotalStock(snapshot: ProductBatchInventorySnapshot): number {
  return snapshot.items.reduce((total, item) => total + item.stock, 0);
}

function sourceBindingRouteCountForCandidate(
  bindings: Array<{ skuRoutes: Prisma.JsonValue }> | undefined,
): number {
  if (bindings?.length !== 1) return 0;
  try {
    return parseSourceBindingRoutes(bindings[0]!.skuRoutes).length;
  } catch (error) {
    if (error instanceof SourceBindingValidationError) return 0;
    throw error;
  }
}

function sourceChangeUnavailableReason(
  record: {
    platformProductId: string | null;
    status: string;
    platformStatusRaw: number | null;
    platformCheckStatusRaw: number | null;
    sourceProductId: bigint;
    inventorySyncStatus: string;
    shop: { platform: string; platformShopId: string };
    sourceProduct: { productId1688: string };
    sourceBindings?: Array<{
      sourceProductId: bigint;
      revision: number;
      currentSlot: number | null;
      sourceOfferId: string;
      bindingFingerprint: string;
      skuRoutes: Prisma.JsonValue;
    }>;
  },
  blockedByUnresolvedMutation: boolean,
  orderSyncReason: string | null,
): string | null {
  if (!record.platformProductId) return '商品缺少平台商品 ID';
  if (isRawDeletedProduct(record)) return '平台商品已删除，不能换源，请重新铺货';
  if (record.status !== 'offline') return '必须先安全下架商品，才能切换采购货源';
  if (!isDemoShop(record.shop) && record.shop.platform !== 'douyin') {
    return '当前仅支持抖店商品离线安全换源';
  }
  if (blockedByUnresolvedMutation) return '商品存在结果待核验的平台写入，请先完成核验';
  if (record.inventorySyncStatus === 'syncing') return '商品库存正在同步，请稍后再换源';
  if (orderSyncReason) return orderSyncReason;
  const bindings = record.sourceBindings ?? [];
  if (bindings.length !== 1) return '商品当前货源绑定缺失或重复，不能安全换源';
  const binding = bindings[0]!;
  if (
    binding.currentSlot !== 1 ||
    binding.sourceProductId !== record.sourceProductId ||
    binding.sourceOfferId !== record.sourceProduct.productId1688 ||
    !Number.isInteger(binding.revision) ||
    binding.revision < 1 ||
    !/^[a-f0-9]{64}$/.test(binding.bindingFingerprint)
  ) {
    return '商品当前货源绑定与商品指针不一致，不能安全换源';
  }
  try {
    if (parseSourceBindingRoutes(binding.skuRoutes).length === 0) {
      return '商品当前货源缺少 SKU 路由，不能安全换源';
    }
  } catch (error) {
    if (error instanceof SourceBindingValidationError) {
      return `商品当前货源 SKU 路由无效：${error.message}`;
    }
    throw error;
  }
  return null;
}

function buildSourceChangeRoutes(
  currentRoutesValue: unknown,
  targetSuggestion: SkuSuggestion,
  targetSkuList: unknown,
): SourceBindingRoute[] {
  const currentRoutes = parseSourceBindingRoutes(currentRoutesValue);
  if (!currentRoutes.length) throw new BadRequestException('商品当前货源缺少 SKU 路由');
  if (
    targetSuggestion.warnings.some((warning) =>
      /(格式无效|重复|超过|缺少规格值|已不存在)/.test(warning),
    )
  ) {
    throw new BadRequestException('目标 1688 货源 SKU 数据不完整，请重新采集后再换源');
  }
  if (targetSuggestion.skus.length !== currentRoutes.length) {
    throw new BadRequestException('目标货源 SKU 数量与平台商品不一致，不能安全换源');
  }
  const targetByValues = new Map<string, SkuSuggestion['skus'][number]>();
  for (const sku of targetSuggestion.skus) {
    const key = JSON.stringify(sku.values);
    if (targetByValues.has(key)) {
      throw new BadRequestException('目标货源包含重复的 SKU 规格组合，不能安全换源');
    }
    targetByValues.set(key, sku);
  }
  const hasSourceSpecs = Array.isArray(targetSkuList) && targetSkuList.length > 0;
  const routes = currentRoutes.map((current) => {
    const target = targetByValues.get(JSON.stringify(current.values));
    if (!target) throw new BadRequestException('目标货源 SKU 规格与平台商品不能一一对应');
    return {
      platformSkuKey: current.platformSkuKey,
      sourceSpecId: hasSourceSpecs ? target.sourceSkuId : null,
      sourceSpecRequired: hasSourceSpecs,
      sourceUnitCost: target.costPrice,
      values: current.values,
    };
  });
  return parseSourceBindingRoutes(routes);
}

function inventorySyncUnavailableReason(
  record: {
    platformProductId: string | null;
    status: string;
    platformStatusRaw: number | null;
    platformCheckStatusRaw: number | null;
    inventorySyncStatus: string;
    sourceProduct: { availability: string; inventoryFingerprint: string; inventoryVersion: number };
  },
  before: ProductBatchInventorySnapshot | null,
  desired: ProductBatchInventorySnapshot | null,
): string | null {
  if (!record.platformProductId) return '商品缺少平台商品 ID';
  if (isRawDeletedProduct(record)) return '平台商品已删除，不能同步库存，请重新铺货';
  if (record.status !== 'online') return '只有在线商品可以同步库存';
  if (record.sourceProduct.availability !== 'available') {
    return '1688 货源缺货、下架或库存待核验';
  }
  if (record.inventorySyncStatus === 'syncing') return '商品库存正在由后台任务同步';
  if (!before) return '缺少已确认的 SKU 库存快照';
  if (
    !desired ||
    !sameInventorySkuIds(before, desired) ||
    !inventoryFingerprintValue(record.sourceProduct.inventoryFingerprint) ||
    record.sourceProduct.inventoryVersion <= 0
  ) {
    return '1688 货源 SKU 结构已变化';
  }
  return null;
}

function onlineUnavailableReason(
  record: {
    platformProductId: string | null;
    status: string;
    platformStatusRaw: number | null;
    platformCheckStatusRaw: number | null;
    inventorySyncStatus: string;
    inventoryFingerprint: string | null;
    inventoryTargetFingerprint: string | null;
    inventoryVersion: number;
    inventoryTargetVersion: number;
    shop: { platform: string; platformShopId: string };
    sourceProduct: { availability: string; inventoryFingerprint: string; inventoryVersion: number };
  },
  before: ProductBatchInventorySnapshot | null,
  desired: ProductBatchInventorySnapshot | null,
  unresolvedTitleResult = false,
  unresolvedOnlineResult = false,
  unresolvedSkuResult = false,
): string | null {
  if (!record.platformProductId) return '商品缺少平台商品 ID';
  if (isRawDeletedProduct(record)) return '平台商品已删除，不能重新上架，请重新铺货';
  if (unresolvedSkuResult) return '存在结果待核验的 SKU 写入，请先在原批量任务核验';
  if (unresolvedOnlineResult) return '存在结果待核验的上架操作，请先在原批量任务核验';
  if (unresolvedTitleResult) return '存在结果待核验的标题更新，请先在原批量任务核验';
  if (record.status !== 'offline') return '只有已下架商品可以重新上架';
  if (!isDemoShop(record.shop) && record.shop.platform !== 'douyin') {
    return '当前仅支持抖店商品批量上架';
  }
  if (record.sourceProduct.availability !== 'available') {
    return '1688 货源缺货、下架或库存待核验';
  }
  if (record.inventorySyncStatus === 'syncing') return '商品库存正在由后台任务同步';
  const fingerprint = inventoryFingerprintValue(record.sourceProduct.inventoryFingerprint);
  if (!fingerprint || record.sourceProduct.inventoryVersion <= 0) return '1688 库存版本无效';
  if (!before || !desired || !sameInventorySkuIds(before, desired)) {
    return '缺少可核对的 SKU 库存快照或 SKU 结构已变化';
  }
  if (inventoryTotalStock(desired) <= 0) return '1688 货源当前没有可售库存';
  return null;
}

function titleEditUnavailableReason(
  record: {
    platformProductId: string | null;
    status: string;
    platformStatusRaw: number | null;
    platformCheckStatusRaw: number | null;
    shop: { platform: string; platformShopId: string };
  },
  unresolvedTitleResult = false,
  unresolvedSkuResult = false,
): string | null {
  if (!record.platformProductId) return '商品缺少平台商品 ID';
  if (isRawDeletedProduct(record)) return '平台商品已删除，不能改标题，请重新铺货';
  if (unresolvedTitleResult) return '存在结果待核验的标题更新，请先在原批量任务核验';
  if (unresolvedSkuResult) return '存在结果待核验的 SKU 写入，请先在原批量任务核验';
  if (record.status !== 'online' && record.status !== 'offline') {
    return '只有已发布的在线或下架商品可以改标题';
  }
  if (!isDemoShop(record.shop) && record.shop.platform !== 'douyin') {
    return '当前仅支持抖店商品批量改标题';
  }
  return null;
}

function titleComplianceReason(title: string, platform: string): string | null {
  if (/\r|\n/.test(title)) return '标题不能包含换行符';
  if (platform === 'douyin') {
    const units = [...title].reduce(
      (total, character) => total + (/^[\x00-\x7f]$/.test(character) ? 1 : 2),
      0,
    );
    if (units < 16) return '抖店标题至少需要 8 个汉字（16 个字符）';
    if (units > 60) return '抖店标题最多允许 30 个汉字（60 个字符）';
  }
  return validateTitleForPlatform(title, platform as PlatformType);
}

function batchInventoryIdempotencyKey(
  itemId: bigint,
  version: number,
  fingerprint: string,
  items: Array<{ sourceSkuId: string; stock: number }>,
): string {
  const remainingFingerprint = createHash('sha256')
    .update(JSON.stringify(items))
    .digest('hex')
    .slice(0, 16);
  return `batch-inventory-${itemId.toString()}-v${version}-${fingerprint.slice(0, 24)}-${remainingFingerprint}`;
}

function batchOnlineInventoryIdempotencyKey(
  itemId: bigint,
  version: number,
  fingerprint: string,
  items: Array<{ sourceSkuId: string; stock: number }>,
): string {
  const remainingFingerprint = createHash('sha256')
    .update(JSON.stringify(items))
    .digest('hex')
    .slice(0, 16);
  return `batch-online-${itemId.toString()}-v${version}-${fingerprint.slice(0, 24)}-${remainingFingerprint}`;
}

function inventoryFingerprintValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const fingerprint = value.trim();
  return fingerprint && fingerprint.length <= 64 ? fingerprint : null;
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveIntegerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function positiveIdOrNull(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value)) return null;
  try {
    const id = BigInt(value);
    return id <= 9_223_372_036_854_775_807n ? id : null;
  } catch {
    return null;
  }
}

function strictFingerprintOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const fingerprint = value.trim();
  return fingerprint.length > 0 && fingerprint.length <= 64 && /^[a-zA-Z0-9:_-]+$/.test(fingerprint)
    ? fingerprint
    : null;
}

function onlineBaseMutationRevision(
  item: Pick<ProductBatchItem, 'expectedMutationRevision' | 'result'>,
): number {
  const quarantineRevision = positiveIntegerOrNull(jsonRecord(item.result)?.quarantineRevision);
  return quarantineRevision && quarantineRevision >= item.expectedMutationRevision
    ? quarantineRevision
    : item.expectedMutationRevision;
}

function parseFrozenSkuEditTarget(item: ProductBatchExecutionRecord): FrozenSkuEditTarget {
  const before = jsonRecord(item.beforeSnapshot);
  const desired = jsonRecord(item.desiredSnapshot);
  const beforeState = parseStoredProductSkuState(before?.skuState);
  const beforeFingerprint = strictFingerprintOrNull(before?.skuFingerprint);
  const ruleFingerprint = strictFingerprintOrNull(before?.ruleFingerprint);
  const desiredFingerprint = strictFingerprintOrNull(desired?.skuFingerprint);
  const bindingId = positiveIdOrNull(before?.sourceBindingId);
  const bindingRevision = positiveIntegerOrNull(before?.sourceBindingRevision);
  const bindingFingerprint = strictFingerprintOrNull(before?.sourceBindingFingerprint);
  const bindingRoutesFingerprint = strictFingerprintOrNull(before?.sourceRoutesFingerprint);
  const sourceProductId = positiveIdOrNull(before?.sourceProductDatabaseId);
  const sourceOfferId = stringValue(before?.sourceProductId)?.trim();
  const sourceSupplierId = stringValue(before?.sourceSupplierId)?.trim();
  const sourceOnePieceDrop = before?.sourceOnePieceDrop;
  const sourceFingerprint = strictFingerprintOrNull(before?.sourceFingerprint);
  const sourceInventoryFingerprint = strictFingerprintOrNull(before?.sourceInventoryFingerprint);
  const sourceInventoryVersion = positiveIntegerOrNull(before?.sourceInventoryVersion);
  const nextBindingRevision = positiveIntegerOrNull(desired?.nextSourceBindingRevision);
  const desiredDimensions = parseFrozenSkuDimensions(desired?.dimensions);
  const desiredItems = parseFrozenSkuItems(desired?.items);
  if (
    !beforeState ||
    !beforeFingerprint ||
    productSkuFingerprint(beforeState) !== beforeFingerprint ||
    !ruleFingerprint ||
    !desiredFingerprint ||
    bindingId === null ||
    bindingRevision === null ||
    !bindingFingerprint ||
    !bindingRoutesFingerprint ||
    sourceProductId === null ||
    !sourceOfferId ||
    !sourceSupplierId ||
    sourceSupplierId.length > 32 ||
    sourceOnePieceDrop !== true ||
    desired?.sourceProductId !== sourceOfferId ||
    desired?.sourceSupplierId !== sourceSupplierId ||
    desired?.sourceOnePieceDrop !== true ||
    !sourceFingerprint ||
    !sourceInventoryFingerprint ||
    sourceInventoryVersion === null ||
    nextBindingRevision !== bindingRevision + 1 ||
    !desiredDimensions ||
    !desiredItems ||
    skuEditTargetFingerprint({
      categoryId: beforeState.categoryId,
      productType: beforeState.productType,
      startSaleType: beforeState.startSaleType,
      dimensions: desiredDimensions,
      items: desiredItems,
    }) !== desiredFingerprint
  ) {
    throw new ProductBatchItemError(
      'SKU_SNAPSHOT_INVALID',
      'SKU 编辑快照不完整或已损坏，请重新生成预览',
      false,
    );
  }
  return {
    beforeState,
    beforeFingerprint,
    ruleFingerprint,
    desiredDimensions,
    desiredItems,
    desiredFingerprint,
    bindingId,
    bindingRevision,
    bindingFingerprint,
    bindingRoutesFingerprint,
    sourceProductId,
    sourceOfferId,
    sourceSupplierId,
    sourceOnePieceDrop,
    sourceFingerprint,
    sourceInventoryFingerprint,
    sourceInventoryVersion,
    nextBindingRevision,
  };
}

function parseFrozenSkuDimensions(value: unknown): NormalizedSkuDimension[] | null {
  if (!Array.isArray(value) || value.length > 3) return null;
  try {
    const dimensions = value.map((dimensionValue) => {
      const dimension = jsonRecord(dimensionValue);
      if (!dimension || !Array.isArray(dimension.values)) throw new Error('invalid');
      return normalizeSkuDimension({
        propertyId: String(dimension.propertyId ?? ''),
        propertyName: String(dimension.propertyName ?? ''),
        values: dimension.values.map((valueEntry) => {
          const entry = jsonRecord(valueEntry);
          if (!entry) throw new Error('invalid');
          return {
            valueId: String(entry.valueId ?? ''),
            valueName: String(entry.valueName ?? ''),
            ...(entry.remark === null || entry.remark === undefined
              ? {}
              : { remark: String(entry.remark) }),
          };
        }),
      });
    });
    return hasValidProductSkuPropertyIdentities(dimensions) ? dimensions : null;
  } catch {
    return null;
  }
}

function parseFrozenSkuItems(value: unknown): ResolvedSkuEditTarget['desiredItems'] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) return null;
  try {
    const items = value.map((itemValue) => {
      const item = jsonRecord(itemValue);
      if (!item || !Array.isArray(item.properties)) throw new Error('invalid');
      const properties = item.properties.map((propertyValue) => {
        const property = jsonRecord(propertyValue);
        if (!property) throw new Error('invalid');
        return {
          propertyId: strictSkuText(property.propertyId, 64, 'SKU 属性 ID'),
          propertyName: strictSkuText(property.propertyName, 64, 'SKU 属性名'),
          valueId: strictSkuText(property.valueId, 64, 'SKU 规格值 ID'),
          valueName: strictSkuText(property.valueName, 64, 'SKU 规格值'),
          remark: nullableSkuText(property.remark, 64, 'SKU 自定义规格值'),
        };
      });
      const sourceUnitCost = Number(item.sourceUnitCost);
      const priceCents = Number(item.priceCents);
      const stock = Number(item.stock);
      const stepStock = Number(item.stepStock);
      const skuType = Number(item.skuType);
      if (
        properties.length > 3 ||
        !hasValidProductSkuPropertyIdentities(properties) ||
        !Number.isFinite(sourceUnitCost) ||
        sourceUnitCost <= 0 ||
        Math.abs(sourceUnitCost * 100 - Math.round(sourceUnitCost * 100)) > 1e-7 ||
        !Number.isSafeInteger(priceCents) ||
        priceCents < 1 ||
        !Number.isSafeInteger(stock) ||
        stock < 0 ||
        !Number.isSafeInteger(stepStock) ||
        stepStock < 0 ||
        (skuType !== 0 && skuType !== 1 && skuType !== 10) ||
        typeof item.skuStatus !== 'boolean' ||
        !Array.isArray(item.barcodes) ||
        !Array.isArray(item.skuPictureUrls)
      ) {
        throw new Error('invalid');
      }
      const platformSkuId = nullableSkuText(item.platformSkuId, 64, '平台 SKU ID');
      return {
        ...(platformSkuId ? { platformSkuId } : {}),
        platformSkuKey: strictSkuText(item.platformSkuKey, 128, '平台 SKU key'),
        sourceSpecId: nullableSkuText(item.sourceSpecId, 128, '1688 specId'),
        sourceUnitCost,
        properties,
        priceCents,
        stock,
        skuStatus: item.skuStatus,
        skuType: skuType as 0 | 1 | 10,
        code: nullableSkuText(item.code, 128, '平台 SKU 编码'),
        supplierId: nullableSkuText(item.supplierId, 128, '平台 SKU 供应商 ID'),
        stepStock,
        barcodes: item.barcodes.map((barcode) => strictSkuText(barcode, 128, 'SKU 条码')).sort(),
        skuPictureUrls: item.skuPictureUrls
          .map((url) => strictSkuText(url, 512, 'SKU 图片'))
          .sort(),
      };
    });
    if (
      new Set(items.map((item) => item.platformSkuKey)).size !== items.length ||
      new Set(items.map((item) => item.sourceSpecId)).size !== items.length
    ) {
      return null;
    }
    return items.sort((left, right) => left.platformSkuKey.localeCompare(right.platformSkuKey));
  } catch {
    return null;
  }
}

function matchesSkuEditTarget(
  stateValue: PlatformProductSkuState,
  target: Pick<
    FrozenSkuEditTarget,
    'beforeState' | 'desiredDimensions' | 'desiredItems' | 'desiredFingerprint'
  >,
): boolean {
  let state: StoredProductSkuState;
  try {
    state = normalizeProductSkuState(stateValue);
  } catch {
    return false;
  }
  if (
    state.categoryId !== target.beforeState.categoryId ||
    state.productType !== target.beforeState.productType ||
    state.startSaleType !== target.beforeState.startSaleType ||
    state.items.length !== target.desiredItems.length ||
    (state.state !== 'offline' && state.state !== 'draft')
  ) {
    return false;
  }
  const actualByKey = new Map(state.items.map((item) => [item.platformSkuKey, item] as const));
  return target.desiredItems.every((desired) => {
    const actual = actualByKey.get(desired.platformSkuKey);
    if (!actual || (desired.platformSkuId && actual.platformSkuId !== desired.platformSkuId)) {
      return false;
    }
    return (
      JSON.stringify(actual.properties) === JSON.stringify(desired.properties) &&
      actual.priceCents === desired.priceCents &&
      actual.stock === desired.stock &&
      actual.skuStatus === desired.skuStatus &&
      actual.skuType === desired.skuType &&
      actual.code === desired.code &&
      actual.supplierId === desired.supplierId &&
      actual.stepStock === desired.stepStock &&
      sameStringSet(actual.barcodes, desired.barcodes) &&
      sameStringSet(actual.skuPictureUrls, desired.skuPictureUrls)
    );
  });
}

function validateSkuTargetAgainstRules(
  target: NormalizedSkuTarget,
  rules: PlatformProductSkuRules,
): void {
  if (rules.unsupportedReasons.length) {
    throw new BadRequestException(
      `当前平台 SKU 规则暂不支持：${rules.unsupportedReasons.join('；')}`,
    );
  }
  if (
    target.dimensions.length > rules.maxDimensions ||
    target.rows.length > rules.maxCombinations
  ) {
    throw new BadRequestException('目标 SKU 维度或组合数量超过平台限制');
  }
  const ruleByIdentity = new Map(
    rules.dimensions.map((dimension) => [
      productSkuPropertyIdentity(dimension.propertyId, dimension.propertyName),
      dimension,
    ]),
  );
  const nonCustomRuleById = new Map(
    rules.dimensions
      .filter((dimension) => dimension.propertyId !== '0')
      .map((dimension) => [dimension.propertyId, dimension]),
  );
  const selectedIdentities = new Set(
    target.dimensions.map((dimension) =>
      productSkuPropertyIdentity(dimension.propertyId, dimension.propertyName),
    ),
  );
  for (const required of rules.dimensions.filter((dimension) => dimension.required)) {
    if (
      !selectedIdentities.has(
        productSkuPropertyIdentity(required.propertyId, required.propertyName),
      )
    ) {
      throw new BadRequestException(`缺少平台必填 SKU 维度：${required.propertyName}`);
    }
  }
  if (!rules.supportsDimensionReordering) {
    const expectedOrder = rules.dimensions
      .filter((dimension) =>
        selectedIdentities.has(
          productSkuPropertyIdentity(dimension.propertyId, dimension.propertyName),
        ),
      )
      .map((dimension) => productSkuPropertyIdentity(dimension.propertyId, dimension.propertyName));
    const selectedKnownOrder = target.dimensions
      .filter((dimension) =>
        ruleByIdentity.has(
          productSkuPropertyIdentity(dimension.propertyId, dimension.propertyName),
        ),
      )
      .map((dimension) => productSkuPropertyIdentity(dimension.propertyId, dimension.propertyName));
    if (JSON.stringify(expectedOrder) !== JSON.stringify(selectedKnownOrder)) {
      throw new BadRequestException('平台不允许调整 SKU 维度顺序');
    }
  }
  for (const dimension of target.dimensions) {
    const identity = productSkuPropertyIdentity(dimension.propertyId, dimension.propertyName);
    const rule = ruleByIdentity.get(identity);
    const officialRule =
      dimension.propertyId === '0' ? undefined : nonCustomRuleById.get(dimension.propertyId);
    if (!rule && officialRule) {
      throw new BadRequestException(`SKU 维度 ${dimension.propertyId} 名称与平台规则不一致`);
    }
    if (!rule && (dimension.propertyId !== '0' || !rules.supportsCustomDimensions)) {
      throw new BadRequestException(`平台不支持自定义 SKU 维度：${dimension.propertyName}`);
    }
    if (rule?.unsupportedReasons.length) {
      throw new BadRequestException(
        `SKU 维度 ${dimension.propertyName} 暂不支持：${rule.unsupportedReasons.join('；')}`,
      );
    }
    if (dimension.values.length > rules.maxValuesPerDimension) {
      throw new BadRequestException(`SKU 维度 ${dimension.propertyName} 的规格值过多`);
    }
    const officialValuesByIdentity = new Map(
      (rule?.values ?? []).map((value) => [
        productSkuRuleValueIdentity(value.valueId, value.valueName),
        value,
      ]),
    );
    const officialNonCustomValuesById = new Map(
      (rule?.values ?? [])
        .filter((value) => value.valueId !== '0')
        .map((value) => [value.valueId, value]),
    );
    for (const value of dimension.values) {
      const officialValue = officialValuesByIdentity.get(
        productSkuRuleValueIdentity(value.valueId, value.valueName),
      );
      const officialValueById =
        value.valueId === '0' ? undefined : officialNonCustomValuesById.get(value.valueId);
      if (!officialValue && officialValueById) {
        throw new BadRequestException(`SKU 规格值 ${value.valueId} 名称与平台规则不一致`);
      }
      if (!officialValue && rule && !rule.supportsCustomValues) {
        throw new BadRequestException(`平台不支持自定义规格值：${value.valueName}`);
      }
      if (value.remark && rule && !rule.supportsRemark) {
        throw new BadRequestException(`SKU 维度 ${dimension.propertyName} 不支持自定义备注`);
      }
    }
  }
  const dimensionByIdentity = new Map(
    target.dimensions.map((dimension) => [
      productSkuPropertyIdentity(dimension.propertyId, dimension.propertyName),
      dimension,
    ]),
  );
  const combinations = new Set<string>();
  for (const row of target.rows) {
    if (row.properties.length !== target.dimensions.length) {
      throw new BadRequestException('每个目标 SKU 必须完整填写全部规格维度');
    }
    const propertyIdentities = row.properties.map((property) =>
      productSkuPropertyIdentity(property.propertyId, property.propertyName),
    );
    if (
      JSON.stringify(propertyIdentities) !==
      JSON.stringify(
        target.dimensions.map((item) =>
          productSkuPropertyIdentity(item.propertyId, item.propertyName),
        ),
      )
    ) {
      throw new BadRequestException('目标 SKU 属性顺序必须与维度顺序一致');
    }
    for (const property of row.properties) {
      const dimension = dimensionByIdentity.get(
        productSkuPropertyIdentity(property.propertyId, property.propertyName),
      );
      if (
        !dimension ||
        !dimension.values.some(
          (value) =>
            value.valueId === property.valueId &&
            value.valueName === property.valueName &&
            value.remark === property.remark,
        )
      ) {
        throw new BadRequestException('目标 SKU 包含未在维度中声明的规格值');
      }
    }
    const combination = JSON.stringify(
      row.properties.map((property) => [
        property.propertyId,
        property.propertyName,
        property.valueId,
        property.valueName,
        property.remark,
      ]),
    );
    if (combinations.has(combination)) throw new BadRequestException('目标 SKU 规格组合不能重复');
    combinations.add(combination);
    if (rules.allSkuPicturesRequired && row.isNew && row.skuPictureUrls.length === 0) {
      throw new BadRequestException('平台要求每个新增 SKU 提供规格图片');
    }
  }
}

function skuEditTargetFingerprint(value: {
  categoryId: string;
  productType: number;
  startSaleType: 0 | 1;
  dimensions: NormalizedSkuDimension[];
  items: ResolvedSkuEditTarget['desiredItems'];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        categoryId: value.categoryId,
        productType: value.productType,
        startSaleType: value.startSaleType,
        dimensions: value.dimensions,
        items: [...value.items].sort((left, right) =>
          left.platformSkuKey.localeCompare(right.platformSkuKey),
        ),
      }),
    )
    .digest('hex');
}

function generatedPlatformSkuKey(
  clientRequestId: string,
  publishedProductId: string,
  rowId: string,
): string {
  const digest = createHash('sha256')
    .update(`${clientRequestId}:${publishedProductId}:${rowId}`)
    .digest('hex');
  return `supplier-${digest.slice(0, 48)}`;
}

function sourceSkuStock(
  sku: SkuSuggestion['skus'][number],
  sourceSkuList: unknown,
  sourceTotalStock: number,
): number | null {
  if (sku.sourceSkuId !== 'default') return sku.stock;
  if (sourceSkuList !== null && !(Array.isArray(sourceSkuList) && sourceSkuList.length === 0)) {
    return null;
  }
  return Number.isSafeInteger(sourceTotalStock) && sourceTotalStock >= 0 ? sourceTotalStock : null;
}

function currentSourceBindingForSkuEdit<T extends { currentSlot?: number | null }>(
  bindings: T[] | undefined,
): T | null {
  if (!bindings || bindings.length !== 1 || bindings[0]?.currentSlot !== 1) return null;
  return bindings[0];
}

function productBatchProductFingerprint(record: {
  status: string;
  title: string;
  platformProductId: string | null;
  shopId: bigint;
  sourceProductId: bigint;
  mutationRevision: number;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        status: record.status,
        title: record.title,
        platformProductId: record.platformProductId,
        shopId: record.shopId.toString(),
        sourceProductId: record.sourceProductId.toString(),
        mutationRevision: record.mutationRevision,
      }),
    )
    .digest('hex');
}

function skuPriceFingerprint(state: PlatformProductSkuState): string {
  return createHash('sha256')
    .update(JSON.stringify(skuPriceSnapshot(state)))
    .digest('hex');
}

function skuInventoryFingerprint(state: PlatformProductSkuState): string {
  return createHash('sha256')
    .update(JSON.stringify(skuInventorySnapshot(state)))
    .digest('hex');
}

function skuVerificationWindowElapsed(result: Prisma.JsonValue | null): boolean {
  const startedAt = stringValue(jsonRecord(result)?.skuWriteStartedAt);
  if (!startedAt) return false;
  const timestamp = Date.parse(startedAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp >= STALE_ITEM_MS;
}

function localStatusFromSkuState(
  state: PlatformProductSkuState,
  fallback: string,
): 'online' | 'offline' | 'draft' | 'rejected' {
  if (state.state === 'online') return 'online';
  if (state.state === 'offline') return 'offline';
  if (
    state.state === 'draft' ||
    state.state === 'reviewing' ||
    state.state === 'approved_pending_online'
  ) {
    return 'draft';
  }
  if (state.state === 'deleted' || state.state === 'rejected' || state.state === 'blocked') {
    return 'rejected';
  }
  return fallback === 'offline' || fallback === 'draft' || fallback === 'rejected'
    ? fallback
    : 'online';
}

function skuEditUnavailableReason(
  record: {
    platformProductId: string | null;
    platformStatusRaw: number | null;
    status: string;
    skuSpecSnapshot: Prisma.JsonValue | null;
    skuSpecFingerprint: string | null;
    skuSpecSyncedAt: Date | null;
    inventorySyncStatus: string;
    sourceProductId: bigint;
    shop: { platform: string; platformShopId: string };
    sourceBindings?: Array<{ currentSlot: number | null; sourceProductId: bigint }>;
  },
  unresolvedPlatformMutation: boolean,
  enabled: boolean,
): string | null {
  if (!enabled) return 'SKU 编辑功能尚未启用';
  if (!record.platformProductId) return '商品缺少平台商品 ID';
  if (record.platformStatusRaw === 2) return '平台商品已删除，不能编辑 SKU';
  if (record.status !== 'offline' && record.status !== 'draft') {
    return '必须先下架商品，才能编辑 SKU';
  }
  if (unresolvedPlatformMutation) {
    return '商品存在结果待核验的平台写入，请先在原批量任务完成核验';
  }
  if (record.inventorySyncStatus === 'syncing') return '商品库存正在同步，请稍后再编辑 SKU';
  if (!parseStoredProductSkuState(record.skuSpecSnapshot) || !record.skuSpecFingerprint) {
    return '请先读取平台 SKU 编辑上下文';
  }
  if (
    !record.skuSpecSyncedAt ||
    Date.now() - record.skuSpecSyncedAt.getTime() > SKU_CONTEXT_MAX_AGE_MS
  ) {
    return '平台 SKU 快照已过期，请重新读取编辑上下文';
  }
  const binding = currentSourceBindingForSkuEdit(record.sourceBindings);
  if (!binding || binding.sourceProductId !== record.sourceProductId) {
    return '商品当前货源绑定缺失、重复或与商品指针不一致';
  }
  if (!isDemoShop(record.shop) && record.shop.platform !== 'douyin') {
    return '当前仅支持抖店商品 SKU 编辑';
  }
  return null;
}

function strictSkuText(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== 'string') throw new BadRequestException(`${label}无效`);
  const text = value.trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new BadRequestException(`${label}无效`);
  }
  return text;
}

function nullableSkuText(value: unknown, maxLength: number, label: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  return strictSkuText(value, maxLength, label);
}

function sameStringSet(left: string[], right: string[]): boolean {
  const sortedRight = [...right].sort();
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === sortedRight[index])
  );
}

function parsePositiveId(value: string, label: string): bigint {
  try {
    const id = BigInt(value);
    if (id <= 0n || id > 9_223_372_036_854_775_807n) throw new Error('invalid');
    return id;
  } catch {
    throw new BadRequestException(`无效${label}`);
  }
}

function ownedItemWhere(item: Pick<ProductBatchItem, 'id' | 'attempts' | 'lockedBy'>) {
  return {
    id: item.id,
    status: 'running' as const,
    attempts: item.attempts,
    lockedBy: item.lockedBy,
  };
}

function ownedItem(current: ProductBatchExecutionRecord, claimed: ProductBatchExecutionRecord) {
  return (
    current.status === 'running' &&
    current.attempts === claimed.attempts &&
    current.lockedBy === claimed.lockedBy
  );
}

function retryDelayMs(attempts: number): number {
  return Math.min(5 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1));
}

function titleVerificationWindowElapsed(result: Prisma.JsonValue | null): boolean {
  const startedAt = stringValue(jsonRecord(result)?.titleWriteStartedAt);
  if (!startedAt) return false;
  const timestamp = Date.parse(startedAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp >= STALE_ITEM_MS;
}

function onlineVerificationWindowElapsed(result: Prisma.JsonValue | null): boolean {
  const startedAt = stringValue(jsonRecord(result)?.onlineWriteStartedAt);
  if (!startedAt) return false;
  const timestamp = Date.parse(startedAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp >= STALE_ITEM_MS;
}

function offlineVerificationWindowElapsed(result: Prisma.JsonValue | null): boolean {
  const startedAt = stringValue(jsonRecord(result)?.offlineWriteStartedAt);
  if (!startedAt) return false;
  const timestamp = Date.parse(startedAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp >= STALE_ITEM_MS;
}

function shouldWaitForTitleVerification(
  state: PlatformProductTitleState,
  beforeTitle: string,
  desiredTitle: string,
  result: Prisma.JsonValue | null,
): boolean {
  if (state.title === desiredTitle || state.title !== beforeTitle) return false;
  if (
    state.state === 'rejected' ||
    state.state === 'blocked' ||
    state.state === 'deleted' ||
    state.state === 'unknown'
  ) {
    return false;
  }
  if (state.state === 'online' || state.state === 'offline') {
    return !titleVerificationWindowElapsed(result);
  }
  return true;
}

function isOfflineState(state: string): boolean {
  return state === 'offline' || state === 'deleted';
}

function sameStableOfflineState(
  first: PlatformProductState,
  second: PlatformProductState,
): boolean {
  return (
    isOfflineState(first.state) &&
    isOfflineState(second.state) &&
    first.state === second.state &&
    first.status === second.status &&
    first.checkStatus === second.checkStatus
  );
}

function sameStableOnlineState(first: PlatformProductState, second: PlatformProductState): boolean {
  return (
    first.state === 'online' &&
    second.state === 'online' &&
    first.status === second.status &&
    first.checkStatus === second.checkStatus
  );
}

function isRawDeletedProduct(record: {
  platformStatusRaw: number | null;
  platformCheckStatusRaw: number | null;
}): boolean {
  return record.platformStatusRaw === 2;
}

function assertTitleEditState(state: PlatformProductTitleState, stage: string): void {
  if (state.state === 'online' || state.state === 'offline') return;
  throw new ProductBatchItemError(
    'TITLE_EDIT_STATE_INVALID',
    `${stage}平台商品状态为 ${state.state}，不能安全提交标题更新`,
    false,
  );
}

function titleResultFailure(
  state: PlatformProductTitleState,
): { code: string; message: string } | null {
  if (state.state === 'rejected' || state.state === 'blocked') {
    return {
      code: 'TITLE_RESULT_REJECTED',
      message: `平台商品状态为 ${state.state}，已同步实际标题，请按平台提示修正`,
    };
  }
  if (state.state === 'deleted' || state.state === 'unknown') {
    return {
      code: 'TITLE_RESULT_STATE_INVALID',
      message: `平台商品状态为 ${state.state}，已同步实际标题，请人工核验`,
    };
  }
  return null;
}

function localStatusFromTitleState(
  state: PlatformProductTitleState,
  fallback: string,
): 'online' | 'offline' | 'draft' | 'rejected' {
  if (state.state === 'online') return 'online';
  if (state.state === 'offline') return 'offline';
  if (state.state === 'deleted') return 'rejected';
  if (
    state.state === 'draft' ||
    state.state === 'reviewing' ||
    state.state === 'approved_pending_online'
  ) {
    return 'draft';
  }
  if (state.state === 'rejected' || state.state === 'blocked') return 'rejected';
  return fallback === 'offline' || fallback === 'draft' || fallback === 'rejected'
    ? fallback
    : 'online';
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '批量商品操作失败';
}

function safeErrorCode(error: unknown, fallback: string): string {
  const value = error instanceof Error ? error.name : '';
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : fallback;
}

function isRetryableFailedError(errorCode: string | null): boolean {
  return errorCode === null || RETRYABLE_FAILED_CODES.has(errorCode);
}

function isResolvedSkuExecutionError(error: unknown): boolean {
  return (
    error instanceof ProductBatchItemError &&
    [
      'SKU_BINDING_CHANGED',
      'SKU_PRODUCT_CHANGED',
      'SKU_RULE_CHANGED',
      'SKU_SOURCE_CHANGED',
      'SKU_UPDATE_FAILED',
      'SKU_WRITE_GUARD_LOST',
      SKU_RESULT_UNKNOWN_CODE,
    ].includes(error.code)
  );
}

function isUnknownSkuExecutionError(error: unknown): boolean {
  return error instanceof ProductBatchItemError && error.code === SKU_RESULT_UNKNOWN_CODE;
}

function isResolvedTitleExecutionError(error: unknown): boolean {
  return (
    error instanceof ProductBatchItemError &&
    [
      'PLATFORM_TITLE_CHANGED',
      'TITLE_WRITE_ABORTED_PRODUCT_CHANGED',
      'TITLE_WRITE_GUARD_LOST',
      'TITLE_RESULT_REJECTED',
      'TITLE_RESULT_STATE_INVALID',
      TITLE_RESULT_UNKNOWN_CODE,
      'TITLE_UPDATE_FAILED',
    ].includes(error.code)
  );
}

function isUnknownTitleExecutionError(error: unknown): boolean {
  return error instanceof ProductBatchItemError && error.code === TITLE_RESULT_UNKNOWN_CODE;
}

function isResolvedOnlineExecutionError(error: unknown): boolean {
  return (
    error instanceof ProductBatchItemError &&
    [
      'ONLINE_COMMIT_CONFLICT',
      'ONLINE_COMMIT_FAILED',
      'ONLINE_INVENTORY_DRIFT',
      'ONLINE_RESULT_REJECTED',
      'ONLINE_SOURCE_CHANGED',
      'ONLINE_UPDATE_FAILED',
      'ONLINE_WRITE_GUARD_LOST',
    ].includes(error.code)
  );
}

function isUnknownOnlineExecutionError(error: unknown): boolean {
  return error instanceof ProductBatchItemError && error.code === ONLINE_RESULT_UNKNOWN_CODE;
}

function isResolvedOfflineExecutionError(error: unknown): boolean {
  return (
    error instanceof ProductBatchItemError &&
    [
      'CLEANUP_EVIDENCE_INVALID',
      'CLEANUP_EVIDENCE_CHANGED',
      'CLEANUP_ORDER_SYNC_UNAVAILABLE',
      'CLEANUP_RECENT_SALES',
      'CLEANUP_SALE_DETECTED',
      'OFFLINE_COMMIT_CONFLICT',
      'OFFLINE_PREFLIGHT_STATE_INVALID',
      'OFFLINE_WRITE_ABORTED_PRODUCT_CHANGED',
      'OFFLINE_WRITE_GUARD_LOST',
      'OFFLINE_UPDATE_FAILED',
      'STATUS_READBACK_UNSUPPORTED',
    ].includes(error.code)
  );
}

function isUnknownOfflineExecutionError(error: unknown): boolean {
  return error instanceof ProductBatchItemError && error.code === OFFLINE_RESULT_UNKNOWN_CODE;
}

function isPlatformMutationResultUnknown(error: unknown): boolean {
  return error instanceof Error && error.name === 'PlatformMutationResultUnknownError';
}

function isUniqueConstraintError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'P2002';
}

function isSerializationConflict(error: unknown): boolean {
  const value = error as { code?: unknown; meta?: { code?: unknown } } | null;
  return value?.code === 'P2034' || value?.meta?.code === '40001';
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}
