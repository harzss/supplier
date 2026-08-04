import {
  BadRequestException,
  Inject,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OrderAfterSaleStatus, Prisma, Shop } from '@supplier/db';
import type { PlatformOrder } from '@supplier/platform-sdk';
import type Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { CryptoService } from '../../common/crypto.module';
import { PrismaService } from '../../common/prisma.module';
import { REDIS_CLIENT } from '../../common/redis.module';
import { AfterSaleService } from '../after-sale/after-sale.service';
import type { CurrentUser } from '../entitlement/user-context.service';
import {
  findSourceBindingRoute,
  type SourceBindingRoute,
  SourceBindingValidationError,
} from '../publish/source-binding';
import { PlatformAdapterFactory, runtimeShopWhere } from '../shop/platform-adapter.factory';
import { ShopTokenService } from '../shop/shop-token.service';
import { maskReceiverName } from './order.service';
import { isTerminalOrderStatus, markPurchaseExceptionsForOrderEvent } from './purchase-exception';

type SyncedOrderStatus = 'paid' | 'shipped' | 'received' | 'refunded' | 'closed';

const ORDER_STATUS_FILTER = '105,2,101,3,4,5';
const PAGE_SIZE = 100;
const SYNC_LOCK_TTL_MS = 15 * 60 * 1000;

interface OrderRoutingBinding {
  id: bigint;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  sourceOfferId: string;
  sourceSupplierId: string | null;
  sourceOnePieceDrop: boolean;
  skuRoutes: Prisma.JsonValue;
}

interface PublishedProductOrderRouting {
  id: bigint;
  platformProductId: string | null;
  sourceProduct: { productId1688: string; supplierId: string | null };
  sourceBindings: OrderRoutingBinding[];
}

export interface OrderSyncResult {
  shopId: string;
  synced: number;
  skipped: number;
}

export interface OrderRefreshResult {
  orderId: string;
  status: string;
  afterSaleStatus: OrderAfterSaleStatus;
}

