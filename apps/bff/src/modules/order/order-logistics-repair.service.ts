import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { OrderLogisticsRepair, Prisma } from '@supplier/db';
import type { PlatformExecutionGuard, ShipPackageDto } from '@supplier/platform-sdk';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/prisma.module';
import { AfterSaleService } from '../after-sale/after-sale.service';
import type { CurrentUser } from '../entitlement/user-context.service';
import { AlertService } from '../observability/alert.service';
import { PlatformAdapterFactory } from '../shop/platform-adapter.factory';
import { ShopTokenService } from '../shop/shop-token.service';
import {
  Alibaba1688PurchaseService,
  type SettledLogisticsRepairProposal,
  type SettledPurchaseShipmentTarget,
} from './alibaba1688-purchase.service';
import { OrderService, type OrderView } from './order.service';

const STALE_REPAIR_LOCK_MS = 5 * 60_000;
export const ORDER_LOGISTICS_REPAIR_HEARTBEAT_MS = 60_000;
const NOOP_AFTER_SALE_MATERIALIZER = {
  materializeOrder: async () => undefined,
} as unknown as AfterSaleService;

@Injectable()
export class OrderLogisticsRepairService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
    private readonly shopTokens: ShopTokenService,
    private readonly adapters: PlatformAdapterFactory,
    private readonly purchases: Alibaba1688PurchaseService,
    private readonly alerts: AlertService,
    private readonly afterSales: AfterSaleService = NOOP_AFTER_SALE_MATERIALIZER,
  ) {}

  async repair(
    user: CurrentUser,
    orderIdValue: string,
    purchaseOrderIdValue: string,
    actualCostValue: number,
    expectedRevisionValue: number,
    noteValue: string,
  ): Promise<OrderView> {
    const orderId = positiveId(orderIdValue, '订单 ID');
    const purchaseOrderId = positiveId(purchaseOrderIdValue, '采购单 ID');
    const actualCost = normalizedNonNegativeMoney(actualCostValue);
    if (!Number.isSafeInteger(expectedRevisionValue) || expectedRevisionValue < 0) {
      throw new BadRequestException('采购异常修订号无效');
    }
    const note = noteValue.trim();
    if (note.length < 2 || note.length > 500) {
      throw new BadRequestException('人工处理说明需为 2～500 个字符');
    }

    const repair = await this.getOrCreateRepair(
      user,
      orderId,
      purchaseOrderId,
      expectedRevisionValue,
      actualCost,
      note,
    );
    if (repair.status === 'completed') {
      await this.resolveAlert(purchaseOrderId, orderId, repair.id);
      return this.orders.getOne(user, orderIdValue);
    }
    assertSameResolution(repair, actualCost, note);

    const lockId = randomUUID();
    const now = new Date();
    const claimed = await this.prisma.orderLogisticsRepair.updateMany({
      where: {
        id: repair.id,
        OR: [
          { status: 'pending' },
          {
            status: 'running',
            lockedAt: { lt: new Date(now.getTime() - STALE_REPAIR_LOCK_MS) },
          },
        ],
      },
      data: {
        status: 'running',
        attempts: { increment: 1 },
        lockedAt: now,
        lockedBy: lockId,
        lastError: null,
      },
    });
    if (claimed.count !== 1) {
      const current = await this.prisma.orderLogisticsRepair.findUnique({
        where: { id: repair.id },
        select: { status: true },
      });
      if (current?.status === 'completed') return this.orders.getOne(user, orderIdValue);
      throw new ConflictException('该订单的物流修复正在执行，请稍后重试');
    }

    const lease = startRepairLease(this.prisma, repair.id, lockId);
    try {
      await lease.guard.assertOwned();
      const order = await this.prisma.order.findFirst({
        where: {
          id: orderId,
          status: { in: ['shipped', 'received'] },
          shop: {
            userId: user.userId,
            platform: 'douyin',
            role: 'seller',
            status: 'active',
            accessTokenEnc: { not: null },
            refreshTokenEnc: { not: null },
            NOT: { platformShopId: { startsWith: 'demo-' } },
          },
        },
        include: { shop: true },
      });
      if (!order) throw new NotFoundException('订单不存在或抖店授权已失效');
      const adapter = this.adapters.create(order.shop);
      if (!adapter.replaceShipPackages) {
        throw new ServiceUnavailableException('当前平台不支持已发货订单物流更新');
      }
      const previousPackages = parsePlatformPackages(repair.previousPlatformPackages);
      const targetPackages = parsePlatformPackages(repair.targetPlatformPackages);
      const targetPurchaseShipments = parsePurchaseShipments(repair.targetPurchaseShipments);
      await lease.guard.assertOwned();
      const accessToken = await this.shopTokens.getAccessToken(order.shop.id, user.userId);
      await lease.guard.assertOwned();
      await adapter.replaceShipPackages(
        accessToken,
        {
          platformOrderId: order.platformOrderId,
          previousPackages,
          targetPackages,
        },
        lease.guard,
      );
      await lease.guard.assertOwned();
      await lease.stop();
      await this.completeRepair(user.userId, repair, lockId, targetPurchaseShipments, new Date());
    } catch (error) {
      await lease.stop();
      await this.prisma.orderLogisticsRepair
        .updateMany({
          where: { id: repair.id, status: 'running', lockedBy: lockId },
          data: {
            status: 'pending',
            lockedAt: null,
            lockedBy: null,
            lastError: safeRepairError(error),
          },
        })
        .catch(() => undefined);
      throw error;
    }

    await this.resolveAlert(purchaseOrderId, orderId, repair.id);
    return this.orders.getOne(user, orderIdValue);
  }

  private resolveAlert(purchaseOrderId: bigint, orderId: bigint, repairId: bigint): Promise<void> {
    return this.alerts.resolve(`purchase_audit.purchase.${purchaseOrderId}`, {
      purchaseOrderId,
      orderId,
      repairId,
    });
  }

  private async getOrCreateRepair(
    user: CurrentUser,
    orderId: bigint,
    purchaseOrderId: bigint,
    exceptionRevision: number,
    actualCost: number,
    note: string,
  ): Promise<OrderLogisticsRepair> {
    const existing = await this.prisma.orderLogisticsRepair.findFirst({
      where: {
        orderId,
        purchaseOrderId,
        exceptionRevision,
        order: { shop: { userId: user.userId } },
      },
      orderBy: { id: 'desc' },
    });
    if (existing) return existing;

    const proposal = await this.purchases.prepareSettledLogisticsRepair(
      user.userId,
      orderId,
      purchaseOrderId,
      exceptionRevision,
    );
    if (actualCost < proposal.priorIncurredCost) {
      throw new BadRequestException('最终实际采购成本不能低于历史失败尝试的已发生成本');
    }
    const repairKey = repairKeyFor(orderId, purchaseOrderId, exceptionRevision, proposal);
    try {
      return await this.prisma.orderLogisticsRepair.create({
        data: {
          repairKey,
          orderId,
          purchaseOrderId,
          operatorUserId: user.userId,
          exceptionRevision,
          purchaseSyncRevision: proposal.purchaseSyncRevision,
          targetFingerprint: proposal.targetFingerprint,
          previousPlatformPackages: platformPackagesJson(proposal.previousPlatformPackages),
          targetPlatformPackages: platformPackagesJson(proposal.targetPlatformPackages),
          targetPurchaseShipments: purchaseShipmentsJson(proposal.targetPurchaseShipments),
          targetPurchaseStatus: proposal.targetPurchaseStatus,
          targetPurchaseCost: proposal.targetPurchaseCost,
          reconciledCost: actualCost,
          resolutionNote: note,
        },
      });
    } catch (error) {
      const raced = await this.prisma.orderLogisticsRepair.findFirst({
        where: { orderId, purchaseOrderId, exceptionRevision },
        orderBy: { id: 'desc' },
      });
      if (raced) return raced;
      throw error;
    }
  }

  private async completeRepair(
    userId: bigint,
    repair: OrderLogisticsRepair,
    lockId: string,
    targetShipments: SettledPurchaseShipmentTarget[],
    completedAt: Date,
  ): Promise<void> {
    await this.withSerializableTransaction(async (tx) => {
      const purchase = await tx.purchaseOrder.findFirst({
        where: {
          id: repair.purchaseOrderId,
          orderId: repair.orderId,
          syncRevision: repair.purchaseSyncRevision,
          exceptionStatus: 'action_required',
          exceptionRevision: repair.exceptionRevision,
          everShipped: true,
          retryEligible: false,
          status: { in: ['shipped', 'received'] },
          order: {
            status: { in: ['shipped', 'received'] },
            shop: { userId },
          },
        },
        include: { shipments: { include: { items: true } } },
      });
      if (!purchase || !purchase.orderId1688) {
        throw new ConflictException('采购异常状态已变化，请刷新订单后重新处理');
      }
      const previousShipments = purchase.shipments.map((shipment) => ({
        trackingNo: shipment.trackingNo,
        carrier: shipment.carrier,
        status: shipment.status,
        items: shipment.items.map((item) => ({
          orderItemId: item.orderItemId.toString(),
          quantity: item.quantity,
        })),
      })) satisfies Prisma.InputJsonValue;
      const updated = await tx.purchaseOrder.updateMany({
        where: {
          id: repair.purchaseOrderId,
          orderId: repair.orderId,
          syncRevision: repair.purchaseSyncRevision,
          exceptionStatus: 'action_required',
          exceptionRevision: repair.exceptionRevision,
          everShipped: true,
          retryEligible: false,
          status: { in: ['shipped', 'received'] },
          order: {
            status: { in: ['shipped', 'received'] },
            shop: { userId },
          },
        },
        data: {
          status: repair.targetPurchaseStatus,
          purchaseCost: repair.targetPurchaseCost,
          reconciledCost: repair.reconciledCost,
          trackingNo: targetShipments[0]!.trackingNo,
          carrier: targetShipments[0]!.carrier,
          failureReason: null,
          retryEligible: false,
          syncRevision: { increment: 1 },
          settledAuditNextAt: completedAt,
          exceptionStatus: 'resolved',
          exceptionResolvedAt: completedAt,
          exceptionResolutionNote: repair.resolutionNote,
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('采购异常状态已变化，请刷新订单后重新处理');
      }
      await tx.purchaseOrderRecovery.create({
        data: {
          purchaseOrderId: purchase.id,
          operatorUserId: repair.operatorUserId,
          exceptionRevision: repair.exceptionRevision,
          outOrderId: purchase.outOrderId,
          orderId1688: purchase.orderId1688,
          previousStatus: purchase.status,
          previousShipments,
          note: repair.resolutionNote,
        },
      });
      await tx.purchaseShipment.deleteMany({ where: { purchaseOrderId: purchase.id } });
      for (const shipment of targetShipments) {
        const stored = await tx.purchaseShipment.create({
          data: {
            purchaseOrderId: purchase.id,
            trackingNo: shipment.trackingNo,
            carrier: shipment.carrier,
            status: shipment.status,
          },
        });
        await tx.purchaseShipmentItem.createMany({
          data: shipment.items.map((item) => ({
            purchaseShipmentId: stored.id,
            orderItemId: BigInt(item.orderItemId),
            quantity: item.quantity,
          })),
        });
      }
      const completed = await tx.orderLogisticsRepair.updateMany({
        where: { id: repair.id, status: 'running', lockedBy: lockId },
        data: {
          status: 'completed',
          completedAt,
          lockedAt: null,
          lockedBy: null,
          lastError: null,
        },
      });
      if (completed.count !== 1) {
        throw new ConflictException('物流修复执行权已失效，请刷新后重试');
      }
      await this.afterSales.materializeOrder(tx, repair.orderId, completedAt);
    });
  }

  private withSerializableTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(operation, { isolationLevel: 'Serializable' });
  }
}

