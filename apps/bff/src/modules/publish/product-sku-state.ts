import type {
  PlatformProductSkuItem,
  PlatformProductSkuRules,
  PlatformProductSkuState,
  PublishProductDto,
} from '@supplier/platform-sdk';
import { createHash } from 'node:crypto';

const MAX_SKUS = 100;
const MAX_DIMENSIONS = 3;
const PLATFORM_PRODUCT_STATES = new Set([
  'online',
  'offline',
  'deleted',
  'draft',
  'reviewing',
  'rejected',
  'blocked',
  'approved_pending_online',
  'unknown',
]);

export interface StoredProductSkuState extends PlatformProductSkuState {
  version: 1;
}

export interface StoredProductSkuPriceSnapshot {
  version: 1;
  items: Array<{ sourceSkuId: string; priceCents: number }>;
}

export interface StoredProductSkuInventorySnapshot {
  version: 1;
  items: Array<{ sourceSkuId: string; stock: number }>;
}

export interface ProductSkuCurrentDimension {
  propertyId: string;
  propertyName: string;
  values: Array<{
    valueId: string;
    valueName: string;
    remark?: string;
  }>;
}

export function productSkuPropertyIdentity(propertyId: string, propertyName: string): string {
  return JSON.stringify([propertyId, propertyName]);
}

export function productSkuRuleValueIdentity(valueId: string, valueName: string): string {
  return JSON.stringify([valueId, valueName]);
}

export function productSkuValueIdentity(
  valueId: string,
  valueName: string,
  remark: string | null,
): string {
  return JSON.stringify([valueId, valueName, remark]);
}

export function hasValidProductSkuPropertyIdentities(
  values: Array<{ propertyId: string; propertyName: string }>,
): boolean {
  const identities = new Set<string>();
  const nonCustomIds = new Set<string>();
  const names = new Set<string>();
  for (const value of values) {
    const identity = productSkuPropertyIdentity(value.propertyId, value.propertyName);
    if (
      identities.has(identity) ||
      (value.propertyId !== '0' && nonCustomIds.has(value.propertyId)) ||
      names.has(value.propertyName)
    ) {
      return false;
    }
    identities.add(identity);
    if (value.propertyId !== '0') nonCustomIds.add(value.propertyId);
    names.add(value.propertyName);
  }
  return true;
}

function hasValidProductSkuRuleValueIdentities(
  values: Array<{ valueId: string; valueName: string }>,
): boolean {
  const identities = new Set<string>();
  const nonCustomIds = new Set<string>();
  const nonCustomNames = new Set<string>();
  for (const value of values) {
    const identity = productSkuRuleValueIdentity(value.valueId, value.valueName);
    if (
      identities.has(identity) ||
      (value.valueId !== '0' &&
        (nonCustomIds.has(value.valueId) || nonCustomNames.has(value.valueName)))
    ) {
      return false;
    }
    identities.add(identity);
    if (value.valueId !== '0') {
      nonCustomIds.add(value.valueId);
      nonCustomNames.add(value.valueName);
    }
  }
  return true;
}

