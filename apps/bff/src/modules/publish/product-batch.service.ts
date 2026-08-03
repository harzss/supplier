import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type ProductBatchItem } from '@supplier/db';
import type { PlatformAdapter, PlatformProductPriceState } from '@supplier/platform-sdk';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma.module';
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
  ProductBatchCandidateQueryDto,
  ProductBatchTaskListQueryDto,
  RetryProductBatchDto,
} from './dto/product-batch.dto';
import { PlatformProductLockService } from './platform-product-lock.service';

const STALE_ITEM_MS = 5 * 60_000;
const TASK_RECONCILE_INTERVAL_MS = 30_000;
const MAX_PRICE_CENTS = 100_000_000;
const TERMINAL_TASK_STATUSES = ['cancelled', 'partial', 'succeeded', 'failed'] as const;

const TASK_INCLUDE = {
  items: {
    orderBy: { ordinal: 'asc' as const },
    include: {
      publishedProduct: {
        include: {
          shop: true,
          sourceProduct: true,
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
    sourceProductId: string;
    sourceAvailability: string;
    inventorySyncStatus: string;
    mutationRevision: number;
    publishedAt: string;
  }>;
  total: number;
  page: number;
  pageSize: number;
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
  beforePrice: number | null;
  desiredPrice: number | null;
  beforePriceRange: [number, number] | null;
  desiredPriceRange: [number, number] | null;
  actualPriceRange: [number, number] | null;
  skuCount: number;
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
          task: { select: { skuSnapshot: true } },
        },
      }),
    ]);
    return {
      items: records.map((record) => {
        const prices =
          parseSkuPriceSnapshot(record.skuPriceSnapshot) ??
          priceSnapshotFromPublishTask(record.task.skuSnapshot, record.shop.platform);
        const priceEditable = record.status === 'online' && !!prices;
        return {
          publishedProductId: record.id.toString(),
          title: record.title,
          mainImage: record.mainImage ?? record.sourceProduct.mainImage,
          shopId: record.shopId.toString(),
          shopName: record.shop.shopName,
          platform: record.shop.platform,
          platformProductId: record.platformProductId!,
          status: record.status,
          salePrice: Number(record.salePrice),
          priceRange: prices ? snapshotPriceRange(prices) : null,
          skuCount: prices?.items.length ?? 0,
          priceEditable,
          priceEditReason: priceEditable
            ? null
            : record.status !== 'online'
              ? '只有在线商品可以改价'
              : '缺少可核对的 SKU 价格快照',
          sourceProductId: record.sourceProduct.productId1688,
          sourceAvailability: record.sourceProduct.availability,
          inventorySyncStatus: record.inventorySyncStatus,
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
    const priceRule = normalizePriceRule(dto.action, dto.publishedProductIds, dto.priceRule);
    const fingerprint = requestFingerprint(dto.action, dto.publishedProductIds, priceRule);
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
        task: { select: { skuSnapshot: true } },
      },
    });
    if (records.length !== ids.length) {
      throw new NotFoundException('部分商品不存在、已失效或不属于当前账号');
    }
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
              const preview = previewForAction(dto.action, record, priceRule);
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
    const requestedIds = dto.itemIds?.map((id) => BigInt(id));
    const retryItems = task.items.filter(
      (item) =>
        item.status === 'failed' &&
        (!requestedIds || requestedIds.some((requested) => requested === item.id)),
    );
    if (!retryItems.length || (requestedIds && retryItems.length !== requestedIds.length)) {
      throw new BadRequestException('所选条目中包含不可重试项');
    }
    const stale = retryItems.find(
      (item) => item.publishedProduct.mutationRevision !== item.expectedMutationRevision,
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
      const itemsUpdated = await tx.productBatchItem.updateMany({
        where: { id: { in: retryItems.map((item) => item.id) }, status: 'failed' },
        data: {
          status: 'pending',
          attempts: 0,
          nextRunAt: now,
          lockedAt: null,
          lockedBy: null,
          errorCode: null,
          errorMessage: null,
          result: Prisma.JsonNull,
          startedAt: null,
          finishedAt: null,
        },
      });
      if (itemsUpdated.count !== retryItems.length) {
        throw new ConflictException('失败项状态已变化，请刷新');
      }
    });
    return toTaskView(await this.requireTask(user.userId, task.id));
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
          task: { cancelRequestedAt: null, status: { in: ['queued', 'running'] } },
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
    if (!['offline', 'edit_price'].includes(item.task.action)) {
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
      if (current.task.action === 'offline' && product.status === 'offline') {
        return this.completeClaimedItem(current, { reason: 'already_offline' });
      }
      if (product.status !== 'online') {
        throw new ProductBatchItemError(
          'PRODUCT_NOT_ONLINE',
          `商品当前状态为 ${product.status}，未执行${current.task.action === 'offline' ? '下架' : '改价'}`,
          false,
        );
      }
      if (product.mutationRevision !== current.expectedMutationRevision) {
        throw new ProductBatchItemError('PRODUCT_CHANGED', '商品已在预览后发生变化', false);
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

      if (current.task.action === 'edit_price') {
        const result = await this.executePriceClaimed(current, adapter, token, lock);
        return result;
      }

      let recovered = false;
      let platformState: Record<string, unknown> | null = null;
      const demoShop = isDemoShop(product.shop);
      if (!demoShop && !adapter.getProductState) {
        throw new ProductBatchItemError(
          'STATUS_READBACK_UNSUPPORTED',
          '当前平台无法回读商品状态，拒绝执行下架',
          false,
        );
      }

      if (!demoShop && current.attempts > 1) {
        const state = await adapter.getProductState!(token, product.platformProductId);
        if (isOfflineState(state.state)) {
          recovered = true;
          platformState = state as unknown as Record<string, unknown>;
        }
      }

      if (!recovered) {
        try {
          await adapter.offlineProduct(token, product.platformProductId);
        } catch (error) {
          if (demoShop) throw error;
          const state = await adapter.getProductState!(token, product.platformProductId);
          if (!isOfflineState(state.state)) throw error;
          recovered = true;
          platformState = state as unknown as Record<string, unknown>;
        }
      }

      if (!demoShop && !recovered) {
        const state = await adapter.getProductState!(token, product.platformProductId);
        if (!isOfflineState(state.state)) {
          throw new ProductBatchItemError(
            'STATUS_NOT_OFFLINE',
            '平台尚未确认商品下架，将稍后重试',
            true,
          );
        }
        platformState = state as unknown as Record<string, unknown>;
      }

      await this.platformProductLocks.renew(product.id, lock);
      if (!(await this.assertItemOwned(current))) return 'stale';
      const updated = await this.prisma.publishedProduct.updateMany({
        where: {
          id: product.id,
          platformProductId: product.platformProductId,
          mutationRevision: current.expectedMutationRevision,
          status: 'online',
        },
        data: {
          status: 'offline',
          mutationRevision: { increment: 1 },
          inventorySyncStatus: 'synced',
          inventoryNextRunAt: null,
          inventoryLockedAt: null,
          inventoryLockedBy: null,
          inventorySyncReason: 'manual_batch_offline',
          inventorySyncError: null,
          platformStatusError: null,
          ...(platformState
            ? {
                platformStatusRaw: integerOrNull(platformState.status),
                platformCheckStatusRaw: integerOrNull(platformState.checkStatus),
                platformStatusSyncedAt: new Date(),
              }
            : {}),
        },
      });
      if (updated.count !== 1) {
        const latest = await this.prisma.publishedProduct.findUnique({ where: { id: product.id } });
        if (latest?.status !== 'offline') {
          throw new ProductBatchItemError(
            'PRODUCT_CHANGED',
            '商品状态已变化，请新建批量预览',
            false,
          );
        }
      }
      return this.completeClaimedItem(current, {
        reason: recovered ? 'platform_result_recovered' : 'offline_confirmed',
        recovered,
        platformState,
      });
    } finally {
      await this.platformProductLocks.release(item.publishedProductId, lock);
    }
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
  ): Promise<'retry_wait' | 'failed' | 'stale'> {
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
      const failed = !cancelled && item.attempts >= item.maxAttempts;
      const updated = await this.prisma.productBatchItem.updateMany({
        where: {
          id: item.id,
          status: 'running',
          attempts: item.attempts,
          lockedBy: item.lockedBy,
        },
        data: {
          status: cancelled ? 'cancelled' : failed ? 'failed' : 'retry_wait',
          nextRunAt: now,
          lockedAt: null,
          lockedBy: null,
          errorCode: cancelled ? null : 'WORKER_STALE',
          errorMessage: cancelled ? null : '批量任务 worker 超时，已安全恢复',
          ...((cancelled || failed) && { finishedAt: now }),
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
        status: { in: ['queued', 'running', 'cancelling'] },
        items: { none: { status: { in: ['pending', 'running', 'retry_wait'] } } },
      },
      orderBy: { updatedAt: 'asc' },
      take: 100,
      select: { id: true },
    });
    for (const task of tasks) await this.refreshTask(task.id);
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
      const beforeStatus = stringValue(before?.status) ?? item.publishedProduct.status;
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
        beforePrice: beforePrices ? snapshotStartPrice(beforePrices) : null,
        desiredPrice: desiredPrices ? snapshotStartPrice(desiredPrices) : null,
        beforePriceRange: beforePrices ? snapshotPriceRange(beforePrices) : null,
        desiredPriceRange: desiredPrices ? snapshotPriceRange(desiredPrices) : null,
        actualPriceRange: actualPrices ? snapshotPriceRange(actualPrices) : null,
        skuCount: beforePrices?.items.length ?? 0,
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
    mutationRevision: number;
    skuPriceSnapshot: Prisma.JsonValue | null;
    shop: { platform: string };
    task: { skuSnapshot: Prisma.JsonValue | null };
  },
  priceRule: NormalizedPriceRule | null,
) {
  const before = beforeSnapshot(record);
  if (action === 'offline') {
    const status = previewOfflineStatus(record.status, record.platformProductId);
    return {
      ...status,
      beforeSnapshot: before,
      desiredSnapshot: { status: 'offline' },
    };
  }
  if (action !== 'edit_price' || !priceRule) {
    throw new BadRequestException('当前批量动作尚未实现');
  }
  if (!record.platformProductId) {
    return skippedPricePreview(before, record.status, 'PLATFORM_ID_MISSING', '商品缺少平台商品 ID');
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

function previewOfflineStatus(status: string, platformProductId: string | null) {
  if (!platformProductId) {
    return {
      status: 'skipped' as const,
      result: { reason: 'platform_id_missing' },
      errorCode: 'PLATFORM_ID_MISSING',
      errorMessage: '商品缺少平台商品 ID，已跳过',
    };
  }
  if (status === 'offline') {
    return {
      status: 'skipped' as const,
      result: { reason: 'already_offline' },
      errorCode: null,
      errorMessage: null,
    };
  }
  if (status !== 'online') {
    return {
      status: 'skipped' as const,
      result: { reason: 'status_not_online', status },
      errorCode: 'PRODUCT_NOT_ONLINE',
      errorMessage: `商品当前状态为 ${status}，无需执行下架`,
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
  if (action === 'offline') {
    if (value) throw new BadRequestException('批量下架不能携带改价规则');
    return null;
  }
  if (action !== 'edit_price' || !value) {
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

function requestFingerprint(
  action: string,
  ids: string[],
  priceRule: NormalizedPriceRule | null,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        action,
        publishedProductIds: [...ids].sort(),
        ...(priceRule ? { priceRule } : {}),
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

function isOfflineState(state: string): boolean {
  return state === 'offline' || state === 'deleted';
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '批量商品操作失败';
}

function safeErrorCode(error: unknown, fallback: string): string {
  const value = error instanceof Error ? error.name : '';
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : fallback;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'P2002';
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
