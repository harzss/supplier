import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma.module';
import type { CurrentUser } from '../entitlement/user-context.service';
import { PlatformAdapterFactory, isDemoShop } from '../shop/platform-adapter.factory';
import { ShopTokenService } from '../shop/shop-token.service';
import { estimatePurchaseCost } from './order-cost';
import { OrderService, type OrderView } from './order.service';
import { Alibaba1688PurchaseService } from './alibaba1688-purchase.service';
import { OrderSyncService } from './order-sync.service';
import type { PartialRefundDispositionAction } from './dto/resolve-partial-refund.dto';

/**
 * 自动代发：paid → 向 1688 下单 → 发货 → 回传平台物流 → shipped。
 * 幂等：非 paid 状态的订单不重复下单，直接返回当前视图。
 */
@Injectable()
export class FulfillmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
    private readonly shopTokens: ShopTokenService,
    private readonly adapters: PlatformAdapterFactory,
    private readonly alibaba1688Purchases: Alibaba1688PurchaseService,
    private readonly orderSync: OrderSyncService,
  ) {}

  async fulfill(user: CurrentUser, orderId: string): Promise<OrderView> {
    const id = parseOrderId(orderId);
    let order = await this.prisma.order.findFirst({
      where: { id, shop: { userId: user.userId } },
      include: { shop: true, purchaseOrders: true, publishedProduct: true },
    });
    if (!order) throw new NotFoundException('订单不存在');

    if (!isDemoShop(order.shop)) {
      await this.orderSync.refreshOrder(user, orderId);
      order = await this.prisma.order.findFirst({
        where: { id, shop: { userId: user.userId } },
        include: { shop: true, purchaseOrders: true, publishedProduct: true },
      });
      if (!order) throw new NotFoundException('订单不存在');
    }

    if (isAfterSaleBlocked(order.afterSaleStatus, order.partialRefundDisposition)) {
      return this.orders.getOne(user, orderId);
    }

    // 幂等：purchasing 表示 1688 已发货但平台回传待重试，不重复下单。
    if (order.status !== 'paid' && order.status !== 'purchasing') {
      return this.orders.getOne(user, orderId);
    }

    if (!isDemoShop(order.shop)) {
      const progress = await this.alibaba1688Purchases.advance(user, id);
      if (progress.packages.length === 0 || !progress.requestId) {
        return this.orders.getOne(user, orderId);
      }
      await this.orderSync.refreshOrder(user, orderId);
      const current = await this.prisma.order.findUnique({
        where: { id },
        select: { status: true, afterSaleStatus: true, partialRefundDisposition: true },
      });
      if (
        current?.status !== 'purchasing' ||
        (current.afterSaleStatus !== undefined &&
          isAfterSaleBlocked(current.afterSaleStatus, current.partialRefundDisposition))
      ) {
        return this.orders.getOne(user, orderId);
      }
      const adapter = this.adapters.create(order.shop);
      const accessToken = await this.shopTokens.getAccessToken(order.shop.id, user.userId);
      await adapter.shipPackages(accessToken, {
        platformOrderId: order.platformOrderId,
        packages: progress.packages,
        requestId: progress.requestId,
      });
      const transitioned = await this.prisma.order.updateMany({
        where: {
          id,
          status: 'purchasing',
          OR: [
            { afterSaleStatus: { in: ['none', 'failed'] } },
            {
              afterSaleStatus: 'partial_refund',
              partialRefundDisposition: 'continue_remaining',
            },
          ],
        },
        data: { status: 'shipped' },
      });
      if (transitioned.count === 0) {
        await this.orderSync.refreshOrder(user, orderId);
      }
      return this.orders.getOne(user, orderId);
    }

    const adapter = this.adapters.create(order.shop);
    const accessToken = 'mock-token';

    let trackingNo = order.purchaseOrders[0]?.trackingNo;
    let carrier = order.purchaseOrders[0]?.carrier;
    if (order.status === 'paid') {
      // 1. 演示店向 1688 下单（Mock）；真实店已在上方 fail-closed。
      const orderId1688 = `1688PO${Date.now()}`;
      const purchaseCost = estimatePurchaseCost(
        order.publishedProduct?.costPrice === null ||
          order.publishedProduct?.costPrice === undefined
          ? null
          : Number(order.publishedProduct.costPrice),
        order.skuInfo,
      );
      const purchaseOrder = await this.prisma.purchaseOrder.upsert({
        where: { uk_order_supplier_purchase: { orderId: id, supplierKey: 'demo' } },
        create: {
          orderId: id,
          supplierKey: 'demo',
          outOrderId: `demo-${id}`,
          orderId1688,
          purchaseCost,
          status: 'placed',
        },
        update: { orderId1688, purchaseCost, status: 'placed', failureReason: null },
      });
      await this.prisma.order.update({ where: { id }, data: { status: 'purchasing' } });

      // 2. 模拟 1688 发货 → 物流单号
      trackingNo = `SF${Date.now()}`;
      carrier = '顺丰速运';
      await this.prisma.purchaseOrder.update({
        where: { id: purchaseOrder.id },
        data: { status: 'shipped', trackingNo, carrier },
      });
    }

    if (!trackingNo || !carrier) {
      throw new ServiceUnavailableException('采购单缺少物流信息，无法回传平台');
    }

    // 3. 回传平台物流；失败时保留 purchasing，允许再次触发重试。
    await adapter.shipOrder(accessToken, {
      platformOrderId: order.platformOrderId,
      trackingNo,
      carrier,
    });

    // 4. 平台订单标记已发货
    await this.prisma.order.update({ where: { id }, data: { status: 'shipped' } });

    return this.orders.getOne(user, orderId);
  }

  async resolvePartialRefund(
    user: CurrentUser,
    orderIdValue: string,
    action: PartialRefundDispositionAction,
    noteValue: string,
  ): Promise<OrderView> {
    const orderId = parseOrderId(orderIdValue);
    const note = noteValue.trim();
    if (note.length < 2 || note.length > 500) {
      throw new BadRequestException('部分退款处置说明需为 2～500 个字符');
    }

    let order = await this.loadPartialRefundOrder(user.userId, orderId);
    this.adapters.create(order.shop);
    if (!isDemoShop(order.shop)) {
      await this.orderSync.refreshOrder(user, orderIdValue);
      order = await this.loadPartialRefundOrder(user.userId, orderId);
    }
    if (order.afterSaleStatus !== 'partial_refund' || !order.partialRefundFingerprint) {
      throw new BadRequestException('订单当前不是可处置的部分退款状态');
    }
    if (order.partialRefundDisposition === action) {
      return this.orders.getOne(user, orderIdValue);
    }
    if (order.partialRefundDisposition !== 'none') {
      throw new BadRequestException('当前部分退款状态已完成处置；子单售后状态变化后可重新选择');
    }

    const refundedItems = order.items.filter(isFulfillmentRefundedItem);
    const remainingItems = order.items.filter((item) => !isFulfillmentRefundedItem(item));
    if (refundedItems.length === 0 || remainingItems.length === 0) {
      throw new ConflictException('子订单退款明细与订单汇总状态不一致，请重新刷新后再试');
    }
    if (action === 'continue_remaining') {
      if (order.status !== 'paid') {
        throw new BadRequestException('只有尚未开始采购的订单可自动继续未退款商品');
      }
      if (remainingItems.some(hasActiveAfterSale)) {
        throw new BadRequestException('仍有未退款子单处于售后处理中，暂不能继续采购');
      }
    }

    const decidedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      if (action === 'continue_remaining') {
        const unsafePurchases = await tx.purchaseOrder.count({
          where: {
            orderId,
            OR: [{ orderId1688: { not: null } }, { status: { notIn: ['pending', 'failed'] } }],
          },
        });
        if (unsafePurchases > 0) {
          throw new BadRequestException(
            '1688 采购已创建或推进，不能自动继续；请完成人工取消、退款或拦截并选择停止整单',
          );
        }
        await tx.purchaseOrder.deleteMany({
          where: { orderId, orderId1688: null, status: { in: ['pending', 'failed'] } },
        });
      } else {
        await tx.purchaseOrder.updateMany({
          where: {
            orderId,
            orderId1688: null,
            status: { in: ['pending', 'failed'] },
          },
          data: {
            exceptionStatus: 'stopped',
            exceptionReason: '运营已确认部分退款后停止整单自动履约。',
            exceptionDetectedAt: decidedAt,
          },
        });
      }

      const updated = await tx.order.updateMany({
        where: {
          id: orderId,
          status: action === 'continue_remaining' ? 'paid' : undefined,
          afterSaleStatus: 'partial_refund',
          partialRefundDisposition: 'none',
          partialRefundFingerprint: order.partialRefundFingerprint,
          shop: { userId: user.userId },
        },
        data: {
          partialRefundDisposition: action,
          partialRefundDispositionAt: decidedAt,
          partialRefundDispositionNote: note,
        },
      });
      if (updated.count === 0) {
        throw new ConflictException('子订单售后状态已变化，请刷新后重新确认');
      }
    });

    return this.orders.getOne(user, orderIdValue);
  }

  private async loadPartialRefundOrder(userId: bigint, orderId: bigint) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, shop: { userId } },
      include: { shop: true, items: true, purchaseOrders: true },
    });
    if (!order) throw new NotFoundException('订单不存在');
    return order;
  }
}

function isAfterSaleBlocked(status: string | undefined, disposition?: string): boolean {
  return (
    status === 'pending' ||
    status === 'refunded' ||
    (status === 'partial_refund' && disposition !== 'continue_remaining')
  );
}

function hasActiveAfterSale(item: {
  afterSaleStatusRaw: number | null;
  refundStatusRaw: number | null;
}): boolean {
  return (
    item.refundStatusRaw === 1 ||
    (item.afterSaleStatusRaw !== null &&
      [6, 7, 11, 12, 13, 14, 51, 53].includes(item.afterSaleStatusRaw))
  );
}

function isFulfillmentRefundedItem(item: {
  afterSaleTypeRaw: number | null;
  refundStatusRaw: number | null;
}): boolean {
  return item.refundStatusRaw === 3 && item.afterSaleTypeRaw !== 6;
}

function parseOrderId(value: string): bigint {
  try {
    const id = BigInt(value);
    if (id <= 0n) throw new Error('invalid');
    return id;
  } catch {
    throw new NotFoundException('订单不存在');
  }
}