export function normalizeProductSkuState(value: PlatformProductSkuState): StoredProductSkuState {
  if (!value || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 100) {
    throw new Error('平台 SKU 状态必须包含 1～100 个 SKU');
  }
  if (!PLATFORM_PRODUCT_STATES.has(value.state)) {
    throw new Error('平台商品状态无效');
  }
  const categoryId = strictText(value.categoryId, 64, '平台类目 ID');
  if (!Number.isSafeInteger(value.productType) || value.productType < 0) {
    throw new Error('平台商品类型无效');
  }
  if (value.startSaleType !== 0 && value.startSaleType !== 1) {
    throw new Error('平台起售类型无效');
  }
  if (!Number.isSafeInteger(value.status) && value.status !== null) {
    throw new Error('平台商品状态码无效');
  }
  if (!Number.isSafeInteger(value.checkStatus) && value.checkStatus !== null) {
    throw new Error('平台商品审核状态码无效');
  }

  const ids = new Set<string>();
  const keys = new Set<string>();
  const combinations = new Set<string>();
  const items = value.items.map((item, index) => {
    const normalized = normalizeSkuItem(item, index);
    if (ids.has(normalized.platformSkuId)) throw new Error('平台返回了重复的 SKU ID');
    if (keys.has(normalized.platformSkuKey)) throw new Error('平台返回了重复的 SKU key');
    const combination = JSON.stringify(
      normalized.properties.map((property) => [
        property.propertyId,
        property.propertyName,
        property.valueId,
        property.valueName,
        property.remark,
      ]),
    );
    if (combinations.has(combination)) throw new Error('平台返回了重复的 SKU 规格组合');
    ids.add(normalized.platformSkuId);
    keys.add(normalized.platformSkuKey);
    combinations.add(combination);
    return normalized;
  });

  return {
    version: 1,
    state: value.state,
    status: value.status,
    checkStatus: value.checkStatus,
    categoryId,
    productType: value.productType,
    startSaleType: value.startSaleType,
    items: items.sort((left, right) => left.platformSkuKey.localeCompare(right.platformSkuKey)),
  };
}

export function parseStoredProductSkuState(value: unknown): StoredProductSkuState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return null;
  try {
    return normalizeProductSkuState(record as unknown as PlatformProductSkuState);
  } catch {
    return null;
  }
}

export function productSkuFingerprint(value: PlatformProductSkuState): string {
  return sha256(normalizeProductSkuState(value));
}

export function sameProductSkuState(
  left: PlatformProductSkuState,
  right: PlatformProductSkuState,
): boolean {
  return productSkuFingerprint(left) === productSkuFingerprint(right);
}

export function productSkuCurrentDimensions(
  value: PlatformProductSkuState,
): ProductSkuCurrentDimension[] {
  const state = normalizeProductSkuState(value);
  const shape = state.items[0]!.properties.map((property) => ({
    propertyId: property.propertyId,
    propertyName: property.propertyName,
  }));
  const valuesByDimension = shape.map(
    () => new Map<string, ProductSkuCurrentDimension['values'][number]>(),
  );

  for (const item of state.items) {
    if (item.properties.length !== shape.length) {
      throw new Error('平台 SKU 规格结构不一致');
    }
    item.properties.forEach((property, index) => {
      const expected = shape[index]!;
      if (
        property.propertyId !== expected.propertyId ||
        property.propertyName !== expected.propertyName
      ) {
        throw new Error('平台 SKU 规格结构不一致');
      }
      const normalized = {
        valueId: property.valueId,
        valueName: property.valueName,
        ...(property.remark ? { remark: property.remark } : {}),
      };
      valuesByDimension[index]!.set(
        productSkuValueIdentity(property.valueId, property.valueName, property.remark),
        normalized,
      );
    });
  }

  return shape.map((dimension, index) => ({
    ...dimension,
    values: [...valuesByDimension[index]!.values()],
  }));
}