function startRepairLease(
  prisma: PrismaService,
  repairId: bigint,
  lockId: string,
): { guard: PlatformExecutionGuard; stop: () => Promise<void> } {
  let failure: Error | null = null;
  let renewing: Promise<void> | null = null;
  let stopped = false;

  const assertOwned = async (): Promise<void> => {
    if (failure) throw failure;
    if (!renewing) {
      renewing = prisma.orderLogisticsRepair
        .updateMany({
          where: { id: repairId, status: 'running', lockedBy: lockId },
          data: { lockedAt: new Date() },
        })
        .then((updated) => {
          if (updated.count !== 1) {
            throw new ConflictException('物流修复执行权已失效，请刷新后重试');
          }
        })
        .catch((error: unknown) => {
          failure = error instanceof Error ? error : new Error('物流修复续租失败');
          throw failure;
        })
        .finally(() => {
          renewing = null;
        });
    }
    await renewing;
    if (failure) throw failure;
  };

  const timer = setInterval(() => {
    if (stopped || failure) return;
    void assertOwned().catch(() => undefined);
  }, ORDER_LOGISTICS_REPAIR_HEARTBEAT_MS);
  timer.unref();

  return {
    guard: { assertOwned },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await renewing?.catch(() => undefined);
    },
  };
}

