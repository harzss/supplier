import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@supplier/db';
import { CryptoService } from '../../common/crypto.module';
import { PrismaService } from '../../common/prisma.module';
import { AfterSaleService } from '../after-sale/after-sale.service';
import type { CurrentUser } from '../entitlement/user-context.service';
import { AlertService } from '../observability/alert.service';
import { runtimeShopWhere } from '../shop/platform-adapter.factory';
import type { OrderListStatus } from './dto/order-list-query.dto';
import { FINANCIAL_RECONCILIATION_ORDER_WHERE } from './financial-reconciliation';

const NOOP_AFTER_SALE_MATERIALIZER = {
  materializeOrder: async () => undefined,
} as unknown as AfterSaleService;

export interface OrderView {
  orderId: string;
  platformOrderId: string;
  shopName: string | null;
  platform: string;
  productTitle: string | null;
  buyerNick: string | null;
  receiverName: string | null;
  receiverPhoneMasked: string | null;
  amount: number;
  status: string;
  afterSaleStatus: 'none' | 'pending' | 'partial_refund' | 'refunded' | 'failed';
  afterSaleSyncedAt: string | null;
  partialRefundDisposition: 'none' | 'continue_remaining' | 'stop_all';
  partialRefundDispositionAt: string | null;
  partialRefundDispositionNote: string | null;
  partialRefundCanContinue: boolean;
  refundAmount: number | null;
  refundAmountConfirmedAt: string | null;
  refundAmountNote: string | null;
  refundAmountConfirmed: boolean;
  refundAmountNeedsConfirmation: boolean;
  paidAt: string | null;
  fulfillmentExceptionStatus: 'none' | 'stopped' | 'action_required' | 'resolved';
  fulfillmentExceptionMessage: string | null;
  purchases: Array<{
    purchaseOrderId: string;
    outOrderId: string;
    orderId1688: string | null;
    paymentMode: string;
    purchaseCost: number | null;
    priorIncurredCost: number;
    reconciledCost: number | null;
    costReconciled: boolean;
    costNeedsReconciliation: boolean;
    status: string;
    attemptNo: number;
    retryEligible: boolean;
    recoveryEligible: boolean;
    logisticsRepairEligible: boolean;
    trackingNo: string | null;
    carrier: string | null;
    exceptionStatus: 'none' | 'stopped' | 'action_required' | 'resolved';
    exceptionRevision: number;
    exceptionCode: string | null;
    exceptionReason: string | null;
    exceptionDetectedAt: string | null;
    exceptionResolvedAt: string | null;
    exceptionResolutionNote: string | null;
    shipments: Array<{
      trackingNo: string;
      carrier: string | null;
      status: string | null;
    }>;
  }>;
}

export interface OrderReconciliationPage {
  items: OrderView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface OrderListPage {
  items: OrderView[];
  total: number;
  page: number;
  pageSize: number;
}

// 演示买家样本（真实系统来自平台订单同步）
const SAMPLE_BUYERS: Array<[string, string, string]> = [
  ['甜甜圈不加糖', '李萌', '13811112222'],
  ['海边的卡夫卡', '王强', '13922223333'],
  ['momo', '张丽', '13733334444'],
  ['奶茶续命中', '刘洋', '15044445555'],
];
const SAMPLE_ADDRESSES = [
  '浙江省杭州市余杭区文一西路 969 号',
  '广东省广州市天河区天河路 385 号',
  '江苏省南京市鼓楼区中山北路 200 号',
  '四川省成都市武侯区天府大道 100 号',
];

type OrderWithRelations = Prisma.OrderGetPayload<{
  include: {
    shop: true;
    publishedProduct: true;
    items: true;
    purchaseOrders: { include: { shipments: true } };
  };
}>;

@Injectable()
export class OrderService {
  private readonly demoMode: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    config: ConfigService,
    @Optional() private readonly alerts?: AlertService,
    private readonly afterSales: AfterSaleService = NOOP_AFTER_SALE_MATERIALIZER,
  ) {
    this.demoMode = (config.get<string>('AUTH_MODE') ?? 'demo') === 'demo';
  }

