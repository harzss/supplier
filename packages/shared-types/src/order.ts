import type { PlatformType } from './platform';

export type OrderStatus =
  | 'paid'
  | 'purchasing'
  | 'shipped'
  | 'received'
  | 'refunded'
  | 'closed';

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
  orderId1688?: string;
  status: 'pending' | 'placed' | 'shipped' | 'received' | 'failed';
  trackingNo?: string;
  carrier?: string;
  failureReason?: string;
  retryCount: number;
}
