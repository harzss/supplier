import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@supplier/db';
import {
  Alibaba1688Adapter,
  type Alibaba1688BuyerOrder,
  type Alibaba1688CreateOrderInput,
  type Alibaba1688LogisticsInfo,
  type ShipPackageDto,
} from '@supplier/platform-sdk';
import { createHash } from 'node:crypto';
import { CryptoService } from '../../common/crypto.module';
import { PrismaService } from '../../common/prisma.module';
import type { CurrentUser } from '../entitlement/user-context.service';
import { OAuthConfigService } from '../shop/oauth-config.service';
import { ShopTokenService } from '../shop/shop-token.service';
import { isTerminalOrderStatus, markPurchaseExceptionsForOrderEvent } from './purchase-exception';
import { PURCHASE_EXCEPTION_CODE, type PurchaseExceptionCode } from './purchase-exception-code';

const MAX_PURCHASE_RETRIES = 3;

type PurchaseOrderGraph = Prisma.PurchaseOrderGetPayload<{
  include: {
    items: { include: { orderItem: true } };
    shipments: { include: { items: { include: { orderItem: true } } } };
  };
}>;

type PurchasingOrder = Prisma.OrderGetPayload<{
  include: {
    shop: true;
    items: {
      include: {
        purchaseOrderItem: true;
        publishedProduct: { include: { sourceProduct: true } };
      };
    };
    purchaseOrders: {
      include: {
        items: { include: { orderItem: true } };
        shipments: { include: { items: { include: { orderItem: true } } } };
      };
    };
  };
}>;

export interface Alibaba1688PurchaseProgress {
  packages: ShipPackageDto[];
  requestId: string | null;
}

export type Alibaba1688PurchaseAuditOutcome = 'checked' | 'action_required' | 'skipped';

export interface SettledPurchaseShipmentTarget {
  trackingNo: string;
  carrier: string;
  status: string | null;
  items: Array<{ orderItemId: string; quantity: number }>;
}

export interface SettledLogisticsRepairProposal {
  purchaseOrderId: bigint;
  purchaseSyncRevision: number;
  priorIncurredCost: number;
  targetPurchaseStatus: 'shipped' | 'received';
  targetPurchaseCost: number;
  previousPlatformPackages: ShipPackageDto[];
  targetPlatformPackages: ShipPackageDto[];
  targetPurchaseShipments: SettledPurchaseShipmentTarget[];
  targetFingerprint: string;
}

interface PreparedPurchase {
  purchase: Pick<PurchaseOrderGraph, 'id' | 'outOrderId' | 'orderId1688' | 'status' | 'retryCount'>;
  items: GroupedPurchaseItem[];
  address: Alibaba1688CreateOrderInput['address'];
}

class PurchaseConsistencyError extends ServiceUnavailableException {}

@Injectable()
export class Alibaba1688PurchaseService {
  private readonly logger = new Logger(Alibaba1688PurchaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
    private readonly oauthConfig: OAuthConfigService,
    private readonly shopTokens: ShopTokenService,
  ) {}