  /** 模拟一笔买家订单（针对已铺货商品），买家隐私字段加密存储 */
  async simulate(user: CurrentUser, publishedProductId: string): Promise<OrderView> {
    if (!this.demoMode) throw new ForbiddenException('当前环境不支持模拟买家下单');
    const pp = await this.prisma.publishedProduct.findFirst({
      where: {
        id: BigInt(publishedProductId),
        status: 'online',
        shop: {
          userId: user.userId,
          role: 'seller',
          status: 'active',
          platformShopId: { startsWith: 'demo-' },
        },
      },
      include: { shop: true },
    });
    if (!pp) throw new NotFoundException('在线的已铺货商品不存在');

    const buyer = SAMPLE_BUYERS[Math.floor(Math.random() * SAMPLE_BUYERS.length)]!;
    const address = SAMPLE_ADDRESSES[Math.floor(Math.random() * SAMPLE_ADDRESSES.length)]!;
    const amount = Number(pp.salePrice);
    const platformOrderId = `mock-order-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const order = await this.prisma.order.create({
      data: {
        shopId: pp.shopId,
        publishedProductId: pp.id,
        platformOrderId,
        buyerNick: buyer[0],
        receiverName: maskReceiverName(buyer[1]),
        receiverNameEnc: this.crypto.encrypt(buyer[1]),
        receiverPhoneEnc: this.crypto.encrypt(buyer[2]),
        receiverAddressEnc: this.crypto.encrypt(address),
        skuInfo: { skuName: '默认', quantity: 1, unitPrice: amount } as Prisma.InputJsonValue,
        amount,
        status: 'paid',
        paidAt: new Date(),
      },
      include: {
        shop: true,
        publishedProduct: true,
        items: true,
        purchaseOrders: { include: { shipments: true } },
      },
    });
    return this.toView(order);
  }

  /** 当前用户的订单列表（脱敏、分页，可按销售店铺和状态筛选） */
  async list(
    user: CurrentUser,
    page: number,
    pageSize: number,
    shopId?: string,
    status?: OrderListStatus,
  ): Promise<OrderListPage> {
    const where: Prisma.OrderWhereInput = {
      shop: {
        userId: user.userId,
        role: 'seller',
        ...runtimeShopWhere(this.demoMode),
        ...(shopId ? { id: BigInt(shopId) } : {}),
      },
      ...(status ? { status } : {}),
    };
    const [total, orders] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          shop: true,
          publishedProduct: true,
          items: true,
          purchaseOrders: { include: { shipments: true } },
        },
      }),
    ]);
    return { items: orders.map((order) => this.toView(order)), total, page, pageSize };
  }

  /** 当前用户的退款金额和采购成本待核对订单（独立完整分页） */
  async listFinancialReconciliations(
    user: CurrentUser,
    page: number,
    pageSize: number,
  ): Promise<OrderReconciliationPage> {
    const where: Prisma.OrderWhereInput = {
      ...FINANCIAL_RECONCILIATION_ORDER_WHERE,
      shop: {
        userId: user.userId,
        role: 'seller',
        ...runtimeShopWhere(this.demoMode),
      },
    };
    const [total, orders] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          shop: true,
          publishedProduct: true,
          items: true,
          purchaseOrders: { include: { shipments: true } },
        },
      }),
    ]);
    return { items: orders.map((order) => this.toView(order)), total, page, pageSize };
  }

  /** 单个订单视图（供代发后回读） */
  async getOne(user: CurrentUser, orderId: string): Promise<OrderView> {
    const order = await this.prisma.order.findFirst({
      where: {
        id: BigInt(orderId),
        shop: { userId: user.userId, ...runtimeShopWhere(this.demoMode) },
      },
      include: {
        shop: true,
        publishedProduct: true,
        items: true,
        purchaseOrders: { include: { shipments: true } },
      },
    });
    if (!order) throw new NotFoundException('订单不存在');
    return this.toView(order);
  }

  async resolvePurchaseException(
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
    const purchase = await this.prisma.purchaseOrder.findFirst({
      where: {
        id: purchaseOrderId,
        orderId,
        order: {
          shop: { userId: user.userId, ...runtimeShopWhere(this.demoMode) },
        },
      },
      select: {
        exceptionStatus: true,
        exceptionRevision: true,
        orderId1688: true,
        priorIncurredCost: true,
        retryEligible: true,
        everShipped: true,
        status: true,
        order: {
          select: {
            status: true,
            afterSaleStatus: true,
            partialRefundDisposition: true,
          },
        },
      },
    });
    if (!purchase) throw new NotFoundException('采购异常不存在');
    if (!['action_required', 'resolved'].includes(purchase.exceptionStatus)) {
      throw new BadRequestException('采购异常无需人工成本核销');
    }
    if (purchase.exceptionRevision !== expectedRevisionValue) {
      throw new BadRequestException('采购异常已更新，请刷新订单后重新核销');
    }
    if (purchase.retryEligible) {
      throw new BadRequestException('该采购单可重新采购，请使用重新采购操作');
    }
    if (
      purchase.status === 'failed' &&
      purchase.everShipped &&
      purchase.order.status === 'purchasing'
    ) {
      throw new BadRequestException('该采购单需先处理物流异常，请使用重新校验物流操作');
    }
    if (
      isSettledLogisticsRepairEligible(
        purchase,
        purchase.order.status,
        purchase.order.afterSaleStatus,
        purchase.order.partialRefundDisposition,
      )
    ) {
      throw new BadRequestException('该采购单需同步最新物流，请使用更新抖店物流操作');
    }
    if (actualCost < Number(purchase.priorIncurredCost)) {
      throw new BadRequestException('最终实际采购成本不能低于历史失败尝试的已发生成本');
    }

    const resolvedAt = new Date();
    await this.withPurchaseFactTransaction(async (tx) => {
      const updated = await tx.purchaseOrder.updateMany({
        where: {
          id: purchaseOrderId,
          orderId,
          exceptionStatus: purchase.exceptionStatus,
          exceptionRevision: expectedRevisionValue,
          order: {
            shop: { userId: user.userId, ...runtimeShopWhere(this.demoMode) },
          },
        },
        data: {
          exceptionStatus: 'resolved',
          reconciledCost: actualCost,
          exceptionResolvedAt: resolvedAt,
          exceptionResolutionNote: note,
        },
      });
      if (updated.count === 0) {
        throw new BadRequestException('采购异常状态已变化，请刷新订单后重新核销');
      }
      await this.afterSales.materializeOrder(tx, orderId, resolvedAt);
    });
    await this.resolvePurchaseAuditAlert(purchaseOrderId, orderId);
    return this.getOne(user, orderIdValue);
  }

  async retryFailedPurchase(
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
    const purchase = await this.prisma.purchaseOrder.findFirst({
      where: {
        id: purchaseOrderId,
        orderId,
        order: {
          shop: { userId: user.userId, ...runtimeShopWhere(this.demoMode) },
        },
      },
      select: {
        attemptNo: true,
        attemptStartedAt: true,
        outOrderId: true,
        orderId1688: true,
        status: true,
        purchaseCost: true,
        priorIncurredCost: true,
        failureReason: true,
        retryEligible: true,
        exceptionStatus: true,
        exceptionRevision: true,
        order: {
          select: {
            status: true,
            afterSaleStatus: true,
            partialRefundDisposition: true,
          },
        },
      },
    });
    if (!purchase) throw new NotFoundException('采购异常不存在');
    if (purchase.exceptionRevision !== expectedRevisionValue) {
      throw new BadRequestException('采购异常已更新，请刷新订单后重新采购');
    }
    if (
      purchase.status !== 'failed' ||
      !purchase.orderId1688 ||
      !purchase.retryEligible ||
      purchase.exceptionStatus !== 'action_required' ||
      purchase.order.status !== 'purchasing' ||
      !isAfterSaleRetryAllowed(
        purchase.order.afterSaleStatus,
        purchase.order.partialRefundDisposition,
      )
    ) {
      throw new BadRequestException('当前采购异常不允许自动重新采购');
    }
    if (Number(purchase.priorIncurredCost) + actualCost > 99_999_999.99) {
      throw new BadRequestException('累计采购成本超出系统可记录范围');
    }

    const failedOrderId1688 = purchase.orderId1688;
    const nextOutOrderId = nextPurchaseOutOrderId(purchase.outOrderId, purchase.attemptNo);
    const resolvedAt = new Date();
    await this.withPurchaseFactTransaction(async (tx) => {
      const reset = await tx.purchaseOrder.updateMany({
        where: {
          id: purchaseOrderId,
          orderId,
          outOrderId: purchase.outOrderId,
          orderId1688: failedOrderId1688,
          status: 'failed',
          attemptNo: purchase.attemptNo,
          retryEligible: true,
          exceptionStatus: 'action_required',
          exceptionRevision: expectedRevisionValue,
          order: {
            shop: { userId: user.userId, ...runtimeShopWhere(this.demoMode) },
          },
        },
        data: {
          attemptNo: { increment: 1 },
          attemptStartedAt: resolvedAt,
          priorIncurredCost: { increment: actualCost },
          outOrderId: nextOutOrderId,
          orderId1688: null,
          status: 'pending',
          purchaseCost: null,
          reconciledCost: null,
          trackingNo: null,
          carrier: null,
          failureReason: null,
          retryCount: 0,
          retryEligible: false,
          everShipped: false,
          syncRevision: { increment: 1 },
          exceptionStatus: 'none',
          exceptionRevision: { increment: 1 },
          exceptionCode: null,
          exceptionReason: null,
          exceptionDetectedAt: null,
          exceptionResolvedAt: null,
          exceptionResolutionNote: null,
        },
      });
      if (reset.count !== 1) {
        throw new BadRequestException('采购异常已变化，请刷新订单后重新采购');
      }
      await tx.purchaseOrderAttempt.create({
        data: {
          purchaseOrderId,
          attemptNo: purchase.attemptNo,
          outOrderId: purchase.outOrderId,
          orderId1688: failedOrderId1688,
          status: purchase.status,
          purchaseCost: purchase.purchaseCost,
          actualCost,
          failureReason: purchase.failureReason,
          resolutionNote: note,
          startedAt: purchase.attemptStartedAt,
          resolvedAt,
        },
      });
      await tx.purchaseShipment.deleteMany({ where: { purchaseOrderId } });
      const resumed = await tx.order.updateMany({
        where: {
          id: orderId,
          status: 'purchasing',
          OR: [
            { afterSaleStatus: { in: ['none', 'failed'] } },
            {
              afterSaleStatus: 'partial_refund',
              partialRefundDisposition: 'continue_remaining',
            },
          ],
        },
        data: { status: 'paid' },
      });
      if (resumed.count !== 1) {
        throw new BadRequestException('销售订单状态已变化，请刷新后重新处理');
      }
      await this.afterSales.materializeOrder(tx, orderId, resolvedAt);
    });
    await this.resolvePurchaseAuditAlert(purchaseOrderId, orderId);
    return this.getOne(user, orderIdValue);
  }

  async resumePurchaseLogistics(
    user: CurrentUser,
    orderIdValue: string,
    purchaseOrderIdValue: string,
    expectedRevisionValue: number,
    noteValue: string,
  ): Promise<OrderView> {
    const orderId = positiveId(orderIdValue, '订单 ID');
    const purchaseOrderId = positiveId(purchaseOrderIdValue, '采购单 ID');
    if (!Number.isSafeInteger(expectedRevisionValue) || expectedRevisionValue < 0) {
      throw new BadRequestException('采购异常修订号无效');
    }
    const note = noteValue.trim();
    if (note.length < 2 || note.length > 500) {
      throw new BadRequestException('人工处理说明需为 2～500 个字符');
    }
    const purchase = await this.prisma.purchaseOrder.findFirst({
      where: {
        id: purchaseOrderId,
        orderId,
        order: {
          shop: { userId: user.userId, ...runtimeShopWhere(this.demoMode) },
        },
      },
      select: {
        outOrderId: true,
        orderId1688: true,
        status: true,
        retryEligible: true,
        everShipped: true,
        exceptionStatus: true,
        exceptionRevision: true,
        shipments: {
          select: {
            trackingNo: true,
            carrier: true,
            status: true,
            items: { select: { orderItemId: true, quantity: true } },
          },
        },
        order: {
          select: {
            status: true,
            afterSaleStatus: true,
            partialRefundDisposition: true,
          },
        },
      },
    });
    if (!purchase) throw new NotFoundException('采购异常不存在');
    if (purchase.exceptionRevision !== expectedRevisionValue) {
      throw new BadRequestException('采购异常已更新，请刷新订单后重新处理物流');
    }
    if (
      purchase.status !== 'failed' ||
      !purchase.orderId1688 ||
      purchase.retryEligible ||
      !purchase.everShipped ||
      purchase.exceptionStatus !== 'action_required' ||
      purchase.order.status !== 'purchasing' ||
      !isAfterSaleRetryAllowed(
        purchase.order.afterSaleStatus,
        purchase.order.partialRefundDisposition,
      )
    ) {
      throw new BadRequestException('当前采购异常不允许重新校验物流');
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
    const failedOrderId1688 = purchase.orderId1688;
    await this.withPurchaseFactTransaction(async (tx) => {
      const resumed = await tx.purchaseOrder.updateMany({
        where: {
          id: purchaseOrderId,
          orderId,
          orderId1688: failedOrderId1688,
          status: 'failed',
          retryEligible: false,
          everShipped: true,
          exceptionStatus: 'action_required',
          exceptionRevision: expectedRevisionValue,
          order: {
            shop: { userId: user.userId, ...runtimeShopWhere(this.demoMode) },
          },
        },
        data: {
          status: 'paid',
          trackingNo: null,
          carrier: null,
          failureReason: null,
          syncRevision: { increment: 1 },
          exceptionStatus: 'none',
          exceptionRevision: { increment: 1 },
          exceptionCode: null,
          exceptionReason: null,
          exceptionDetectedAt: null,
          exceptionResolvedAt: null,
          exceptionResolutionNote: null,
        },
      });
      if (resumed.count !== 1) {
        throw new BadRequestException('采购异常已变化，请刷新订单后重新处理物流');
      }
      await tx.purchaseOrderRecovery.create({
        data: {
          purchaseOrderId,
          operatorUserId: user.userId,
          exceptionRevision: expectedRevisionValue,
          outOrderId: purchase.outOrderId,
          orderId1688: failedOrderId1688,
          previousStatus: purchase.status,
          previousShipments,
          note,
        },
      });
      await tx.purchaseShipment.deleteMany({ where: { purchaseOrderId } });
      await this.afterSales.materializeOrder(tx, orderId);
    });
    await this.resolvePurchaseAuditAlert(purchaseOrderId, orderId);
    return this.getOne(user, orderIdValue);
  }

  private async resolvePurchaseAuditAlert(purchaseOrderId: bigint, orderId: bigint): Promise<void> {
    await this.alerts?.resolve(`purchase_audit.purchase.${purchaseOrderId}`, {
      purchaseOrderId,
      orderId,
    });
  }

  async confirmRefundAmount(
    user: CurrentUser,
    orderIdValue: string,
    amountValue: number,
    noteValue: string,
  ): Promise<OrderView> {
    const orderId = positiveId(orderIdValue, '订单 ID');
    const amount = normalizedMoney(amountValue);
    const note = noteValue.trim();
    if (note.length < 2 || note.length > 500) {
      throw new BadRequestException('退款金额核对说明需为 2～500 个字符');
    }
    const order = await this.prisma.order.findFirst({
      where: {
        id: orderId,
        shop: { userId: user.userId, ...runtimeShopWhere(this.demoMode) },
      },
      select: {
        amount: true,
        status: true,
        partialRefundFingerprint: true,
        items: { select: { refundStatusRaw: true } },
      },
    });
    if (!order) throw new NotFoundException('订单不存在');
    if (!['paid', 'purchasing', 'shipped', 'received'].includes(order.status)) {
      throw new BadRequestException('当前订单无需核对部分退款金额');
    }
    if (!order.partialRefundFingerprint) {
      throw new BadRequestException('请先刷新平台售后状态，再核对退款金额');
    }
    if (!order.items.some((item) => item.refundStatusRaw === 3)) {
      throw new BadRequestException('当前订单没有退款成功的子单或价保记录');
    }
    if (amount >= Number(order.amount)) {
      throw new BadRequestException('部分退款累计金额必须小于订单实付金额');
    }

    const confirmedAt = new Date();
    await this.withPurchaseFactTransaction(async (tx) => {
      const updated = await tx.order.updateMany({
        where: {
          id: orderId,
          status: order.status,
          amount: order.amount,
          partialRefundFingerprint: order.partialRefundFingerprint,
          shop: { userId: user.userId, ...runtimeShopWhere(this.demoMode) },
        },
        data: {
          refundAmount: amount,
          refundAmountFingerprint: order.partialRefundFingerprint,
          refundAmountConfirmedAt: confirmedAt,
          refundAmountNote: note,
        },
      });
      if (updated.count === 0) {
        throw new BadRequestException('售后状态已变化，请刷新订单后重新核对退款金额');
      }
      await this.afterSales.materializeOrder(tx, orderId, confirmedAt);
    });
    return this.getOne(user, orderIdValue);
  }

  private withPurchaseFactTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (this.afterSales === NOOP_AFTER_SALE_MATERIALIZER) {
      return operation(this.prisma as unknown as Prisma.TransactionClient);
    }
    return this.prisma.$transaction(operation, { isolationLevel: 'Serializable' });
  }

  private toView(o: OrderWithRelations): OrderView {
    let receiverPhoneMasked: string | null = null;
    if (o.receiverPhoneEnc) {
      try {
        receiverPhoneMasked = maskPhone(this.crypto.decrypt(o.receiverPhoneEnc));
      } catch {
        receiverPhoneMasked = '****';
      }
    }
    const fulfillmentException = fulfillmentExceptionView(
      o.status,
      o.afterSaleStatus,
      o.partialRefundDisposition,
      o.purchaseOrders,
    );
    const refundAmountConfirmed =
      o.refundAmount != null &&
      o.refundAmountFingerprint != null &&
      o.partialRefundFingerprint != null &&
      o.refundAmountFingerprint === o.partialRefundFingerprint;
    const refundAmountNeedsConfirmation =
      ['paid', 'purchasing', 'shipped', 'received'].includes(o.status) &&
      (o.afterSaleStatus === 'partial_refund' ||
        o.items.some((item) => item.refundStatusRaw === 3)) &&
      !refundAmountConfirmed;
    return {
      orderId: o.id.toString(),
      platformOrderId: o.platformOrderId,
      shopName: o.shop?.shopName ?? null,
      platform: o.shop?.platform ?? '',
      productTitle: o.publishedProduct?.title ?? null,
      buyerNick: o.buyerNick,
      receiverName: o.receiverName,
      receiverPhoneMasked,
      amount: Number(o.amount),
      status: o.status,
      afterSaleStatus: o.afterSaleStatus,
      afterSaleSyncedAt: o.afterSaleSyncedAt?.toISOString() ?? null,
      partialRefundDisposition: o.partialRefundDisposition,
      partialRefundDispositionAt: o.partialRefundDispositionAt?.toISOString() ?? null,
      partialRefundDispositionNote: o.partialRefundDispositionNote,
      partialRefundCanContinue: canContinuePartialRefund(o),
      refundAmount: refundAmountConfirmed ? Number(o.refundAmount) : null,
      refundAmountConfirmedAt: refundAmountConfirmed
        ? (o.refundAmountConfirmedAt?.toISOString() ?? null)
        : null,
      refundAmountNote: refundAmountConfirmed ? o.refundAmountNote : null,
      refundAmountConfirmed,
      refundAmountNeedsConfirmation,
      paidAt: o.paidAt?.toISOString() ?? null,
      fulfillmentExceptionStatus: fulfillmentException.status,
      fulfillmentExceptionMessage: fulfillmentException.message,
      purchases: o.purchaseOrders.map((purchase) => ({
        purchaseOrderId: purchase.id.toString(),
        outOrderId: purchase.outOrderId,
        orderId1688: purchase.orderId1688,
        paymentMode: purchase.paymentMode,
        purchaseCost: purchase.purchaseCost == null ? null : Number(purchase.purchaseCost),
        priorIncurredCost: Number(purchase.priorIncurredCost),
        reconciledCost:
          purchase.exceptionStatus === 'stopped'
            ? 0
            : purchase.reconciledCost == null
              ? null
              : Number(purchase.reconciledCost),
        costReconciled:
          purchase.exceptionStatus === 'stopped' ||
          (purchase.exceptionStatus === 'resolved' && purchase.reconciledCost != null),
        costNeedsReconciliation:
          !isPurchaseRecoveryEligible(purchase, o.status) &&
          !isSettledLogisticsRepairEligible(
            purchase,
            o.status,
            o.afterSaleStatus,
            o.partialRefundDisposition,
          ) &&
          (purchase.exceptionStatus === 'action_required' ||
            (purchase.exceptionStatus === 'resolved' && purchase.reconciledCost == null)),
        status: purchase.status,
        attemptNo: purchase.attemptNo,
        retryEligible: purchase.retryEligible,
        recoveryEligible: isPurchaseRecoveryEligible(purchase, o.status),
        logisticsRepairEligible: isSettledLogisticsRepairEligible(
          purchase,
          o.status,
          o.afterSaleStatus,
          o.partialRefundDisposition,
        ),
        trackingNo: purchase.trackingNo,
        carrier: purchase.carrier,
        exceptionStatus: purchase.exceptionStatus,
        exceptionRevision: purchase.exceptionRevision,
        exceptionCode: purchase.exceptionCode,
        exceptionReason: purchase.exceptionReason,
        exceptionDetectedAt: purchase.exceptionDetectedAt?.toISOString() ?? null,
        exceptionResolvedAt: purchase.exceptionResolvedAt?.toISOString() ?? null,
        exceptionResolutionNote: purchase.exceptionResolutionNote,
        shipments: purchase.shipments.map((shipment) => ({
          trackingNo: shipment.trackingNo,
          carrier: shipment.carrier,
          status: shipment.status,
        })),
      })),
    };
  }
}

function fulfillmentExceptionView(
  orderStatus: string,
  afterSaleStatus: string,
  partialRefundDisposition: string,
  purchases: OrderWithRelations['purchaseOrders'],
): {
  status: OrderView['fulfillmentExceptionStatus'];
  message: string | null;
} {
  const fulfillmentStopped =
    orderStatus === 'refunded' ||
    orderStatus === 'closed' ||
    (afterSaleStatus === 'partial_refund' && partialRefundDisposition !== 'continue_remaining') ||
    afterSaleStatus === 'refunded';
  const actionRequired = purchases.some(
    (purchase) =>
      purchase.exceptionStatus === 'action_required' ||
      (fulfillmentStopped &&
        purchase.exceptionStatus === 'none' &&
        (purchase.orderId1688 !== null || !['pending', 'failed'].includes(purchase.status))),
  );
  if (actionRequired) {
    return {
      status: 'action_required',
      message: fulfillmentStopped
        ? '销售订单已退款、部分退款或关闭，但 1688 采购已创建或推进。系统已停止物流回传，请尽快完成取消、退款或物流拦截。'
        : purchases.some((purchase) => isPurchaseRecoveryEligible(purchase, orderStatus))
          ? '1688 采购单在产生物流后进入取消或关闭状态。请先在 1688 核实或恢复物流，再清除旧快照并重新校验同一远端订单。'
          : purchases.some((purchase) =>
                isSettledLogisticsRepairEligible(
                  purchase,
                  orderStatus,
                  afterSaleStatus,
                  partialRefundDisposition,
                ),
              )
            ? '已发货订单的 1688 采购成本或物流发生变化。请核对最新成本，并将已验证的新包裹同步到抖店。'
            : purchases.some((purchase) => purchase.retryEligible)
              ? '1688 采购单已取消或关闭。请核对本次实际成本后重新采购，系统不会复用已失败的远端订单号。'
              : '1688 采购状态异常，自动履约已停止；请核对采购成本和物流后人工处理。',
    };
  }
  if (afterSaleStatus === 'pending') {
    return {
      status: 'stopped',
      message: '平台子订单正在售后处理中，系统已暂停采购和物流回传；售后失败后可继续处理。',
    };
  }
  if (!fulfillmentStopped) {
    return { status: 'none', message: null };
  }
  if (purchases.some((purchase) => purchase.exceptionStatus === 'resolved')) {
    return { status: 'resolved', message: '销售订单售后异常已完成人工处理。' };
  }
  return {
    status: 'stopped',
    message:
      afterSaleStatus === 'partial_refund'
        ? partialRefundDisposition === 'stop_all'
          ? '运营已确认部分退款后停止整单自动履约。'
          : '销售订单存在部分退款，系统已停止继续采购和物流回传；请核对后选择仅履约未退款商品或停止整单。'
        : '销售订单已退款或关闭，系统已停止采购和物流回传。',
  };
}

function canContinuePartialRefund(order: OrderWithRelations): boolean {
  if (
    order.status !== 'paid' ||
    order.afterSaleStatus !== 'partial_refund' ||
    order.partialRefundDisposition !== 'none'
  ) {
    return false;
  }
  const refunded = order.items.filter(isFulfillmentRefundedItem);
  const remaining = order.items.filter((item) => !isFulfillmentRefundedItem(item));
  const activeStatuses = new Set([6, 7, 11, 12, 13, 14, 51, 53]);
  return (
    refunded.length > 0 &&
    remaining.length > 0 &&
    remaining.every(
      (item) =>
        item.refundStatusRaw !== 1 &&
        (item.afterSaleStatusRaw === null || !activeStatuses.has(item.afterSaleStatusRaw)),
    ) &&
    order.purchaseOrders.every(
      (purchase) =>
        purchase.orderId1688 === null && ['pending', 'failed'].includes(purchase.status),
    )
  );
}

function isFulfillmentRefundedItem(item: {
  afterSaleTypeRaw: number | null;
  refundStatusRaw: number | null;
}): boolean {
  return item.refundStatusRaw === 3 && item.afterSaleTypeRaw !== 6;
}

function isAfterSaleRetryAllowed(status: string, disposition: string): boolean {
  return (
    status === 'none' ||
    status === 'failed' ||
    (status === 'partial_refund' && disposition === 'continue_remaining')
  );
}

function isPurchaseRecoveryEligible(
  purchase: OrderWithRelations['purchaseOrders'][number],
  orderStatus: string,
): boolean {
  return (
    orderStatus === 'purchasing' &&
    purchase.status === 'failed' &&
    purchase.orderId1688 !== null &&
    !purchase.retryEligible &&
    purchase.everShipped &&
    purchase.exceptionStatus === 'action_required'
  );
}

function isSettledLogisticsRepairEligible(
  purchase: {
    status: string;
    orderId1688: string | null;
    retryEligible: boolean;
    everShipped: boolean;
    exceptionStatus: string;
  },
  orderStatus: string,
  afterSaleStatus: string,
  partialRefundDisposition: string,
): boolean {
  return (
    orderStatus === 'shipped' &&
    isAfterSaleRetryAllowed(afterSaleStatus, partialRefundDisposition) &&
    ['shipped', 'received'].includes(purchase.status) &&
    purchase.orderId1688 !== null &&
    !purchase.retryEligible &&
    purchase.everShipped &&
    purchase.exceptionStatus === 'action_required'
  );
}

function nextPurchaseOutOrderId(current: string, attemptNo: number): string {
  const currentSuffix = attemptNo === 1 ? '' : `-r${attemptNo}`;
  if (attemptNo < 1 || (currentSuffix && !current.endsWith(currentSuffix))) {
    throw new BadRequestException('采购尝试序号与外部订单号不一致');
  }
  const root = currentSuffix ? current.slice(0, -currentSuffix.length) : current;
  const next = `${root}-r${attemptNo + 1}`;
  if (next.length > 128) {
    throw new BadRequestException('采购外部订单号过长，无法安全重新采购');
  }
  return next;
}

function positiveId(value: string, label: string): bigint {
  try {
    const id = BigInt(value);
    if (id <= 0n) throw new Error('invalid');
    return id;
  } catch {
    throw new BadRequestException(`无效${label}`);
  }
}

function normalizedMoney(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new BadRequestException('退款金额必须大于 0');
  }
  const cents = Math.round(value * 100);
  if (Math.abs(value - cents / 100) > 1e-9) {
    throw new BadRequestException('退款金额最多保留两位小数');
  }
  return cents / 100;
}

function normalizedNonNegativeMoney(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 99_999_999.99) {
    throw new BadRequestException('最终实际采购成本必须在 0～99999999.99 之间');
  }
  const cents = Math.round(value * 100);
  if (Math.abs(value - cents / 100) > 1e-9) {
    throw new BadRequestException('最终实际采购成本最多保留两位小数');
  }
  return cents / 100;
}

export function maskPhone(phone: string): string {
  return phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : '****';
}

export function maskReceiverName(name: string): string {
  const value = name.trim();
  if (!value) return '**';
  return `${value.slice(0, 1)}${'*'.repeat(Math.min(2, Math.max(1, value.length - 1)))}`;
}
