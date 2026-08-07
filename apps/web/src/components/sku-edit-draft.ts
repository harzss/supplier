import type {
  ProductBatchSkuDimension,
  ProductBatchSkuEditContext,
  ProductBatchSkuPropertyValue,
  ProductBatchSkuRowTarget,
  ProductBatchSkuTarget,
  ProductBatchSkuValueTarget,
} from '@/lib/api';

const MAX_SKUS = 100;
const MAX_TEXT_LENGTH = 30;
const FORBIDDEN_SPEC_TEXT = /[|,^]/;

export interface SkuChangeSummary {
  added: number;
  changed: number;
  deleted: number;
}

export function skuDimensionIdentity(value: { propertyId: string; propertyName: string }): string {
  return value.propertyId === '0'
    ? JSON.stringify([value.propertyId, value.propertyName.trim()])
    : value.propertyId;
}

export function createSkuTarget(context: ProductBatchSkuEditContext): ProductBatchSkuTarget {
  return {
    publishedProductId: context.publishedProductId,
    expectedMutationRevision: context.expectedMutationRevision,
    expectedPlatformSkuFingerprint: context.expectedPlatformSkuFingerprint,
    expectedRuleFingerprint: context.expectedRuleFingerprint,
    dimensions: cloneDimensions(context.dimensions),
    rows: context.rows.map((row) => ({
      rowId: row.rowId,
      isNew: false,
      platformSkuId: row.platformSkuId,
      platformSkuKey: row.platformSkuKey,
      sourceSpecId: row.sourceSpecId,
      properties: row.properties.map(copyProperty),
      priceCents: row.priceCents,
      skuPictureUrls: [...row.skuPictureUrls],
    })),
  };
}

export function createNewSkuRow(
  target: ProductBatchSkuTarget,
  sourceSpecId: string | null,
): ProductBatchSkuRowTarget {
  const rowIdBase = `new:${sourceSpecId ?? 'default'}`;
  const usedRowIds = new Set(target.rows.map((row) => row.rowId));
  let rowId = rowIdBase;
  let suffix = 2;
  while (usedRowIds.has(rowId)) {
    rowId = `${rowIdBase}:${suffix}`;
    suffix += 1;
  }
  return {
    rowId,
    isNew: true,
    platformSkuId: null,
    platformSkuKey: null,
    sourceSpecId,
    properties: target.dimensions.map((dimension) => ({
      propertyId: dimension.propertyId,
      propertyName: dimension.propertyName,
      valueId: '',
      valueName: '',
    })),
    priceCents: 0,
    skuPictureUrls: [],
  };
}

export function skuCustomValueInputText(
  value: ProductBatchSkuValueTarget,
  supportsRemark: boolean,
): string {
  return supportsRemark ? (value.remark ?? '') : value.valueName;
}

export function updateSkuCustomValueInput(
  value: ProductBatchSkuValueTarget,
  input: string,
  supportsRemark: boolean,
): ProductBatchSkuValueTarget {
  const { remark: _remark, ...withoutRemark } = value;
  if (!supportsRemark) {
    return {
      ...withoutRemark,
      valueId: value.valueId || '0',
      valueName: input,
    };
  }
  return {
    ...withoutRemark,
    valueId: value.valueId || '0',
    valueName: value.valueName.trim() || '其他',
    ...(input ? { remark: input } : {}),
  };
}

export function nextAvailableSkuDimension(
  context: ProductBatchSkuEditContext,
  target: ProductBatchSkuTarget,
): ProductBatchSkuDimension | null {
  const selected = new Set(target.dimensions.map(skuDimensionIdentity));
  const official = context.rules.dimensions.find(
    (rule) => rule.unsupportedReasons.length === 0 && !selected.has(skuDimensionIdentity(rule)),
  );
  if (official) {
    return {
      propertyId: official.propertyId,
      propertyName: official.propertyName,
      values: [],
    };
  }
  if (!context.rules.supportsCustomDimensions) return null;
  let suffix = 1;
  let propertyName = `自定义规格 ${suffix}`;
  while (selected.has(skuDimensionIdentity({ propertyId: '0', propertyName }))) {
    suffix += 1;
    propertyName = `自定义规格 ${suffix}`;
  }
  return { propertyId: '0', propertyName, values: [] };
}

