import type { PlatformType } from './platform';

export type OrderStatus = 'paid' | 'purchasing' | 'shipped' | 'received' | 'refunded' | 'closed';
export type OrderAfterSaleStatus = 'none' | 'pending' | 'partial_refund' | 'refunded' | 'failed';

export interface Order {
  id: string;
  shopId: string;
  publishedProductId?: string;
  platform: PlatformType;
  platformOrderId: string;
  buyerNick: string;
  receiverName: string;
  amount: number;
  status: OrderStatus;
  afterSaleStatus: OrderAfterSaleStatus;
  paidAt: Date;
  skuInfo: OrderSkuInfo[];
}

export interface OrderSkuInfo {
  skuId: string;
  specName: string;
  quantity: number;
  unitPrice: number;
}

export interface PurchaseOrder {
  id: string;
  orderId: string;
  supplierKey: string;
  outOrderId: string;
  orderId1688?: string;
  paymentMode: 'manual';
  status: 'pending' | 'placed' | 'awaiting_payment' | 'paid' | 'shipped' | 'received' | 'failed';
  trackingNo?: string;
  carrier?: string;
  failureReason?: string;
  retryCount: number;
  exceptionStatus: 'none' | 'stopped' | 'action_required' | 'resolved';
  exceptionCode?: string;
  exceptionReason?: string;
  exceptionDetectedAt?: Date;
  exceptionResolvedAt?: Date;
  exceptionResolutionNote?: string;
}
