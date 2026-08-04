import type { ProductBatchAction, ProductBatchCandidate } from '../lib/api';

const STORAGE_VERSION = 1;
const STORAGE_PREFIX = 'supplier.product-batch.workbench.v1';
const MAX_SELECTION = 100;
const VALID_STATUSES = new Set(['online', 'draft', 'rejected', 'offline']);
const INVENTORY_CANDIDATE_FIELDS = [
  'sourceTotalStock',
  'sourceSkuCount',
  'sourceInventoryVersion',
  'syncedInventoryVersion',
  'inventoryLastSyncedAt',
  'inventorySyncError',
  'inventorySyncEligible',
  'inventorySyncReason',
] as const;
const TITLE_CANDIDATE_FIELDS = ['titleEditable', 'titleEditReason'] as const;
const ONLINE_CANDIDATE_FIELDS = [
  'onlineEligible',
  'onlineReason',
  'onlineVerificationTaskId',
  'onlineVerificationItemId',
] as const;
const OFFLINE_CANDIDATE_FIELDS = [
  'offlineVerificationTaskId',
  'offlineVerificationItemId',
] as const;
const CLEANUP_CANDIDATE_FIELDS = ['cleanupEligible', 'cleanupReason', 'cleanupEvidence'] as const;
const SOURCE_CHANGE_CANDIDATE_FIELDS = [
  'sourceChangeEligible',
  'sourceChangeReason',
  'currentSourceRouteCount',
] as const;

type LegacyProductBatchCandidate = Omit<
  ProductBatchCandidate,
  | (typeof INVENTORY_CANDIDATE_FIELDS)[number]
  | (typeof TITLE_CANDIDATE_FIELDS)[number]
  | (typeof ONLINE_CANDIDATE_FIELDS)[number]
  | (typeof OFFLINE_CANDIDATE_FIELDS)[number]
  | (typeof CLEANUP_CANDIDATE_FIELDS)[number]
  | (typeof SOURCE_CHANGE_CANDIDATE_FIELDS)[number]
>;

export interface ProductBatchSessionScope {
  accountId: string;
  pathname: string;
}

export interface ProductBatchComposerDraft {
  page: number;
  status: string;
  searchInput: string;
  query: string;
  action: ProductBatchAction;
  priceMode: 'percentage' | 'targets';
  priceDirection: 'increase' | 'decrease';
  percentageInput: string;
  targetInputs: Record<string, string>;
  titleInputs: Record<string, string>;
  sourceTargetInputs: Record<string, string>;
  bulkTargetInput: string;
  targetPage: number;
  selected: ProductBatchCandidate[];
}

export interface ProductBatchPreviewSession {
  fingerprint: string;
  clientRequestId: string;
  taskId?: string;
}

export interface ProductBatchWorkbenchSession {
  draft: ProductBatchComposerDraft;
  preview: ProductBatchPreviewSession | null;
}

export interface ProductBatchSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readProductBatchWorkbenchSession(
  scope: ProductBatchSessionScope,
  storage: ProductBatchSessionStorage | undefined = browserSessionStorage(),
): ProductBatchWorkbenchSession | null {
  if (!storage) return null;
  const key = productBatchWorkbenchStorageKey(scope);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    const parsed = parseStoredSession(value, scope);
    if (parsed) return parsed;
    storage.removeItem(key);
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // sessionStorage 不可用时，调用方仍可依赖服务端幂等约束。
    }
  }
  return null;
}

