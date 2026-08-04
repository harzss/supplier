import type { PlatformType, TokenSet } from '@supplier/shared-types';

export interface PublishProductDto {
  /** 平台侧幂等恢复标识；同一次业务发布的所有重试必须复用。 */
  externalProductId?: string;
  title: string;
  detailHtml: string;
  mainImages: string[];
  categoryId: string;
  attributes: Record<string, string>;
  skus: Array<{
    sourceSkuId?: string;
    specName: string;
    price: number;
    stock: number;
    attributes: Record<string, string>;
    image?: string;
  }>;
  salePrice: number;
  costPrice?: number;
  categoryProperties?: CategoryPropertyMap;
  qualifications?: ProductQualification[];
}

export interface PublishResult {
  platformProductId: string;
  url?: string;
}

export interface UpdateProductDto extends PublishProductDto {
  platformProductId: string;
}

export interface UpdateProductTitleDto {
  platformProductId: string;
  title: string;
}

export type PlatformProductStateName =
  | 'online'
  | 'offline'
  | 'deleted'
  | 'draft'
  | 'reviewing'
  | 'rejected'
  | 'blocked'
  | 'approved_pending_online'
  | 'unknown';

export interface PlatformProductState {
  state: PlatformProductStateName;
  status: number | null;
  checkStatus: number | null;
}

export interface PlatformProductTitleState extends PlatformProductState {
  title: string;
}

export interface UpdateProductPriceDto {
  platformProductId: string;
  /** 发布商品时写入平台的外部 SKU 编码，对应平台 outer_sku_id。 */
  sourceSkuId: string;
  /** 绝对售价，单位为分。 */
  priceCents: number;
}

export interface PlatformProductPriceState extends PlatformProductState {
  items: Array<{
    sourceSkuId: string;
    priceCents: number;
  }>;
}

export interface PlatformProductInventoryState extends PlatformProductState {
  items: Array<{
    sourceSkuId: string;
    stock: number;
  }>;
}

/** The request may have reached the platform, but its final mutation result is unknown. */
export class PlatformMutationResultUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformMutationResultUnknownError';
  }
}

export interface SyncInventoryItemDto {
  /** 发布商品时写入平台的外部 SKU 编码，对应 1688 specId。 */
  sourceSkuId: string;
  stock: number;
}

export interface SyncInventoryDto {
  platformProductId: string;
  /** 同一库存快照重试时必须复用，避免重复应用库存变更。 */
  idempotencyKey: string;
  items: SyncInventoryItemDto[];
}

export interface CategoryNode {
  id: string;
  name: string;
  parentId?: string;
  isLeaf: boolean;
  level: number;
  enabled?: boolean;
  channel?: number;
}

export interface CategoryRecommendationInput {
  title: string;
}

export interface CategoryRecommendation {
  categoryId: string;
  categoryName: string;
  categoryPath: string;
  qualificationStatus: 0 | 1 | 2 | null;
}

export interface CategoryRecommendationResult {
  recommendations: CategoryRecommendation[];
  recommendId?: string;
}

export interface CategoryAttr {
  id: string;
  name: string;
  required: boolean;
  multiValue: boolean;
  inputType: 'text' | 'select' | 'multi_select' | 'timestamp' | 'timerange' | 'unsupported';
  supportsCustom: boolean;
  maxSelections?: number;
  unsupportedReason?: string;
  values?: Array<{ id: string; name: string }>;
}

export interface CategoryPropertyValue {
  value: number;
  name: string;
  diyType: 0 | 1;
}

export type CategoryPropertyMap = Record<string, CategoryPropertyValue[]>;

export type CategoryQualificationOperand = 'equal' | 'not_equal';

export interface CategoryQualificationRuleClause {
  propertyId: string;
  propertyValues: string[];
  operand: CategoryQualificationOperand;
}

export interface CategoryQualificationRule {
  clauses: CategoryQualificationRuleClause[];
  required: boolean;
}

export interface CategoryQualification {
  key: string;
  name: string;
  hints: string[];
  required: boolean;
  rules: CategoryQualificationRule[];
  unsupportedReason?: string;
}

export interface ProductQualification {
  qualityKey: string;
  qualityName: string;
  qualityContentName?: string;
  qualityId: number;
  attachments: Array<{
    mediaType: 1;
    url: string;
  }>;
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
  receiverAddressDetail?: PlatformReceiverAddress;
  amount: number;
  status: string;
  paidAt: Date;
  skuList: Array<{
    platformOrderItemId: string;
    platformProductId?: string;
    skuId: string;
    sourceSkuId?: string;
    title: string;
    quantity: number;
    unitPrice: number;
    specs?: Record<string, string>;
    afterSaleStatus?: number;
    afterSaleType?: number;
    refundStatus?: number;
  }>;
  shipmentPackages: PlatformShipmentPackage[];
}

export interface PlatformReceiverAddress {
  province: string;
  city: string;
  area: string;
  town?: string;
  detail: string;
  postalCode?: string;
}

export interface ShipDto {
  platformOrderId: string;
  trackingNo: string;
  carrier: string;
}

export interface ShipPackageItemDto {
  platformOrderItemId: string;
  quantity: number;
}

export interface ShipPackageDto {
  trackingNo: string;
  carrier: string;
  items: ShipPackageItemDto[];
}

export interface PlatformShipmentPackageItem {
  platformOrderItemId: string;
  quantity: number;
}

export interface PlatformShipmentPackage {
  deliveryId: string;
  trackingNo: string;
  companyCode: string;
  carrier: string;
  items: PlatformShipmentPackageItem[];
}

export interface ShipPackagesDto {
  platformOrderId: string;
  requestId: string;
  packages: ShipPackageDto[];
}

export interface ReplaceShipPackagesDto {
  platformOrderId: string;
  /** 系统上次成功回传的平台物流快照，用于检测远端是否被人工改动。 */
  previousPackages: ShipPackageDto[];
  targetPackages: ShipPackageDto[];
}

export interface PlatformExecutionGuard {
  assertOwned(): Promise<void>;
}

export interface AdapterConfig {
  appKey: string;
  appSecret: string;
  redirectUri: string;
  serviceId?: string;
  customerMobile?: string;
  sandbox?: boolean;
}

export type { PlatformType, TokenSet };