  async advance(user: CurrentUser, orderId: bigint): Promise<Alibaba1688PurchaseProgress> {
    this.assertEnabled();
    let order = await this.loadOrder(user.userId, orderId);
    if (isAfterSaleBlocked(order.afterSaleStatus, order.partialRefundDisposition)) {
      return { packages: [], requestId: null };
    }
    if (order.status !== 'paid' && order.status !== 'purchasing') {
      return { packages: [], requestId: null };
    }
    if (order.purchaseOrders.some((purchase) => purchase.exceptionStatus === 'action_required')) {
      return { packages: [], requestId: null };
    }

    const buyer = await this.prisma.shop.findFirst({
      where: {
        userId: user.userId,
        platform: 'alibaba_1688',
        role: 'buyer',
        status: 'active',
        accessTokenEnc: { not: null },
        refreshTokenEnc: { not: null },
        NOT: { platformShopId: { startsWith: 'demo-' } },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!buyer) {
      throw new ServiceUnavailableException('尚未授权可用的 1688 买家账号');
    }

    const adapter = new Alibaba1688Adapter(this.oauthConfig.getPlatformConfig('alibaba_1688'));
    const accessToken = await this.shopTokens.getAccessToken(buyer.id, user.userId);

    if (order.status === 'paid') {
      await this.placeMissingPurchases(order, buyer.id, accessToken, adapter);
      const transitioned = await this.prisma.order.updateMany({
        where: {
          id: order.id,
          status: 'paid',
          OR: [
            { afterSaleStatus: { in: ['none', 'failed'] } },
            {
              afterSaleStatus: 'partial_refund',
              partialRefundDisposition: 'continue_remaining',
            },
          ],
        },
        data: { status: 'purchasing' },
      });
      if (transitioned.count === 0) {
        const current = await this.prisma.order.findUnique({
          where: { id: order.id },
          select: { status: true, afterSaleStatus: true, partialRefundDisposition: true },
        });
        if (current && isTerminalOrderStatus(current.status)) {
          await markPurchaseExceptionsForOrderEvent(this.prisma, order.id, current.status);
        } else if (current?.afterSaleStatus === 'partial_refund') {
          await markPurchaseExceptionsForOrderEvent(this.prisma, order.id, 'partial_refund');
        }
      }
      return { packages: [], requestId: null };
    }

    for (const purchase of order.purchaseOrders) {
      if (purchase.orderId1688) {
        await this.syncPurchase(purchase, accessToken, adapter);
      }
    }

    order = await this.loadOrder(user.userId, orderId);
    const packages = buildPackages(order);
    return {
      packages,
      requestId: packages.length ? stableShipmentRequestId(order.platformOrderId, packages) : null,
    };
  }

  async auditSettledPurchase(
    userId: bigint,
    purchaseOrderId: bigint,
  ): Promise<Alibaba1688PurchaseAuditOutcome> {
    this.assertEnabled();
    const purchase = await this.prisma.purchaseOrder.findFirst({
      where: {
        id: purchaseOrderId,
        orderId1688: { not: null },
        everShipped: true,
        exceptionStatus: { in: ['none', 'resolved'] },
        status: { in: ['shipped', 'received'] },
        order: {
          status: { in: ['shipped', 'received'] },
          shop: { userId },
        },
        buyerShop: {
          userId,
          platform: 'alibaba_1688',
          role: 'buyer',
          status: 'active',
          accessTokenEnc: { not: null },
          refreshTokenEnc: { not: null },
          NOT: { platformShopId: { startsWith: 'demo-' } },
        },
      },
      include: {
        items: { include: { orderItem: true } },
        shipments: { include: { items: { include: { orderItem: true } } } },
      },
    });
    if (!purchase || !purchase.buyerShopId) return 'skipped';

    const adapter = new Alibaba1688Adapter(this.oauthConfig.getPlatformConfig('alibaba_1688'));
    const accessToken = await this.shopTokens.getAccessToken(purchase.buyerShopId, userId);
    await this.syncPurchase(purchase, accessToken, adapter, true);
    const current = await this.prisma.purchaseOrder.findUnique({
      where: { id: purchase.id },
      select: { exceptionStatus: true },
    });
    return current?.exceptionStatus === 'action_required' ? 'action_required' : 'checked';
  }

  async prepareSettledLogisticsRepair(
    userId: bigint,
    orderId: bigint,
    purchaseOrderId: bigint,
    expectedRevision: number,
  ): Promise<SettledLogisticsRepairProposal> {
    this.assertEnabled();
    const order = await this.loadOrder(userId, orderId);
    if (
      order.status !== 'shipped' ||
      isAfterSaleBlocked(order.afterSaleStatus, order.partialRefundDisposition)
    ) {
      throw new BadRequestException('只有抖店仍为已发货状态的订单可自动更新物流');
    }
    const purchase = order.purchaseOrders.find((item) => item.id === purchaseOrderId);
    if (
      !purchase ||
      !purchase.buyerShopId ||
      !purchase.orderId1688 ||
      !purchase.everShipped ||
      purchase.retryEligible ||
      purchase.exceptionStatus !== 'action_required' ||
      purchase.exceptionRevision !== expectedRevision ||
      !['shipped', 'received'].includes(purchase.status)
    ) {
      throw new BadRequestException('当前采购异常不允许自动更新抖店物流');
    }

    const adapter = new Alibaba1688Adapter(this.oauthConfig.getPlatformConfig('alibaba_1688'));
    const accessToken = await this.shopTokens.getAccessToken(purchase.buyerShopId, userId);
    const remote = await adapter.getBuyerOrder(accessToken, purchase.orderId1688);
    if (remote.orderId !== purchase.orderId1688) {
      throw new PurchaseConsistencyError('1688 采购单详情与本地绑定不一致，已停止自动处理');
    }
    assertRemotePurchaseItemsMatch(
      remote,
      purchase.items,
      '1688 采购单商品明细与本地快照不一致，已停止自动处理',
    );
    const targetPurchaseStatus = mapPurchaseStatus(remote.status);
    assertPurchaseStatusTransition(purchase.status, targetPurchaseStatus);
    if (!['shipped', 'received'].includes(targetPurchaseStatus)) {
      throw new BadRequestException('1688 采购单当前没有可同步的新物流');
    }
    if (remote.totalAmount === null) {
      throw new PurchaseConsistencyError('1688 采购单缺少可核对的采购金额');
    }
    const logistics = await adapter.getLogisticsInfos(accessToken, purchase.orderId1688);
    if (logistics.length === 0) {
      throw new BadRequestException('1688 当前未返回物流快照，无法更新抖店物流');
    }
    const mapped = mapLogisticsToItems(purchase, remote, logistics);
    const previousPlatformPackages = buildPackages(order);
    const targetOrder = {
      ...order,
      purchaseOrders: order.purchaseOrders.map((item) =>
        item.id === purchase.id
          ? {
              ...item,
              status: targetPurchaseStatus,
              trackingNo: mapped[0]!.trackingNo,
              carrier: mapped[0]!.carrier,
              shipments: mapped,
            }
          : item,
      ),
    } as unknown as PurchasingOrder;
    const targetPlatformPackages = buildPackages(targetOrder);
    if (previousPlatformPackages.length === 0 || targetPlatformPackages.length === 0) {
      throw new PurchaseConsistencyError('订单包裹快照不完整，无法安全更新抖店物流');
    }
    const targetPurchaseShipments = mapped.map((shipment) => ({
      trackingNo: shipment.trackingNo,
      carrier: shipment.carrier,
      status: shipment.status,
      items: shipment.items.map((item) => ({
        orderItemId: item.orderItemId.toString(),
        quantity: item.quantity,
      })),
    }));
    return {
      purchaseOrderId: purchase.id,
      purchaseSyncRevision: purchase.syncRevision,
      priorIncurredCost: Number(purchase.priorIncurredCost),
      targetPurchaseStatus: targetPurchaseStatus as 'shipped' | 'received',
      targetPurchaseCost: remote.totalAmount,
      previousPlatformPackages,
      targetPlatformPackages,
      targetPurchaseShipments,
      targetFingerprint: shipmentPackagesFingerprint(targetPlatformPackages),
    };
  }

  private assertEnabled(): void {
    if (this.config.get<string>('ALIBABA_1688_PURCHASE_ENABLED') !== 'true') {
      throw new ServiceUnavailableException(
        '真实 1688 采购开关未启用，请先完成准备度检查并配置 ALIBABA_1688_PURCHASE_ENABLED=true',
      );
    }
    if (this.config.get<string>('ALIBABA_1688_PAYMENT_MODE') !== 'manual') {
      throw new ServiceUnavailableException('当前仅支持 1688 人工确认支付模式');
    }
  }

  private async loadOrder(userId: bigint, orderId: bigint): Promise<PurchasingOrder> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, shop: { userId } },
      include: {
        shop: true,
        items: {
          include: {
            purchaseOrderItem: true,
            publishedProduct: { include: { sourceProduct: true } },
          },
        },
        purchaseOrders: {
          include: {
            items: { include: { orderItem: true } },
            shipments: { include: { items: { include: { orderItem: true } } } },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('订单不存在');
    return order;
  }

  private async placeMissingPurchases(
    order: PurchasingOrder,
    buyerShopId: bigint,
    accessToken: string,
    adapter: Alibaba1688Adapter,
  ): Promise<void> {
    const preparedPurchases = await this.preparePurchaseSnapshots(order.id, buyerShopId);
    for (const { purchase, items, address } of preparedPurchases) {
      const current = await this.prisma.order.findUnique({
        where: { id: order.id },
        select: { status: true, afterSaleStatus: true, partialRefundDisposition: true },
      });
      if (
        current?.status !== 'paid' ||
        (current.afterSaleStatus !== undefined &&
          isAfterSaleBlocked(current.afterSaleStatus, current.partialRefundDisposition))
      ) {
        return;
      }

      if (purchase.orderId1688) continue;
      const outOrderId = purchase.outOrderId;

      try {
        let remote =
          purchase.status === 'failed' || purchase.retryCount > 0
            ? await adapter.findBuyerOrderByOutOrderId(accessToken, outOrderId)
            : null;
        let recoveredFromList = remote !== null;
        if (!remote) {
          try {
            const created = await adapter.createOrder(accessToken, {
              flow: 'saleproxy',
              address,
              cargo: items.map((item) => ({
                offerId: item.offerId,
                ...(item.specId ? { specId: item.specId } : {}),
                quantity: item.quantity,
              })),
              outOrderId,
              fenxiaoChannel: 'douyin',
            });
            remote = {
              orderId: created.orderId,
              status: 'unknown',
              totalAmount: null,
              items: [],
            };
          } catch (createError) {
            try {
              remote = await adapter.findBuyerOrderByOutOrderId(accessToken, outOrderId);
            } catch {
              throw createError;
            }
            if (!remote) throw createError;
            recoveredFromList = true;
          }
        }
        if (recoveredFromList) {
          assertRemotePurchaseItemsMatch(
            remote,
            items,
            '1688 恢复采购单商品明细与本地快照不一致，已停止自动处理',
          );
        }
        const persisted = await this.prisma.purchaseOrder.updateMany({
          where: {
            id: purchase.id,
            OR: [{ orderId1688: null }, { orderId1688: remote.orderId }],
          },
          data: {
            orderId1688: remote.orderId,
            status: 'awaiting_payment',
            failureReason: null,
          },
        });
        if (persisted.count !== 1) {
          throw new ServiceUnavailableException(
            '1688 采购单恢复结果与本地记录冲突，已停止自动处理',
          );
        }
      } catch (error) {
        try {
          await this.prisma.purchaseOrder.updateMany({
            where: {
              id: purchase.id,
              orderId1688: null,
              status: { in: ['pending', 'failed'] },
            },
            data: {
              status: 'failed',
              retryCount: { increment: 1 },
              failureReason: safeFailure(error),
            },
          });
        } catch (persistenceError) {
          this.logger.error(`1688 采购失败状态保存失败：${safeFailure(persistenceError)}`);
        }
        throw error;
      }
    }
  }

  private async preparePurchaseSnapshots(
    orderId: bigint,
    buyerShopId: bigint,
  ): Promise<PreparedPurchase[]> {
    return this.withSerializableTransaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: {
          shop: true,
          items: {
            include: {
              purchaseOrderItem: true,
              publishedProduct: { include: { sourceProduct: true } },
            },
          },
          purchaseOrders: {
            include: {
              items: { include: { orderItem: true } },
              shipments: { include: { items: { include: { orderItem: true } } } },
            },
          },
        },
      });
      if (!order) throw new NotFoundException('订单不存在');
      if (
        order.status !== 'paid' ||
        isAfterSaleBlocked(order.afterSaleStatus, order.partialRefundDisposition)
      ) {
        return [];
      }

      const address = this.decryptAddress(order);
      const groups = groupPurchaseItems(order);
      const expectedSuppliers = new Set(groups.keys());
      const unexpected = order.purchaseOrders.find(
        (purchase) => !expectedSuppliers.has(purchase.supplierKey),
      );
      if (unexpected) {
        throw new ServiceUnavailableException('采购拆单与当前订单项不一致，已停止自动下单');
      }

      const prepared: PreparedPurchase[] = [];
      for (const [supplierKey, items] of groups) {
        const existing = order.purchaseOrders.find(
          (purchase) => purchase.supplierKey === supplierKey,
        );
        assertPurchaseItemsMatch(existing, items);
        if (existing && existing.status !== 'pending' && existing.status !== 'failed') {
          continue;
        }
        if (existing && existing.retryCount >= MAX_PURCHASE_RETRIES) {
          throw new ServiceUnavailableException(
            `1688 采购单 ${existing.outOrderId} 已达到最大重试次数，请人工处理`,
          );
        }

        const purchaseCost = items.reduce(
          (sum, item) => sum + (item.unitCost ?? 0) * item.quantity,
          0,
        );
        const stored = await tx.purchaseOrder.upsert({
          where: { uk_order_supplier_purchase: { orderId, supplierKey } },
          create: {
            orderId,
            buyerShopId,
            supplierKey,
            outOrderId: `supplier-${orderId}-${supplierKey}`,
            paymentMode: 'manual',
            purchaseCost: purchaseCost || null,
            status: 'pending',
          },
          update: {
            buyerShopId,
            purchaseCost: purchaseCost || null,
            failureReason: null,
          },
        });
        for (const item of items) {
          await tx.purchaseOrderItem.upsert({
            where: { orderItemId: item.id },
            create: {
              purchaseOrderId: stored.id,
              orderItemId: item.id,
              offerId: item.offerId,
              specId: item.specId,
              quantity: item.quantity,
              unitCost: item.unitCost,
            },
            update: {
              purchaseOrderId: stored.id,
              offerId: item.offerId,
              specId: item.specId,
              quantity: item.quantity,
              unitCost: item.unitCost,
            },
          });
        }
        prepared.push({ purchase: stored, items, address });
      }
      return prepared;
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
    throw new ServiceUnavailableException('采购快照创建失败，请稍后重试');
  }

  private decryptAddress(order: PurchasingOrder) {
    if (!order.receiverNameEnc || !order.receiverPhoneEnc || !order.receiverAddressDetailEnc) {
      throw new ServiceUnavailableException('订单缺少可用于 1688 代发的完整收件信息');
    }
    let phone: string;
    let receiver: string;
    let value: unknown;
    try {
      phone = this.crypto.decrypt(order.receiverPhoneEnc).trim();
      receiver = this.crypto.decrypt(order.receiverNameEnc).trim();
      value = JSON.parse(this.crypto.decrypt(order.receiverAddressDetailEnc));
    } catch {
      throw new ServiceUnavailableException('订单收件信息无法安全解密，已停止自动下单');
    }
    const address = addressRecord(value);
    if (!address || !receiver || !phone) {
      throw new ServiceUnavailableException('订单收件信息不完整，已停止自动下单');
    }
    return {
      provinceText: requiredText(address.province, '省份'),
      cityText: requiredText(address.city, '城市'),
      areaText: requiredText(address.area, '区县'),
      townText: optionalText(address.town),
      address: requiredText(address.detail, '详细地址'),
      fullName: receiver,
      ...(/^1\d{10}$/.test(phone) ? { mobile: phone } : { phone }),
      postCode: optionalText(address.postalCode),
    };
  }

  private async syncPurchase(
    purchase: PurchaseOrderGraph,
    accessToken: string,
    adapter: Alibaba1688Adapter,
    settledOrder = false,
  ): Promise<void> {
    const claim = settledOrder
      ? await this.claimSettledPurchase(purchase)
      : await this.prisma.purchaseOrder.update({
          where: { id: purchase.id },
          data: { syncRevision: { increment: 1 } },
          select: { syncRevision: true, status: true },
        });
    if (!claim) return;

    let remote: Alibaba1688BuyerOrder;
    let status: ReturnType<typeof mapPurchaseStatus>;
    try {
      remote = await adapter.getBuyerOrder(accessToken, purchase.orderId1688!);
      if (remote.orderId !== purchase.orderId1688) {
        throw new PurchaseConsistencyError('1688 采购单详情与本地绑定不一致，已停止自动处理');
      }
      assertRemotePurchaseItemsMatch(
        remote,
        purchase.items,
        '1688 采购单商品明细与本地快照不一致，已停止自动处理',
      );
      status = mapPurchaseStatus(remote.status);
      assertPurchaseStatusTransition(claim.status, status);
    } catch (error) {
      if (error instanceof PurchaseConsistencyError) {
        if (settledOrder) {
          await this.flagSettledPurchase(
            purchase.id,
            claim.syncRevision,
            PURCHASE_EXCEPTION_CODE.snapshotMismatch,
            error.message,
          );
        } else {
          await this.flagActivePurchase(
            purchase.id,
            claim.syncRevision,
            PURCHASE_EXCEPTION_CODE.snapshotMismatch,
            error.message,
          );
          throw error;
        }
        return;
      }
      throw error;
    }
    if (status === 'failed') {
      const retryEligible =
        ['pending', 'placed', 'awaiting_payment', 'paid'].includes(claim.status) &&
        !purchase.everShipped &&
        purchase.shipments.length === 0;
      await this.prisma.purchaseOrder.updateMany({
        where: ownedPurchaseWhere(purchase.id, claim.syncRevision, settledOrder),
        data: {
          status: 'failed',
          purchaseCost: settledOrder
            ? purchase.purchaseCost
            : (remote.totalAmount ?? purchase.purchaseCost),
          retryEligible,
          failureReason: `1688 采购单状态：${safeStatus(remote.status)}`,
          exceptionStatus: 'action_required',
          exceptionRevision: { increment: 1 },
          exceptionCode: settledOrder
            ? PURCHASE_EXCEPTION_CODE.remoteCancelledAfterShipment
            : retryEligible
              ? PURCHASE_EXCEPTION_CODE.remoteCancelledRetryable
              : PURCHASE_EXCEPTION_CODE.remoteCancelledManual,
          exceptionReason: settledOrder
            ? '抖店订单已发货，但 1688 采购单后续进入取消或关闭状态；请核对采购成本，并在抖店和 1688 完成人工物流处置。'
            : retryEligible
              ? '1688 采购单已取消或关闭，自动履约已停止；请核对本次实际成本后重新采购。'
              : '1688 采购单在发货后进入取消或关闭状态，自动履约已停止；请核对实际成本和物流后人工处理。',
          exceptionDetectedAt: new Date(),
          exceptionResolvedAt: null,
          exceptionResolutionNote: null,
          reconciledCost: null,
        },
      });
      return;
    }
    if (settledOrder && !samePurchaseCost(purchase.purchaseCost, remote.totalAmount)) {
      await this.flagSettledPurchase(
        purchase.id,
        claim.syncRevision,
        PURCHASE_EXCEPTION_CODE.costChanged,
        '抖店订单已发货，但 1688 采购金额后续发生变化；系统保留原成本，请人工核对。',
      );
      return;
    }
    const purchaseData = {
      status,
      ...(settledOrder ? {} : { purchaseCost: remote.totalAmount ?? purchase.purchaseCost }),
      failureReason: null,
    };
    if (status !== 'shipped' && status !== 'received') {
      await this.prisma.purchaseOrder.updateMany({
        where: ownedPurchaseWhere(purchase.id, claim.syncRevision, settledOrder),
        data: purchaseData,
      });
      return;
    }

    const logistics = await adapter.getLogisticsInfos(accessToken, purchase.orderId1688!);
    if (logistics.length === 0) {
      if (settledOrder) {
        await this.flagSettledPurchase(
          purchase.id,
          claim.syncRevision,
          PURCHASE_EXCEPTION_CODE.logisticsSnapshotMissing,
          '抖店订单已发货，但 1688 不再返回物流快照；系统保留原包裹并停止静默更新，请人工核对。',
        );
        return;
      }
      await this.prisma.purchaseOrder.updateMany({
        where: ownedPurchaseWhere(purchase.id, claim.syncRevision, settledOrder),
        data: purchaseData,
      });
      return;
    }
    let mapped: ReturnType<typeof mapLogisticsToItems>;
    try {
      mapped = mapLogisticsToItems(purchase, remote, logistics);
    } catch (error) {
      if (error instanceof PurchaseConsistencyError) {
        if (settledOrder) {
          await this.flagSettledPurchase(
            purchase.id,
            claim.syncRevision,
            PURCHASE_EXCEPTION_CODE.logisticsMappingMismatch,
            error.message,
          );
        } else {
          await this.flagActivePurchase(
            purchase.id,
            claim.syncRevision,
            PURCHASE_EXCEPTION_CODE.logisticsMappingMismatch,
            error.message,
          );
          throw error;
        }
        return;
      }
      throw error;
    }
    if (settledOrder && !sameShipmentRouting(purchase, mapped)) {
      await this.flagSettledPurchase(
        purchase.id,
        claim.syncRevision,
        PURCHASE_EXCEPTION_CODE.logisticsRoutingChanged,
        '抖店订单已发货，但 1688 运单、承运商或商品包裹映射已变化；系统保留原快照，请人工同步两端物流。',
      );
      return;
    }
    await this.prisma.$transaction(async (tx) => {
      const persisted = await tx.purchaseOrder.updateMany({
        where: ownedPurchaseWhere(purchase.id, claim.syncRevision, settledOrder),
        data: {
          ...purchaseData,
          everShipped: true,
          trackingNo: mapped[0]!.trackingNo,
          carrier: mapped[0]!.carrier,
        },
      });
      if (persisted.count === 0) return;
      await tx.purchaseShipment.deleteMany({
        where: {
          purchaseOrderId: purchase.id,
          trackingNo: { notIn: mapped.map((shipment) => shipment.trackingNo) },
        },
      });
      for (const shipment of mapped) {
        const stored = await tx.purchaseShipment.upsert({
          where: {
            purchaseOrderId_trackingNo: {
              purchaseOrderId: purchase.id,
              trackingNo: shipment.trackingNo,
            },
          },
          create: {
            purchaseOrderId: purchase.id,
            trackingNo: shipment.trackingNo,
            carrier: shipment.carrier,
            status: shipment.status,
          },
          update: { carrier: shipment.carrier, status: shipment.status },
        });
        await tx.purchaseShipmentItem.deleteMany({
          where: { purchaseShipmentId: stored.id },
        });
        await tx.purchaseShipmentItem.createMany({
          data: shipment.items.map((item) => ({
            purchaseShipmentId: stored.id,
            orderItemId: item.orderItemId,
            quantity: item.quantity,
          })),
        });
      }
    });
  }

  private async claimSettledPurchase(
    purchase: PurchaseOrderGraph,
  ): Promise<{ syncRevision: number; status: PurchaseOrderGraph['status'] } | null> {
    const claimed = await this.prisma.purchaseOrder.updateMany({
      where: {
        id: purchase.id,
        syncRevision: purchase.syncRevision,
        everShipped: true,
        exceptionStatus: { in: ['none', 'resolved'] },
        status: { in: ['shipped', 'received'] },
        order: { status: { in: ['shipped', 'received'] } },
      },
      data: { syncRevision: { increment: 1 } },
    });
    return claimed.count === 1
      ? { syncRevision: purchase.syncRevision + 1, status: purchase.status }
      : null;
  }

  private async flagSettledPurchase(
    purchaseOrderId: bigint,
    syncRevision: number,
    code: PurchaseExceptionCode,
    reason: string,
  ): Promise<void> {
    await this.prisma.purchaseOrder.updateMany({
      where: {
        id: purchaseOrderId,
        syncRevision,
        exceptionStatus: { in: ['none', 'resolved'] },
        status: { in: ['shipped', 'received'] },
        order: { status: { in: ['shipped', 'received'] } },
      },
      data: {
        retryEligible: false,
        exceptionStatus: 'action_required',
        exceptionRevision: { increment: 1 },
        exceptionCode: code,
        exceptionReason: reason,
        exceptionDetectedAt: new Date(),
        exceptionResolvedAt: null,
        exceptionResolutionNote: null,
        reconciledCost: null,
      },
    });
  }

  private async flagActivePurchase(
    purchaseOrderId: bigint,
    syncRevision: number,
    code: PurchaseExceptionCode,
    reason: string,
  ): Promise<void> {
    await this.prisma.purchaseOrder.updateMany({
      where: {
        id: purchaseOrderId,
        syncRevision,
        exceptionStatus: { in: ['none', 'resolved'] },
      },
      data: {
        retryEligible: false,
        exceptionStatus: 'action_required',
        exceptionRevision: { increment: 1 },
        exceptionCode: code,
        exceptionReason: reason,
        exceptionDetectedAt: new Date(),
        exceptionResolvedAt: null,
        exceptionResolutionNote: null,
        reconciledCost: null,
      },
    });
  }
}

function ownedPurchaseWhere(
  purchaseOrderId: bigint,
  syncRevision: number,
  settledOrder: boolean,
): Prisma.PurchaseOrderWhereInput {
  return settledOrder
    ? {
        id: purchaseOrderId,
        syncRevision,
        exceptionStatus: { in: ['none', 'resolved'] },
        status: { in: ['shipped', 'received'] },
        order: { status: { in: ['shipped', 'received'] } },
      }
    : { id: purchaseOrderId, syncRevision };
}

function samePurchaseCost(
  stored: PurchaseOrderGraph['purchaseCost'],
  remote: number | null,
): boolean {
  if (stored === null || remote === null) return stored === null && remote === null;
  return Math.round(Number(stored) * 100) === Math.round(remote * 100);
}

function isAfterSaleBlocked(status: string | undefined, disposition?: string): boolean {
  return (
    status === 'pending' ||
    status === 'refunded' ||
    (status === 'partial_refund' && disposition !== 'continue_remaining')
  );
}

interface GroupedPurchaseItem {
  id: bigint;
  offerId: string;
  specId: string | null;
  quantity: number;
  unitCost: number | null;
}

function groupPurchaseItems(order: PurchasingOrder): Map<string, GroupedPurchaseItem[]> {
  const orderItems = eligibleOrderItems(order);
  if (orderItems.length === 0) {
    throw new ServiceUnavailableException('订单没有可采购的商品项');
  }
  const groups = new Map<string, GroupedPurchaseItem[]>();
  for (const item of orderItems) {
    const versionedBinding =
      (item.sourceBindingId !== null && item.sourceBindingId !== undefined) ||
      (item.sourceUnitCost !== null && item.sourceUnitCost !== undefined) ||
      (item.sourceOnePieceDrop !== null && item.sourceOnePieceDrop !== undefined);
    const supplierKey = item.sourceSupplierId?.trim();
    const offerId = item.sourceOfferId?.trim();
    const specId = item.sourceSpecId?.trim() || null;
    if (!supplierKey || !offerId || !/^[1-9]\d*$/.test(offerId)) {
      throw new ServiceUnavailableException('订单项缺少有效的 1688 供应商或商品绑定');
    }
    if (item.sourceSpecRequired && !specId) {
      throw new ServiceUnavailableException('订单项缺少必需的 1688 规格绑定');
    }
    if (
      versionedBinding
        ? item.sourceOnePieceDrop !== true
        : !item.publishedProduct?.sourceProduct.isOnePieceDrop
    ) {
      throw new ServiceUnavailableException('订单项货源未确认支持 1688 一件代发');
    }
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new ServiceUnavailableException('订单项采购数量无效');
    }
    const values = groups.get(supplierKey) ?? [];
    const unitCost = versionedBinding
      ? bindingUnitCost(item.sourceUnitCost)
      : item.publishedProduct?.costPrice === null || item.publishedProduct?.costPrice === undefined
        ? null
        : Number(item.publishedProduct.costPrice);
    values.push({
      id: item.id,
      offerId,
      specId,
      quantity: item.quantity,
      unitCost,
    });
    groups.set(supplierKey, values);
  }
  return groups;
}

