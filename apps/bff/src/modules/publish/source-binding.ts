import { createHash } from 'node:crypto';

const MAX_ROUTES = 100;
const MAX_PLATFORM_SKU_KEY_LENGTH = 128;
const MAX_SOURCE_SPEC_ID_LENGTH = 128;
const MAX_ROUTE_VALUES = 10;
const MAX_ROUTE_VALUE_LENGTH = 255;
const MAX_UNIT_COST = 99_999_999.99;
const ROUTE_KEYS = [
  'platformSkuKey',
  'sourceSpecId',
  'sourceSpecRequired',
  'sourceUnitCost',
  'values',
] as const;

export interface SourceBindingRoute {
  platformSkuKey: string;
  sourceSpecId: string | null;
  sourceSpecRequired: boolean;
  sourceUnitCost: number;
  values: string[];
}

export interface SourceBindingFingerprintInput {
  sourceProductId: string | bigint;
  sourceOfferId: string;
  sourceSupplierId: string | null;
  sourceOnePieceDrop: boolean;
  sourceFingerprint: string;
  inventoryFingerprint: string;
  inventoryVersion: number;
  skuRoutes: unknown;
}

export interface SourceBindingPlatformRoute {
  platformSkuKey: string;
  values: string[];
}

export class SourceBindingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceBindingValidationError';
  }
}

export function buildSourceBindingRoutes(
  platformRoutesValue: SourceBindingPlatformRoute[],
  sourceSkuList: unknown,
  basePriceValue: number,
): SourceBindingRoute[] {
  const basePrice = positivePrice(basePriceValue, '货源基础采购价');
  if (!Array.isArray(platformRoutesValue) || platformRoutesValue.length > MAX_ROUTES) {
    throw new SourceBindingValidationError('平台 SKU 路由必须是最多 100 项的数组');
  }
  const seenPlatformKeys = new Set<string>();
  const platformRoutes = platformRoutesValue.map((value, index) => {
    const route = exactRecord(
      value,
      ['platformSkuKey', 'values'],
      `第 ${index + 1} 条平台 SKU 路由`,
    );
    const platformSkuKey = strictText(
      route.platformSkuKey,
      MAX_PLATFORM_SKU_KEY_LENGTH,
      `第 ${index + 1} 条路由的平台 SKU key`,
    );
    if (seenPlatformKeys.has(platformSkuKey)) {
      throw new SourceBindingValidationError(`平台 SKU 路由包含重复 key：${platformSkuKey}`);
    }
    seenPlatformKeys.add(platformSkuKey);
    return { platformSkuKey, values: routeValues(route.values, index) };
  });

  if (sourceSkuList === null || sourceSkuList === undefined || isEmptyArray(sourceSkuList)) {
    if (platformRoutes.length !== 1 || platformRoutes[0]!.values.length !== 0) {
      throw new SourceBindingValidationError('无 SKU 货源只能绑定一条空规格平台路由');
    }
    return parseSourceBindingRoutes([
      {
        platformSkuKey: platformRoutes[0]!.platformSkuKey,
        sourceSpecId: null,
        sourceSpecRequired: false,
        sourceUnitCost: basePrice,
        values: [],
      },
    ]);
  }
  if (!Array.isArray(sourceSkuList) || sourceSkuList.length > MAX_ROUTES) {
    throw new SourceBindingValidationError('货源 SKU 必须是最多 100 项的数组');
  }
  if (sourceSkuList.length < platformRoutes.length) {
    throw new SourceBindingValidationError('货源 SKU 数量少于平台 SKU 路由');
  }

  const seenSourceIds = new Set<string>();
  const sourceSkus = sourceSkuList.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new SourceBindingValidationError(`第 ${index + 1} 个货源 SKU 格式无效`);
    }
    const sku = value as Record<string, unknown>;
    const sourceSpecId = strictText(
      sku.skuId,
      MAX_SOURCE_SPEC_ID_LENGTH,
      `第 ${index + 1} 个货源 SKU 的 skuId`,
    );
    if (seenSourceIds.has(sourceSpecId)) {
      throw new SourceBindingValidationError(`货源 SKU 包含重复 skuId：${sourceSpecId}`);
    }
    seenSourceIds.add(sourceSpecId);
    return {
      sourceSpecId,
      sourceUnitCost:
        sku.price === null || sku.price === undefined
          ? basePrice
          : positivePrice(sku.price, `第 ${index + 1} 个货源 SKU 的采购价`),
      values: sourceSkuValues(sku, index),
    };
  });

  const unusedSourceIndexes = new Set(sourceSkus.map((_sku, index) => index));
  const matched = new Map<number, number>();
  for (const [routeIndex, route] of platformRoutes.entries()) {
    const exactIndex = sourceSkus.findIndex((sku) => sku.sourceSpecId === route.platformSkuKey);
    if (exactIndex >= 0) {
      matched.set(routeIndex, exactIndex);
      unusedSourceIndexes.delete(exactIndex);
    }
  }
  for (const [routeIndex, route] of platformRoutes.entries()) {
    if (matched.has(routeIndex)) continue;
    const candidates = [...unusedSourceIndexes].filter((sourceIndex) =>
      sameStringArray(sourceSkus[sourceIndex]!.values, route.values),
    );
    if (candidates.length !== 1) {
      throw new SourceBindingValidationError(
        candidates.length === 0
          ? `平台 SKU ${route.platformSkuKey} 无法精确匹配货源规格`
          : `平台 SKU ${route.platformSkuKey} 匹配到多个相同规格货源 SKU`,
      );
    }
    matched.set(routeIndex, candidates[0]!);
    unusedSourceIndexes.delete(candidates[0]!);
  }

  return parseSourceBindingRoutes(
    platformRoutes.map((route, routeIndex) => {
      const source = sourceSkus[matched.get(routeIndex)!]!;
      return {
        platformSkuKey: route.platformSkuKey,
        sourceSpecId: source.sourceSpecId,
        sourceSpecRequired: true,
        sourceUnitCost: source.sourceUnitCost,
        values: route.values,
      };
    }),
  );
}