export function normalizeProductSkuRules(value: PlatformProductSkuRules): PlatformProductSkuRules {
  if (
    !value ||
    !Number.isSafeInteger(value.maxDimensions) ||
    value.maxDimensions < 0 ||
    value.maxDimensions > MAX_DIMENSIONS ||
    !Number.isSafeInteger(value.maxCombinations) ||
    value.maxCombinations < 1 ||
    value.maxCombinations > MAX_SKUS ||
    !Number.isSafeInteger(value.maxValuesPerDimension) ||
    value.maxValuesPerDimension < 1 ||
    value.maxValuesPerDimension > MAX_SKUS ||
    !Array.isArray(value.dimensions) ||
    value.dimensions.length > value.maxDimensions ||
    typeof value.supportsDimensionReordering !== 'boolean' ||
    typeof value.supportsCustomDimensions !== 'boolean' ||
    typeof value.allSkuPicturesRequired !== 'boolean'
  ) {
    throw new Error('平台 SKU 规则无效');
  }
  const dimensions = value.dimensions.map((dimension, index) => {
    const propertyId = strictText(dimension.propertyId, 64, `第 ${index + 1} 个规格属性 ID`);
    const propertyName = strictText(dimension.propertyName, 64, `第 ${index + 1} 个规格属性名`);
    if (
      typeof dimension.required !== 'boolean' ||
      typeof dimension.supportsCustomValues !== 'boolean' ||
      typeof dimension.supportsRemark !== 'boolean' ||
      typeof dimension.requiresPagedValues !== 'boolean' ||
      !Array.isArray(dimension.navigationProperties) ||
      !Array.isArray(dimension.values) ||
      dimension.values.length > value.maxValuesPerDimension
    ) {
      throw new Error('平台 SKU 规格维度规则无效');
    }
    const values = dimension.values.map((item, valueIndex) => {
      const valueId = strictText(item.valueId, 64, `第 ${valueIndex + 1} 个规格值 ID`);
      const valueName = strictText(item.valueName, 64, `第 ${valueIndex + 1} 个规格值`);
      return { valueId, valueName };
    });
    if (!hasValidProductSkuRuleValueIdentities(values)) {
      throw new Error('平台 SKU 规则包含重复规格值');
    }
    return {
      propertyId,
      propertyName,
      required: dimension.required,
      supportsCustomValues: dimension.supportsCustomValues,
      supportsRemark: dimension.supportsRemark,
      requiresPagedValues: dimension.requiresPagedValues,
      navigationProperties: dimension.navigationProperties.map((navigation) => ({
        propertyId: strictText(navigation.propertyId, 64, '导航属性 ID'),
        propertyName: strictText(navigation.propertyName, 64, '导航属性名'),
      })),
      values,
      unsupportedReasons: normalizeReasons(dimension.unsupportedReasons),
    };
  });
  if (!hasValidProductSkuPropertyIdentities(dimensions)) {
    throw new Error('平台 SKU 规则包含重复属性');
  }
  return {
    maxDimensions: value.maxDimensions,
    maxCombinations: value.maxCombinations,
    maxValuesPerDimension: value.maxValuesPerDimension,
    supportsDimensionReordering: value.supportsDimensionReordering,
    supportsCustomDimensions: value.supportsCustomDimensions,
    allSkuPicturesRequired: value.allSkuPicturesRequired,
    dimensions,
    unsupportedReasons: normalizeReasons(value.unsupportedReasons),
  };
}

export function productSkuRuleFingerprint(value: PlatformProductSkuRules): string {
  return sha256(normalizeProductSkuRules(value));
}

export function skuPriceSnapshot(value: PlatformProductSkuState): StoredProductSkuPriceSnapshot {
  const state = normalizeProductSkuState(value);
  return {
    version: 1,
    items: state.items.map((item) => ({
      sourceSkuId: item.platformSkuKey,
      priceCents: item.priceCents,
    })),
  };
}

export function skuInventorySnapshot(
  value: PlatformProductSkuState,
): StoredProductSkuInventorySnapshot {
  const state = normalizeProductSkuState(value);
  return {
    version: 1,
    items: state.items.map((item) => ({ sourceSkuId: item.platformSkuKey, stock: item.stock })),
  };
}

export function skuStateToPublishSkus(value: PlatformProductSkuState): PublishProductDto['skus'] {
  return normalizeProductSkuState(value).items.map((item) => ({
    sourceSkuId: item.platformSkuKey,
    specName: item.properties.map(skuPropertyDisplayValue).join('/') || '默认',
    price: item.priceCents / 100,
    stock: item.stock,
    attributes: Object.fromEntries(
      item.properties.map((property) => [property.propertyName, skuPropertyDisplayValue(property)]),
    ),
    ...(item.skuPictureUrls[0] ? { image: item.skuPictureUrls[0] } : {}),
  }));
}