function bindingUnitCost(value: PurchasingOrder['items'][number]['sourceUnitCost']): number {
  if (value === null || value === undefined) {
    throw new ServiceUnavailableException('订单项缺少版本化货源单价快照');
  }
  const cost = Number(value);
  if (!Number.isFinite(cost) || cost <= 0 || cost > 99_999_999.99) {
    throw new ServiceUnavailableException('订单项版本化货源单价快照无效');
  }
  return cost;
}

function assertPurchaseItemsMatch(
  purchase: PurchaseOrderGraph | undefined,
  items: GroupedPurchaseItem[],
): void {
  if (!purchase || purchase.items.length === 0) return;
  const expected = new Map(items.map((item) => [item.id, item]));
  const mismatch =
    purchase.items.length !== items.length ||
    purchase.items.some((stored) => {
      const item = expected.get(stored.orderItemId);
      return (
        !item ||
        stored.offerId !== item.offerId ||
        (stored.specId ?? null) !== item.specId ||
        stored.quantity !== item.quantity
      );
    });
  if (mismatch) {
    throw new ServiceUnavailableException('采购单商品快照与销售订单不一致，已停止自动重试');
  }
}

interface PurchaseSnapshotItem {
  offerId: string;
  specId: string | null;
  quantity: number;
}