export function parseSourceBindingRoutes(value: unknown): SourceBindingRoute[] {
  if (!Array.isArray(value) || value.length > MAX_ROUTES) {
    throw new SourceBindingValidationError('货源绑定 SKU 路由必须是最多 100 项的数组');
  }

  const seen = new Set<string>();
  const routes = value.map((routeValue, index) => {
    const route = exactRecord(routeValue, ROUTE_KEYS, `第 ${index + 1} 条货源绑定 SKU 路由`);
    const platformSkuKey = strictText(
      route.platformSkuKey,
      MAX_PLATFORM_SKU_KEY_LENGTH,
      `第 ${index + 1} 条路由的平台 SKU key`,
    );
    if (seen.has(platformSkuKey)) {
      throw new SourceBindingValidationError(`货源绑定包含重复的平台 SKU key：${platformSkuKey}`);
    }
    seen.add(platformSkuKey);

    const sourceSpecId = nullableStrictText(
      route.sourceSpecId,
      MAX_SOURCE_SPEC_ID_LENGTH,
      `第 ${index + 1} 条路由的 1688 specId`,
    );
    if (typeof route.sourceSpecRequired !== 'boolean') {
      throw new SourceBindingValidationError(`第 ${index + 1} 条路由的规格必填标记无效`);
    }
    if (route.sourceSpecRequired && sourceSpecId === null) {
      throw new SourceBindingValidationError(`第 ${index + 1} 条路由缺少必填的 1688 specId`);
    }
    const sourceUnitCost = positiveUnitCost(route.sourceUnitCost, index);
    const values = routeValues(route.values, index);

    return {
      platformSkuKey,
      sourceSpecId,
      sourceSpecRequired: route.sourceSpecRequired,
      sourceUnitCost,
      values,
    };
  });

  return routes.sort((left, right) => left.platformSkuKey.localeCompare(right.platformSkuKey));
}

export function findSourceBindingRoute(
  routesValue: unknown,
  platformSkuKeyValue: string,
): SourceBindingRoute | null {
  const platformSkuKey = strictText(
    platformSkuKeyValue,
    MAX_PLATFORM_SKU_KEY_LENGTH,
    '平台订单 SKU key',
  );
  return (
    parseSourceBindingRoutes(routesValue).find(
      (route) => route.platformSkuKey === platformSkuKey,
    ) ?? null
  );
}

export function sourceBindingRoutesFingerprint(routesValue: unknown): string {
  return sha256(parseSourceBindingRoutes(routesValue));
}

