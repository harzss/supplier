import type { PlatformAdapter } from '@supplier/platform-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { CurrentUser } from '../entitlement/user-context.service';
import type { AlertService } from '../observability/alert.service';
import type { PlatformAdapterFactory } from '../shop/platform-adapter.factory';
import type { ShopTokenService } from '../shop/shop-token.service';
import type { Alibaba1688PurchaseService } from './alibaba1688-purchase.service';
import {
  ORDER_LOGISTICS_REPAIR_HEARTBEAT_MS,
  OrderLogisticsRepairService,
} from './order-logistics-repair.service';
import type { OrderService, OrderView } from './order.service';

const USER: CurrentUser = {
  userId: 1n,
  plan: 'pro',
  entitlementSource: 'internal_beta',
  accessStatus: 'active',
  entitlementRevision: 1,
};
const NOW = new Date('2026-07-22T12:00:00.000Z');

function repair(status: 'pending' | 'running' | 'completed' = 'pending') {
  return {
    id: 41n,
    repairKey: 'a'.repeat(64),
    orderId: 5n,
    purchaseOrderId: 7n,
    operatorUserId: 1n,
    exceptionRevision: 4,
    purchaseSyncRevision: 3,
    targetFingerprint: 'b'.repeat(64),
    previousPlatformPackages: [
      {
        trackingNo: 'OLD111',
        carrier: '顺丰速运',
        items: [{ platformOrderItemId: 'sku-order-1', quantity: 1 }],
      },
    ],
    targetPlatformPackages: [
      {
        trackingNo: 'NEW222',
        carrier: '圆通速递',
        items: [{ platformOrderItemId: 'sku-order-1', quantity: 1 }],
      },
    ],
    targetPurchaseShipments: [
      {
        trackingNo: 'NEW222',
        carrier: '圆通速递',
        status: 'ACCEPT',
        items: [{ orderItemId: '11', quantity: 1 }],
      },
    ],
    targetPurchaseStatus: 'shipped' as const,
    targetPurchaseCost: 12,
    reconciledCost: 12,
    resolutionNote: '已核对 1688 和抖店包裹',
    status,
    attempts: status === 'completed' ? 1 : 0,
    lockedAt: null,
    lockedBy: null,
    lastError: null,
    completedAt: status === 'completed' ? NOW : null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function orderView(): OrderView {
  return { orderId: '5', status: 'shipped' } as OrderView;
}

describe('OrderLogisticsRepairService', () => {
  it('updates Douyin first and atomically replaces the owned local shipment snapshot', async () => {
    const storedRepair = repair();
    const claimRepair = vi.fn().mockResolvedValue({ count: 1 });
    const completeRepair = vi.fn().mockResolvedValue({ count: 1 });
    const purchaseUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const recoveryCreate = vi.fn().mockResolvedValue({ id: 51n });
    const shipmentDelete = vi.fn().mockResolvedValue({ count: 1 });
    const shipmentCreate = vi.fn().mockResolvedValue({ id: 61n });
    const shipmentItemCreate = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = vi.fn(async (callback) =>
      callback({
        purchaseOrder: {
          findFirst: vi.fn().mockResolvedValue({
            id: 7n,
            orderId: 5n,
            orderId1688: '900001',
            outOrderId: 'supplier-5-a',
            status: 'shipped',
            shipments: [
              {
                trackingNo: 'OLD111',
                carrier: '顺丰速运',
                status: 'ACCEPT',
                items: [{ orderItemId: 11n, quantity: 1 }],
              },
            ],
          }),
          updateMany: purchaseUpdate,
        },
        purchaseOrderRecovery: { create: recoveryCreate },
        purchaseShipment: { deleteMany: shipmentDelete, create: shipmentCreate },
        purchaseShipmentItem: { createMany: shipmentItemCreate },
        orderLogisticsRepair: { updateMany: completeRepair },
      }),
    );
    const prisma = {
      orderLogisticsRepair: {
        findFirst: vi.fn().mockResolvedValue(storedRepair),
        updateMany: claimRepair,
      },
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 5n,
          platformOrderId: 'douyin-5',
          shop: { id: 9n, platform: 'douyin' },
        }),
      },
      $transaction: transaction,
    } as unknown as PrismaService;
    const replaceShipPackages = vi.fn().mockResolvedValue(undefined);
    const getOne = vi.fn().mockResolvedValue(orderView());
    const resolve = vi.fn().mockResolvedValue(undefined);
    const service = new OrderLogisticsRepairService(
      prisma,
      { getOne } as unknown as OrderService,
      { getAccessToken: vi.fn().mockResolvedValue('seller-token') } as unknown as ShopTokenService,
      {
        create: vi.fn().mockReturnValue({ replaceShipPackages } as unknown as PlatformAdapter),
      } as unknown as PlatformAdapterFactory,
      {} as Alibaba1688PurchaseService,
      { resolve } as unknown as AlertService,
    );

    await expect(
      service.repair(USER, '5', '7', 12, 4, '已核对 1688 和抖店包裹'),
    ).resolves.toMatchObject({ orderId: '5', status: 'shipped' });

    expect(replaceShipPackages).toHaveBeenCalledWith(
      'seller-token',
      {
        platformOrderId: 'douyin-5',
        previousPackages: storedRepair.previousPlatformPackages,
        targetPackages: storedRepair.targetPlatformPackages,
      },
      expect.objectContaining({ assertOwned: expect.any(Function) }),
    );
    expect(purchaseUpdate).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 7n,
        orderId: 5n,
        syncRevision: 3,
        exceptionStatus: 'action_required',
        exceptionRevision: 4,
      }),
      data: expect.objectContaining({
        status: 'shipped',
        purchaseCost: 12,
        reconciledCost: 12,
        trackingNo: 'NEW222',
        carrier: '圆通速递',
        syncRevision: { increment: 1 },
        exceptionStatus: 'resolved',
      }),
    });
    expect(recoveryCreate).toHaveBeenCalledTimes(1);
    expect(shipmentDelete).toHaveBeenCalledWith({ where: { purchaseOrderId: 7n } });
    expect(shipmentCreate).toHaveBeenCalledWith({
      data: {
        purchaseOrderId: 7n,
        trackingNo: 'NEW222',
        carrier: '圆通速递',
        status: 'ACCEPT',
      },
    });
    expect(completeRepair).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 41n, status: 'running' }),
      data: expect.objectContaining({ status: 'completed' }),
    });
    expect(resolve).toHaveBeenCalledWith('purchase_audit.purchase.7', {
      purchaseOrderId: 7n,
      orderId: 5n,
      repairId: 41n,
    });
  });

  it('releases the execution lock when the platform update fails', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      orderLogisticsRepair: {
        findFirst: vi.fn().mockResolvedValue(repair()),
        updateMany,
      },
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 5n,
          platformOrderId: 'douyin-5',
          shop: { id: 9n, platform: 'douyin' },
        }),
      },
      $transaction: vi.fn(),
    } as unknown as PrismaService;
    const service = new OrderLogisticsRepairService(
      prisma,
      { getOne: vi.fn() } as unknown as OrderService,
      { getAccessToken: vi.fn().mockResolvedValue('seller-token') } as unknown as ShopTokenService,
      {
        create: vi.fn().mockReturnValue({
          replaceShipPackages: vi.fn().mockRejectedValue(new Error('platform unavailable')),
        } as unknown as PlatformAdapter),
      } as unknown as PlatformAdapterFactory,
      {} as Alibaba1688PurchaseService,
      { resolve: vi.fn() } as unknown as AlertService,
    );

    await expect(service.repair(USER, '5', '7', 12, 4, '已核对 1688 和抖店包裹')).rejects.toThrow(
      'platform unavailable',
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 41n, status: 'running' }),
      data: expect.objectContaining({
        status: 'pending',
        lockedAt: null,
        lockedBy: null,
        lastError: 'platform unavailable',
      }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('renews the repair lease while a long platform replacement is running', async () => {
    vi.useFakeTimers();
    try {
      let rejectPlatform!: (error: Error) => void;
      const platformCall = new Promise<void>((_resolve, reject) => {
        rejectPlatform = reject;
      });
      const updateMany = vi.fn().mockResolvedValue({ count: 1 });
      const replaceShipPackages = vi.fn().mockReturnValue(platformCall);
      const prisma = {
        orderLogisticsRepair: {
          findFirst: vi.fn().mockResolvedValue(repair()),
          updateMany,
        },
        order: {
          findFirst: vi.fn().mockResolvedValue({
            id: 5n,
            platformOrderId: 'douyin-5',
            shop: { id: 9n, platform: 'douyin' },
          }),
        },
        $transaction: vi.fn(),
      } as unknown as PrismaService;
      const service = new OrderLogisticsRepairService(
        prisma,
        { getOne: vi.fn() } as unknown as OrderService,
        {
          getAccessToken: vi.fn().mockResolvedValue('seller-token'),
        } as unknown as ShopTokenService,
        {
          create: vi.fn().mockReturnValue({ replaceShipPackages } as unknown as PlatformAdapter),
        } as unknown as PlatformAdapterFactory,
        {} as Alibaba1688PurchaseService,
        { resolve: vi.fn() } as unknown as AlertService,
      );

      const running = service.repair(USER, '5', '7', 12, 4, '已核对 1688 和抖店包裹');
      await vi.advanceTimersByTimeAsync(0);
      expect(replaceShipPackages).toHaveBeenCalledOnce();
      const callsBeforeHeartbeat = updateMany.mock.calls.length;

      await vi.advanceTimersByTimeAsync(ORDER_LOGISTICS_REPAIR_HEARTBEAT_MS);
      expect(updateMany.mock.calls.length).toBeGreaterThan(callsBeforeHeartbeat);

      rejectPlatform(new Error('platform stopped'));
      await expect(running).rejects.toThrow('platform stopped');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries alert resolution without touching the platform for an already completed repair', async () => {
    const getOne = vi.fn().mockResolvedValue(orderView());
    const resolve = vi.fn().mockResolvedValue(undefined);
    const platformFactory = { create: vi.fn() };
    const prisma = {
      orderLogisticsRepair: { findFirst: vi.fn().mockResolvedValue(repair('completed')) },
    } as unknown as PrismaService;
    const service = new OrderLogisticsRepairService(
      prisma,
      { getOne } as unknown as OrderService,
      {} as ShopTokenService,
      platformFactory as unknown as PlatformAdapterFactory,
      {} as Alibaba1688PurchaseService,
      { resolve } as unknown as AlertService,
    );

    await expect(
      service.repair(USER, '5', '7', 12, 4, '已核对 1688 和抖店包裹'),
    ).resolves.toMatchObject({ orderId: '5' });

    expect(platformFactory.create).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(getOne).toHaveBeenCalledWith(USER, '5');
  });

  it('reuses the single repair created by a concurrent request for the same exception revision', async () => {
    const winner = repair('completed');
    const findFirst = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    const create = vi.fn().mockRejectedValue(new Error('unique constraint'));
    const prepareSettledLogisticsRepair = vi.fn().mockResolvedValue({
      purchaseOrderId: 7n,
      purchaseSyncRevision: 3,
      priorIncurredCost: 0,
      targetPurchaseStatus: 'shipped',
      targetPurchaseCost: 12,
      previousPlatformPackages: winner.previousPlatformPackages,
      targetPlatformPackages: winner.targetPlatformPackages,
      targetPurchaseShipments: winner.targetPurchaseShipments,
      targetFingerprint: winner.targetFingerprint,
    });
    const getOne = vi.fn().mockResolvedValue(orderView());
    const prisma = {
      orderLogisticsRepair: { findFirst, create },
    } as unknown as PrismaService;
    const service = new OrderLogisticsRepairService(
      prisma,
      { getOne } as unknown as OrderService,
      {} as ShopTokenService,
      { create: vi.fn() } as unknown as PlatformAdapterFactory,
      { prepareSettledLogisticsRepair } as unknown as Alibaba1688PurchaseService,
      { resolve: vi.fn().mockResolvedValue(undefined) } as unknown as AlertService,
    );

    await expect(
      service.repair(USER, '5', '7', 12, 4, '已核对 1688 和抖店包裹'),
    ).resolves.toMatchObject({ orderId: '5' });

    expect(create).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenNthCalledWith(2, {
      where: { orderId: 5n, purchaseOrderId: 7n, exceptionRevision: 4 },
      orderBy: { id: 'desc' },
    });
    expect(getOne).toHaveBeenCalledTimes(1);
  });
});