function assertRemotePurchaseItemsMatch(
  remote: Alibaba1688BuyerOrder,
  items: PurchaseSnapshotItem[],
  errorMessage: string,
): void {
  const expected = new Map<string, number>();
  for (const item of items) {
    const key = cargoKey(item.offerId, item.specId);
    expected.set(key, (expected.get(key) ?? 0) + item.quantity);
  }
  const actual = new Map<string, number>();
  for (const item of remote.items) {
    const key = cargoKey(item.offerId, item.specId);
    actual.set(key, (actual.get(key) ?? 0) + item.quantity);
  }
  if (
    actual.size !== expected.size ||
    [...expected].some(([key, quantity]) => actual.get(key) !== quantity)
  ) {
    throw new PurchaseConsistencyError(errorMessage);
  }
}

function mapPurchaseStatus(
  value: string,
): 'awaiting_payment' | 'paid' | 'shipped' | 'received' | 'failed' {
  const status = value.toLowerCase();
  if (['waitbuyerpay', 'waitbuyerpayment'].includes(status)) return 'awaiting_payment';
  if (['waitsellersend', 'waitselleract'].includes(status)) return 'paid';
  if (['waitbuyerreceive', 'waitlogisticstakein'].includes(status)) return 'shipped';
  if (['success', 'confirm_goods', 'received'].includes(status)) return 'received';
  if (['cancel', 'canceled', 'closed', 'terminated'].includes(status)) return 'failed';
  throw new PurchaseConsistencyError(`无法识别 1688 采购单状态：${safeStatus(value)}`);
}