export function appendSkuDimension(
  target: ProductBatchSkuTarget,
  dimension: ProductBatchSkuDimension,
): ProductBatchSkuTarget {
  return {
    ...target,
    dimensions: [...target.dimensions, dimension],
    rows: target.rows.map((row) => ({
      ...row,
      properties: [
        ...row.properties,
        {
          propertyId: dimension.propertyId,
          propertyName: dimension.propertyName,
          valueId: dimension.propertyId === '0' ? '0' : '',
          valueName: '',
        },
      ],
    })),
  };
}

export function deriveSkuTargetDimensions(target: ProductBatchSkuTarget): ProductBatchSkuTarget {
  const dimensions = target.dimensions.map((dimension, dimensionIndex) => {
    const values = new Map<string, ProductBatchSkuDimension['values'][number]>();
    for (const row of target.rows) {
      const value = row.properties[dimensionIndex];
      if (!value) continue;
      const normalized = {
        valueId: value.valueId,
        valueName: value.valueName.trim(),
        ...(value.remark?.trim() ? { remark: value.remark.trim() } : {}),
      };
      values.set(JSON.stringify(normalized), normalized);
    }
    return {
      propertyId: dimension.propertyId,
      propertyName: dimension.propertyName.trim(),
      values: [...values.values()],
    };
  });
  return { ...target, dimensions };
}

