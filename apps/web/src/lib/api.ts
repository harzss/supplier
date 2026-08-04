/** BFF API 客户端 + 共享类型（与 apps/bff product.service.ts 对齐） */

import type { AnalyticsOverview, AnalyticsRangeDays } from '@supplier/shared-types';
import { getBffUrl } from './environment';
import { getAccessToken, isDemoAuthMode } from './supabase';

export interface ProductScore {
  overall: number;
  demand: number;
  competition: number;
  profit: number;
  compliance: number;
  trend: number;
  reason: string[];
}

export interface Product {
  id: string;
  productId1688: string;
  title: string;
  price: string;
  priceRange: [string, string] | null;
  mainImage: string | null;
  categoryPath: string | null;
  categoryL1: string | null;
  categoryL2: string | null;
  monthlySold: number;
  isOnePieceDrop: boolean;
  availability: 'available' | 'out_of_stock' | 'offline' | 'unknown';
  totalStock: number;
  availabilityChangedAt: string;
  score: ProductScore | null;
  syncedAt: string;
}

export interface FavoriteProduct extends Product {
  favoritedAt: string;
}

export interface FavoriteList {
  total: number;
  items: FavoriteProduct[];
}

export interface RecommendationList {
  total: number;
  items: Product[];
  degraded?: boolean;
}

export interface ProductFacets {
  categories: Array<{ name: string; count: number }>;
  priceRange: { min: number; max: number } | null;
  degraded?: boolean;
}

export interface RecommendationQuery {
  categoryL1?: string;
  priceMin?: number;
  priceMax?: number;
  limit?: number;
}

export type BillingStatus = 'internal_beta' | 'unavailable';

export interface PlanSummary {
  id: string;
  name: string;
  billingStatus: BillingStatus;
  billingLabel: string;
  highlight: string;
  features: string[];
}

export interface EntitlementView {
  plan: string | null;
  planName: string;
  features: string[];
  aiUsage: { used: number; limit: number; remaining: number; exceeded: boolean };
  quotas: { shopsMax: number; publishMonthly: number };
  plans: PlanSummary[];
}

export interface LlmKeyView {
  configured: boolean;
  usable?: boolean;
  provider?: string;
  masked?: string;
  status?: string;
  lastUsedAt?: string | null;
}

export interface TitleBilling {
  viaByok: boolean;
  quota: { limit: number; used: number; remaining: number } | null;
}

export interface TitleResult {
  titles: string[];
  rejected: { title: string; reason: string }[];
  model: string;
  cached: boolean;
  costCny: number;
  billing: TitleBilling;
}

export interface Shop {
  id: string;
  platform: string;
  platformLabel: string;
  platformShopId: string;
  shopName: string | null;
  role: 'seller' | 'buyer';
  connectionType: 'demo' | 'oauth';
  status: string;
  tokenExpiresAt: string | null;
  lastOrderSyncAt: string | null;
  orderSyncAttemptAt: string | null;
  orderSyncError: string | null;
  createdAt: string;
}

export interface OrderSyncResult {
  shopId: string;
  synced: number;
  skipped: number;
}

export interface OrderRefreshResult {
  orderId: string;
  status: string;
  afterSaleStatus: string;
}

export interface OAuthAuthorizationResult {
  platform: 'douyin' | 'alibaba_1688';
  authorizationUrl: string;
  expiresInSeconds: number;
}

export interface OAuthResult {
  platform: 'douyin' | 'alibaba_1688';
  result: 'success' | 'error';
  shopId?: string;
  shopName?: string;
  message?: string;
}

export interface DouyinReadiness {
  ready: boolean;
  readyCount: number;
  totalCount: number;
  checks: Array<{
    id: string;
    label: string;
    ready: boolean;
    detail: string;
  }>;
}

export interface Alibaba1688Readiness {
  ready: boolean;
  readyCount: number;
  totalCount: number;
  checks: Array<{
    id: string;
    label: string;
    ready: boolean;
    detail: string;
  }>;
}

export interface MediaReadiness {
  ready: boolean;
  readyCount: number;
  totalCount: number;
  checks: Array<{
    id: 'storage' | 'image_pipeline';
    label: string;
    ready: boolean;
    detail: string;
  }>;
}

export interface CategoryMapping {
  sourceProductId: string;
  sourceTitle: string;
  sourceCategoryPath: string | null;
  platform: 'douyin';
  confirmed: boolean;
  categoryId: string | null;
  categoryName: string | null;
  confirmedAt: string | null;
}

export interface CategoryCatalogStatus {
  shopId: string;
  shopName: string | null;
  connectionType: 'demo' | 'oauth';
  synced: boolean;
  nodeCount: number;
  leafCount: number;
  syncedAt: string | null;
}

export interface CategorySuggestions {
  shopId: string;
  sourceProductId: string;
  sourceTitle: string;
  catalogSyncedAt: string;
  recommendId: string | null;
  candidates: Array<{
    rank: number;
    categoryId: string;
    categoryName: string;
    categoryPath: string;
    qualificationStatus: 0 | 1 | 2 | null;
    confidence: null;
  }>;
}