function assertPurchaseStatusTransition(
  current: PurchaseOrderGraph['status'],
  next: ReturnType<typeof mapPurchaseStatus>,
): void {
  if (next === 'failed') return;
  if (current === 'failed') {
    throw new PurchaseConsistencyError('1688 采购单终态不能自动恢复，已停止自动处理');
  }
  const rank = {
    pending: 0,
    placed: 1,
    awaiting_payment: 1,
    paid: 2,
    shipped: 3,
    received: 4,
  } as const;
  if (rank[next] < rank[current]) {
    throw new PurchaseConsistencyError('1688 采购单状态发生回退，已停止自动处理');
  }
}

function mapLogisticsToItems(
  purchase: PurchaseOrderGraph,
  remote: Alibaba1688BuyerOrder,
  logistics: Alibaba1688LogisticsInfo[],
) {
  if (new Set(logistics.map((info) => info.trackingNo)).size !== logistics.length) {
    throw new PurchaseConsistencyError('1688 物流返回重复运单，已停止自动处理');
  }
  const localByCargo = new Map<string, PurchaseOrderGraph['items']>();
  for (const item of purchase.items) {
    const key = cargoKey(item.offerId, item.specId);
    const values = localByCargo.get(key) ?? [];
    values.push(item);
    localByCargo.set(key, values);
  }
  const localByRemoteEntry = new Map<string, PurchaseOrderGraph['items']>();
  const remoteCargoKeys = new Set<string>();
  for (const remoteItem of remote.items) {
    const key = cargoKey(remoteItem.offerId, remoteItem.specId);
    if (remoteCargoKeys.has(key)) {
      throw new PurchaseConsistencyError('1688 采购单将同一规格拆成多个明细，无法安全映射');
    }
    remoteCargoKeys.add(key);
    const local = localByCargo.get(key) ?? [];
    const quantity = local.reduce((sum, item) => sum + item.quantity, 0);
    if (local.length === 0 || quantity !== remoteItem.quantity) {
      throw new PurchaseConsistencyError('1688 采购单商品明细与本地快照不一致');
    }
    localByRemoteEntry.set(remoteItem.subItemId, local);
  }
  if (localByRemoteEntry.size !== remote.items.length) {
    throw new PurchaseConsistencyError('1688 采购单商品明细存在重复映射');
  }

  const entryUseCount = new Map<string, number>();
  for (const info of logistics) {
    for (const entryId of info.orderEntryIds) {
      entryUseCount.set(entryId, (entryUseCount.get(entryId) ?? 0) + 1);
    }
  }
  if ([...entryUseCount.values()].some((count) => count > 1)) {
    throw new PurchaseConsistencyError('1688 子商品被拆入多个包裹，缺少可验证的分包数量');
  }

  const mapped = logistics.map((info) => {
    const entries = info.orderEntryIds.length
      ? info.orderEntryIds
      : logistics.length === 1
        ? [...localByRemoteEntry.keys()]
        : [];
    if (entries.some((entryId) => !localByRemoteEntry.has(entryId))) {
      throw new PurchaseConsistencyError('1688 物流包含无法识别的商品明细');
    }
    const items = entries.flatMap((entryId) => localByRemoteEntry.get(entryId) ?? []);
    if (!info.trackingNo || !info.carrier || items.length === 0) {
      throw new PurchaseConsistencyError('1688 物流缺少承运商或商品项映射');
    }
    return {
      trackingNo: info.trackingNo,
      carrier: info.carrier,
      status: info.status,
      items: items.map((item) => ({
        orderItemId: item.orderItemId,
        quantity: item.quantity,
      })),
    };
  });
  const covered = new Set(
    mapped.flatMap((shipment) => shipment.items.map((item) => item.orderItemId)),
  );
  if (covered.size !== purchase.items.length) {
    throw new PurchaseConsistencyError('1688 物流尚未覆盖全部采购商品项');
  }
  return mapped;
}