@Injectable()
export class OrderSyncService {
  private readonly logger = new Logger('OrderSync');
  private readonly demoMode: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly shopTokens: ShopTokenService,
    private readonly adapters: PlatformAdapterFactory,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly afterSales: AfterSaleService,
  ) {
    this.demoMode = (config.get<string>('AUTH_MODE') ?? 'demo') === 'demo';
  }

  async sync(user: CurrentUser, shopId: string): Promise<OrderSyncResult> {
    const id = parseId(shopId);
    return this.syncShop(user.userId, id);
  }

  async syncShop(userId: bigint, id: bigint): Promise<OrderSyncResult> {
    const shop = await this.prisma.shop.findFirst({
      where: { id, userId, status: 'active', ...runtimeShopWhere(this.demoMode) },
    });
    if (!shop) throw new NotFoundException('店铺不存在或授权已失效');

    const lock = await this.acquireSyncLock(shop.id);
    if (!lock) throw new ServiceUnavailableException('该店铺订单正在同步，请稍后重试');
    const attemptedAt = new Date();

    try {
      await this.prisma.shop.update({
        where: { id: shop.id },
        data: { orderSyncAttemptAt: attemptedAt, orderSyncError: null },
      });
      const result = await this.pullOrders(shop, attemptedAt, lock);
      const completed = await this.prisma.shop.updateMany({
        where: {
          id: shop.id,
          status: 'active',
          orderSyncAttemptAt: attemptedAt,
        },
        data: {
          lastOrderSyncAt: attemptedAt,
          orderSyncAttemptAt: attemptedAt,
          orderSyncError: null,
        },
      });
      if (completed.count !== 1) {
        throw new ServiceUnavailableException('订单同步执行权已失效，请由当前任务继续');
      }
      return result;
    } catch (error) {
      await this.recordSyncFailure(shop.id, attemptedAt, error);
      throw error;
    } finally {
      await this.releaseSyncLock(shop.id, lock);
    }
  }

  async refreshOrder(user: CurrentUser, orderIdValue: string): Promise<OrderRefreshResult> {
    const orderId = parseOrderId(orderIdValue);
    const local = await this.prisma.order.findFirst({
      where: {
        id: orderId,
        shop: {
          userId: user.userId,
          status: 'active',
          ...runtimeShopWhere(this.demoMode),
        },
      },
      include: { shop: true },
    });
    if (!local) throw new NotFoundException('订单不存在或店铺授权已失效');
    const lock = await this.acquireSyncLock(local.shopId);
    if (!lock) throw new ServiceUnavailableException('该店铺订单正在同步，请稍后重试');
    try {
      const adapter = this.adapters.create(local.shop);
      if (!adapter.getOrder) throw new BadRequestException('当前平台暂不支持订单即时刷新');
      const accessToken = local.shop.accessTokenEnc
        ? await this.shopTokens.getAccessToken(local.shop.id, user.userId)
        : 'mock-token';
      await this.renewSyncLock(local.shopId, lock);
      const platformOrder = await adapter.getOrder(accessToken, local.platformOrderId);
      await this.renewSyncLock(local.shopId, lock);
      if (platformOrder.platformOrderId !== local.platformOrderId) {
        throw new ServiceUnavailableException(
          '平台订单详情与请求订单不一致，已停止刷新并保留原状态',
        );
      }
      await this.upsertOrders(local.shopId, [platformOrder]);
      const refreshed = await this.prisma.order.findUnique({
        where: { id: local.id },
        select: { status: true, afterSaleStatus: true },
      });
      if (!refreshed) throw new NotFoundException('订单不存在');
      return {
        orderId: local.id.toString(),
        status: refreshed.status,
        afterSaleStatus: refreshed.afterSaleStatus,
      };
    } finally {
      await this.releaseSyncLock(local.shopId, lock);
    }
  }

  private async pullOrders(
    shop: Pick<
      Shop,
      'id' | 'userId' | 'platform' | 'platformShopId' | 'accessTokenEnc' | 'lastOrderSyncAt'
    >,
    syncEnd: Date,
    lock: string,
  ): Promise<OrderSyncResult> {
    const overlapMs = Number(this.config.get('DOUYIN_ORDER_SYNC_OVERLAP_SECONDS') ?? 300) * 1000;
    const lookbackMs =
      Number(this.config.get('DOUYIN_ORDER_SYNC_LOOKBACK_DAYS') ?? 30) * 86_400_000;
    const previousSyncMs = shop.lastOrderSyncAt?.getTime();
    const syncStart = new Date(
      previousSyncMs === undefined
        ? syncEnd.getTime() - lookbackMs
        : Math.min(previousSyncMs, syncEnd.getTime()) - overlapMs,
    );
    const maxPages = Number(this.config.get('DOUYIN_ORDER_SYNC_MAX_PAGES') ?? 100);

    const adapter = this.adapters.create(shop);
    const accessToken = shop.accessTokenEnc
      ? await this.shopTokens.getAccessToken(shop.id, shop.userId)
      : 'mock-token';

    let synced = 0;
    let skipped = 0;
    const seenOrderIds = new Set<string>();
    for (let page = 0; page < maxPages; page++) {
      await this.renewSyncLock(shop.id, lock);
      const platformOrders = await adapter.listOrders(accessToken, {
        cursor: String(page),
        pageSize: PAGE_SIZE,
        status: ORDER_STATUS_FILTER,
        startTime: syncStart,
        endTime: syncEnd,
      });
      await this.renewSyncLock(shop.id, lock);
      const freshOrders = platformOrders.filter((order) => {
        if (seenOrderIds.has(order.platformOrderId)) return false;
        seenOrderIds.add(order.platformOrderId);
        return true;
      });
      const pageResult = await this.upsertOrders(shop.id, freshOrders);
      synced += pageResult.synced;
      skipped += pageResult.skipped;
      if (platformOrders.length < PAGE_SIZE) {
        return { shopId: shop.id.toString(), synced, skipped };
      }
    }
    throw new ServiceUnavailableException(
      `订单同步超过 ${maxPages} 页安全上限，未推进同步水位；请调大 DOUYIN_ORDER_SYNC_MAX_PAGES 后重试`,
    );
  }

  private async upsertOrders(
    shopId: bigint,
    platformOrders: PlatformOrder[],
  ): Promise<{ synced: number; skipped: number }> {
    const platformStatuses = platformOrders.map((order) => {
      const status = syncedStatus(order.status);
      if (!status) {
        throw new ServiceUnavailableException('平台返回未支持的订单状态，已停止更新并保留原状态');
      }
      return status;
    });
    let synced = 0;
    for (const [index, order] of platformOrders.entries()) {
      const platformStatus = platformStatuses[index]!;
      const afterSaleStatus = summarizeAfterSale(order.skuList);
      const status = afterSaleStatus === 'refunded' ? 'refunded' : platformStatus;
      await this.upsertOrder(shopId, order, status, afterSaleStatus);
      synced++;
    }

    return { synced, skipped: 0 };
  }

  private async acquireSyncLock(shopId: bigint): Promise<string | null> {
    const value = randomUUID();
    try {
      const stored = await this.redis.set(
        `orders:sync:${shopId}`,
        value,
        'PX',
        SYNC_LOCK_TTL_MS,
        'NX',
      );
      return stored === 'OK' ? value : null;
    } catch {
      this.logger.warn(`店铺 ${shopId} 订单同步锁不可用`);
      throw new ServiceUnavailableException('订单同步依赖 Redis，不可用时拒绝执行');
    }
  }

  private async releaseSyncLock(shopId: bigint, value: string): Promise<void> {
    try {
      await this.redis.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
        1,
        `orders:sync:${shopId}`,
        value,
      );
    } catch {
      this.logger.warn(`店铺 ${shopId} 订单同步锁释放失败`);
    }
  }

  private async renewSyncLock(shopId: bigint, value: string): Promise<void> {
    let renewed: unknown;
    try {
      renewed = await this.redis.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end',
        1,
        `orders:sync:${shopId}`,
        value,
        String(SYNC_LOCK_TTL_MS),
      );
    } catch {
      this.logger.warn(`店铺 ${shopId} 订单同步锁续租失败`);
      throw new ServiceUnavailableException('订单同步依赖 Redis，不可用时拒绝执行');
    }
    if (renewed !== 1) {
      throw new ServiceUnavailableException('订单同步执行权已失效，请由当前任务继续');
    }
  }

  private async recordSyncFailure(
    shopId: bigint,
    attemptedAt: Date,
    error: unknown,
  ): Promise<void> {
    const internalMessage = error instanceof Error ? error.message : 'unknown error';
    this.logger.error(`店铺 ${shopId} 订单同步失败：${internalMessage}`);
    try {
      await this.prisma.shop.updateMany({
        where: { id: shopId, orderSyncAttemptAt: attemptedAt },
        data: {
          orderSyncAttemptAt: attemptedAt,
          orderSyncError: publicSyncError(error),
        },
      });
    } catch (recordError) {
      this.logger.error(
        `店铺 ${shopId} 同步失败状态写入失败：${recordError instanceof Error ? recordError.message : 'unknown error'}`,
      );
    }
  }

  private async upsertOrder(
    shopId: bigint,
    order: PlatformOrder,
    status: SyncedOrderStatus,
    afterSaleStatus: OrderAfterSaleStatus,
  ): Promise<void> {
    const receiverPhoneEnc = order.receiverPhone ? this.crypto.encrypt(order.receiverPhone) : null;
    const receiverNameEnc = order.receiverName ? this.crypto.encrypt(order.receiverName) : null;
    const receiverAddressEnc = order.receiverAddress
      ? this.crypto.encrypt(order.receiverAddress)
      : null;
    const receiverAddressDetailEnc = order.receiverAddressDetail
      ? this.crypto.encrypt(JSON.stringify(order.receiverAddressDetail))
      : null;
    const partialRefundFingerprint = afterSaleFingerprint(order.skuList);
    const sharedOrderData = {
      amount: order.amount,
      afterSaleStatus,
      afterSaleSyncedAt: new Date(),
      buyerNick: order.buyerNick || null,
      paidAt: order.paidAt,
      receiverAddressEnc,
      receiverAddressDetailEnc,
      receiverName: order.receiverName ? maskReceiverName(order.receiverName) : null,
      receiverNameEnc,
      receiverPhoneEnc,
      skuInfo: order.skuList as unknown as Prisma.InputJsonValue,
    };
    await this.withSerializableTransaction(async (tx) => {
      const productIds = [
        ...new Set(
          order.skuList
            .map((sku) => sku.platformProductId)
            .filter((value): value is string => !!value),
        ),
      ];
      const publishedProducts = productIds.length
        ? await tx.publishedProduct.findMany({
            where: { shopId, platformProductId: { in: productIds } },
            select: {
              id: true,
              platformProductId: true,
              sourceProduct: { select: { productId1688: true, supplierId: true } },
              sourceBindings: {
                orderBy: [{ effectiveFrom: 'asc' }, { revision: 'asc' }],
                select: {
                  id: true,
                  effectiveFrom: true,
                  effectiveTo: true,
                  sourceOfferId: true,
                  sourceSupplierId: true,
                  sourceOnePieceDrop: true,
                  skuRoutes: true,
                },
              },
            },
          })
        : [];
      const publishedByPlatformId = new Map(
        publishedProducts.flatMap((product) =>
          product.platformProductId ? [[product.platformProductId, product] as const] : [],
        ),
      );
      const publishedProductId = order.skuList.flatMap((sku) => {
        const published = sku.platformProductId
          ? publishedByPlatformId.get(sku.platformProductId)
          : undefined;
        return published ? [published.id] : [];
      })[0];
      const shared = { ...sharedOrderData, publishedProductId };
      const existing = await tx.order.findUnique({
        where: { shopId_platformOrderId: { shopId, platformOrderId: order.platformOrderId } },
        select: {
          id: true,
          amount: true,
          status: true,
          partialRefundFingerprint: true,
          items: { select: { platformOrderItemId: true } },
          purchaseOrders: { take: 1, select: { id: true } },
        },
      });
      const nextStatus = reconcileOrderStatus(existing?.status, status);
      const partialRefundChanged =
        afterSaleStatus === 'partial_refund' &&
        existing?.partialRefundFingerprint !== partialRefundFingerprint;
      const refundBasisChanged =
        existing !== null &&
        existing !== undefined &&
        (existing.partialRefundFingerprint !== partialRefundFingerprint ||
          Number(existing.amount) !== order.amount);
      const partialRefundData = {
        partialRefundFingerprint,
        ...(afterSaleStatus !== 'partial_refund' || partialRefundChanged
          ? {
              partialRefundDisposition: 'none' as const,
              partialRefundDispositionAt: null,
              partialRefundDispositionNote: null,
            }
          : {}),
        ...(refundBasisChanged
          ? {
              refundAmount: null,
              refundAmountFingerprint: null,
              refundAmountConfirmedAt: null,
              refundAmountNote: null,
            }
          : {}),
      };
      const storedOrder = await tx.order.upsert({
        where: {
          shopId_platformOrderId: { shopId, platformOrderId: order.platformOrderId },
        },
        create: {
          ...shared,
          ...partialRefundData,
          shopId,
          platformOrderId: order.platformOrderId,
          status,
        },
        update: { ...shared, ...partialRefundData, status: nextStatus },
        select: { id: true },
      });
      if (
        isTerminalOrderStatus(nextStatus) &&
        (existing?.status !== nextStatus || refundBasisChanged)
      ) {
        await markPurchaseExceptionsForOrderEvent(tx, storedOrder.id, nextStatus);
      } else if (partialRefundChanged) {
        await markPurchaseExceptionsForOrderEvent(tx, storedOrder.id, 'partial_refund');
      }
      if (existing?.purchaseOrders.length) {
        const incomingItemIds = order.skuList.map((sku) => sku.platformOrderItemId);
        const incomingItemIdSet = new Set(incomingItemIds);
        const storedItemIdSet = new Set(existing.items.map((item) => item.platformOrderItemId));
        if (
          incomingItemIdSet.size !== incomingItemIds.length ||
          incomingItemIdSet.size !== storedItemIdSet.size ||
          [...incomingItemIdSet].some((itemId) => !storedItemIdSet.has(itemId))
        ) {
          throw new ServiceUnavailableException(
            '平台订单子单与采购快照不一致，已停止同步并保留原状态',
          );
        }
        for (const sku of order.skuList) {
          const updated = await tx.orderItem.updateMany({
            where: {
              orderId: storedOrder.id,
              platformOrderItemId: sku.platformOrderItemId,
            },
            data: {
              afterSaleStatusRaw: sku.afterSaleStatus ?? null,
              afterSaleTypeRaw: sku.afterSaleType ?? null,
              refundStatusRaw: sku.refundStatus ?? null,
            },
          });
          if (updated.count !== 1) {
            throw new ServiceUnavailableException(
              '平台订单子单售后状态未能完整更新，已停止同步并保留原状态',
            );
          }
        }
        await this.afterSales.materializeOrder(tx, storedOrder.id);
        return;
      }

      const itemIds = order.skuList.map((sku) => sku.platformOrderItemId);
      await tx.orderItem.deleteMany({
        where: {
          orderId: storedOrder.id,
          ...(itemIds.length ? { platformOrderItemId: { notIn: itemIds } } : {}),
        },
      });
      for (const sku of order.skuList) {
        const published = sku.platformProductId
          ? publishedByPlatformId.get(sku.platformProductId)
          : undefined;
        const source = resolveOrderItemSourceSnapshot(published, sku, order.paidAt);
        const data = {
          publishedProductId: published?.id,
          platformProductId: sku.platformProductId,
          platformSkuId: sku.skuId,
          ...source,
          afterSaleStatusRaw: sku.afterSaleStatus ?? null,
          afterSaleTypeRaw: sku.afterSaleType ?? null,
          refundStatusRaw: sku.refundStatus ?? null,
          title: sku.title,
          quantity: sku.quantity,
          unitPrice: sku.unitPrice,
          specs: (sku.specs ?? undefined) as Prisma.InputJsonValue | undefined,
        };
        await tx.orderItem.upsert({
          where: {
            uk_order_platform_item: {
              orderId: storedOrder.id,
              platformOrderItemId: sku.platformOrderItemId,
            },
          },
          create: {
            ...data,
            orderId: storedOrder.id,
            platformOrderItemId: sku.platformOrderItemId,
          },
          update: data,
        });
      }
      await this.afterSales.materializeOrder(tx, storedOrder.id);
    });
  }

  private async withSerializableTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, { isolationLevel: 'Serializable' });
      } catch (error) {
        if (isSerializationConflict(error) && attempt < 3) continue;
        throw error;
      }
    }
    throw new ServiceUnavailableException('订单快照更新失败，请稍后重试');
  }
}