function repairKeyFor(
  orderId: bigint,
  purchaseOrderId: bigint,
  exceptionRevision: number,
  proposal: SettledLogisticsRepairProposal,
): string {
  return createHash('sha256')
    .update(`${orderId}:${purchaseOrderId}:${exceptionRevision}:${proposal.targetFingerprint}`)
    .digest('hex');
}

function assertSameResolution(
  repair: OrderLogisticsRepair,
  actualCost: number,
  note: string,
): void {
  if (Math.round(Number(repair.reconciledCost) * 100) !== Math.round(actualCost * 100)) {
    throw new ConflictException('物流修复已开始，最终采购成本不能在执行中修改');
  }
  if (repair.resolutionNote !== note) {
    throw new ConflictException('物流修复已开始，处理说明不能在执行中修改');
  }
}

function platformPackagesJson(packages: ShipPackageDto[]): Prisma.InputJsonValue {
  return packages.map((pack) => ({
    trackingNo: pack.trackingNo,
    carrier: pack.carrier,
    items: pack.items.map((item) => ({
      platformOrderItemId: item.platformOrderItemId,
      quantity: item.quantity,
    })),
  }));
}

function purchaseShipmentsJson(shipments: SettledPurchaseShipmentTarget[]): Prisma.InputJsonValue {
  return shipments.map((shipment) => ({
    trackingNo: shipment.trackingNo,
    carrier: shipment.carrier,
    status: shipment.status,
    items: shipment.items.map((item) => ({
      orderItemId: item.orderItemId,
      quantity: item.quantity,
    })),
  }));
}