function sameShipmentRouting(
  purchase: PurchaseOrderGraph,
  mapped: ReturnType<typeof mapLogisticsToItems>,
): boolean {
  if (purchase.shipments.some((shipment) => !shipment.carrier)) return false;
  const stored = purchase.shipments
    .map((shipment) => ({
      trackingNo: shipment.trackingNo,
      carrier: shipment.carrier!,
      items: shipment.items
        .map((item) => ({ orderItemId: item.orderItemId.toString(), quantity: item.quantity }))
        .sort((a, b) => a.orderItemId.localeCompare(b.orderItemId)),
    }))
    .sort((a, b) => a.trackingNo.localeCompare(b.trackingNo) || a.carrier.localeCompare(b.carrier));
  const current = mapped
    .map((shipment) => ({
      trackingNo: shipment.trackingNo,
      carrier: shipment.carrier,
      items: shipment.items
        .map((item) => ({ orderItemId: item.orderItemId.toString(), quantity: item.quantity }))
        .sort((a, b) => a.orderItemId.localeCompare(b.orderItemId)),
    }))
    .sort((a, b) => a.trackingNo.localeCompare(b.trackingNo) || a.carrier.localeCompare(b.carrier));
  return JSON.stringify(stored) === JSON.stringify(current);
}

function buildPackages(order: PurchasingOrder): ShipPackageDto[] {
  if (
    order.purchaseOrders.length === 0 ||
    order.purchaseOrders.some(
      (purchase) =>
        !['shipped', 'received'].includes(purchase.status) || purchase.shipments.length === 0,
    )
  ) {
    return [];
  }
  const eligibleItems = eligibleOrderItems(order);
  const eligibleById = new Map(eligibleItems.map((item) => [item.id, item]));
  const purchasedItemIds = new Set<bigint>();
  const packages = new Map<string, ShipPackageDto>();
  const shippedQuantity = new Map<bigint, number>();
  for (const purchase of order.purchaseOrders) {
    const purchaseItemIds = new Set<bigint>();
    for (const item of purchase.items) {
      const orderItem = eligibleById.get(item.orderItemId);
      if (
        !orderItem ||
        item.quantity !== orderItem.quantity ||
        purchaseItemIds.has(item.orderItemId) ||
        purchasedItemIds.has(item.orderItemId)
      ) {
        throw new ServiceUnavailableException('1688 采购商品快照与待履约订单项不一致');
      }
      purchaseItemIds.add(item.orderItemId);
      purchasedItemIds.add(item.orderItemId);
    }
    for (const shipment of purchase.shipments) {
      if (!shipment.carrier || shipment.items.length === 0) return [];
      const key = `${shipment.carrier}\u0000${shipment.trackingNo}`;
      const pack = packages.get(key) ?? {
        trackingNo: shipment.trackingNo,
        carrier: shipment.carrier,
        items: [],
      };
      for (const item of shipment.items) {
        const orderItem = eligibleById.get(item.orderItemId);
        if (!orderItem || !purchaseItemIds.has(item.orderItemId)) {
          throw new ServiceUnavailableException('1688 包裹包含不属于当前采购单的订单项');
        }
        if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
          throw new ServiceUnavailableException('1688 包裹商品数量无效');
        }
        pack.items.push({
          platformOrderItemId: orderItem.platformOrderItemId,
          quantity: item.quantity,
        });
        shippedQuantity.set(
          item.orderItemId,
          (shippedQuantity.get(item.orderItemId) ?? 0) + item.quantity,
        );
      }
      packages.set(key, pack);
    }
  }
  if (purchasedItemIds.size !== eligibleById.size) {
    throw new ServiceUnavailableException('1688 采购商品快照与待履约订单项不一致');
  }
  if (eligibleItems.some((item) => (shippedQuantity.get(item.id) ?? 0) !== item.quantity)) {
    throw new ServiceUnavailableException('1688 包裹数量与销售订单项数量不一致');
  }
  return [...packages.values()];
}

