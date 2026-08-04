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
  PlatformProductState,
  PlatformProductTitleState,
  PlatformType,
} from '@supplier/platform-sdk';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma.module';
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
  ProductBatchTitleTargetDto,
  ProductBatchCandidateQueryDto,
  ProductBatchTaskListQueryDto,
  RetryProductBatchDto,
} from './dto/product-batch.dto';
import { PlatformProductLockService } from './platform-product-lock.service';

const STALE_ITEM_MS = 5 * 60_000;
const TASK_RECONCILE_INTERVAL_MS = 30_000;
const MAX_PRICE_CENTS = 100_000_000;
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
  'STATUS_NOT_OFFLINE',
  'STATUS_NOT_ONLINE',
  'ONLINE_RESULT_NOT_APPLIED',
  'TITLE_WRITE_GUARD_LOST',
  'TITLE_READBACK_FAILED',
  'WORKER_STALE',
]);

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
    titleEditable: boolean;
    titleEditReason: string | null;
    titleVerificationTaskId: string | null;
    titleVerificationItemId: string | null;
    onlineEligible: boolean;
    onlineReason: string | null;
    onlineVerificationTaskId: string | null;
    onlineVerificationItemId: string | null;
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
  skuCount: number;
  beforeInventory: ProductBatchInventorySnapshot | null;
  desiredInventory: ProductBatchInventorySnapshot | null;
  actualInventory: ProductBatchInventorySnapshot | null;
  beforeInventoryVersion: number | null;
  desiredInventoryVersion: number | null;
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
    return {
      items: records.map((record) => {
        const rawDeleted = isRawDeletedProduct(record);
        const prices =
          parseSkuPriceSnapshot(record.skuPriceSnapshot) ??
          priceSnapshotFromPublishTask(record.task.skuSnapshot, record.shop.platform);
        const priceEditable = !rawDeleted && record.status === 'online' && !!prices;
        const titleEditReason = titleEditUnavailableReason(
          record,
          unresolvedTitleByProduct.has(record.id),
        );
        const unresolvedTitle = unresolvedTitleByProduct.get(record.id);
        const beforeInventory =
          parseSkuInventorySnapshot(record.skuInventorySnapshot) ??
          inventorySnapshotFromPublishTask(record.task.skuSnapshot, record.shop.platform);
        const desiredInventory = inventorySnapshotFromSource(
          record.task.skuSnapshot,
          record.shop.platform,
          record.sourceProduct.skuList,
        );
        const inventorySyncReason = inventorySyncUnavailableReason(
          record,
          beforeInventory,
          desiredInventory,
        );
        const onlineVerification = unresolvedOnlineByProduct.get(record.id);
        const onlineReason = onlineUnavailableReason(
          record,
          beforeInventory,
          desiredInventory,
          unresolvedTitleByProduct.has(record.id),
          Boolean(onlineVerification),
        );
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
              : record.status !== 'online'
                ? '只有在线商品可以改价'
                : '缺少可核对的 SKU 价格快照',
          titleEditable: titleEditReason === null,
          titleEditReason,
          titleVerificationTaskId: unresolvedTitle?.taskId.toString() ?? null,
          titleVerificationItemId: unresolvedTitle?.id.toString() ?? null,
          onlineEligible: onlineReason === null,
          onlineReason,
          onlineVerificationTaskId: onlineVerification?.taskId.toString() ?? null,
          onlineVerificationItemId: onlineVerification?.id.toString() ?? null,
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
    const fingerprint = requestFingerprint(
      dto.action,
      dto.publishedProductIds,
      titleTargets,
      priceRule,
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
              const preview = previewForAction(dto.action, record, titleTargets, priceRule);
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
    if (retryItems.some((item) => item.errorCode === TITLE_RESULT_UNKNOWN_CODE)) {
      throw new BadRequestException('标题更新结果未知，请先在原批量任务核验平台实际标题');
    }
    if (retryItems.some((item) => item.errorCode === ONLINE_RESULT_UNKNOWN_CODE)) {
      throw new BadRequestException('上架结果未知，请先在原批量任务核验平台状态与库存');
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
    if (
      !['online', 'offline', 'edit_title', 'edit_price', 'sync_inventory'].includes(
        item.task.action,
      )
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
      if (current.task.action === 'offline' && product.status === 'offline') {
        return this.completeClaimedItem(current, { reason: 'already_offline' });
      }
      const titleAction = current.task.action === 'edit_title';
      const onlineAction = current.task.action === 'online';
      if (
        (titleAction && product.status !== 'online' && product.status !== 'offline') ||
        (onlineAction && product.status !== 'offline' && product.status !== 'online') ||
        (!titleAction && !onlineAction && product.status !== 'online')
      ) {
        const actionLabel =
          current.task.action === 'offline'
            ? '下架'
            : onlineAction
              ? '上架'
              : titleAction
                ? '改标题'
                : current.task.action === 'edit_price'
                  ? '改价'
                  : '同步库存';
        throw new ProductBatchItemError(
          titleAction
            ? 'PRODUCT_NOT_PUBLISHED'
            : onlineAction
              ? 'PRODUCT_NOT_OFFLINE'
              : 'PRODUCT_NOT_ONLINE',
          `商品当前状态为 ${product.status}，未执行${actionLabel}`,
          false,
        );
      }
      if (product.mutationRevision !== current.expectedMutationRevision) {
        throw new ProductBatchItemError('PRODUCT_CHANGED', '商品已在预览后发生变化', false);
      }
      if (titleAction || onlineAction) {
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
      if (current.task.action === 'sync_inventory') {
        const result = await this.executeInventoryClaimed(current, adapter, token, lock);
        return result;
      }
      if (current.task.action === 'online') {
        return this.executeOnlineClaimed(current, adapter, token, lock);
      }

      let recovered = false;
      let platformState: PlatformProductState | null = null;
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
          platformState = state;
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
          platformState = state;
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
        platformState = state;
      }

      await this.platformProductLocks.renew(product.id, lock);
      if (!(await this.assertItemOwned(current))) return 'stale';
      const persistedStatus = platformState?.state === 'deleted' ? 'rejected' : 'offline';
      const updated = await this.prisma.publishedProduct.updateMany({
        where: {
          id: product.id,
          platformProductId: product.platformProductId,
          mutationRevision: current.expectedMutationRevision,
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
            platformState?.state === 'deleted'
              ? 'platform_product_deleted'
              : 'manual_batch_offline',
          inventorySyncError: null,
          platformStatusError: null,
          ...(platformState
            ? {
                platformStatusRaw: platformState.status,
                platformCheckStatusRaw: platformState.checkStatus,
                platformStatusSyncedAt: new Date(),
              }
            : {}),
        },
      });
      if (updated.count !== 1) {
        const latest = await this.prisma.publishedProduct.findUnique({ where: { id: product.id } });
        if (latest?.status !== persistedStatus) {
          throw new ProductBatchItemError(
            'PRODUCT_CHANGED',
            '商品状态已变化，请新建批量预览',
            false,
          );
        }
      }
      return this.completeClaimedItem(current, {
        reason:
          platformState?.state === 'deleted'
            ? 'platform_product_deleted'
            : recovered
              ? 'platform_result_recovered'
              : 'offline_confirmed',
        recovered,
        platformState,
      });
    } finally {
      await this.platformProductLocks.release(item.publishedProductId, lock);
    }
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
      const unresolvedMutation = titleResultUnknown || onlineResultUnknown;
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
              : ONLINE_RESULT_UNKNOWN_CODE
            : cancelled
              ? null
              : 'WORKER_STALE',
          errorMessage: unresolvedMutation
            ? titleResultUnknown
              ? '标题写入期间 worker 中断，请核验平台实际标题'
              : '上架写入期间 worker 中断，请核验平台实际状态与库存'
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
        skuCount: beforePrices?.items.length ?? beforeInventory?.items.length ?? 0,
        beforeInventory,
        desiredInventory,
        actualInventory,
        beforeInventoryVersion: integerOrNull(before?.inventoryVersion),
        desiredInventoryVersion: integerOrNull(desired?.inventoryVersion),
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
      availability: string;
      skuList: Prisma.JsonValue | null;
      inventoryFingerprint: string;
      inventoryVersion: number;
    };
  },
  titleTargets: NormalizedTitleTarget[] | null,
  priceRule: NormalizedPriceRule | null,
) {
  const before = beforeSnapshot(record);
  if (action === 'online') {
    const beforeInventory =
      parseSkuInventorySnapshot(record.skuInventorySnapshot) ??
      inventorySnapshotFromPublishTask(record.task.skuSnapshot, record.shop.platform);
    const desiredInventory = inventorySnapshotFromSource(
      record.task.skuSnapshot,
      record.shop.platform,
      record.sourceProduct.skuList,
    );
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
    const desiredInventory = inventorySnapshotFromSource(
      record.task.skuSnapshot,
      record.shop.platform,
      record.sourceProduct.skuList,
    );
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

function requestFingerprint(
  action: string,
  ids: string[],
  titleTargets: NormalizedTitleTarget[] | null,
  priceRule: NormalizedPriceRule | null,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        action,
        publishedProductIds: [...ids].sort(),
        ...(titleTargets ? { titleTargets } : {}),
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
): string | null {
  if (!record.platformProductId) return '商品缺少平台商品 ID';
  if (isRawDeletedProduct(record)) return '平台商品已删除，不能重新上架，请重新铺货';
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
): string | null {
  if (!record.platformProductId) return '商品缺少平台商品 ID';
  if (isRawDeletedProduct(record)) return '平台商品已删除，不能改标题，请重新铺货';
  if (unresolvedTitleResult) return '存在结果待核验的标题更新，请先在原批量任务核验';
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

function onlineBaseMutationRevision(
  item: Pick<ProductBatchItem, 'expectedMutationRevision' | 'result'>,
): number {
  const quarantineRevision = positiveIntegerOrNull(jsonRecord(item.result)?.quarantineRevision);
  return quarantineRevision && quarantineRevision >= item.expectedMutationRevision
    ? quarantineRevision
    : item.expectedMutationRevision;
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

function isPlatformMutationResultUnknown(error: unknown): boolean {
  return error instanceof Error && error.name === 'PlatformMutationResultUnknownError';
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