export function validateSkuTarget(
  context: ProductBatchSkuEditContext,
  target: ProductBatchSkuTarget,
): string[] {
  const errors: string[] = [];
  if (!context.editable) errors.push(context.blockers[0] ?? '当前商品不能安全编辑 SKU');
  if (context.blockers.length > 0) errors.push(...context.blockers);
  if (context.rules.unsupportedReasons.length > 0) {
    errors.push(...context.rules.unsupportedReasons);
  }
  if (
    target.publishedProductId !== context.publishedProductId ||
    target.expectedMutationRevision !== context.expectedMutationRevision ||
    target.expectedPlatformSkuFingerprint !== context.expectedPlatformSkuFingerprint ||
    target.expectedRuleFingerprint !== context.expectedRuleFingerprint
  ) {
    errors.push('商品或平台规则已变化，请重新读取 SKU 配置');
  }

  const maxDimensions = Math.min(3, context.rules.maxDimensions);
  if (target.dimensions.length > maxDimensions) {
    errors.push(`规格维度不能超过 ${maxDimensions} 个`);
  }
  const dimensionKeys = new Set<string>();
  const ruleByIdentity = new Map(
    context.rules.dimensions.map(
      (dimension) => [skuDimensionIdentity(dimension), dimension] as const,
    ),
  );
  const selectedDimensionIds = new Set(target.dimensions.map(skuDimensionIdentity));
  for (const required of context.rules.dimensions.filter((dimension) => dimension.required)) {
    if (!selectedDimensionIds.has(skuDimensionIdentity(required))) {
      errors.push(`缺少平台必填规格维度：${required.propertyName}`);
    }
  }
  if (!context.rules.supportsDimensionReordering) {
    const expectedOrder = context.rules.dimensions
      .filter((dimension) => selectedDimensionIds.has(skuDimensionIdentity(dimension)))
      .map(skuDimensionIdentity);
    const selectedKnownOrder = target.dimensions
      .filter((dimension) => ruleByIdentity.has(skuDimensionIdentity(dimension)))
      .map(skuDimensionIdentity);
    if (JSON.stringify(expectedOrder) !== JSON.stringify(selectedKnownOrder)) {
      errors.push('平台不允许调整规格维度顺序');
    }
  }
  target.dimensions.forEach((dimension, index) => {
    const nameError = validateSpecText(dimension.propertyName, `第 ${index + 1} 个规格维度`);
    if (nameError) errors.push(nameError);
    const key = dimensionKey(dimension);
    if (dimensionKeys.has(key)) errors.push('规格维度不能重复');
    dimensionKeys.add(key);
    const rule = ruleByIdentity.get(skuDimensionIdentity(dimension));
    if (!rule && !context.rules.supportsCustomDimensions) {
      errors.push(`平台不支持自定义规格维度：${dimension.propertyName}`);
    }
    if (rule && rule.propertyName !== dimension.propertyName.trim()) {
      errors.push(`规格维度 ${dimension.propertyId} 名称与平台规则不一致`);
    }
    if (rule?.unsupportedReasons.length) errors.push(...rule.unsupportedReasons);
    const officialValues = new Map(
      rule?.values.map((value) => [skuRuleValueIdentity(value), value] as const),
    );
    for (const value of dimension.values) {
      const officialValue = officialValues.get(skuRuleValueIdentity(value));
      if (officialValue && officialValue.valueName !== value.valueName) {
        errors.push(`规格值 ${value.valueId} 名称与平台规则不一致`);
      }
      if (!officialValue && rule && !rule.supportsCustomValues) {
        errors.push(`平台不支持自定义规格值：${value.valueName}`);
      }
      if (value.remark && rule && !rule.supportsRemark) {
        errors.push(`规格维度 ${dimension.propertyName} 不支持自定义备注`);
      }
    }
  });

  const maxRows = Math.min(MAX_SKUS, context.rules.maxCombinations);
  if (target.rows.length === 0) errors.push('至少保留一个 SKU');
  if (target.rows.length > maxRows) errors.push(`SKU 数量不能超过 ${maxRows} 个`);

  const contextRows = new Map(context.rows.map((row) => [row.rowId, row]));
  const sourceOptions = new Set(context.sourceSkus.map((source) => source.sourceSpecId));
  const rowIds = new Set<string>();
  const platformSkuIds = new Set<string>();
  const platformSkuKeys = new Set<string>();
  const sourceSpecIds = new Set<string | null>();
  const combinations = new Set<string>();
  const valuesPerDimension = target.dimensions.map(() => new Set<string>());

  target.rows.forEach((row, rowIndex) => {
    const label = `第 ${rowIndex + 1} 个 SKU`;
    if (!row.rowId || rowIds.has(row.rowId)) errors.push(`${label} 的行标识无效或重复`);
    rowIds.add(row.rowId);

    const before = contextRows.get(row.rowId);
    if (before) {
      if (
        row.isNew ||
        row.platformSkuId !== before.platformSkuId ||
        row.platformSkuKey !== before.platformSkuKey
      ) {
        errors.push(`${label} 的平台 SKU ID 或稳定编码不能修改`);
      }
      if (row.priceCents !== before.priceCents) {
        errors.push(`${label} 的既有售价必须保持平台强回读值`);
      }
      if (!sameStringSet(row.skuPictureUrls, before.skuPictureUrls)) {
        errors.push(`${label} 的既有 SKU 图片不能在本次操作中修改`);
      }
    } else {
      if (!row.isNew) errors.push(`${label} 缺少新增 SKU 标记`);
      if (row.platformSkuId !== null || row.platformSkuKey !== null) {
        errors.push(`${label} 是新增 SKU，不能提交平台生成的 ID 或编码`);
      }
    }

    if (row.platformSkuId) {
      if (platformSkuIds.has(row.platformSkuId)) errors.push('平台 SKU ID 不能重复');
      platformSkuIds.add(row.platformSkuId);
    }
    if (row.platformSkuKey) {
      if (platformSkuKeys.has(row.platformSkuKey)) errors.push('平台 SKU 稳定编码不能重复');
      platformSkuKeys.add(row.platformSkuKey);
    }

    if (!sourceOptions.has(row.sourceSpecId)) errors.push(`${label} 未绑定有效的 1688 规格`);
    if (sourceSpecIds.has(row.sourceSpecId)) errors.push('每个 1688 规格只能绑定一个目标 SKU');
    sourceSpecIds.add(row.sourceSpecId);

    if (row.properties.length !== target.dimensions.length) {
      errors.push(`${label} 的规格值数量与维度不一致`);
      return;
    }
    const combination: string[] = [];
    row.properties.forEach((value, valueIndex) => {
      const dimension = target.dimensions[valueIndex];
      if (
        !dimension ||
        skuDimensionIdentity(value) !== skuDimensionIdentity(dimension) ||
        value.propertyName.trim() !== dimension?.propertyName.trim()
      ) {
        errors.push(`${label} 的规格维度与目标定义不一致`);
      }
      const valueError = validateSpecText(value.valueName, `${label} 的规格值`);
      if (valueError) errors.push(valueError);
      if (!value.valueId.trim()) errors.push(`${label} 的规格值缺少平台值 ID`);
      const remark = value.remark?.trim() ?? '';
      if (remark) {
        const remarkError = validateSpecText(remark, `${label} 的规格备注`);
        if (remarkError) errors.push(remarkError);
      }
      const key = `${value.valueId}:${value.valueName.trim()}:${remark}`;
      valuesPerDimension[valueIndex]?.add(key);
      combination.push(key);
    });
    const combinationKey = combination.join('|');
    if (combinations.has(combinationKey)) errors.push('SKU 规格组合不能重复');
    combinations.add(combinationKey);

    if (!before && !isValidPriceCents(row.priceCents)) {
      errors.push(`${label} 的新增售价无效`);
    }
    if (!before && context.rules.allSkuPicturesRequired && row.skuPictureUrls.length === 0) {
      errors.push(`${label} 所在类目要求提供 SKU 图片，当前编辑器暂不支持新增该 SKU`);
    }
  });

  valuesPerDimension.forEach((values, index) => {
    if (values.size > context.rules.maxValuesPerDimension) {
      errors.push(
        `${target.dimensions[index]?.propertyName || `维度 ${index + 1}`} 的规格值不能超过 ${context.rules.maxValuesPerDimension} 个`,
      );
    }
  });

  const summary = summarizeSkuChanges(context, target);
  if (summary.added + summary.changed + summary.deleted === 0) {
    errors.push('SKU 配置没有变化');
  }
  return [...new Set(errors)];
}

