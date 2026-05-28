import type { PlatformType, TokenSet } from '@supplier/shared-types';

export interface PublishProductDto {
  title: string;
  detailHtml: string;
  mainImages: string[];
  categoryId: string;
  attributes: Record<string, string>;
  skus: Array<{
    specName: string;
    price: number;
    stock: number;
    attributes: Record<string, string>;
    image?: string;
  }>;
  salePrice: number;
  costPrice?: number;
}

export interface PublishResult {
  platformProductId: string;
  url?: string;
}

export interface UpdateProductDto extends Partial<PublishProductDto> {
  platformProductId: string;
}

export interface CategoryNode {
  id: string;
  name: string;
  parentId?: string;
  isLeaf: boolean;
  level: number;
}

export interface CategoryAttr {
  id: string;
  name: string;
  required: boolean;
  multiValue: boolean;
  values?: Array<{ id: string; name: string }>;
}

export interface OrderQuery {
  startTime?: Date;
  endTime?: Date;
  status?: string;
  pageSize?: number;
  cursor?: string;
}

export interface PlatformOrder {
  platformOrderId: string;
  buyerNick: string;
  receiverName: string;
  receiverPhone: string;
  receiverAddress: string;
  amount: number;
  status: string;
  paidAt: Date;
  skuList: Array<{
    skuId: string;
    title: string;
    quantity: number;
    unitPrice: number;
  }>;
}

export interface ShipDto {
  platformOrderId: string;
  trackingNo: string;
  carrier: string;
}

export interface AdapterConfig {
  appKey: string;
  appSecret: string;
  redirectUri: string;
  sandbox?: boolean;
}

export type { PlatformType, TokenSet };