export interface CategoryAttribute {
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

export interface CategoryProperties {
  sourceProductId: string;
  sourceTitle: string;
  shopId: string;
  shopName: string | null;
  categoryId: string;
  categoryName: string | null;
  schemaFingerprint: string;
  attributes: CategoryAttribute[];
  values: Record<string, CategoryPropertyValue[]>;
  confirmed: boolean;
  stale: boolean;
  blockers: string[];
  confirmedAt: string | null;
}

export interface CategoryQualifications {
  sourceProductId: string;
  sourceTitle: string;
  shopId: string;
  shopName: string | null;
  categoryId: string;
  categoryName: string | null;
  schemaFingerprint: string;
  requirementFingerprint: string;
  qualifications: Array<{
    key: string;
    name: string;
    hints: string[];
    required: boolean;
    requiredReason: 'category' | 'property' | null;
    unsupportedReason?: string;
  }>;
  values: Record<
    string,
    {
      qualityContentName: string | null;
      attachmentUrls: string[];
    }
  >;
  confirmed: boolean;
  stale: boolean;
  blockers: string[];
  confirmedAt: string | null;
  syncedAt: string;
  warning: string;
}

export interface SkuMappingRow {
  sourceSkuId: string;
  sourceSpecName: string;
  costPrice: number;
  stock: number;
  image: string | null;
  values: string[];
  enabled: boolean;
}

export interface SkuMapping {
  sourceProductId: string;
  sourceTitle: string;
  platform: 'douyin';
  confirmed: boolean;
  stale: boolean;
  requiresConfirmation: boolean;
  dimensions: string[];
  skus: SkuMappingRow[];
  warnings: string[];
  confirmedAt: string | null;
}

export interface PublishShopResult {
  shopId: string;
  shopName: string | null;
  platform: string;
  platformProductId?: string;
  url?: string;
  salePrice?: number;
  error?: string;
}

export interface PublishTaskResult {
  taskId: string;
  status: string;
  optimizedTitle: string;
  detailOptimized: boolean;
  detailImageHosted: boolean;
  mainImageRequested: boolean;
  mainImageProcessed: boolean;
  mainImageMessage: string | null;
  pricing: PricingQuote;
  skuCount: number;
  skuDimensions: string[];
  salePrice: number;
  results: PublishShopResult[];
}

export interface PublishTaskAccepted {
  taskId: string;
  status: string;
  queued: true;
}

export interface PublishTaskReplay {
  taskId: string;
  status: string;
  queued: boolean;
  reused: true;
}

export interface PublishAiOptions {
  titleOverride?: string;
  rewriteTitle?: boolean;
  rewriteDetail?: boolean;
  removeWatermark?: boolean;
  relightImages?: boolean;
  backgroundStyle?: 'white_studio' | 'warm_lifestyle' | 'cool_minimal';
}

export interface PublishPreflightRequest {
  pricingPreviewToken?: string;
  sourceProductId: string;
  targetShopIds: string[];
  pricingStrategy?: PricingStrategy;
  aiOptions?: PublishAiOptions;
}

export interface PublishRequest extends PublishPreflightRequest {
  clientRequestId?: string;
  draftRevision?: number;
}

export interface PublishDraftView {
  clientRequestId: string;
  sourceProductId: string;
  targetShopIds: string[];
  pricingStrategy: PricingStrategy | null;
  aiOptions: PublishAiOptions | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface SavePublishDraftRequest {
  expectedRevision: number;
  expectedClientRequestId?: string;
  sourceProductId: string;
  targetShopIds: string[];
  pricingStrategy?: PricingStrategy;
  aiOptions?: PublishAiOptions;
}

export interface PublishPreflightCheck {
  id: string;
  severity: 'blocker' | 'warning';
  scope?: string;
  shopId?: string;
  message: string;
  actionHref?: string;
}

export interface PublishPreflightResult {
  ready: boolean;
  checks: PublishPreflightCheck[];
  sourcePricingFingerprint: string | null;
  pricingPreviewConfirmed: boolean;
  pricing: PricingQuote | null;
}

export type ActivationStepKey =
  | 'connect_shop'
  | 'select_product'
  | 'preview_pricing'
  | 'publish_product';

export interface ActivationStep {
  key: ActivationStepKey;
  title: string;
  description: string;
  href: string;
  completedAt: string | null;
  readyNow: boolean;
}

export interface ActivationProgress {
  currentStep: ActivationStepKey | null;
  nextHref: string;
  completedSteps: number;
  totalSteps: number;
  steps: ActivationStep[];
}

export interface PublishedItem {
  publishedProductId: string;
  shopName: string | null;
  platform: string;
  platformProductId: string | null;
  title: string;
  salePrice: number;
  status: string;
  inventorySyncStatus: string;
  inventorySyncReason: string | null;
  inventorySyncError: string | null;
  inventoryLastSyncedAt: string | null;
  editAttempts: number;
  lastEditAttemptAt: string | null;
  lastEditedAt: string | null;
  lastEditError: string | null;
  platformStatusSyncedAt: string | null;
  platformStatusError: string | null;
  publishedAt: string;
}

export interface PublishedProductUpdateResult {
  publishedProductId: string;
  title: string;
  status: string;
  lastEditedAt: string;
}

export interface PublishedProductStatusResult {
  publishedProductId: string;
  status: string;
  platformStatus: number | null;
  platformCheckStatus: number | null;
  syncedAt: string;
}

export interface ProductBatchCleanupEvidence {
  policyVersion: 1;
  windowDays: 30;
  graceDays: 7;
  observedAt: string;
  windowStartedAt: string;
  daysOnline: number;
  validOrderCount: number;
  lastPaidAt: string | null;
  orderSyncAt: string | null;
}

export interface ProductBatchCandidate {
  publishedProductId: string;
  title: string;
  mainImage: string | null;
  shopId: string;
  shopName: string | null;
  platform: string;
  platformProductId: string;
  status: string;
  salePrice: number;
  priceRange: [number, number] | null;
  skuCount: number;
  titleEditable: boolean;
  titleEditReason: string | null;
  titleVerificationTaskId: string | null;
  titleVerificationItemId: string | null;
  onlineEligible: boolean;
  onlineReason: string | null;
  onlineVerificationTaskId: string | null;
  onlineVerificationItemId: string | null;
  offlineVerificationTaskId: string | null;
  offlineVerificationItemId: string | null;
  priceEditable: boolean;
  priceEditReason: string | null;
  sourceProductId: string;
  sourceAvailability: string;
  sourceTotalStock: number;
  sourceSkuCount: number;
  sourceInventoryVersion: number;
  inventorySyncStatus: string;
  syncedInventoryVersion: number;
  inventoryLastSyncedAt: string | null;
  inventorySyncError: string | null;
  inventorySyncEligible: boolean;
  inventorySyncReason: string | null;
  cleanupEligible: boolean;
  cleanupReason: string | null;
  cleanupEvidence: ProductBatchCleanupEvidence | null;
  sourceChangeEligible: boolean;
  sourceChangeReason: string | null;
  currentSourceRouteCount: number;
  mutationRevision: number;
  publishedAt: string;
}

export type ProductBatchAction =
  | 'online'
  | 'offline'
  | 'edit_title'
  | 'edit_price'
  | 'sync_inventory'
  | 'change_source'
  | 'cleanup';

export type ProductBatchPriceRule =
  | {
      mode: 'percentage';
      direction: 'increase' | 'decrease';
      basisPoints: number;
    }
  | {
      mode: 'targets';
      targets: Array<{ publishedProductId: string; targetStartPrice: string }>;
    };

export type ProductBatchPreviewRequest =
  | {
      clientRequestId: string;
      action: 'online';
      publishedProductIds: string[];
    }
  | {
      clientRequestId: string;
      action: 'offline';
      publishedProductIds: string[];
    }
  | {
      clientRequestId: string;
      action: 'edit_title';
      publishedProductIds: string[];
      titleTargets: Array<{
        publishedProductId: string;
        expectedMutationRevision: number;
        targetTitle: string;
      }>;
    }
  | {
      clientRequestId: string;
      action: 'edit_price';
      publishedProductIds: string[];
      priceRule: ProductBatchPriceRule;
    }
  | {
      clientRequestId: string;
      action: 'sync_inventory';
      publishedProductIds: string[];
    }
  | {
      clientRequestId: string;
      action: 'change_source';
      publishedProductIds: string[];
      sourceTargets: Array<{
        publishedProductId: string;
        expectedMutationRevision: number;
        targetSourceProductId: string;
      }>;
    }
  | {
      clientRequestId: string;
      action: 'cleanup';
      publishedProductIds: string[];
    };

export interface ProductBatchCandidatePage {
  items: ProductBatchCandidate[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ProductBatchSummary {
  total: number;
  pending: number;
  running: number;
  retryWait: number;
  succeeded: number;
  failed: number;
  skipped: number;
  cancelled: number;
  completed: number;
  progressPercent: number;
}

export interface ProductBatchInventorySnapshot {
  version: 1;
  items: Array<{ sourceSkuId: string; stock: number }>;
}

export interface ProductBatchItem {
  itemId: string;
  publishedProductId: string;
  title: string;
  mainImage: string | null;
  shopId: string;
  shopName: string | null;
  platform: string;
  platformProductId: string | null;
  beforeTitle: string;
  desiredTitle: string | null;
  actualTitle: string | null;
  beforeStatus: string;
  desiredStatus: string;
  actualStatus: string | null;
  beforePrice: number | null;
  desiredPrice: number | null;
  beforePriceRange: [number, number] | null;
  desiredPriceRange: [number, number] | null;
  actualPriceRange: [number, number] | null;
  skuCount: number;
  beforeInventory: ProductBatchInventorySnapshot | null;
  desiredInventory: ProductBatchInventorySnapshot | null;
  actualInventory: ProductBatchInventorySnapshot | null;
  beforeInventoryVersion: number | null;
  desiredInventoryVersion: number | null;
  cleanupEvidence: ProductBatchCleanupEvidence | null;
  beforeSourceProductId: string | null;
  desiredSourceProductId: string | null;
  actualSourceProductId: string | null;
  beforeSourceTitle: string | null;
  desiredSourceTitle: string | null;
  sourceRouteCount: number | null;
  sourceCostRange: [number, number] | null;
  retryable: boolean;
  status: string;
  attempts: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  result: Record<string, unknown> | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ProductBatchTask {
  taskId: string;
  clientRequestId: string;
  action: ProductBatchAction;
  status: string;
  previewRevision: number;
  cancelRequestedAt: string | null;
  confirmedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  summary: ProductBatchSummary;
  items: ProductBatchItem[];
}

export interface ProductBatchTaskPage {
  items: ProductBatchTask[];
  total: number;
  page: number;
  pageSize: number;
}

export type SourceImportAction = 'create' | 'refresh';

export interface SourceImportSummary {
  total: number;
  pending: number;
  running: number;
  retryWait: number;
  succeeded: number;
  failed: number;
  skipped: number;
  cancelled: number;
  completed: number;
  progressPercent: number;
}

export interface SourceImportItem {
  itemId: string;
  reference: string;
  offerId: string;
  existing: boolean;
  collected: boolean;
  action: SourceImportAction;
  status: string;
  retryable: boolean;
  title: string | null;
  mainImage: string | null;
  price: number | null;
  skuCount: number | null;
  totalStock: number | null;
  availability: string | null;
  sourceProductId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  result: Record<string, unknown> | null;
  attempts: number;
  maxAttempts: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SourceImportTask {
  taskId: string;
  clientRequestId: string;
  buyerShopId: string | null;
  status: string;
  previewRevision: number;
  cancelRequestedAt: string | null;
  confirmedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  summary: SourceImportSummary;
  items: SourceImportItem[];
}

export interface SourceImportTaskPage {
  items: SourceImportTask[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CollectedSourceProduct {
  collectionId: string;
  sourceProductId: string;
  productId1688: string;
  title: string;
  price: number;
  mainImage: string | null;
  categoryL1: string | null;
  availability: string;
  totalStock: number;
  skuCount: number;
  syncedAt: string;
  firstCollectedAt: string;
  lastCollectedAt: string;
}

export interface CollectedSourceProductList {
  items: CollectedSourceProduct[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PublishTaskSummary {
  taskId: string;
  status: string;
  sourceTitle: string;
  sourceProductId: string;
  sourceAvailability: string;
  sourceTotalStock: number;
  mainImage: string | null;
  detailOptimized: boolean;
  detailImageHosted: boolean;
  mainImageRequested: boolean;
  mainImageProcessed: boolean;
  pricing: PricingQuote | null;
  skuCount: number;
  skuDimensions: string[];
  queueStatus: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  finishedAt: string | null;
  items: PublishedItem[];
}

export interface PublishTaskPage {
  items: PublishTaskSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PricingStrategy {
  mode: 'fixed_markup' | 'competitor_anchor' | 'profit_target';
  markupRatio?: number;
  targetMargin?: number;
  competitorPriceRange?: [number, number];
  estimatedShipping?: number;
  platformFeeRate?: number;
}

export interface PricingQuote {
  mode: PricingStrategy['mode'];
  costPrice: number;
  estimatedShipping: number;
  platformFeeRate: number;
  breakEvenPrice: number;
  suggestedPrice: number;
  estimatedProfit: number;
  estimatedMargin: number;
  competitorPriceRange: [number, number] | null;
  warning: string | null;
}

export interface PricingPreviewResult extends PricingQuote {
  pricingPreviewToken: string;
  pricingPreviewExpiresAt: string;
  sourcePricingFingerprint: string;
}

export interface OrderPurchase {
  purchaseOrderId: string;
  outOrderId: string;
  orderId1688: string | null;
  paymentMode: string;
  purchaseCost: number | null;
  priorIncurredCost: number;
  reconciledCost: number | null;
  costReconciled: boolean;
  costNeedsReconciliation: boolean;
  status: string;
  attemptNo: number;
  retryEligible: boolean;
  recoveryEligible: boolean;
  logisticsRepairEligible: boolean;
  trackingNo: string | null;
  carrier: string | null;
  exceptionStatus: 'none' | 'stopped' | 'action_required' | 'resolved';
  exceptionCode: string | null;
  exceptionRevision: number;
  exceptionReason: string | null;
  exceptionDetectedAt: string | null;
  exceptionResolvedAt: string | null;
  exceptionResolutionNote: string | null;
  shipments: Array<{
    trackingNo: string;
    carrier: string | null;
    status: string | null;
  }>;
}

export interface Order {
  orderId: string;
  platformOrderId: string;
  shopName: string | null;
  platform: string;
  productTitle: string | null;
  buyerNick: string | null;
  receiverName: string | null;
  receiverPhoneMasked: string | null;
  amount: number;
  status: string;
  afterSaleStatus: 'none' | 'pending' | 'partial_refund' | 'refunded' | 'failed';
  afterSaleSyncedAt: string | null;
  partialRefundDisposition: 'none' | 'continue_remaining' | 'stop_all';
  partialRefundDispositionAt: string | null;
  partialRefundDispositionNote: string | null;
  partialRefundCanContinue: boolean;
  refundAmount: number | null;
  refundAmountConfirmedAt: string | null;
  refundAmountNote: string | null;
  refundAmountConfirmed: boolean;
  refundAmountNeedsConfirmation: boolean;
  paidAt: string | null;
  fulfillmentExceptionStatus: 'none' | 'stopped' | 'action_required' | 'resolved';
  fulfillmentExceptionMessage: string | null;
  purchases: OrderPurchase[];
}

export interface OrderReconciliationPage {
  items: Order[];
  total: number;
  page: number;
  pageSize: number;
}

export interface OrderListPage {
  items: Order[];
  total: number;
  page: number;
  pageSize: number;
}

export type ExceptionCaseDomain =
  | 'publish'
  | 'order'
  | 'purchase'
  | 'logistics'
  | 'after_sale'
  | 'entitlement';

export type ExceptionCasePriority = 'critical' | 'high' | 'medium';
export type ExceptionCaseStatus = 'open' | 'acknowledged' | 'resolved';
export type ExceptionResponsibleParty = 'merchant' | 'supplier' | 'platform' | 'system';

export interface ExceptionCaseSubject {
  type: string;
  id: string;
  label: string;
  href: string | null;
}

export interface ExceptionCaseListItem {
  id: string;
  domain: ExceptionCaseDomain;
  code: string;
  priority: ExceptionCasePriority;
  status: ExceptionCaseStatus;
  title: string;
  subject: ExceptionCaseSubject;
  impact: string;
  reason: string;
  nextAction: string;
  actionLabel: string | null;
  actionHref: string | null;
  responsibleParty: ExceptionResponsibleParty;
  assigneeUserId: string | null;
  sourceActive: boolean;
  occurrences: number;
  stateRevision: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  updatedAt: string;
}

export interface ExceptionCaseEvidence {
  type: string;
  label: string;
  value?: string;
}

export interface ExceptionCaseEvent {
  id: string;
  caseRevision: number;
  type: string;
  actor: {
    type: 'system' | 'user' | 'worker';
    userId?: string;
  };
  note: string | null;
  evidence: ExceptionCaseEvidence[];
  fromStatus: ExceptionCaseStatus | null;
  toStatus: ExceptionCaseStatus | null;
  fromAssigneeUserId: string | null;
  toAssigneeUserId: string | null;
  fromResponsibleParty: ExceptionResponsibleParty | null;
  toResponsibleParty: ExceptionResponsibleParty | null;
  createdAt: string;
}

export interface ExceptionCaseDetail extends ExceptionCaseListItem {
  events: ExceptionCaseEvent[];
}

export interface ExceptionCaseQuery {
  status?: ExceptionCaseStatus;
  domain?: ExceptionCaseDomain;
  priority?: ExceptionCasePriority;
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface ExceptionCasePage {
  items: ExceptionCaseListItem[];
  total: number;
  page: number;
  pageSize: number;
  counts?: Partial<Record<ExceptionCaseStatus, number>>;
  criticalOpenCount?: number;
}

export interface ExceptionCaseRefreshDomainStats {
  scanned?: number;
  created?: number;
  updated?: number;
  reopened?: number;
  resolved?: number;
}

export interface ExceptionCaseRefreshError {
  domain?: ExceptionCaseDomain;
  code?: string;
  message: string;
}

export interface RefreshExceptionCasesResult {
  domains: Partial<Record<ExceptionCaseDomain, ExceptionCaseRefreshDomainStats | number>>;
  errors: Array<ExceptionCaseRefreshError | string>;
  refreshedAt?: string;
}

export interface AcknowledgeExceptionCaseRequest {
  expectedRevision: number;
  clientRequestId: string;
  note: string;
}

export type AfterSaleCaseStatus = 'open' | 'handling' | 'waiting_external' | 'verifying' | 'closed';
export type AfterSaleCasePriority = 'critical' | 'high' | 'medium';
export type AfterSalePurchaseLinkStatus =
  | 'not_required'
  | 'action_required'
  | 'waiting_external'
  | 'confirmed'
  | 'failed';
export type AfterSalePurchaseAction =
  | 'cancel'
  | 'refund'
  | 'return_refund'
  | 'intercept'
  | 'accept_loss'
  | 'manual_review';
export type AfterSaleRemoteReferenceType =
  | 'purchase_order'
  | 'refund'
  | 'return_order'
  | 'logistics'
  | 'other';
export type AfterSalePurchaseActionResult = 'confirmed' | 'failed';

export interface AfterSaleOrderSummary {
  id: string;
  platformOrderId: string;
  shopName: string | null;
  platform?: string;
  status: string;
  afterSaleStatus: string;
  amount?: number;
}

export interface AfterSaleCaseItem {
  id: string;
  orderItemId?: string;
  platformOrderItemId: string;
  title: string;
  quantity: number;
  afterSaleStatusRaw?: number | null;
  afterSaleTypeRaw?: number | null;
  refundStatusRaw?: number | null;
}

export interface AfterSalePurchaseLink {
  id: string;
  purchaseOrderId: string;
  purchaseOrderItemId?: string | null;
  orderId1688: string | null;
  outOrderId?: string | null;
  status: AfterSalePurchaseLinkStatus;
  exceptionStatus: string;
  purchaseExceptionRevision: number;
  purchaseSyncRevision: number;
  action?: AfterSalePurchaseAction | 'none' | null;
  remoteReferenceType?: AfterSaleRemoteReferenceType | null;
  remoteReferenceId?: string | null;
  result?: AfterSalePurchaseActionResult | null;
  actionStartedAt?: string | null;
  actionConfirmedAt?: string | null;
}

export interface AfterSaleClosureBlocker {
  code: string;
  label: string;
  detail?: string | null;
  purchaseOrderId?: string | null;
}

export interface AfterSaleCaseEvidence {
  type: string;
  label: string;
  value?: string;
}

export interface AfterSaleCaseEvent {
  id: string;
  caseRevision?: number;
  stateRevision?: number;
  type: string;
  actor: {
    type: 'system' | 'user' | 'worker';
    userId?: string;
  };
  note: string | null;
  evidence: AfterSaleCaseEvidence[];
  fromStatus: AfterSaleCaseStatus | null;
  toStatus: AfterSaleCaseStatus | null;
  createdAt: string;
}

export interface AfterSaleCaseListItem {
  id: string;
  status: AfterSaleCaseStatus;
  waitingOn: string | null;
  priority: AfterSaleCasePriority;
  sourceRevision: number;
  stateRevision: number;
  sourceActive: boolean;
  assigneeUserId: string | null;
  nextAction: string;
  nextActionDueAt: string | null;
  overdue: boolean;
  order: AfterSaleOrderSummary;
  items: AfterSaleCaseItem[];
  purchaseLinks: AfterSalePurchaseLink[];
  closureBlockers: Array<AfterSaleClosureBlocker | string>;
  openedAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface AfterSaleCaseDetail extends AfterSaleCaseListItem {
  events: AfterSaleCaseEvent[];
}

export interface AfterSaleCaseQuery {
  status?: AfterSaleCaseStatus;
  overdue?: boolean;
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface AfterSaleCasePage {
  items: AfterSaleCaseListItem[];
  total: number;
  page: number;
  pageSize: number;
  counts?: Partial<{
    open: number;
    handling: number;
    waitingExternal: number;
    verifying: number;
    closed: number;
  }>;
  overdueCount?: number;
}

export interface RefreshAfterSaleCasesResult {
  scanned?: number;
  created?: number;
  updated?: number;
  reopened?: number;
  closed?: number;
  hasMore: boolean;
  nextCursor: string | null;
  errors?: Array<{ code?: string; message: string } | string>;
  refreshedAt?: string;
}

export interface AfterSaleCaseCommand {
  clientRequestId: string;
  expectedRevision: number;
  note: string;
}

export interface StartAfterSalePurchaseActionRequest extends AfterSaleCaseCommand {
  action: AfterSalePurchaseAction;
  remoteReferenceType: AfterSaleRemoteReferenceType;
  remoteReferenceId: string;
  expectedPurchaseExceptionRevision: number;
  expectedPurchaseSyncRevision: number;
}

export interface ConfirmAfterSalePurchaseActionRequest extends AfterSaleCaseCommand {
  result: AfterSalePurchaseActionResult;
  expectedPurchaseExceptionRevision: number;
  expectedPurchaseSyncRevision: number;
}

/** 结构化 API 错误，携带 HTTP 状态与业务错误码（如 QUOTA_EXCEEDED / BYOK_CALL_FAILED） */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const PREVIEW_PLAN_KEY = 'supplier.previewPlan';

/** 演示用：预览不同内部权限档位（真实系统由登录用户权限决定） */
export function getPreviewPlan(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(PREVIEW_PLAN_KEY);
}

export function setPreviewPlan(plan: string | null): void {
  if (typeof window === 'undefined') return;
  if (plan) window.localStorage.setItem(PREVIEW_PLAN_KEY, plan);
  else window.localStorage.removeItem(PREVIEW_PLAN_KEY);
}

function userHeaders(): Record<string, string> {
  if (!isDemoAuthMode) {
    const token = getAccessToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  }
  const headers: Record<string, string> = { 'x-user-id': '1' };
  const preview = getPreviewPlan();
  if (preview) headers['x-user-plan'] = preview;
  return headers;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body != null;
  const res = await fetch(`${getBffUrl()}/api${path}`, {
    ...init,
    headers: {
      // 仅在有 body 时声明 JSON，避免无体 POST 触发 Fastify 空 body 校验
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...userHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let code: string | undefined;
    let message = res.statusText;
    try {
      const body = JSON.parse(text);
      message = body.message ?? message;
      code = body.code;
    } catch {
      if (text) message = text;
    }
    throw new ApiError(res.status, code, message);
  }
  return res.json() as Promise<T>;
}

export const api = {
  recommendations(query: RecommendationQuery = {}): Promise<RecommendationList> {
    const params = new URLSearchParams();
    if (query.categoryL1) params.set('categoryL1', query.categoryL1);
    if (query.priceMin !== undefined) params.set('priceMin', String(query.priceMin));
    if (query.priceMax !== undefined) params.set('priceMax', String(query.priceMax));
    params.set('limit', String(query.limit ?? 30));
    return request<RecommendationList>(`/products/recommendations?${params.toString()}`);
  },

  productFacets(): Promise<ProductFacets> {
    return request<ProductFacets>('/products/facets');
  },

  productDetail(productId1688: string): Promise<Product> {
    return request<Product>(`/products/${encodeURIComponent(productId1688)}`);
  },

  favorites(): Promise<FavoriteList> {
    return request('/favorites');
  },

  addFavorite(productId1688: string): Promise<FavoriteProduct> {
    return request(`/favorites/${encodeURIComponent(productId1688)}`, { method: 'PUT' });
  },

  removeFavorite(productId1688: string): Promise<{ removed: boolean }> {
    return request(`/favorites/${encodeURIComponent(productId1688)}`, { method: 'DELETE' });
  },

  generateTitle(body: {
    originalTitle: string;
    category: string;
    sellingPoints: string[];
    targetPlatform: string;
  }): Promise<TitleResult> {
    return request('/ai/title', { method: 'POST', body: JSON.stringify(body) });
  },

  entitlements(): Promise<EntitlementView> {
    return request('/me/entitlements');
  },

  activation(): Promise<ActivationProgress> {
    return request('/me/activation');
  },

  getLlmKey(): Promise<LlmKeyView> {
    return request('/settings/llm-key');
  },

  saveLlmKey(body: { provider: string; apiKey: string; label?: string }): Promise<LlmKeyView> {
    return request('/settings/llm-key', { method: 'POST', body: JSON.stringify(body) });
  },

  deleteLlmKey(): Promise<{ deleted: boolean }> {
    return request('/settings/llm-key', { method: 'DELETE' });
  },

  shops(): Promise<Shop[]> {
    return request('/shops');
  },

  connectShop(body: { platform: string; shopName?: string }): Promise<Shop> {
    return request('/shops/connect', { method: 'POST', body: JSON.stringify(body) });
  },

  disconnectShop(shopId: string): Promise<Shop> {
    return request(`/shops/${encodeURIComponent(shopId)}/disconnect`, { method: 'POST' });
  },

  authorizeDouyin(returnTo?: string): Promise<OAuthAuthorizationResult> {
    return request(oauthAuthorizePath('douyin', returnTo));
  },

  authorizeAlibaba1688(returnTo?: string): Promise<OAuthAuthorizationResult> {
    return request(oauthAuthorizePath('alibaba_1688', returnTo));
  },

  consumeOAuthResult(token: string): Promise<OAuthResult> {
    return request('/shops/oauth/result', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  },

  douyinReadiness(): Promise<DouyinReadiness> {
    return request('/shops/oauth/douyin/readiness');
  },

  alibaba1688Readiness(): Promise<Alibaba1688Readiness> {
    return request('/shops/oauth/alibaba_1688/readiness');
  },

  mediaReadiness(): Promise<MediaReadiness> {
    return request('/media/readiness');
  },

  categoryMapping(sourceProductId: string): Promise<CategoryMapping> {
    return request(`/categories/mappings/${encodeURIComponent(sourceProductId)}?platform=douyin`);
  },

  confirmCategoryMapping(
    sourceProductId: string,
    body: {
      platform: 'douyin';
      categoryId: string;
      categoryName?: string;
      shopId?: string;
    },
  ): Promise<CategoryMapping> {
    return request(`/categories/mappings/${encodeURIComponent(sourceProductId)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },

  removeCategoryMapping(sourceProductId: string): Promise<{ deleted: boolean }> {
    return request(`/categories/mappings/${encodeURIComponent(sourceProductId)}?platform=douyin`, {
      method: 'DELETE',
    });
  },

  categoryCatalogStatus(shopId: string): Promise<CategoryCatalogStatus> {
    return request(`/categories/catalog/${encodeURIComponent(shopId)}`);
  },

  syncCategoryCatalog(shopId: string): Promise<CategoryCatalogStatus> {
    return request(`/categories/catalog/${encodeURIComponent(shopId)}/sync`, { method: 'POST' });
  },

  categorySuggestions(sourceProductId: string, shopId: string): Promise<CategorySuggestions> {
    const params = new URLSearchParams({ shopId });
    return request(
      `/categories/mappings/${encodeURIComponent(sourceProductId)}/suggestions?${params.toString()}`,
    );
  },

  categoryProperties(sourceProductId: string, shopId: string): Promise<CategoryProperties> {
    const params = new URLSearchParams({ shopId });
    return request(
      `/categories/mappings/${encodeURIComponent(sourceProductId)}/properties?${params.toString()}`,
    );
  },

  syncCategoryProperties(sourceProductId: string, shopId: string): Promise<CategoryProperties> {
    const params = new URLSearchParams({ shopId });
    return request(
      `/categories/mappings/${encodeURIComponent(sourceProductId)}/properties/sync?${params.toString()}`,
      { method: 'POST' },
    );
  },

  confirmCategoryProperties(
    sourceProductId: string,
    body: {
      shopId: string;
      values: Array<{
        propertyId: string;
        selections: Array<{ valueId?: string; name: string }>;
      }>;
    },
  ): Promise<CategoryProperties> {
    return request(`/categories/mappings/${encodeURIComponent(sourceProductId)}/properties`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },

  removeCategoryProperties(sourceProductId: string, shopId: string): Promise<{ deleted: boolean }> {
    const params = new URLSearchParams({ shopId });
    return request(
      `/categories/mappings/${encodeURIComponent(sourceProductId)}/properties?${params.toString()}`,
      { method: 'DELETE' },
    );
  },

  categoryQualifications(sourceProductId: string, shopId: string): Promise<CategoryQualifications> {
    const params = new URLSearchParams({ shopId });
    return request(
      `/categories/mappings/${encodeURIComponent(sourceProductId)}/qualifications?${params.toString()}`,
    );
  },

  syncCategoryQualifications(
    sourceProductId: string,
    shopId: string,
  ): Promise<CategoryQualifications> {
    const params = new URLSearchParams({ shopId });
    return request(
      `/categories/mappings/${encodeURIComponent(sourceProductId)}/qualifications/sync?${params.toString()}`,
      { method: 'POST' },
    );
  },

  confirmCategoryQualifications(
    sourceProductId: string,
    body: {
      shopId: string;
      qualifications: Array<{
        qualificationKey: string;
        qualityContentName?: string;
        attachmentUrls: string[];
      }>;
    },
  ): Promise<CategoryQualifications> {
    return request(`/categories/mappings/${encodeURIComponent(sourceProductId)}/qualifications`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },

  removeCategoryQualifications(
    sourceProductId: string,
    shopId: string,
  ): Promise<{ deleted: boolean }> {
    const params = new URLSearchParams({ shopId });
    return request(
      `/categories/mappings/${encodeURIComponent(sourceProductId)}/qualifications?${params.toString()}`,
      { method: 'DELETE' },
    );
  },

  skuMapping(sourceProductId: string): Promise<SkuMapping> {
    return request(`/skus/mappings/${encodeURIComponent(sourceProductId)}?platform=douyin`);
  },

  confirmSkuMapping(
    sourceProductId: string,
    body: {
      platform: 'douyin';
      dimensions: string[];
      skus: Array<{ sourceSkuId: string; values: string[]; enabled: boolean }>;
    },
  ): Promise<SkuMapping> {
    return request(`/skus/mappings/${encodeURIComponent(sourceProductId)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },

  removeSkuMapping(sourceProductId: string): Promise<{ deleted: boolean }> {
    return request(`/skus/mappings/${encodeURIComponent(sourceProductId)}?platform=douyin`, {
      method: 'DELETE',
    });
  },

  publish(
    body: PublishRequest,
  ): Promise<PublishTaskResult | PublishTaskAccepted | PublishTaskReplay> {
    return request('/publish-tasks', { method: 'POST', body: JSON.stringify(body) });
  },

  publishTaskByClientRequestId(clientRequestId: string): Promise<PublishTaskSummary> {
    return request(`/publish-tasks/by-client-request/${encodeURIComponent(clientRequestId)}`);
  },

  publishDraft(): Promise<PublishDraftView | null> {
    return request('/publish-drafts/current');
  },

  savePublishDraft(body: SavePublishDraftRequest): Promise<PublishDraftView> {
    return request('/publish-drafts/current', { method: 'PUT', body: JSON.stringify(body) });
  },

  deletePublishDraft(
    expectedRevision: number,
    expectedClientRequestId: string,
  ): Promise<{ deleted: true }> {
    const params = new URLSearchParams({
      expectedRevision: String(expectedRevision),
      expectedClientRequestId,
    });
    return request(`/publish-drafts/current?${params.toString()}`, { method: 'DELETE' });
  },

  publishPreflight(body: PublishPreflightRequest): Promise<PublishPreflightResult> {
    return request('/publish-tasks/preflight', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  pricingPreview(body: {
    sourceProductId: string;
    pricingStrategy: PricingStrategy;
  }): Promise<PricingPreviewResult> {
    return request('/publish-tasks/pricing-preview', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  retryPublishTask(taskId: string): Promise<{ taskId: string; queued: true }> {
    return request(`/publish-tasks/${encodeURIComponent(taskId)}/retry`, { method: 'POST' });
  },

  retryInventorySync(
    publishedProductId: string,
  ): Promise<{ publishedProductId: string; queued: true }> {
    return request(`/inventory-sync/${encodeURIComponent(publishedProductId)}/retry`, {
      method: 'POST',
    });
  },

  updatePublishedProduct(
    publishedProductId: string,
    body: { title?: string },
  ): Promise<PublishedProductUpdateResult> {
    return request(`/published-products/${encodeURIComponent(publishedProductId)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },

  syncPublishedProductStatus(publishedProductId: string): Promise<PublishedProductStatusResult> {
    return request(`/published-products/${encodeURIComponent(publishedProductId)}/status-sync`, {
      method: 'POST',
    });
  },

  productBatchCandidates(filters: {
    page: number;
    pageSize: number;
    status?: string;
    q?: string;
  }): Promise<ProductBatchCandidatePage> {
    const params = new URLSearchParams({
      page: String(filters.page),
      pageSize: String(filters.pageSize),
    });
    if (filters.status) params.set('status', filters.status);
    if (filters.q) params.set('q', filters.q);
    return request(`/product-batches/candidates?${params.toString()}`);
  },

  createProductBatchPreview(body: ProductBatchPreviewRequest): Promise<ProductBatchTask> {
    return request('/product-batches/previews', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  productBatchTask(taskId: string): Promise<ProductBatchTask> {
    return request(`/product-batches/${encodeURIComponent(taskId)}`);
  },

  productBatchTasks(page: number, pageSize: number): Promise<ProductBatchTaskPage> {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    return request(`/product-batches?${params.toString()}`);
  },

  executeProductBatch(taskId: string, previewRevision: number): Promise<ProductBatchTask> {
    return request(`/product-batches/${encodeURIComponent(taskId)}/execute`, {
      method: 'POST',
      body: JSON.stringify({ previewRevision }),
    });
  },

  cancelProductBatch(taskId: string): Promise<ProductBatchTask> {
    return request(`/product-batches/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' });
  },

  retryProductBatch(taskId: string, itemIds?: string[]): Promise<ProductBatchTask> {
    return request(`/product-batches/${encodeURIComponent(taskId)}/retry`, {
      method: 'POST',
      body: JSON.stringify(itemIds?.length ? { itemIds } : {}),
    });
  },

  verifyProductBatchTitle(taskId: string, itemId: string): Promise<ProductBatchTask> {
    return request(
      `/product-batches/${encodeURIComponent(taskId)}/items/${encodeURIComponent(itemId)}/verify-title`,
      { method: 'POST' },
    );
  },

  verifyProductBatchOnline(taskId: string, itemId: string): Promise<ProductBatchTask> {
    return request(
      `/product-batches/${encodeURIComponent(taskId)}/items/${encodeURIComponent(itemId)}/verify-online`,
      { method: 'POST' },
    );
  },

  verifyProductBatchOffline(taskId: string, itemId: string): Promise<ProductBatchTask> {
    return request(
      `/product-batches/${encodeURIComponent(taskId)}/items/${encodeURIComponent(itemId)}/verify-offline`,
      { method: 'POST' },
    );
  },

  createSourceImportPreview(body: {
    clientRequestId: string;
    references: string[];
    buyerShopId?: string;
  }): Promise<SourceImportTask> {
    return request('/source-imports/previews', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  sourceImportTask(taskId: string): Promise<SourceImportTask> {
    return request(`/source-imports/${encodeURIComponent(taskId)}`);
  },

  sourceImportTaskByClientRequest(clientRequestId: string): Promise<SourceImportTask> {
    return request(`/source-imports/by-client-request/${encodeURIComponent(clientRequestId)}`);
  },

  sourceImportTasks(page: number, pageSize: number): Promise<SourceImportTaskPage> {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    return request(`/source-imports?${params.toString()}`);
  },

  executeSourceImport(taskId: string, previewRevision: number): Promise<SourceImportTask> {
    return request(`/source-imports/${encodeURIComponent(taskId)}/execute`, {
      method: 'POST',
      body: JSON.stringify({ previewRevision }),
    });
  },

  cancelSourceImport(taskId: string): Promise<SourceImportTask> {
    return request(`/source-imports/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' });
  },

  retrySourceImport(taskId: string, itemIds?: string[]): Promise<SourceImportTask> {
    return request(`/source-imports/${encodeURIComponent(taskId)}/retry`, {
      method: 'POST',
      body: JSON.stringify(itemIds?.length ? { itemIds } : {}),
    });
  },

  collectedSourceProducts(page = 1, pageSize = 50): Promise<CollectedSourceProductList> {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    return request(`/source-products/collected?${params.toString()}`);
  },

  publishTasks(page: number, pageSize: number): Promise<PublishTaskPage> {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    return request(`/publish-tasks?${params.toString()}`);
  },

  orders(
    page: number,
    pageSize: number,
    filters: { shopId?: string; status?: string } = {},
  ): Promise<OrderListPage> {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (filters.shopId) params.set('shopId', filters.shopId);
    if (filters.status) params.set('status', filters.status);
    return request(`/orders?${params.toString()}`);
  },

  orderReconciliations(page: number, pageSize: number): Promise<OrderReconciliationPage> {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    return request(`/orders/reconciliations?${params.toString()}`);
  },

  syncOrders(shopId: string): Promise<OrderSyncResult> {
    return request(`/orders/sync/${encodeURIComponent(shopId)}`, { method: 'POST' });
  },

  refreshOrder(orderId: string): Promise<OrderRefreshResult> {
    return request(`/orders/${encodeURIComponent(orderId)}/refresh`, { method: 'POST' });
  },

  simulateOrder(publishedProductId: string): Promise<Order> {
    return request('/orders/simulate', {
      method: 'POST',
      body: JSON.stringify({ publishedProductId }),
    });
  },

  fulfillOrder(orderId: string): Promise<Order> {
    return request(`/orders/${orderId}/fulfill`, { method: 'POST' });
  },

  resolvePartialRefund(
    orderId: string,
    action: 'continue_remaining' | 'stop_all',
    note: string,
  ): Promise<Order> {
    return request(`/orders/${encodeURIComponent(orderId)}/resolve-partial-refund`, {
      method: 'POST',
      body: JSON.stringify({ action, note }),
    });
  },

  confirmRefundAmount(orderId: string, amount: number, note: string): Promise<Order> {
    return request(`/orders/${encodeURIComponent(orderId)}/confirm-refund-amount`, {
      method: 'POST',
      body: JSON.stringify({ amount, note }),
    });
  },

  resolvePurchaseException(
    orderId: string,
    purchaseOrderId: string,
    actualCost: number,
    expectedRevision: number,
    note: string,
  ): Promise<Order> {
    return request(
      `/orders/${encodeURIComponent(orderId)}/purchases/${encodeURIComponent(purchaseOrderId)}/resolve-exception`,
      { method: 'POST', body: JSON.stringify({ actualCost, expectedRevision, note }) },
    );
  },

  retryFailedPurchase(
    orderId: string,
    purchaseOrderId: string,
    actualCost: number,
    expectedRevision: number,
    note: string,
  ): Promise<Order> {
    return request(
      `/orders/${encodeURIComponent(orderId)}/purchases/${encodeURIComponent(purchaseOrderId)}/retry`,
      { method: 'POST', body: JSON.stringify({ actualCost, expectedRevision, note }) },
    );
  },

  resumePurchaseLogistics(
    orderId: string,
    purchaseOrderId: string,
    expectedRevision: number,
    note: string,
  ): Promise<Order> {
    return request(
      `/orders/${encodeURIComponent(orderId)}/purchases/${encodeURIComponent(purchaseOrderId)}/resume-logistics`,
      { method: 'POST', body: JSON.stringify({ expectedRevision, note }) },
    );
  },

  repairSettledLogistics(
    orderId: string,
    purchaseOrderId: string,
    actualCost: number,
    expectedRevision: number,
    note: string,
  ): Promise<Order> {
    return request(
      `/orders/${encodeURIComponent(orderId)}/purchases/${encodeURIComponent(purchaseOrderId)}/repair-settled-logistics`,
      { method: 'POST', body: JSON.stringify({ actualCost, expectedRevision, note }) },
    );
  },

  exceptionCases(query: ExceptionCaseQuery = {}): Promise<ExceptionCasePage> {
    const params = new URLSearchParams({
      page: String(query.page ?? 1),
      pageSize: String(query.pageSize ?? 30),
    });
    if (query.status) params.set('status', query.status);
    if (query.domain) params.set('domain', query.domain);
    if (query.priority) params.set('priority', query.priority);
    if (query.q) params.set('q', query.q);
    return request(`/exception-cases?${params.toString()}`);
  },

  exceptionCase(caseId: string): Promise<ExceptionCaseDetail> {
    return request(`/exception-cases/${encodeURIComponent(caseId)}`);
  },

  refreshExceptionCases(): Promise<RefreshExceptionCasesResult> {
    return request('/exception-cases/refresh', { method: 'POST' });
  },

  acknowledgeExceptionCase(
    caseId: string,
    body: AcknowledgeExceptionCaseRequest,
  ): Promise<ExceptionCaseDetail> {
    return request(`/exception-cases/${encodeURIComponent(caseId)}/acknowledge`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  afterSaleCases(query: AfterSaleCaseQuery = {}): Promise<AfterSaleCasePage> {
    const params = new URLSearchParams({
      page: String(query.page ?? 1),
      pageSize: String(query.pageSize ?? 30),
    });
    if (query.status) params.set('status', query.status);
    if (query.overdue !== undefined) params.set('overdue', String(query.overdue));
    if (query.q) params.set('q', query.q);
    return request(`/after-sale-cases?${params.toString()}`);
  },

  afterSaleCase(caseId: string): Promise<AfterSaleCaseDetail> {
    return request(`/after-sale-cases/${encodeURIComponent(caseId)}`);
  },

  refreshAfterSaleCases(afterOrderId?: string): Promise<RefreshAfterSaleCasesResult> {
    const params = new URLSearchParams();
    if (afterOrderId) params.set('afterOrderId', afterOrderId);
    const query = params.size > 0 ? `?${params.toString()}` : '';
    return request(`/after-sale-cases/refresh${query}`, { method: 'POST' });
  },

  claimAfterSaleCase(caseId: string, body: AfterSaleCaseCommand): Promise<AfterSaleCaseDetail> {
    return request(`/after-sale-cases/${encodeURIComponent(caseId)}/claim`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  startAfterSalePurchaseAction(
    caseId: string,
    linkId: string,
    body: StartAfterSalePurchaseActionRequest,
  ): Promise<AfterSaleCaseDetail> {
    return request(
      `/after-sale-cases/${encodeURIComponent(caseId)}/purchase-links/${encodeURIComponent(linkId)}/start`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  },

  confirmAfterSalePurchaseAction(
    caseId: string,
    linkId: string,
    body: ConfirmAfterSalePurchaseActionRequest,
  ): Promise<AfterSaleCaseDetail> {
    return request(
      `/after-sale-cases/${encodeURIComponent(caseId)}/purchase-links/${encodeURIComponent(linkId)}/confirm`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  },

  verifyCloseAfterSaleCase(
    caseId: string,
    body: AfterSaleCaseCommand,
  ): Promise<AfterSaleCaseDetail> {
    return request(`/after-sale-cases/${encodeURIComponent(caseId)}/verify-close`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  analyticsOverview(days: AnalyticsRangeDays): Promise<AnalyticsOverview> {
    return request(`/analytics/overview?days=${days}`);
  },
};

function oauthAuthorizePath(platform: 'douyin' | 'alibaba_1688', returnTo?: string): string {
  const path = `/shops/oauth/${platform}/authorize`;
  if (!returnTo) return path;
  return `${path}?${new URLSearchParams({ returnTo }).toString()}`;
}