function skuRuleValueIdentity(value: { valueId: string; valueName: string }): string {
  return value.valueId === '0'
    ? JSON.stringify([value.valueId, value.valueName.trim()])
    : value.valueId;
}

export function summarizeSkuChanges(
  context: ProductBatchSkuEditContext,
  target: ProductBatchSkuTarget,
): SkuChangeSummary {
  const beforeRows = new Map(context.rows.map((row) => [row.rowId, row]));
  const targetRows = new Map(target.rows.map((row) => [row.rowId, row]));
  let added = 0;
  let changed = 0;
  for (const row of target.rows) {
    const before = beforeRows.get(row.rowId);
    if (!before) {
      added += 1;
      continue;
    }
    const beforeValues = before.properties.map(copyProperty);
    if (
      row.sourceSpecId !== before.sourceSpecId ||
      JSON.stringify(row.properties) !== JSON.stringify(beforeValues)
    ) {
      changed += 1;
    }
  }
  let deleted = 0;
  for (const row of context.rows) {
    if (!targetRows.has(row.rowId)) deleted += 1;
  }
  return { added, changed, deleted };
}

export function isValidPriceCents(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 100_000_000;
}

export function skuPriceInputToCents(value: string): number {
  const match = /^(\d{1,7})(?:\.(\d{0,2}))?$/.exec(value.trim());
  if (!match) return 0;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return isValidPriceCents(cents) ? cents : 0;
}

export function skuPriceCentsToInput(value: number): string {
  return isValidPriceCents(value) ? (value / 100).toFixed(2) : '';
}

function copyProperty(
  value: ProductBatchSkuValueTarget | ProductBatchSkuPropertyValue,
): ProductBatchSkuValueTarget {
  return {
    propertyId: value.propertyId,
    propertyName: value.propertyName,
    valueId: value.valueId,
    valueName: value.valueName,
    ...(value.remark ? { remark: value.remark } : {}),
  };
}

function cloneDimensions(dimensions: ProductBatchSkuDimension[]): ProductBatchSkuDimension[] {
  return dimensions.map((dimension) => ({
    propertyId: dimension.propertyId,
    propertyName: dimension.propertyName,
    values: dimension.values.map((value) => ({ ...value })),
  }));
}

function dimensionKey(dimension: ProductBatchSkuDimension): string {
  return skuDimensionIdentity(dimension);
}

function validateSpecText(value: string, label: string): string | null {
  const normalized = value.trim();
  if (!normalized) return `${label}不能为空`;
  if (normalized.length > MAX_TEXT_LENGTH) return `${label}不能超过 ${MAX_TEXT_LENGTH} 个字符`;
  if (FORBIDDEN_SPEC_TEXT.test(normalized)) return `${label}不能包含 |、,、^`;
  return null;
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
