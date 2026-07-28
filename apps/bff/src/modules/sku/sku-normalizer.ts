import { createHash } from 'node:crypto';

const MAX_DIMENSIONS = 3;
const MAX_SKUS = 100;

const DIMENSION_ALIASES: Record<string, string> = {
  颜色分类: '颜色',
  色号: '颜色',
  color: '颜色',
  colour: '颜色',
  尺寸: '尺码',
  大小: '尺码',
  size: '尺码',
  型号: '款式',
  model: '款式',
};

export interface NormalizedSourceSku {
  sourceSkuId: string;
  sourceSpecName: string;
  costPrice: number;
  stock: number;
  attributes: Record<string, string>;
  image: string | null;
}

export interface SkuSuggestionRow extends NormalizedSourceSku {
  values: string[];
  enabled: boolean;
}

export interface SkuSuggestion {
  dimensions: string[];
  skus: SkuSuggestionRow[];
  requiresConfirmation: boolean;
  warnings: string[];
  sourceFingerprint: string;
}

export interface ConfirmedSkuRow {
  sourceSkuId: string;
  values: string[];
  enabled: boolean;
}

export interface ConfirmedSkuMapping {
  dimensions: string[];
  skus: ConfirmedSkuRow[];
  sourceFingerprint: string;
}

export interface MaterializedSku extends NormalizedSourceSku {
  values: string[];
  mappedAttributes: Record<string, string>;
}

export function parseConfirmedSkuMapping(
  dimensionsValue: unknown,
  skusValue: unknown,
  sourceFingerprint: unknown,
): ConfirmedSkuMapping | null {
  if (!Array.isArray(dimensionsValue) || !Array.isArray(skusValue)) return null;
  const dimensions = dimensionsValue.filter(
    (value): value is string => typeof value === 'string' && !!value.trim(),
  );
  if (!dimensions.length || dimensions.length > MAX_DIMENSIONS) return null;
  const skus: ConfirmedSkuRow[] = [];
  for (const value of skusValue) {
    const record = objectRecord(value);
    if (!record || !Array.isArray(record.values)) return null;
    const sourceSkuId = stringValue(record.sourceSkuId);
    const values = record.values.map(stringValue);
    if (!sourceSkuId || values.length !== dimensions.length || values.some((item) => !item)) {
      return null;
    }
    skus.push({ sourceSkuId, values, enabled: record.enabled !== false });
  }
  if (!skus.length || typeof sourceFingerprint !== 'string') return null;
  return { dimensions, skus, sourceFingerprint };
}

export function buildSkuSuggestion(skuList: unknown, basePrice: number): SkuSuggestion {
  const warnings: string[] = [];
  const normalized = normalizeSourceSkus(skuList, basePrice, warnings);
  if (!normalized.length) {
    const fallback: NormalizedSourceSku = {
      sourceSkuId: 'default',
      sourceSpecName: '默认',
      costPrice: basePrice,
      stock: 999,
      attributes: {},
      image: null,
    };
    return {
      dimensions: [],
      skus: [{ ...fallback, values: [], enabled: true }],
      requiresConfirmation: false,
      warnings: ['货源未提供 SKU，将按默认规格发布'],
      sourceFingerprint: fingerprint([fallback]),
    };
  }

  const allDimensions = sortDimensions(
    unique(normalized.flatMap((sku) => Object.keys(sku.attributes).map(normalizeDimensionName))),
  );
  if (allDimensions.length > MAX_DIMENSIONS) {
    warnings.push(
      `货源包含 ${allDimensions.length} 个规格维度，抖店当前最多支持 ${MAX_DIMENSIONS} 个`,
    );
  }
  const dimensions = allDimensions.slice(0, MAX_DIMENSIONS);
  const skus = normalized.map((sku) => ({
    ...sku,
    values: dimensions.map((dimension) => sku.attributes[dimension] ?? ''),
    enabled: sku.stock > 0,
  }));
  if (skus.some((sku) => sku.values.some((value) => !value))) {
    warnings.push('部分 SKU 缺少规格值，请补齐后再确认');
  }

  return {
    dimensions,
    skus,
    requiresConfirmation: skus.length > 1 || dimensions.length > 0,
    warnings,
    sourceFingerprint: fingerprint(normalized),
  };
}