export function sourceBindingFingerprint(input: SourceBindingFingerprintInput): string {
  const sourceProductId = positiveId(input.sourceProductId, '货源商品 ID');
  const sourceOfferId = strictNumericText(input.sourceOfferId, 32, '1688 offerId');
  const sourceSupplierId = nullableStrictText(input.sourceSupplierId, 32, '1688 供应商 ID');
  if (typeof input.sourceOnePieceDrop !== 'boolean') {
    throw new SourceBindingValidationError('货源一件代发标记无效');
  }
  const sourceFingerprint = strictFingerprint(input.sourceFingerprint, '货源指纹');
  const inventoryFingerprint = strictFingerprint(input.inventoryFingerprint, '货源库存指纹');
  if (!Number.isSafeInteger(input.inventoryVersion) || input.inventoryVersion < 0) {
    throw new SourceBindingValidationError('货源库存版本无效');
  }
  return sha256({
    version: 1,
    sourceProductId,
    sourceOfferId,
    sourceSupplierId,
    sourceOnePieceDrop: input.sourceOnePieceDrop,
    sourceFingerprint,
    inventoryFingerprint,
    inventoryVersion: input.inventoryVersion,
    skuRoutes: parseSourceBindingRoutes(input.skuRoutes),
  });
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SourceBindingValidationError(`${label}格式无效`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new SourceBindingValidationError(`${label}字段不完整或包含未知字段`);
  }
  return record;
}

function strictText(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== 'string') throw new SourceBindingValidationError(`${label}无效`);
  const text = value.trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new SourceBindingValidationError(`${label}无效`);
  }
  return text;
}

function strictNumericText(value: unknown, maxLength: number, label: string): string {
  const text = strictText(value, maxLength, label);
  if (!/^[1-9]\d*$/.test(text)) throw new SourceBindingValidationError(`${label}无效`);
  return text;
}

function nullableStrictText(value: unknown, maxLength: number, label: string): string | null {
  return value === null ? null : strictText(value, maxLength, label);
}

function positiveUnitCost(value: unknown, index: number): number {
  return positivePrice(value, `第 ${index + 1} 条路由的货源单价`);
}

function positivePrice(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_UNIT_COST ||
    Math.abs(value * 100 - Math.round(value * 100)) > 1e-7
  ) {
    throw new SourceBindingValidationError(`${label}无效`);
  }
  return value;
}

function routeValues(value: unknown, index: number): string[] {
  if (!Array.isArray(value) || value.length > MAX_ROUTE_VALUES) {
    throw new SourceBindingValidationError(`第 ${index + 1} 条路由的规格值无效`);
  }
  return value.map((item, valueIndex) =>
    strictText(
      item,
      MAX_ROUTE_VALUE_LENGTH,
      `第 ${index + 1} 条路由的第 ${valueIndex + 1} 个规格值`,
    ),
  );
}

function sourceSkuValues(sku: Record<string, unknown>, index: number): string[] {
  if (sku.values !== undefined) return routeValues(sku.values, index);
  if (sku.attributes !== undefined) {
    if (!sku.attributes || typeof sku.attributes !== 'object' || Array.isArray(sku.attributes)) {
      throw new SourceBindingValidationError(`第 ${index + 1} 个货源 SKU 的规格属性无效`);
    }
    return Object.entries(sku.attributes as Record<string, unknown>)
      .sort(([left], [right]) => compareSourceDimension(left, right))
      .map(([, value], valueIndex) =>
        strictText(
          value,
          MAX_ROUTE_VALUE_LENGTH,
          `第 ${index + 1} 个货源 SKU 的第 ${valueIndex + 1} 个规格值`,
        ),
      );
  }
  if (sku.specName === undefined || sku.specName === null) return [];
  return [strictText(sku.specName, MAX_ROUTE_VALUE_LENGTH, `第 ${index + 1} 个货源 SKU 的规格名`)];
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareSourceDimension(left: string, right: string): number {
  const priority = new Map([
    ['颜色', 0],
    ['尺码', 1],
    ['款式', 2],
    ['规格', 3],
  ]);
  return (priority.get(left) ?? 100) - (priority.get(right) ?? 100) || left.localeCompare(right);
}

function isEmptyArray(value: unknown): value is [] {
  return Array.isArray(value) && value.length === 0;
}

function strictFingerprint(value: unknown, label: string): string {
  const fingerprint = strictText(value, 64, label);
  if (!/^[a-zA-Z0-9:_-]+$/.test(fingerprint)) {
    throw new SourceBindingValidationError(`${label}无效`);
  }
  return fingerprint;
}

function positiveId(value: string | bigint, label: string): string {
  const text = typeof value === 'bigint' ? value.toString() : value.trim();
  if (!/^[1-9]\d{0,18}$/.test(text)) throw new SourceBindingValidationError(`${label}无效`);
  return text;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