function eligibleOrderItems(order: PurchasingOrder): PurchasingOrder['items'] {
  return order.afterSaleStatus === 'partial_refund' &&
    order.partialRefundDisposition === 'continue_remaining'
    ? order.items.filter((item) => !(item.refundStatusRaw === 3 && item.afterSaleTypeRaw !== 6))
    : order.items;
}

function stableShipmentRequestId(platformOrderId: string, packages: ShipPackageDto[]): string {
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        platformOrderId,
        packages: [...packages]
          .map((pack) => ({
            carrier: pack.carrier,
            trackingNo: pack.trackingNo,
            items: [...pack.items].sort((a, b) =>
              a.platformOrderItemId.localeCompare(b.platformOrderItemId),
            ),
          }))
          .sort((a, b) => a.trackingNo.localeCompare(b.trackingNo)),
      }),
    )
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function shipmentPackagesFingerprint(packages: ShipPackageDto[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        packages
          .map((pack) => ({
            carrier: pack.carrier,
            trackingNo: pack.trackingNo,
            items: [...pack.items].sort(
              (left, right) =>
                left.platformOrderItemId.localeCompare(right.platformOrderItemId) ||
                left.quantity - right.quantity,
            ),
          }))
          .sort(
            (left, right) =>
              left.trackingNo.localeCompare(right.trackingNo) ||
              left.carrier.localeCompare(right.carrier),
          ),
      ),
    )
    .digest('hex');
}

function cargoKey(offerId: string, specId: string | null): string {
  return `${offerId}\u0000${specId ?? ''}`;
}

function addressRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredText(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new ServiceUnavailableException(`订单收件${label}缺失`);
  return text;
}

function optionalText(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

function safeFailure(error: unknown): string {
  return (error instanceof Error ? error.message : '1688 采购请求失败').slice(0, 500);
}

function safeStatus(value: string): string {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : 'unknown';
}

function isSerializationConflict(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'P2034';
}
