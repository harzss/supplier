import { describe, expect, it } from 'vitest';
import {
  PURCHASE_EXCEPTION_CODE,
  purchaseExceptionCodeForOrderEvent,
  purchaseExceptionDomain,
} from './purchase-exception-code';

describe('purchase exception codes', () => {
  it('maps order events to stable after-sale codes', () => {
    expect(purchaseExceptionCodeForOrderEvent('partial_refund')).toBe(
      PURCHASE_EXCEPTION_CODE.salesOrderPartialRefund,
    );
    expect(purchaseExceptionCodeForOrderEvent('refunded')).toBe(
      PURCHASE_EXCEPTION_CODE.salesOrderRefunded,
    );
    expect(purchaseExceptionCodeForOrderEvent('closed')).toBe(
      PURCHASE_EXCEPTION_CODE.salesOrderClosed,
    );
  });

  it('classifies purchase and logistics cases without reading free-text reasons', () => {
    expect(purchaseExceptionDomain(PURCHASE_EXCEPTION_CODE.snapshotMismatch)).toBe('purchase');
    expect(purchaseExceptionDomain(PURCHASE_EXCEPTION_CODE.logisticsRoutingChanged)).toBe(
      'logistics',
    );
    expect(purchaseExceptionDomain(PURCHASE_EXCEPTION_CODE.logisticsManualReview)).toBe(
      'logistics',
    );
    expect(purchaseExceptionDomain(PURCHASE_EXCEPTION_CODE.salesOrderRefunded)).toBe('after_sale');
    expect(purchaseExceptionDomain(PURCHASE_EXCEPTION_CODE.afterSaleHold)).toBe('after_sale');
    expect(purchaseExceptionDomain(null)).toBe('purchase');
  });
});