function parsePlatformPackages(value: Prisma.JsonValue): ShipPackageDto[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new ServiceUnavailableException('物流修复包裹快照无效');
  }
  return value.map((entry) => {
    const record = jsonRecord(entry);
    const trackingNo = boundedText(record?.trackingNo, 64);
    const carrier = boundedText(record?.carrier, 64);
    if (!trackingNo || !carrier || !Array.isArray(record?.items) || record.items.length === 0) {
      throw new ServiceUnavailableException('物流修复包裹快照无效');
    }
    const items = record.items.map((item) => {
      const row = jsonRecord(item);
      const platformOrderItemId = boundedText(row?.platformOrderItemId, 64);
      const quantity = Number(row?.quantity);
      if (!platformOrderItemId || !Number.isSafeInteger(quantity) || quantity <= 0) {
        throw new ServiceUnavailableException('物流修复包裹商品快照无效');
      }
      return { platformOrderItemId, quantity };
    });
    return { trackingNo, carrier, items };
  });
}

function parsePurchaseShipments(value: Prisma.JsonValue): SettledPurchaseShipmentTarget[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new ServiceUnavailableException('采购物流修复快照无效');
  }
  return value.map((entry) => {
    const record = jsonRecord(entry);
    const trackingNo = boundedText(record?.trackingNo, 64);
    const carrier = boundedText(record?.carrier, 64);
    const status = record?.status === null ? null : boundedText(record?.status, 32);
    if (!trackingNo || !carrier || !Array.isArray(record?.items) || record.items.length === 0) {
      throw new ServiceUnavailableException('采购物流修复快照无效');
    }
    const items = record.items.map((item) => {
      const row = jsonRecord(item);
      const orderItemId = boundedPositiveId(row?.orderItemId);
      const quantity = Number(row?.quantity);
      if (!orderItemId || !Number.isSafeInteger(quantity) || quantity <= 0) {
        throw new ServiceUnavailableException('采购物流修复商品快照无效');
      }
      return { orderItemId, quantity };
    });
    return { trackingNo, carrier, status, items };
  });
}

function jsonRecord(value: Prisma.JsonValue | undefined): Record<string, Prisma.JsonValue> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : null;
}

function boundedText(value: Prisma.JsonValue | undefined, max: number): string | null {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;
}

function boundedPositiveId(value: Prisma.JsonValue | undefined): string | null {
  return typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) ? value : null;
}

function positiveId(value: string, label: string): bigint {
  try {
    const id = BigInt(value);
    if (id <= 0n) throw new Error('invalid');
    return id;
  } catch {
    throw new NotFoundException(`${label} 无效`);
  }
}

function normalizedNonNegativeMoney(value: number): number {
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > 99_999_999.99 ||
    Math.abs(value * 100 - Math.round(value * 100)) >= 1e-8
  ) {
    throw new BadRequestException('最终实际采购成本必须是 0～99999999.99 的两位小数金额');
  }
  return Math.round(value * 100) / 100;
}

function safeRepairError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);
}
