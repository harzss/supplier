import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CrawlerError,
  inventorySnapshot,
  offlineInventorySnapshot,
  type CrawledProduct,
} from '@supplier/crawler';
import { Prisma } from '@supplier/db';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma.module';
import { EntitlementService } from '../entitlement/entitlement.service';
import type { CurrentUser } from '../entitlement/user-context.service';
import type {
  CollectedSourceProductQueryDto,
  CreateSourceImportPreviewDto,
  ExecuteSourceImportDto,
  RetrySourceImportDto,
  SourceImportListQueryDto,
} from './dto/source-import.dto';
import {
  SourceImportAdapterFactory,
  SourceImportRateLimiter,
} from './source-import-adapter.service';
import { normalizeSourceReferences } from './source-import-reference';

const STALE_ITEM_MS = 5 * 60_000;
const TASK_RECONCILE_INTERVAL_MS = 30_000;
const TERMINAL_TASK_STATUSES = ['cancelled', 'partial', 'succeeded', 'failed'] as const;
const MANUALLY_RETRYABLE_CODES = new Set([
  'AUTH',
  'DATABASE_ERROR',
  'INFRASTRUCTURE',
  'NETWORK',
  'PLATFORM_ERROR',
  'RATE_LIMITED',
  'WORKER_STALE',
]);

const TASK_INCLUDE = {
  items: {
    orderBy: { ordinal: 'asc' as const },
    include: {
      sourceProduct: {
        select: {
          productId1688: true,
          title: true,
          mainImage: true,
          price: true,
          totalStock: true,
          availability: true,
        },
      },
    },
  },
} satisfies Prisma.SourceImportTaskInclude;

const EXECUTION_INCLUDE = {
  task: true,
} satisfies Prisma.SourceImportItemInclude;

const STORED_SOURCE_PRODUCT_SELECT = {
  id: true,
  productId1688: true,
  title: true,
  mainImage: true,
  price: true,
  skuList: true,
  totalStock: true,
  availability: true,
  inventoryFingerprint: true,
  inventoryVersion: true,
  syncedAt: true,
} satisfies Prisma.SourceProductSelect;

type SourceImportTaskRecord = Prisma.SourceImportTaskGetPayload<{ include: typeof TASK_INCLUDE }>;
export type SourceImportExecutionRecord = Prisma.SourceImportItemGetPayload<{
  include: typeof EXECUTION_INCLUDE;
}>;
type StoredSourceProduct = Prisma.SourceProductGetPayload<{
  select: typeof STORED_SOURCE_PRODUCT_SELECT;
}>;

export interface SourceImportSummary {
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

export interface SourceImportItemView {
  itemId: string;
  reference: string;
  offerId: string;
  action: 'create' | 'refresh';
  existing: boolean;
  collected: boolean;
  status: string;
  attempts: number;
  maxAttempts: number;
  retryable: boolean;
  sourceProductId: string | null;
  title: string | null;
  mainImage: string | null;
  price: number | null;
  skuCount: number | null;
  totalStock: number | null;
  availability: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  result: Record<string, unknown> | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SourceImportTaskView {
  taskId: string;
  clientRequestId: string;
  buyerShopId: string | null;
  status: string;
  previewRevision: number;
  cancelRequestedAt: string | null;
  confirmedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  summary: SourceImportSummary;
  items: SourceImportItemView[];
}

@Injectable()
export class SourceImportService {
  private lastTaskReconcileAt = 0;
  private lastTaskReconcileCursor: bigint | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly entitlement: EntitlementService,
    private readonly adapters: SourceImportAdapterFactory,
    private readonly rateLimiter: SourceImportRateLimiter,
  ) {}

  isEnabled(): boolean {
    return this.config.get<string>('SOURCE_IMPORT_ENABLED') === 'true';
  }