export function skuPropertyDisplayValue(
  property: PlatformProductSkuItem['properties'][number],
): string {
  return property.remark?.trim() || property.valueName;
}

function normalizeSkuItem(item: PlatformProductSkuItem, index: number): PlatformProductSkuItem {
  const platformSkuId = strictText(item.platformSkuId, 64, `第 ${index + 1} 个平台 SKU ID`);
  const platformSkuKey = strictText(item.platformSkuKey, 128, `第 ${index + 1} 个平台 SKU key`);
  if (!Array.isArray(item.properties) || item.properties.length > MAX_DIMENSIONS) {
    throw new Error(`第 ${index + 1} 个平台 SKU 规格无效`);
  }
  const properties = item.properties.map((property, propertyIndex) => {
    const propertyId = strictText(
      property.propertyId,
      64,
      `第 ${index + 1} 个 SKU 的第 ${propertyIndex + 1} 个属性 ID`,
    );
    const remark = nullableText(property.remark, 64, 'SKU 自定义规格值');
    return {
      propertyId,
      propertyName: strictText(property.propertyName, 64, 'SKU 规格属性名'),
      valueId: strictText(property.valueId, 64, 'SKU 规格值 ID'),
      valueName: strictText(property.valueName, 64, 'SKU 规格值'),
      remark,
    };
  });
  if (!hasValidProductSkuPropertyIdentities(properties)) {
    throw new Error('平台 SKU 包含重复规格属性');
  }
  if (!Number.isSafeInteger(item.priceCents) || item.priceCents < 1) {
    throw new Error(`第 ${index + 1} 个平台 SKU 价格无效`);
  }
  if (!Number.isSafeInteger(item.stock) || item.stock < 0) {
    throw new Error(`第 ${index + 1} 个平台 SKU 库存无效`);
  }
  if (typeof item.skuStatus !== 'boolean') throw new Error('平台 SKU 状态无效');
  if (![0, 1, 10].includes(item.skuType)) throw new Error('平台 SKU 类型无效');
  if (!Number.isSafeInteger(item.stepStock) || item.stepStock < 0) {
    throw new Error('平台 SKU 阶梯库存无效');
  }
  return {
    platformSkuId,
    platformSkuKey,
    properties,
    priceCents: item.priceCents,
    stock: item.stock,
    skuStatus: item.skuStatus,
    skuType: item.skuType,
    code: nullableText(item.code, 128, '平台 SKU 编码'),
    supplierId: nullableText(item.supplierId, 128, '平台 SKU 供应商 ID'),
    stepStock: item.stepStock,
    barcodes: normalizeStringArray(item.barcodes, 100, 128, '平台 SKU 条码'),
    skuPictureUrls: normalizeUrlArray(item.skuPictureUrls, 20, '平台 SKU 图片'),
  };
}

function normalizeReasons(value: string[]): string[] {
  if (!Array.isArray(value)) throw new Error('平台 SKU 不支持原因无效');
  return [...new Set(value.map((reason) => strictText(reason, 255, '平台 SKU 不支持原因')))].sort();
}

function normalizeStringArray(
  value: string[],
  maxItems: number,
  maxLength: number,
  label: string,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label}无效`);
  return [...new Set(value.map((item) => strictText(item, maxLength, label)))].sort();
}

function normalizeUrlArray(value: string[], maxItems: number, label: string): string[] {
  const urls = normalizeStringArray(value, maxItems, 512, label);
  if (urls.some((url) => !/^https:\/\/[^\s]+$/i.test(url))) throw new Error(`${label}无效`);
  return urls;
}

function strictText(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}无效`);
  const text = value.trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`${label}无效`);
  }
  return text;
}

function nullableText(value: unknown, maxLength: number, label: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  return strictText(value, maxLength, label);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
