import type { Prisma } from '@supplier/db';

export const PURCHASE_COST_RECONCILIATION_WHERE = {
  OR: [
    { exceptionStatus: 'action_required' },
    { exceptionStatus: 'resolved', reconciledCost: null },
  ],
} satisfies Prisma.PurchaseOrderWhereInput;

export const REFUND_AMOUNT_RECONCILIATION_WHERE = {
  status: { in: ['paid', 'purchasing', 'shipped', 'received'] },
  refundAmount: null,
  OR: [{ afterSaleStatus: 'partial_refund' }, { items: { some: { refundStatusRaw: 3 } } }],
} satisfies Prisma.OrderWhereInput;

export const FINANCIAL_RECONCILIATION_ORDER_WHERE = {
  OR: [
    REFUND_AMOUNT_RECONCILIATION_WHERE,
    { purchaseOrders: { some: PURCHASE_COST_RECONCILIATION_WHERE } },
  ],
} satisfies Prisma.OrderWhereInput;