export function writeProductBatchWorkbenchSession(
  scope: ProductBatchSessionScope,
  session: ProductBatchWorkbenchSession,
  storage: ProductBatchSessionStorage | undefined = browserSessionStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      productBatchWorkbenchStorageKey(scope),
      JSON.stringify({
        version: STORAGE_VERSION,
        accountId: scope.accountId,
        pathname: scope.pathname,
        ...session,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearProductBatchWorkbenchSession(
  scope: ProductBatchSessionScope,
  storage: ProductBatchSessionStorage | undefined = browserSessionStorage(),
): void {
  try {
    storage?.removeItem(productBatchWorkbenchStorageKey(scope));
  } catch {
    // 清理失败不影响服务端任务状态。
  }
}

export function clearProductBatchSessionForTask(
  scope: ProductBatchSessionScope,
  task: { taskId: string; clientRequestId: string },
  storage: ProductBatchSessionStorage | undefined = browserSessionStorage(),
): boolean {
  const session = readProductBatchWorkbenchSession(scope, storage);
  if (
    !session?.preview?.taskId ||
    session.preview.taskId !== task.taskId ||
    session.preview.clientRequestId !== task.clientRequestId
  ) {
    return false;
  }
  clearProductBatchWorkbenchSession(scope, storage);
  return true;
}

export function shouldRestoreProductBatchPreview(
  preview: ProductBatchPreviewSession,
  task: { taskId: string; clientRequestId: string; status: string },
): boolean {
  return (
    task.status === 'preview' &&
    task.taskId === preview.taskId &&
    task.clientRequestId === preview.clientRequestId
  );
}

export function productBatchWorkbenchStorageKey(scope: ProductBatchSessionScope): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(scope.accountId)}:${encodeURIComponent(scope.pathname)}`;
}

function parseStoredSession(
  value: unknown,
  scope: ProductBatchSessionScope,
): ProductBatchWorkbenchSession | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== STORAGE_VERSION ||
    value.accountId !== scope.accountId ||
    value.pathname !== scope.pathname
  ) {
    return null;
  }
  const draft = parseDraft(value.draft);
  const preview = parsePreview(value.preview);
  if (!draft || preview === undefined) return null;
  return { draft, preview };
}

function parseDraft(value: unknown): ProductBatchComposerDraft | null {
  if (!isRecord(value)) return null;
  const action = value.action;
  if (
    !isPositiveInteger(value.page) ||
    !isPositiveInteger(value.targetPage) ||
    typeof value.status !== 'string' ||
    !VALID_STATUSES.has(value.status) ||
    typeof value.searchInput !== 'string' ||
    typeof value.query !== 'string' ||
    !isProductBatchAction(action) ||
    !isPriceMode(value.priceMode) ||
    !isPriceDirection(value.priceDirection) ||
    typeof value.percentageInput !== 'string' ||
    typeof value.bulkTargetInput !== 'string' ||
    !Array.isArray(value.selected) ||
    value.selected.length > MAX_SELECTION ||
    !isStringRecord(value.targetInputs) ||
    (value.titleInputs !== undefined && !isStringRecord(value.titleInputs)) ||
    (value.sourceTargetInputs !== undefined && !isStringRecord(value.sourceTargetInputs)) ||
    (action === 'change_source' &&
      (value.status !== 'offline' ||
        !isStringRecord(value.sourceTargetInputs) ||
        !hasValidSourceTargetInputs(value.sourceTargetInputs)))
  ) {
    return null;
  }

  const selected = value.selected.map((item) => parseProductBatchCandidate(item, action));
  if (selected.some((item) => item === null)) return null;
  const candidates = selected as ProductBatchCandidate[];
  const selectedIds = new Set(candidates.map((item) => item.publishedProductId));
  if (selectedIds.size !== candidates.length) return null;
  const targetInputs = Object.fromEntries(
    Object.entries(value.targetInputs).filter(([id]) => selectedIds.has(id)),
  );
  const titleInputs = Object.fromEntries(
    Object.entries(isStringRecord(value.titleInputs) ? value.titleInputs : {}).filter(([id]) =>
      selectedIds.has(id),
    ),
  );
  const sourceTargetInputs = Object.fromEntries(
    Object.entries(isStringRecord(value.sourceTargetInputs) ? value.sourceTargetInputs : {}).filter(
      ([id]) => selectedIds.has(id),
    ),
  );
  return {
    page: value.page,
    status: value.status,
    searchInput: value.searchInput,
    query: value.query,
    action,
    priceMode: value.priceMode,
    priceDirection: value.priceDirection,
    percentageInput: value.percentageInput,
    targetInputs,
    titleInputs,
    sourceTargetInputs,
    bulkTargetInput: value.bulkTargetInput,
    targetPage: value.targetPage,
    selected: candidates,
  };
}

function parsePreview(value: unknown): ProductBatchPreviewSession | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.fingerprint !== 'string' ||
    !isUuid(value.clientRequestId) ||
    (value.taskId !== undefined && !isPositiveId(value.taskId))
  ) {
    return undefined;
  }
  return {
    fingerprint: value.fingerprint,
    clientRequestId: value.clientRequestId,
    ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
  };
}

function parseProductBatchCandidate(
  value: unknown,
  action: ProductBatchAction,
): ProductBatchCandidate | null {
  if (!isLegacyProductBatchCandidate(value)) return null;
  if (isProductBatchCandidate(value)) {
    return (action !== 'online' || value.onlineEligible === true) &&
      (action !== 'cleanup' || value.cleanupEligible === true) &&
      (action !== 'change_source' || value.sourceChangeEligible === true) &&
      value.offlineVerificationTaskId === null
      ? value
      : null;
  }
  const hasInventoryFields = INVENTORY_CANDIDATE_FIELDS.some((field) =>
    Object.hasOwn(value, field),
  );
  const hasTitleFields = TITLE_CANDIDATE_FIELDS.some((field) => Object.hasOwn(value, field));
  const hasOnlineFields = ONLINE_CANDIDATE_FIELDS.some((field) => Object.hasOwn(value, field));
  const hasOfflineFields = OFFLINE_CANDIDATE_FIELDS.some((field) => Object.hasOwn(value, field));
  const hasCleanupFields = CLEANUP_CANDIDATE_FIELDS.some((field) => Object.hasOwn(value, field));
  const hasSourceChangeFields = SOURCE_CHANGE_CANDIDATE_FIELDS.some((field) =>
    Object.hasOwn(value, field),
  );
  const inventoryFieldsValid = hasInventoryCandidateFields(value);
  const titleFieldsValid = hasTitleCandidateFields(value);
  const onlineFieldsValid = hasValidOnlineCandidateState(value);
  const offlineFieldsValid = hasValidOfflineCandidateState(value);
  const cleanupFieldsValid = hasValidCleanupCandidateState(value);
  const sourceChangeFieldsValid = hasValidSourceChangeCandidateState(value);
  if (
    (hasInventoryFields && !inventoryFieldsValid) ||
    (hasTitleFields && !titleFieldsValid) ||
    (hasOnlineFields && !onlineFieldsValid) ||
    (hasOfflineFields && (!offlineFieldsValid || value.offlineVerificationTaskId !== null)) ||
    (hasCleanupFields && !cleanupFieldsValid) ||
    (hasSourceChangeFields && !sourceChangeFieldsValid) ||
    (action === 'sync_inventory' && !inventoryFieldsValid) ||
    (action === 'edit_title' && !titleFieldsValid) ||
    (action === 'online' && (!onlineFieldsValid || value.onlineEligible !== true)) ||
    (action === 'cleanup' && (!cleanupFieldsValid || value.cleanupEligible !== true)) ||
    (action === 'change_source' &&
      (!sourceChangeFieldsValid || value.sourceChangeEligible !== true)) ||
    (['offline', 'cleanup', 'change_source'].includes(action) &&
      (!offlineFieldsValid || value.offlineVerificationTaskId !== null))
  ) {
    return null;
  }
  return {
    ...value,
    sourceTotalStock: inventoryFieldsValid ? (value.sourceTotalStock as number) : 0,
    sourceSkuCount: inventoryFieldsValid ? (value.sourceSkuCount as number) : 0,
    sourceInventoryVersion: inventoryFieldsValid ? (value.sourceInventoryVersion as number) : 0,
    syncedInventoryVersion: inventoryFieldsValid ? (value.syncedInventoryVersion as number) : 0,
    inventoryLastSyncedAt: inventoryFieldsValid
      ? (value.inventoryLastSyncedAt as string | null)
      : null,
    inventorySyncError: inventoryFieldsValid ? (value.inventorySyncError as string | null) : null,
    inventorySyncEligible: inventoryFieldsValid ? (value.inventorySyncEligible as boolean) : false,
    inventorySyncReason: inventoryFieldsValid
      ? (value.inventorySyncReason as string | null)
      : '旧版会话缺少库存快照，请刷新商品后再同步库存',
    titleEditable: titleFieldsValid ? (value.titleEditable as boolean) : false,
    titleEditReason: titleFieldsValid
      ? (value.titleEditReason as string | null)
      : '旧版会话缺少标题编辑状态，请刷新商品后再修改标题',
    onlineEligible: onlineFieldsValid ? (value.onlineEligible as boolean) : false,
    onlineReason: onlineFieldsValid
      ? (value.onlineReason as string | null)
      : '旧版会话缺少安全上架状态，请刷新商品后再上架',
    onlineVerificationTaskId: onlineFieldsValid
      ? (value.onlineVerificationTaskId as string | null)
      : null,
    onlineVerificationItemId: onlineFieldsValid
      ? (value.onlineVerificationItemId as string | null)
      : null,
    offlineVerificationTaskId: offlineFieldsValid
      ? (value.offlineVerificationTaskId as string | null)
      : null,
    offlineVerificationItemId: offlineFieldsValid
      ? (value.offlineVerificationItemId as string | null)
      : null,
    cleanupEligible: cleanupFieldsValid ? (value.cleanupEligible as boolean) : false,
    cleanupReason: cleanupFieldsValid
      ? (value.cleanupReason as string | null)
      : '旧版会话缺少滞销清理证据，请刷新商品后再操作',
    cleanupEvidence: cleanupFieldsValid
      ? (value.cleanupEvidence as ProductBatchCandidate['cleanupEvidence'])
      : null,
    sourceChangeEligible: sourceChangeFieldsValid ? (value.sourceChangeEligible as boolean) : false,
    sourceChangeReason: sourceChangeFieldsValid
      ? (value.sourceChangeReason as string | null)
      : '旧版会话缺少安全换源状态，请刷新商品后再操作',
    currentSourceRouteCount: sourceChangeFieldsValid
      ? (value.currentSourceRouteCount as number)
      : 0,
  };
}

function isLegacyProductBatchCandidate(
  value: unknown,
): value is LegacyProductBatchCandidate & Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    isPositiveId(value.publishedProductId) &&
    typeof value.title === 'string' &&
    (value.mainImage === null || typeof value.mainImage === 'string') &&
    isPositiveId(value.shopId) &&
    (value.shopName === null || typeof value.shopName === 'string') &&
    typeof value.platform === 'string' &&
    typeof value.platformProductId === 'string' &&
    typeof value.status === 'string' &&
    isFiniteNumber(value.salePrice) &&
    isPriceRange(value.priceRange) &&
    Number.isInteger(value.skuCount) &&
    Number(value.skuCount) >= 0 &&
    typeof value.priceEditable === 'boolean' &&
    (value.priceEditReason === null || typeof value.priceEditReason === 'string') &&
    typeof value.sourceProductId === 'string' &&
    typeof value.sourceAvailability === 'string' &&
    typeof value.inventorySyncStatus === 'string' &&
    Number.isInteger(value.mutationRevision) &&
    Number(value.mutationRevision) >= 0 &&
    typeof value.publishedAt === 'string'
  );
}

function isProductBatchCandidate(
  value: LegacyProductBatchCandidate & Record<string, unknown>,
): value is ProductBatchCandidate & Record<string, unknown> {
  return (
    hasInventoryCandidateFields(value) &&
    hasTitleCandidateFields(value) &&
    hasValidOnlineCandidateState(value) &&
    hasValidOfflineCandidateState(value) &&
    hasValidCleanupCandidateState(value) &&
    hasValidSourceChangeCandidateState(value)
  );
}

function hasInventoryCandidateFields(value: Record<string, unknown>): boolean {
  return (
    isNonNegativeInteger(value.sourceTotalStock) &&
    isNonNegativeInteger(value.sourceSkuCount) &&
    isNonNegativeInteger(value.sourceInventoryVersion) &&
    isNonNegativeInteger(value.syncedInventoryVersion) &&
    (value.inventoryLastSyncedAt === null || typeof value.inventoryLastSyncedAt === 'string') &&
    (value.inventorySyncError === null || typeof value.inventorySyncError === 'string') &&
    typeof value.inventorySyncEligible === 'boolean' &&
    (value.inventorySyncReason === null || typeof value.inventorySyncReason === 'string')
  );
}

function hasTitleCandidateFields(value: Record<string, unknown>): boolean {
  return (
    typeof value.titleEditable === 'boolean' &&
    (value.titleEditReason === null || typeof value.titleEditReason === 'string')
  );
}

export function hasValidOnlineCandidateState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const eligible = value.onlineEligible;
  const reason = value.onlineReason;
  const taskId = value.onlineVerificationTaskId;
  const itemId = value.onlineVerificationItemId;
  const verificationIdsValid =
    (taskId === null && itemId === null) || (isPositiveId(taskId) && isPositiveId(itemId));
  if (typeof eligible !== 'boolean' || !verificationIdsValid) return false;
  if (eligible) {
    return value.status === 'offline' && reason === null && taskId === null && itemId === null;
  }
  return typeof reason === 'string' && reason.trim().length > 0;
}

export function hasValidOfflineCandidateState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const taskId = value.offlineVerificationTaskId;
  const itemId = value.offlineVerificationItemId;
  return (taskId === null && itemId === null) || (isPositiveId(taskId) && isPositiveId(itemId));
}

export function hasValidCleanupCandidateState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const eligible = value.cleanupEligible;
  const reason = value.cleanupReason;
  const evidence = value.cleanupEvidence;
  if (typeof eligible !== 'boolean' || (evidence !== null && !isCleanupEvidence(evidence))) {
    return false;
  }
  if (eligible) {
    return (
      value.status === 'online' &&
      reason === null &&
      evidence !== null &&
      evidence.daysOnline >= evidence.graceDays &&
      evidence.validOrderCount === 0 &&
      evidence.orderSyncAt !== null
    );
  }
  return typeof reason === 'string' && reason.trim().length > 0;
}

export function hasValidSourceChangeCandidateState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const eligible = value.sourceChangeEligible;
  const reason = value.sourceChangeReason;
  const routeCount = value.currentSourceRouteCount;
  if (typeof eligible !== 'boolean' || !isNonNegativeInteger(routeCount)) return false;
  if (eligible) return value.status === 'offline' && reason === null && routeCount > 0;
  return typeof reason === 'string' && reason.trim().length > 0;
}

function isCleanupEvidence(
  value: unknown,
): value is NonNullable<ProductBatchCandidate['cleanupEvidence']> {
  if (!isRecord(value)) return false;
  return (
    value.policyVersion === 1 &&
    value.windowDays === 30 &&
    value.graceDays === 7 &&
    isIsoDate(value.observedAt) &&
    isIsoDate(value.windowStartedAt) &&
    isNonNegativeInteger(value.daysOnline) &&
    isNonNegativeInteger(value.validOrderCount) &&
    (value.lastPaidAt === null || isIsoDate(value.lastPaidAt)) &&
    (value.orderSyncAt === null || isIsoDate(value.orderSyncAt))
  );
}

function isPriceRange(value: unknown): value is [number, number] | null {
  return (
    value === null ||
    (Array.isArray(value) &&
      value.length === 2 &&
      isFiniteNumber(value[0]) &&
      isFiniteNumber(value[1]))
  );
}

function isProductBatchAction(value: unknown): value is ProductBatchAction {
  return (
    value === 'online' ||
    value === 'offline' ||
    value === 'edit_title' ||
    value === 'edit_price' ||
    value === 'sync_inventory' ||
    value === 'change_source' ||
    value === 'cleanup'
  );
}

function isPriceMode(value: unknown): value is 'percentage' | 'targets' {
  return value === 'percentage' || value === 'targets';
}

function isPriceDirection(value: unknown): value is 'increase' | 'decrease' {
  return value === 'increase' || value === 'decrease';
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function hasValidSourceTargetInputs(value: Record<string, string>): boolean {
  return Object.values(value).every((entry) => {
    const offerId = entry.trim();
    return offerId === '' || /^[1-9]\d{0,31}$/.test(offerId);
  });
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isPositiveId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function browserSessionStorage(): ProductBatchSessionStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}