interface OrderItemSourceSnapshot {
  sourceBindingId: bigint | null;
  sourceOfferId: string | null;
  sourceSupplierId: string | null;
  sourceSpecId: string | null;
  sourceSpecRequired: boolean;
  sourceUnitCost: number | null;
  sourceOnePieceDrop: boolean | null;
}

function resolveOrderItemSourceSnapshot(
  published: PublishedProductOrderRouting | undefined,
  sku: PlatformOrder['skuList'][number],
  paidAt: Date,
): OrderItemSourceSnapshot {
  const legacy = (): OrderItemSourceSnapshot => ({
    sourceBindingId: null,
    sourceOfferId: published?.sourceProduct.productId1688 ?? null,
    sourceSupplierId: published?.sourceProduct.supplierId ?? null,
    sourceSpecId: sku.sourceSkuId && sku.sourceSkuId !== 'default' ? sku.sourceSkuId : null,
    sourceSpecRequired: Object.keys(sku.specs ?? {}).length > 0,
    sourceUnitCost: null,
    sourceOnePieceDrop: null,
  });
  if (!published || published.sourceBindings.length === 0) return legacy();

  const paidAtMs = paidAt.getTime();
  if (!Number.isFinite(paidAtMs)) {
    throw new ServiceUnavailableException('平台订单付款时间无效，无法匹配货源绑定');
  }
  const matching = published.sourceBindings.filter(
    (binding) =>
      binding.effectiveFrom.getTime() <= paidAtMs &&
      (binding.effectiveTo === null || paidAtMs < binding.effectiveTo.getTime()),
  );
  if (matching.length !== 1) {
    throw new ServiceUnavailableException(
      matching.length === 0
        ? '订单付款时间没有对应的货源绑定，已停止同步以避免错单'
        : '订单付款时间命中多条货源绑定，已停止同步以避免错单',
    );
  }

  const platformSkuKey = sku.sourceSkuId?.trim();
  if (!platformSkuKey) {
    throw new ServiceUnavailableException('平台订单缺少货源绑定所需的外部 SKU key');
  }
  const binding = matching[0]!;
  let route: SourceBindingRoute | null;
  try {
    route = findSourceBindingRoute(binding.skuRoutes, platformSkuKey);
  } catch (error) {
    if (error instanceof SourceBindingValidationError) {
      throw new ServiceUnavailableException(`货源绑定 SKU 路由无效：${error.message}`);
    }
    throw error;
  }
  if (!route) {
    throw new ServiceUnavailableException('平台订单 SKU 没有对应的货源路由，已停止同步以避免错单');
  }
  return {
    sourceBindingId: binding.id,
    sourceOfferId: binding.sourceOfferId,
    sourceSupplierId: binding.sourceSupplierId,
    sourceSpecId: route.sourceSpecId,
    sourceSpecRequired: route.sourceSpecRequired,
    sourceUnitCost: route.sourceUnitCost,
    sourceOnePieceDrop: binding.sourceOnePieceDrop,
  };
}

