export const PURCHASE_EXCEPTION_CODE = {
  salesOrderPartialRefund: 'sales_order_partial_refund',
  salesOrderRefunded: 'sales_order_refunded',
  salesOrderClosed: 'sales_order_closed',
  remoteCancelledRetryable: 'purchase_remote_cancelled_retryable',
  remoteCancelledManual: 'purchase_remote_cancelled_manual',
  remoteCancelledAfterShipment: 'purchase_remote_cancelled_after_shipment',
  manualReview: 'purchase_manual_review',
  snapshotMismatch: 'purchase_snapshot_mismatch',
  costChanged: 'purchase_cost_changed',
  logisticsSnapshotMissing: 'logistics_snapshot_missing',
  logisticsMappingMismatch: 'logistics_mapping_mismatch',
  logisticsRoutingChanged: 'logistics_routing_changed',
  logisticsManualReview: 'logistics_manual_review',
  afterSaleHold: 'sales_order_after_sale_hold',
} as const;

export type PurchaseExceptionCode =
  (typeof PURCHASE_EXCEPTION_CODE)[keyof typeof PURCHASE_EXCEPTION_CODE];

const LOGISTICS_CODES = new Set<string>([
  PURCHASE_EXCEPTION_CODE.remoteCancelledAfterShipment,
  PURCHASE_EXCEPTION_CODE.logisticsSnapshotMissing,
  PURCHASE_EXCEPTION_CODE.logisticsMappingMismatch,
  PURCHASE_EXCEPTION_CODE.logisticsRoutingChanged,
  PURCHASE_EXCEPTION_CODE.logisticsManualReview,
]);

const AFTER_SALE_CODES = new Set<string>([
  PURCHASE_EXCEPTION_CODE.salesOrderPartialRefund,
  PURCHASE_EXCEPTION_CODE.salesOrderRefunded,
  PURCHASE_EXCEPTION_CODE.salesOrderClosed,
  PURCHASE_EXCEPTION_CODE.afterSaleHold,
]);

export function purchaseExceptionDomain(
  code: string | null | undefined,
): 'purchase' | 'logistics' | 'after_sale' {
  if (code && LOGISTICS_CODES.has(code)) return 'logistics';
  if (code && AFTER_SALE_CODES.has(code)) return 'after_sale';
  return 'purchase';
}

export function purchaseExceptionCodeForOrderEvent(
  event: 'refunded' | 'closed' | 'partial_refund',
): PurchaseExceptionCode {
  if (event === 'refunded') return PURCHASE_EXCEPTION_CODE.salesOrderRefunded;
  if (event === 'closed') return PURCHASE_EXCEPTION_CODE.salesOrderClosed;
  return PURCHASE_EXCEPTION_CODE.salesOrderPartialRefund;
}