export function materializeConfirmedSkus(
  suggestion: SkuSuggestion,
  mapping: ConfirmedSkuMapping,
): MaterializedSku[] {
  const sourceById = new Map(suggestion.skus.map((sku) => [sku.sourceSkuId, sku]));
  return mapping.skus
    .filter((sku) => sku.enabled)
    .map((sku) => {
      const source = sourceById.get(sku.sourceSkuId);
      if (!source) throw new Error(`SKU ${sku.sourceSkuId} 已不存在`);
      return {
        sourceSkuId: source.sourceSkuId,
        sourceSpecName: source.sourceSpecName,
        costPrice: source.costPrice,
        stock: source.stock,
        attributes: source.attributes,
        image: source.image,
        values: sku.values,
        mappedAttributes: Object.fromEntries(
          mapping.dimensions.map((dimension, index) => [dimension, sku.values[index] ?? '']),
        ),
      };
    });
}

function normalizeSourceSkus(
  value: unknown,
  basePrice: number,
  warnings: string[],
): NormalizedSourceSku[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_SKUS)
    warnings.push(`货源 SKU 超过 ${MAX_SKUS} 个，仅处理前 ${MAX_SKUS} 个`);

  const seen = new Set<string>();
  const out: NormalizedSourceSku[] = [];
  for (const [index, item] of value.slice(0, MAX_SKUS).entries()) {
    const record = objectRecord(item);
    if (!record) {
      warnings.push(`第 ${index + 1} 个 SKU 格式无效，已忽略`);
      continue;
    }
    const sourceSkuId = stringValue(record.skuId ?? record.id) || `source-${index + 1}`;
    if (seen.has(sourceSkuId)) {
      warnings.push(`SKU ID ${sourceSkuId} 重复，后续重复项已忽略`);
      continue;
    }
    seen.add(sourceSkuId);

    const sourceSpecName = stringValue(record.specName ?? record.name) || `规格 ${index + 1}`;
    const attributes = normalizeAttributes(record.attributes, sourceSpecName);
    const rawPrice = numberValue(record.price);
    const rawStock = numberValue(record.stock);
    out.push({
      sourceSkuId,
      sourceSpecName,
      costPrice: rawPrice > 0 ? round2(rawPrice) : round2(basePrice),
      stock: rawStock >= 0 ? Math.trunc(rawStock) : 0,
      attributes,
      image: httpUrl(record.image),
    });
  }
  return out;
}

function normalizeAttributes(value: unknown, specName: string): Record<string, string> {
  const record = objectRecord(value);
  const entries = record
    ? Object.entries(record)
        .map(([key, val]) => [normalizeDimensionName(key), stringValue(val)] as const)
        .filter((entry) => entry[0] && entry[1])
    : [];
  if (entries.length) return Object.fromEntries(entries);

  const parsed = specName
    .split(/[;；,，|]/)
    .map((segment) => segment.split(/[:：=]/, 2).map((part) => part.trim()))
    .filter((parts): parts is [string, string] => parts.length === 2 && !!parts[0] && !!parts[1]);
  if (parsed.length) {
    return Object.fromEntries(parsed.map(([key, val]) => [normalizeDimensionName(key), val]));
  }
  if (specName && specName !== '默认') return { 规格: specName };
  return {};
}

function normalizeDimensionName(value: string): string {
  const trimmed = value.trim();
  return DIMENSION_ALIASES[trimmed.toLowerCase()] ?? DIMENSION_ALIASES[trimmed] ?? trimmed;
}

function fingerprint(skus: NormalizedSourceSku[]): string {
  const source = skus.map((sku) => ({
    sourceSkuId: sku.sourceSkuId,
    sourceSpecName: sku.sourceSpecName,
    attributes: sku.attributes,
  }));
  return createHash('sha256').update(JSON.stringify(source)).digest('hex');
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function numberValue(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : -1;
}

function httpUrl(value: unknown): string | null {
  const url = stringValue(value);
  return /^https?:\/\//i.test(url) ? url : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function sortDimensions(values: string[]): string[] {
  const priority = new Map([
    ['颜色', 0],
    ['尺码', 1],
    ['款式', 2],
    ['规格', 3],
  ]);
  return [...values].sort(
    (a, b) => (priority.get(a) ?? 100) - (priority.get(b) ?? 100) || a.localeCompare(b),
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