  async createPreview(
    user: CurrentUser,
    dto: CreateSourceImportPreviewDto,
  ): Promise<SourceImportTaskView> {
    this.entitlement.assertFeature(user.plan, 'catalog.batch');
    const references = normalizeSourceReferences(dto.references);
    const replay = await this.findByClientRequestId(user.userId, dto.clientRequestId);
    if (replay) {
      const requestedBuyerShopId = dto.buyerShopId
        ? parsePositiveId(dto.buyerShopId, '1688 买家账号 ID')
        : replay.buyerShopId;
      assertSameRequest(
        replay,
        sourceImportFingerprint(
          references.map((item) => item.offerId),
          requestedBuyerShopId,
        ),
        requestedBuyerShopId,
      );
      return toTaskView(replay);
    }
    const buyerShopId = await this.adapters.resolveBuyerShop(user.userId, dto.buyerShopId);
    const fingerprint = sourceImportFingerprint(
      references.map((item) => item.offerId),
      buyerShopId,
    );

    const offerIds = references.map((item) => item.offerId);
    const existing = await this.prisma.sourceProduct.findMany({
      where: { productId1688: { in: offerIds } },
      select: {
        id: true,
        productId1688: true,
        availability: true,
        skuList: true,
        syncedAt: true,
        userSourceProducts: {
          where: { userId: user.userId },
          select: { id: true },
        },
      },
    });
    const byOfferId = new Map(existing.map((item) => [item.productId1688, item]));
    const maxAttempts = this.maxAttempts();
    try {
      const task = await this.prisma.sourceImportTask.create({
        data: {
          userId: user.userId,
          buyerShopId,
          clientRequestId: dto.clientRequestId,
          requestFingerprint: fingerprint,
          items: {
            create: references.map((item, ordinal) => {
              const product = byOfferId.get(item.offerId);
              const userSourceProduct = product?.userSourceProducts[0];
              return {
                offerId: item.offerId,
                ordinal,
                sourceProductId: product?.id,
                userSourceProductId: userSourceProduct?.id,
                beforeSnapshot: {
                  reference: item.reference,
                  existing: Boolean(product),
                  collected: Boolean(userSourceProduct),
                  ...(product
                    ? {
                        sourceProductId: product.productId1688,
                        availability: product.availability,
                        skuCount: jsonArrayLength(product.skuList),
                        syncedAt: product.syncedAt.toISOString(),
                      }
                    : {}),
                },
                maxAttempts,
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
      assertSameRequest(concurrent, fingerprint, buyerShopId);
      return toTaskView(concurrent);
    }
  }

  async list(user: CurrentUser, query: SourceImportListQueryDto) {
    this.entitlement.assertFeature(user.plan, 'catalog.batch');
    const where = { userId: user.userId };
    const [total, records] = await Promise.all([
      this.prisma.sourceImportTask.count({ where }),
      this.prisma.sourceImportTask.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: TASK_INCLUDE,
      }),
    ]);
    return { items: records.map(toTaskView), total, page: query.page, pageSize: query.pageSize };
  }

  async detail(user: CurrentUser, taskIdValue: string): Promise<SourceImportTaskView> {
    this.entitlement.assertFeature(user.plan, 'catalog.batch');
    return toTaskView(
      await this.requireTask(user.userId, parsePositiveId(taskIdValue, '采集任务 ID')),
    );
  }

  async byClientRequest(user: CurrentUser, clientRequestId: string): Promise<SourceImportTaskView> {
    this.entitlement.assertFeature(user.plan, 'catalog.batch');
    const task = await this.findByClientRequestId(user.userId, clientRequestId);
    if (!task) throw new NotFoundException('采集任务不存在');
    return toTaskView(task);
  }

  async execute(
    user: CurrentUser,
    taskIdValue: string,
    dto: ExecuteSourceImportDto,
  ): Promise<SourceImportTaskView> {
    this.assertExecutionEnabled();
    this.entitlement.assertFeature(user.plan, 'catalog.batch');
    const taskId = parsePositiveId(taskIdValue, '采集任务 ID');
    const task = await this.requireTask(user.userId, taskId);
    if (task.previewRevision !== dto.previewRevision) {
      throw new ConflictException('采集预览已变化，请刷新后重新确认');
    }
    if (task.status !== 'preview') return toTaskView(task);
    const now = new Date();
    const updated = await this.prisma.sourceImportTask.updateMany({
      where: {
        id: task.id,
        userId: user.userId,
        status: 'preview',
        stateRevision: task.stateRevision,
        previewRevision: dto.previewRevision,
      },
      data: {
        status: 'queued',
        stateRevision: { increment: 1 },
        confirmedAt: now,
      },
    });
    if (updated.count !== 1) throw new ConflictException('采集任务状态已变化，请刷新');
    return toTaskView(await this.requireTask(user.userId, task.id));
  }

  async cancel(user: CurrentUser, taskIdValue: string): Promise<SourceImportTaskView> {
    this.entitlement.assertFeature(user.plan, 'catalog.batch');
    const taskId = parsePositiveId(taskIdValue, '采集任务 ID');
    const task = await this.requireTask(user.userId, taskId);
    if (TERMINAL_TASK_STATUSES.includes(task.status as (typeof TERMINAL_TASK_STATUSES)[number])) {
      return toTaskView(task);
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.sourceImportTask.updateMany({
        where: {
          id: task.id,
          userId: user.userId,
          stateRevision: task.stateRevision,
          status: task.status,
        },
        data: {
          status: 'cancelling',
          stateRevision: { increment: 1 },
          cancelRequestedAt: now,
        },
      });
      if (changed.count !== 1) throw new ConflictException('采集任务状态已变化，请刷新');
      await tx.sourceImportItem.updateMany({
        where: { taskId: task.id, status: { in: ['pending', 'retry_wait'] } },
        data: {
          status: 'cancelled',
          lockedAt: null,
          lockedBy: null,
          finishedAt: now,
        },
      });
    });
    await this.refreshTask(task.id);
    return toTaskView(await this.requireTask(user.userId, task.id));
  }

  async retry(
    user: CurrentUser,
    taskIdValue: string,
    dto: RetrySourceImportDto,
  ): Promise<SourceImportTaskView> {
    this.assertExecutionEnabled();
    this.entitlement.assertFeature(user.plan, 'catalog.batch');
    const taskId = parsePositiveId(taskIdValue, '采集任务 ID');
    const task = await this.requireTask(user.userId, taskId);
    if (!['failed', 'partial'].includes(task.status)) {
      throw new BadRequestException('只有失败或部分完成的采集任务可以重试');
    }
    const requestedIds = dto.itemIds?.map((id) => BigInt(id));
    const items = task.items.filter(
      (item) =>
        item.status === 'failed' &&
        isManuallyRetryable(item.errorCode) &&
        (!requestedIds || requestedIds.some((id) => id === item.id)),
    );
    if (!items.length || (requestedIds && items.length !== requestedIds.length)) {
      throw new BadRequestException('所选条目中包含不可重试项');
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.sourceImportTask.updateMany({
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
      if (changed.count !== 1) throw new ConflictException('采集任务状态已变化，请刷新');
      const reset = await tx.sourceImportItem.updateMany({
        where: { id: { in: items.map((item) => item.id) }, status: 'failed' },
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
      if (reset.count !== items.length) throw new ConflictException('失败项状态已变化，请刷新');
    });
    return toTaskView(await this.requireTask(user.userId, task.id));
  }

  async collected(user: CurrentUser, query: CollectedSourceProductQueryDto) {
    this.entitlement.assertFeature(user.plan, 'product.browse');
    const where = { userId: user.userId };
    const [total, records] = await Promise.all([
      this.prisma.userSourceProduct.count({ where }),
      this.prisma.userSourceProduct.findMany({
        where,
        orderBy: [{ lastCollectedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          firstCollectedAt: true,
          lastCollectedAt: true,
          sourceProduct: {
            select: {
              productId1688: true,
              title: true,
              price: true,
              mainImage: true,
              categoryL1: true,
              availability: true,
              totalStock: true,
              skuList: true,
              syncedAt: true,
            },
          },
        },
      }),
    ]);
    return {
      items: records.map((record) => ({
        collectionId: record.id.toString(),
        sourceProductId: record.sourceProduct.productId1688,
        productId1688: record.sourceProduct.productId1688,
        title: record.sourceProduct.title,
        price: Number(record.sourceProduct.price),
        mainImage: record.sourceProduct.mainImage,
        categoryL1: record.sourceProduct.categoryL1,
        availability: record.sourceProduct.availability,
        totalStock: record.sourceProduct.totalStock,
        skuCount: jsonArrayLength(record.sourceProduct.skuList),
        syncedAt: record.sourceProduct.syncedAt.toISOString(),
        firstCollectedAt: record.firstCollectedAt.toISOString(),
        lastCollectedAt: record.lastCollectedAt.toISOString(),
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async claimNext(workerId: string): Promise<SourceImportExecutionRecord | null> {
    const now = new Date();
    await this.recoverStaleItems(now);
    await this.reconcileFinishedTasks();
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = await this.prisma.sourceImportItem.findFirst({
        where: {
          status: { in: ['pending', 'retry_wait'] },
          nextRunAt: { lte: now },
          task: {
            status: { in: ['queued', 'running'] },
            cancelRequestedAt: null,
            user: { entitlementAccessStatus: 'active' },
          },
        },
        orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
      });
      if (!candidate) return null;
      const claimed = await this.prisma.sourceImportItem.updateMany({
        where: {
          id: candidate.id,
          status: candidate.status,
          attempts: candidate.attempts,
          task: {
            status: { in: ['queued', 'running'] },
            cancelRequestedAt: null,
            user: { entitlementAccessStatus: 'active' },
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
      const firstStart = await this.prisma.sourceImportTask.updateMany({
        where: {
          id: candidate.taskId,
          status: 'queued',
          cancelRequestedAt: null,
          startedAt: null,
          user: { entitlementAccessStatus: 'active' },
        },
        data: { status: 'running', stateRevision: { increment: 1 }, startedAt: now },
      });
      if (firstStart.count === 0) {
        await this.prisma.sourceImportTask.updateMany({
          where: {
            id: candidate.taskId,
            status: 'queued',
            cancelRequestedAt: null,
            user: { entitlementAccessStatus: 'active' },
          },
          data: { status: 'running', stateRevision: { increment: 1 } },
        });
      }
      return this.prisma.sourceImportItem.findUnique({
        where: { id: candidate.id },
        include: EXECUTION_INCLUDE,
      });
    }
    return null;
  }

  async executeClaimed(item: SourceImportExecutionRecord): Promise<'processed' | 'stale'> {
    const current = await this.prisma.sourceImportItem.findUnique({
      where: { id: item.id },
      include: EXECUTION_INCLUDE,
    });
    if (!current || !ownedItem(current, item)) return 'stale';
    if (current.task.cancelRequestedAt) return this.cancelClaimedItem(current);
    if (!['queued', 'running'].includes(current.task.status)) return 'stale';
    if (!(await this.isExecutionOwned(current))) return 'stale';

    const context = await this.adapters.create(current.task.userId, current.task.buyerShopId);
    await this.rateLimiter.take(context.demo);
    if (!(await this.isExecutionOwned(current))) return 'stale';
    const fetchStartedAt = new Date();
    const product = await context.adapter.fetchProduct(current.offerId);
    if (product && product.productId1688 !== current.offerId) {
      throw new SourceImportItemError('PARSE', '1688 商品详情返回了错误的 offer ID', false);
    }
    const result = product
      ? await this.persistProductAndComplete(current, product, fetchStartedAt)
      : await this.persistNotFoundAndComplete(current, fetchStartedAt);
    if (result === 'processed') await this.refreshTask(current.taskId);
    return result;
  }

  async failClaimedItem(
    item: SourceImportExecutionRecord,
    error: unknown,
  ): Promise<'retry_wait' | 'failed' | 'cancelled' | 'stale'> {
    const cancelled = await this.prisma.sourceImportItem.updateMany({
      where: {
        id: item.id,
        status: 'running',
        attempts: item.attempts,
        lockedBy: item.lockedBy,
        task: {
          cancelRequestedAt: { not: null },
          user: { entitlementAccessStatus: 'active' },
        },
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
    if (error instanceof SourceImportOwnershipLost) return 'stale';

    const classified = classifyFailure(error);
    const failed = !classified.autoRetry || item.attempts >= item.maxAttempts;
    const updated = await this.prisma.sourceImportItem.updateMany({
      where: ownedItemWhere(item),
      data: {
        status: failed ? 'failed' : 'retry_wait',
        nextRunAt: failed ? item.nextRunAt : new Date(Date.now() + retryDelayMs(item.attempts)),
        lockedAt: null,
        lockedBy: null,
        errorCode: classified.code,
        errorMessage: classified.message.slice(0, 1000),
        ...(failed ? { finishedAt: new Date() } : {}),
      },
    });
    if (updated.count !== 1) return 'stale';
    await this.refreshTask(item.taskId);
    return failed ? 'failed' : 'retry_wait';
  }

  private async persistProductAndComplete(
    item: SourceImportExecutionRecord,
    product: CrawledProduct,
    fetchStartedAt: Date,
  ): Promise<'processed' | 'stale'> {
    const snapshot = inventorySnapshot(product);
    return this.withSerializableTransaction(async (tx) => {
      await assertOwnedInTransaction(tx, item);
      const existing = await tx.sourceProduct.findUnique({
        where: { productId1688: product.productId1688 },
        select: STORED_SOURCE_PRODUCT_SELECT,
      });
      const now = new Date();
      if (existing && existing.syncedAt.getTime() >= fetchStartedAt.getTime()) {
        await this.collectStoredProductAndComplete(
          tx,
          item,
          existing,
          now,
          'stale_response_ignored',
        );
        return 'processed' as const;
      }
      const inventoryChanged = existing?.inventoryFingerprint !== snapshot.fingerprint;
      const inventoryVersion = inventoryChanged
        ? (existing?.inventoryVersion ?? 0) + 1
        : (existing?.inventoryVersion ?? 1);
      // syncedAt is the remote observation fence, not transaction commit time. Reusing this
      // captured value across Serializable retries prevents an older response from becoming new.
      const data = sourceProductData(product, snapshot, inventoryVersion, fetchStartedAt);
      const stored = await tx.sourceProduct.upsert({
        where: { productId1688: product.productId1688 },
        create: { ...data, availabilityChangedAt: now },
        update: {
          ...data,
          ...(existing?.availability !== snapshot.availability
            ? { availabilityChangedAt: now }
            : {}),
        },
        select: STORED_SOURCE_PRODUCT_SELECT,
      });
      await queueInventorySync(tx, stored.id, snapshot.fingerprint, inventoryVersion, now);
      await this.collectStoredProductAndComplete(
        tx,
        item,
        stored,
        now,
        existing ? 'refreshed' : 'created',
      );
      return 'processed' as const;
    });
  }

  private async persistNotFoundAndComplete(
    item: SourceImportExecutionRecord,
    fetchStartedAt: Date,
  ): Promise<'processed' | 'stale'> {
    return this.withSerializableTransaction(async (tx) => {
      await assertOwnedInTransaction(tx, item);
      const existing = await tx.sourceProduct.findUnique({
        where: { productId1688: item.offerId },
        select: STORED_SOURCE_PRODUCT_SELECT,
      });
      const now = new Date();
      if (existing && existing.syncedAt.getTime() >= fetchStartedAt.getTime()) {
        await this.collectStoredProductAndComplete(
          tx,
          item,
          existing,
          now,
          'stale_response_ignored',
        );
        return 'processed' as const;
      }
      if (!existing) {
        const skipped = await tx.sourceImportItem.updateMany({
          where: ownedItemWhere(item),
          data: {
            status: 'skipped',
            result: { reason: 'not_found' },
            errorCode: 'NOT_FOUND',
            errorMessage: '1688 商品不存在或已下架',
            lockedAt: null,
            lockedBy: null,
            finishedAt: now,
          },
        });
        if (skipped.count !== 1) throw new SourceImportOwnershipLost();
        return 'processed' as const;
      }

      const offline = offlineInventorySnapshot(item.offerId);
      const inventoryChanged = existing.inventoryFingerprint !== offline.fingerprint;
      const inventoryVersion = inventoryChanged
        ? existing.inventoryVersion + 1
        : existing.inventoryVersion;
      const stored = await tx.sourceProduct.update({
        where: { id: existing.id },
        data: {
          availability: 'offline',
          totalStock: 0,
          inventoryFingerprint: offline.fingerprint,
          inventoryVersion,
          syncedAt: fetchStartedAt,
          ...(existing.availability !== 'offline' ? { availabilityChangedAt: now } : {}),
        },
        select: STORED_SOURCE_PRODUCT_SELECT,
      });
      await queueInventorySync(tx, stored.id, offline.fingerprint, inventoryVersion, now);
      await this.collectStoredProductAndComplete(tx, item, stored, now, 'offline_existing');
      return 'processed' as const;
    });
  }

  private async collectStoredProductAndComplete(
    tx: Prisma.TransactionClient,
    item: SourceImportExecutionRecord,
    stored: StoredSourceProduct,
    now: Date,
    reason: 'created' | 'refreshed' | 'offline_existing' | 'stale_response_ignored',
  ): Promise<void> {
    const collected = await tx.userSourceProduct.upsert({
      where: {
        uk_user_source_product: {
          userId: item.task.userId,
          sourceProductId: stored.id,
        },
      },
      create: {
        userId: item.task.userId,
        sourceProductId: stored.id,
        firstCollectedAt: now,
        lastCollectedAt: now,
      },
      update: { lastCollectedAt: now },
    });
    const completed = await tx.sourceImportItem.updateMany({
      where: ownedItemWhere(item),
      data: {
        status: 'succeeded',
        sourceProductId: stored.id,
        userSourceProductId: collected.id,
        result: {
          reason,
          sourceProductId: stored.productId1688,
          title: stored.title,
          mainImage: stored.mainImage,
          price: Number(stored.price),
          skuCount: jsonArrayLength(stored.skuList),
          totalStock: stored.totalStock,
          availability: stored.availability,
        },
        errorCode: null,
        errorMessage: null,
        lockedAt: null,
        lockedBy: null,
        finishedAt: now,
      },
    });
    if (completed.count !== 1) throw new SourceImportOwnershipLost();
  }

  private async cancelClaimedItem(
    item: SourceImportExecutionRecord,
  ): Promise<'processed' | 'stale'> {
    const updated = await this.prisma.sourceImportItem.updateMany({
      where: {
        id: item.id,
        status: 'running',
        attempts: item.attempts,
        lockedBy: item.lockedBy,
        task: { user: { entitlementAccessStatus: 'active' } },
      },
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

  private async recoverStaleItems(now: Date): Promise<void> {
    const stale = await this.prisma.sourceImportItem.findMany({
      where: {
        status: 'running',
        lockedAt: { lt: new Date(now.getTime() - STALE_ITEM_MS) },
        task: { user: { entitlementAccessStatus: 'active' } },
      },
      take: 100,
      orderBy: { lockedAt: 'asc' },
      include: { task: true },
    });
    const taskIds = new Set<bigint>();
    for (const item of stale) {
      const cancelled = Boolean(item.task.cancelRequestedAt);
      const failed = !cancelled && item.attempts >= item.maxAttempts;
      const updated = await this.prisma.sourceImportItem.updateMany({
        where: {
          id: item.id,
          status: 'running',
          attempts: item.attempts,
          lockedBy: item.lockedBy,
          task: cancelled
            ? {
                cancelRequestedAt: { not: null },
                user: { entitlementAccessStatus: 'active' },
              }
            : {
                status: { in: ['queued', 'running'] },
                cancelRequestedAt: null,
                user: { entitlementAccessStatus: 'active' },
              },
        },
        data: {
          status: cancelled ? 'cancelled' : failed ? 'failed' : 'retry_wait',
          nextRunAt: now,
          lockedAt: null,
          lockedBy: null,
          errorCode: cancelled ? null : 'WORKER_STALE',
          errorMessage: cancelled ? null : '货源采集 worker 超时，已安全恢复',
          ...((cancelled || failed) && { finishedAt: now }),
        },
      });
      if (updated.count === 1) taskIds.add(item.taskId);
    }
    for (const taskId of taskIds) await this.refreshTask(taskId);
  }

  private async reconcileFinishedTasks(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTaskReconcileAt < TASK_RECONCILE_INTERVAL_MS) return;
    this.lastTaskReconcileAt = now;
    const tasks = await this.prisma.sourceImportTask.findMany({
      where: {
        ...(this.lastTaskReconcileCursor ? { id: { gt: this.lastTaskReconcileCursor } } : {}),
        confirmedAt: { not: null },
        status: { in: ['queued', 'running', 'cancelling', ...TERMINAL_TASK_STATUSES] },
        user: { entitlementAccessStatus: 'active' },
      },
      take: 100,
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    for (const task of tasks) await this.refreshTask(task.id);
    this.lastTaskReconcileCursor = tasks.length === 100 ? (tasks.at(-1)?.id ?? null) : null;
  }

  private async refreshTask(taskId: bigint): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const task = await this.prisma.sourceImportTask.findUnique({
        where: { id: taskId },
        include: { items: { select: { status: true } } },
      });
      if (!task || (!task.confirmedAt && task.status === 'preview')) return;
      const summary = summarizeStatuses(task.items.map((item) => item.status));
      const active = summary.pending + summary.running + summary.retryWait;
      let status: Prisma.SourceImportTaskUpdateInput['status'];
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
        ) {
          status = 'cancelled';
        } else if (summary.failed > 0 && summary.succeeded === 0 && summary.skipped === 0) {
          status = 'failed';
        } else {
          status = 'partial';
        }
      }
      const nextFinishedAt = active > 0 ? null : (task.finishedAt ?? finishedAt);
      if (task.status === status && sameInstant(task.finishedAt, nextFinishedAt)) return;
      const changed = await this.prisma.sourceImportTask.updateMany({
        where: {
          id: task.id,
          stateRevision: task.stateRevision,
          user: { entitlementAccessStatus: 'active' },
        },
        data: {
          status,
          stateRevision: { increment: 1 },
          finishedAt: nextFinishedAt,
        },
      });
      if (changed.count === 1) return;
    }
  }

  private async isExecutionOwned(item: SourceImportExecutionRecord): Promise<boolean> {
    const owned = await this.prisma.sourceImportItem.findFirst({
      where: ownedItemWhere(item),
      select: { id: true },
    });
    return Boolean(owned);
  }

  private async requireTask(userId: bigint, taskId: bigint): Promise<SourceImportTaskRecord> {
    const task = await this.prisma.sourceImportTask.findFirst({
      where: { id: taskId, userId },
      include: TASK_INCLUDE,
    });
    if (!task) throw new NotFoundException('采集任务不存在');
    return task;
  }

  private async findByClientRequestId(
    userId: bigint,
    clientRequestId: string,
  ): Promise<SourceImportTaskRecord | null> {
    return this.prisma.sourceImportTask.findUnique({
      where: { uk_source_import_user_client_request: { userId, clientRequestId } },
      include: TASK_INCLUDE,
    });
  }

  private assertExecutionEnabled(): void {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException('批量执行 worker 尚未启用，请联系管理员');
    }
  }

  private maxAttempts(): number {
    const value = Number(this.config.get<string>('SOURCE_IMPORT_MAX_ATTEMPTS') ?? 3);
    return Number.isInteger(value) && value >= 1 && value <= 10 ? value : 3;
  }

  private async withSerializableTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.prisma.$transaction(operation, { isolationLevel: 'Serializable' });
      } catch (error) {
        lastError = error;
        if (error instanceof SourceImportOwnershipLost || !isConcurrentWriteError(error)) {
          throw error;
        }
      }
    }
    throw lastError;
  }
}

class SourceImportItemError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly autoRetry: boolean,
  ) {
    super(message);
  }
}

class SourceImportOwnershipLost extends Error {}

async function assertOwnedInTransaction(
  tx: Prisma.TransactionClient,
  item: SourceImportExecutionRecord,
): Promise<void> {
  const owned = await tx.sourceImportItem.findFirst({
    where: ownedItemWhere(item),
    select: { id: true },
  });
  if (!owned) throw new SourceImportOwnershipLost();
}

function ownedItemWhere(item: SourceImportExecutionRecord): Prisma.SourceImportItemWhereInput {
  return {
    id: item.id,
    status: 'running',
    attempts: item.attempts,
    lockedBy: item.lockedBy,
    task: {
      status: { in: ['queued', 'running'] },
      cancelRequestedAt: null,
      user: { entitlementAccessStatus: 'active' },
    },
  };
}

function ownedItem(current: SourceImportExecutionRecord, claimed: SourceImportExecutionRecord) {
  return (
    current.id === claimed.id &&
    current.status === 'running' &&
    current.attempts === claimed.attempts &&
    current.lockedBy === claimed.lockedBy
  );
}

function toTaskView(task: SourceImportTaskRecord): SourceImportTaskView {
  return {
    taskId: task.id.toString(),
    clientRequestId: task.clientRequestId,
    buyerShopId: task.buyerShopId?.toString() ?? null,
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
      const result = jsonRecord(item.result);
      const source = item.sourceProduct;
      const existing = before?.existing === true;
      const collected = before?.collected === true || item.userSourceProductId !== null;
      return {
        itemId: item.id.toString(),
        reference: stringValue(before?.reference) ?? item.offerId,
        offerId: item.offerId,
        action: existing ? 'refresh' : 'create',
        existing,
        collected,
        status: item.status,
        attempts: item.attempts,
        maxAttempts: item.maxAttempts,
        retryable: item.status === 'failed' && isManuallyRetryable(item.errorCode),
        sourceProductId: source?.productId1688 ?? stringValue(result?.sourceProductId),
        title: source?.title ?? stringValue(result?.title),
        mainImage: source?.mainImage ?? stringValue(result?.mainImage),
        price: source ? Number(source.price) : numberValue(result?.price),
        skuCount: integerValue(result?.skuCount) ?? integerValue(before?.skuCount),
        totalStock: source?.totalStock ?? integerValue(result?.totalStock),
        availability: source?.availability ?? stringValue(result?.availability),
        errorCode: item.errorCode,
        errorMessage: item.errorMessage,
        result,
        startedAt: item.startedAt?.toISOString() ?? null,
        finishedAt: item.finishedAt?.toISOString() ?? null,
      };
    }),
  };
}

function summarizeStatuses(statuses: string[]): SourceImportSummary {
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

function sourceImportFingerprint(offerIds: string[], buyerShopId: bigint | null): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        buyerShopId: buyerShopId?.toString() ?? null,
        offerIds: [...offerIds].sort(),
      }),
    )
    .digest('hex');
}

function assertSameRequest(
  task: SourceImportTaskRecord,
  fingerprint: string,
  buyerShopId: bigint | null,
): void {
  if (task.requestFingerprint === fingerprint && task.buyerShopId === buyerShopId) return;
  throw new ConflictException('该请求标识已用于不同的采集操作，请生成新标识');
}

function sourceProductData(
  product: CrawledProduct,
  snapshot: ReturnType<typeof inventorySnapshot>,
  inventoryVersion: number,
  syncedAt: Date,
): Prisma.SourceProductUncheckedCreateInput {
  return {
    productId1688: product.productId1688,
    supplierId: product.supplierId,
    title: product.title,
    price: product.price,
    priceMin: product.priceMin,
    priceMax: product.priceMax,
    mainImage: product.mainImage,
    detailImages: (product.detailImages ?? []) as Prisma.InputJsonValue,
    categoryPath: product.categoryPath,
    categoryL1: product.categoryL1,
    categoryL2: product.categoryL2,
    skuList: (product.skuList ?? []) as unknown as Prisma.InputJsonValue,
    attributes: {
      ...(product.attributes ?? {}),
      signals: product.signals ?? {},
    } as unknown as Prisma.InputJsonValue,
    monthlySold: product.monthlySold ?? 0,
    isCrossBorder: product.isCrossBorder ?? false,
    isOnePieceDrop: product.isOnePieceDrop ?? false,
    availability: snapshot.availability,
    totalStock: snapshot.totalStock,
    inventoryFingerprint: snapshot.fingerprint,
    inventoryVersion,
    syncedAt,
  };
}

async function queueInventorySync(
  tx: Prisma.TransactionClient,
  sourceProductId: bigint,
  targetFingerprint: string,
  targetVersion: number,
  now: Date,
): Promise<void> {
  const changed = [
    { inventoryTargetFingerprint: null },
    { inventoryTargetFingerprint: { not: targetFingerprint } },
    { inventoryTargetVersion: { not: targetVersion } },
  ];
  await tx.publishedProduct.updateMany({
    where: { sourceProductId, status: 'online', OR: changed },
    data: {
      inventorySyncStatus: 'pending',
      inventoryTargetFingerprint: targetFingerprint,
      inventoryTargetVersion: targetVersion,
      inventorySyncAttempts: 0,
      inventoryNextRunAt: now,
      inventoryLockedAt: null,
      inventoryLockedBy: null,
      inventorySyncError: null,
    },
  });
  await tx.publishedProduct.updateMany({
    where: { sourceProductId, status: { not: 'online' }, OR: changed },
    data: {
      inventoryTargetFingerprint: targetFingerprint,
      inventoryTargetVersion: targetVersion,
    },
  });
}

function classifyFailure(error: unknown): {
  code: string;
  message: string;
  autoRetry: boolean;
} {
  if (error instanceof SourceImportItemError) {
    return { code: error.code, message: error.message, autoRetry: error.autoRetry };
  }
  if (error instanceof CrawlerError) {
    if (error.code === 'rate_limited') {
      return { code: 'RATE_LIMITED', message: error.message, autoRetry: true };
    }
    if (error.code === 'network') {
      return { code: 'NETWORK', message: error.message, autoRetry: true };
    }
    if (error.code === 'auth') {
      return { code: 'AUTH', message: '1688 授权已失效，请重新授权后手工重试', autoRetry: false };
    }
    if (error.code === 'parse') {
      return { code: 'PARSE', message: error.message, autoRetry: false };
    }
    return { code: 'PLATFORM_ERROR', message: error.message, autoRetry: false };
  }
  if (error instanceof ServiceUnavailableException) {
    return { code: 'INFRASTRUCTURE', message: error.message, autoRetry: true };
  }
  if (isPrismaError(error)) {
    return {
      code: 'DATABASE_ERROR',
      message: '货源采集暂时不可用，请稍后重试',
      autoRetry: true,
    };
  }
  return {
    code: 'PLATFORM_ERROR',
    message: '1688 货源采集失败，请稍后重试',
    autoRetry: true,
  };
}

function isManuallyRetryable(code: string | null): boolean {
  return code !== null && MANUALLY_RETRYABLE_CODES.has(code);
}

function retryDelayMs(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

function parsePositiveId(value: string, label: string): bigint {
  if (!/^[1-9]\d{0,18}$/.test(value)) throw new BadRequestException(`${label}无效`);
  const id = BigInt(value);
  if (id > 9_223_372_036_854_775_807n) throw new BadRequestException(`${label}无效`);
  return id;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'P2002';
}

function isConcurrentWriteError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'P2034' || code === 'P2002';
}

function isPrismaError(error: unknown): boolean {
  return /^P\d{4}$/.test(String((error as { code?: unknown } | null)?.code ?? ''));
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function jsonArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function integerValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function sameInstant(left: Date | null, right: Date | null): boolean {
  return left === null ? right === null : right !== null && left.getTime() === right.getTime();
}