function reconcileOrderStatus(
  current: SyncedOrderStatus | 'purchasing' | undefined,
  incoming: SyncedOrderStatus,
): SyncedOrderStatus | 'purchasing' {
  if (!current || incoming === 'refunded' || incoming === 'closed') return incoming;
  const rank: Record<Exclude<SyncedOrderStatus, 'refunded' | 'closed'> | 'purchasing', number> = {
    paid: 1,
    purchasing: 2,
    shipped: 3,
    received: 4,
  };
  if (current === 'refunded' || current === 'closed') return current;
  return rank[current] > rank[incoming as keyof typeof rank] ? current : incoming;
}

function parseId(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new NotFoundException('店铺不存在或授权已失效');
  }
}

function parseOrderId(value: string): bigint {
  try {
    const id = BigInt(value);
    if (id <= 0n) throw new Error('invalid');
    return id;
  } catch {
    throw new NotFoundException('订单不存在或店铺授权已失效');
  }
}

function syncedStatus(value: string): SyncedOrderStatus | undefined {
  return ['paid', 'shipped', 'received', 'refunded', 'closed'].includes(value)
    ? (value as SyncedOrderStatus)
    : undefined;
}

function summarizeAfterSale(skus: PlatformOrder['skuList']): OrderAfterSaleStatus {
  if (skus.length === 0) return 'none';
  const refunded = skus.filter(isFulfillmentRefundedSku).length;
  if (refunded === skus.length) return 'refunded';
  if (refunded > 0) return 'partial_refund';
  const activeStatuses = new Set([6, 7, 11, 12, 13, 14, 51, 53]);
  if (
    skus.some(
      (sku) =>
        sku.afterSaleType !== 6 &&
        (sku.refundStatus === 1 ||
          (sku.afterSaleStatus !== undefined && activeStatuses.has(sku.afterSaleStatus))),
    )
  ) {
    return 'pending';
  }
  const failedStatuses = new Set([27, 28, 29]);
  if (
    skus.some(
      (sku) =>
        sku.afterSaleType !== 6 &&
        (sku.refundStatus === 4 ||
          (sku.afterSaleStatus !== undefined && failedStatuses.has(sku.afterSaleStatus))),
    )
  ) {
    return 'failed';
  }
  return 'none';
}

function afterSaleFingerprint(skus: PlatformOrder['skuList']): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        skus
          .map((sku) => [
            sku.platformOrderItemId,
            sku.afterSaleStatus ?? null,
            sku.afterSaleType ?? null,
            sku.refundStatus ?? null,
          ])
          .sort(([left], [right]) => String(left).localeCompare(String(right))),
      ),
    )
    .digest('hex');
}

function isFulfillmentRefundedSku(sku: PlatformOrder['skuList'][number]): boolean {
  return sku.refundStatus === 3 && sku.afterSaleType !== 6;
}

function publicSyncError(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'string') return response.slice(0, 500);
    if (response && typeof response === 'object') {
      const message = (response as { message?: unknown }).message;
      if (typeof message === 'string') return message.slice(0, 500);
      if (Array.isArray(message)) return message.map(String).join('；').slice(0, 500);
    }
  }
  if (error instanceof Error && error.message.startsWith('Douyin ')) {
    return error.message.slice(0, 500);
  }
  return '订单同步失败，请稍后重试';
}

function isSerializationConflict(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'P2034';
}
