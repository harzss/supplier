import type { Prisma } from '@supplier/db';

type PurchaseExceptionClient = Pick<Prisma.TransactionClient, 'purchaseOrder'>;
export type PurchaseExceptionEvent = 'refunded' | 'closed' | 'partial_refund';

export async function markPurchaseExceptionsForOrderEvent(
  db: PurchaseExceptionClient,
  orderId: bigint,
  event: PurchaseExceptionEvent,
  detectedAt = new Date(),
): Promise<{ stopped: number; actionRequired: number }> {
  if (event === 'partial_refund') {
    const stopped = await db.purchaseOrder.updateMany({
      where: {
        orderId,
        exceptionStatus: { in: ['none', 'resolved', 'stopped'] },
        orderId1688: null,
        status: { in: ['pending', 'failed'] },
      },
      data: {
        exceptionStatus: 'stopped',
        exceptionRevision: { increment: 1 },
        exceptionReason:
          '销售订单存在部分退款，采购尚未提交到 1688，系统已停止；可在核对剩余子单后选择仅履约未退款商品。',
        exceptionDetectedAt: detectedAt,
        exceptionResolvedAt: null,
        exceptionResolutionNote: null,
        reconciledCost: null,
      },
    });
    const actionRequired = await db.purchaseOrder.updateMany({
      where: {
        orderId,
        exceptionStatus: { in: ['none', 'resolved', 'action_required'] },
        OR: [{ orderId1688: { not: null } }, { status: { notIn: ['pending', 'failed'] } }],
      },
      data: {
        exceptionStatus: 'action_required',
        exceptionRevision: { increment: 1 },
        exceptionReason:
          '销售订单存在部分退款成功的商品，系统已暂停整单采购和物流回传；请核对未退款商品、调整或取消 1688 采购后回到系统确认。',
        exceptionDetectedAt: detectedAt,
        exceptionResolvedAt: null,
        exceptionResolutionNote: null,
        reconciledCost: null,
      },
    });
    return { stopped: stopped.count, actionRequired: actionRequired.count };
  }
  const label = event === 'refunded' ? '退款' : '关闭';
  const stopped = await db.purchaseOrder.updateMany({
    where: {
      orderId,
      exceptionStatus: { in: ['none', 'resolved', 'stopped'] },
      orderId1688: null,
      status: { in: ['pending', 'failed'] },
    },
    data: {
      exceptionStatus: 'stopped',
      exceptionRevision: { increment: 1 },
      exceptionReason: `销售订单已${label}，采购尚未提交到 1688，系统已自动停止。`,
      exceptionDetectedAt: detectedAt,
      exceptionResolvedAt: null,
      exceptionResolutionNote: null,
      reconciledCost: null,
    },
  });
  const actionRequired = await db.purchaseOrder.updateMany({
    where: {
      orderId,
      exceptionStatus: { in: ['none', 'resolved', 'action_required'] },
      OR: [{ orderId1688: { not: null } }, { status: { notIn: ['pending', 'failed'] } }],
    },
    data: {
      exceptionStatus: 'action_required',
      exceptionRevision: { increment: 1 },
      exceptionReason: `销售订单已${label}，但 1688 采购单已创建或已推进；请停止付款或发货，并在 1688 完成取消、退款或物流拦截后回到系统确认。`,
      exceptionDetectedAt: detectedAt,
      exceptionResolvedAt: null,
      exceptionResolutionNote: null,
      reconciledCost: null,
    },
  });
  return { stopped: stopped.count, actionRequired: actionRequired.count };
}

export function isTerminalOrderStatus(status: string): status is 'refunded' | 'closed' {
  return status === 'refunded' || status === 'closed';
}
