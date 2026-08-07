import { describe, expect, it } from 'vitest';
import type { ProductBatchSkuEditContext } from '@/lib/api';
import {
  appendSkuDimension,
  createNewSkuRow,
  createSkuTarget,
  deriveSkuTargetDimensions,
  nextAvailableSkuDimension,
  skuCustomValueInputText,
  summarizeSkuChanges,
  updateSkuCustomValueInput,
  validateSkuTarget,
} from './sku-edit-draft';

function context(): ProductBatchSkuEditContext {
  return {
    publishedProductId: '9',
    expectedMutationRevision: 3,
    expectedPlatformSkuFingerprint: 'a'.repeat(64),
    expectedRuleFingerprint: 'b'.repeat(64),
    editable: true,
    blockers: [],
    dimensions: [
      {
        propertyId: '100',
        propertyName: '颜色',
        values: [
          { valueId: '101', valueName: '白色' },
          { valueId: '102', valueName: '黑色' },
        ],
      },
    ],
    rows: [
      {
        rowId: 'existing:sku-1',
        platformSkuId: 'sku-1',
        platformSkuKey: 'stable-white',
        sourceSpecId: 'spec-white',
        properties: [
          {
            propertyId: '100',
            propertyName: '颜色',
            valueId: '101',
            valueName: '白色',
            remark: null,
          },
        ],
        priceCents: 1990,
        stock: 8,
        isNew: false,
        skuPictureUrls: [],
      },
    ],
    sourceSkus: [
      {
        sourceSpecId: 'spec-white',
        sourceSpecName: '白色',
        costPrice: 8,
        stock: 8,
        usedByPlatformSkuKey: 'stable-white',
      },
      {
        sourceSpecId: 'spec-black',
        sourceSpecName: '黑色',
        costPrice: 8.5,
        stock: 5,
        usedByPlatformSkuKey: null,
      },
    ],
    rules: {
      maxDimensions: 3,
      maxCombinations: 100,
      maxValuesPerDimension: 20,
      supportsDimensionReordering: true,
      supportsCustomDimensions: false,
      allSkuPicturesRequired: false,
      unsupportedReasons: [],
      dimensions: [
        {
          propertyId: '100',
          propertyName: '颜色',
          required: true,
          supportsCustomValues: false,
          supportsRemark: false,
          requiresPagedValues: false,
          values: [
            { valueId: '101', valueName: '白色' },
            { valueId: '102', valueName: '黑色' },
          ],
          unsupportedReasons: [],
        },
      ],
    },
  };
}

describe('SKU edit draft', () => {
  it('creates an immutable-identity target from the platform context', () => {
    const target = createSkuTarget(context());

    expect(target.rows).toEqual([
      expect.objectContaining({
        isNew: false,
        platformSkuId: 'sku-1',
        platformSkuKey: 'stable-white',
        sourceSpecId: 'spec-white',
        priceCents: 1990,
      }),
    ]);
    expect(summarizeSkuChanges(context(), target)).toEqual({ added: 0, changed: 0, deleted: 0 });
  });

  it('accepts a new source-bound SKU with an explicit price', () => {
    const fixture = context();
    const target = createSkuTarget(fixture);
    const added = {
      ...createNewSkuRow(target, 'spec-black'),
      properties: [
        {
          propertyId: '100',
          propertyName: '颜色',
          valueId: '102',
          valueName: '黑色',
        },
      ],
      priceCents: 2190,
    };
    const next = deriveSkuTargetDimensions({ ...target, rows: [...target.rows, added] });

    expect(validateSkuTarget(fixture, next)).toEqual([]);
    expect(summarizeSkuChanges(fixture, next)).toEqual({ added: 1, changed: 0, deleted: 0 });
    expect(next.dimensions[0]?.values).toEqual([
      { valueId: '101', valueName: '白色' },
      { valueId: '102', valueName: '黑色' },
    ]);
  });

  it('keeps new row IDs stable and unique after a row is remapped', () => {
    const target = createSkuTarget(context());
    const first = createNewSkuRow(target, 'spec-black');
    const remapped = { ...first, sourceSpecId: 'spec-another' };
    const second = createNewSkuRow({ ...target, rows: [...target.rows, remapped] }, 'spec-black');

    expect(first.rowId).toBe('new:spec-black');
    expect(remapped.rowId).toBe('new:spec-black');
    expect(second.rowId).toBe('new:spec-black:2');
  });

  it('round-trips custom value ID zero through remark without changing its platform name', () => {
    const custom = {
      propertyId: '100',
      propertyName: '颜色',
      valueId: '0',
      valueName: '其他',
      remark: '定制蓝',
    };

    expect(skuCustomValueInputText(custom, true)).toBe('定制蓝');
    expect(updateSkuCustomValueInput(custom, '定制蓝', true)).toEqual(custom);
    expect(updateSkuCustomValueInput(custom, '月白', true)).toEqual({
      ...custom,
      remark: '月白',
    });
    expect(
      updateSkuCustomValueInput(
        { ...custom, valueId: '', valueName: '', remark: undefined },
        '雾蓝',
        true,
      ),
    ).toEqual({
      propertyId: '100',
      propertyName: '颜色',
      valueId: '0',
      valueName: '其他',
      remark: '雾蓝',
    });
  });

  it('keeps two custom dimensions with property ID zero distinct by name and order', () => {
    const fixture = context();
    fixture.dimensions = [
      {
        propertyId: '0',
        propertyName: '颜色',
        values: [{ valueId: '0', valueName: '其他', remark: '雾蓝' }],
      },
      {
        propertyId: '0',
        propertyName: '尺码',
        values: [{ valueId: '0', valueName: '其他', remark: '定制码' }],
      },
    ];
    fixture.rows[0]!.properties = [
      { propertyId: '0', propertyName: '颜色', valueId: '0', valueName: '其他', remark: '雾蓝' },
      { propertyId: '0', propertyName: '尺码', valueId: '0', valueName: '其他', remark: '定制码' },
    ];
    fixture.rules.supportsCustomDimensions = true;
    fixture.rules.dimensions = [];
    const target = createSkuTarget(fixture);
    const remapped = {
      ...target,
      rows: [{ ...target.rows[0]!, sourceSpecId: 'spec-black' }],
    };

    expect(validateSkuTarget(fixture, deriveSkuTargetDimensions(remapped))).toEqual([]);
    expect(deriveSkuTargetDimensions(remapped).dimensions).toEqual(fixture.dimensions);
  });

  it('does not collapse multiple official value ID zero entries by ID alone', () => {
    const fixture = context();
    fixture.dimensions[0]!.values = [
      { valueId: '0', valueName: '其他', remark: '雾蓝' },
      { valueId: '0', valueName: '定制', remark: '月白' },
    ];
    fixture.rows[0]!.properties = [
      {
        propertyId: '100',
        propertyName: '颜色',
        valueId: '0',
        valueName: '其他',
        remark: '雾蓝',
      },
    ];
    fixture.rules.dimensions[0]!.supportsCustomValues = false;
    fixture.rules.dimensions[0]!.supportsRemark = true;
    fixture.rules.dimensions[0]!.values = [
      { valueId: '0', valueName: '其他' },
      { valueId: '0', valueName: '定制' },
    ];
    const target = createSkuTarget(fixture);
    const remapped = {
      ...target,
      rows: [{ ...target.rows[0]!, sourceSpecId: 'spec-black' }],
    };

    expect(validateSkuTarget(fixture, deriveSkuTargetDimensions(remapped))).toEqual([]);
  });

  it('adds uniquely named custom dimensions with editable value ID zero cells', () => {
    const fixture = context();
    fixture.rules.dimensions = [];
    fixture.rules.supportsCustomDimensions = true;
    const target = createSkuTarget(fixture);
    const first = nextAvailableSkuDimension(fixture, target);

    expect(first).toEqual({ propertyId: '0', propertyName: '自定义规格 1', values: [] });
    const withFirst = appendSkuDimension(target, first!);
    expect(withFirst.rows[0]?.properties.at(-1)).toEqual({
      propertyId: '0',
      propertyName: '自定义规格 1',
      valueId: '0',
      valueName: '',
    });
    expect(nextAvailableSkuDimension(fixture, withFirst)).toEqual({
      propertyId: '0',
      propertyName: '自定义规格 2',
      values: [],
    });
  });

  it('counts a remap and a deletion without mutating platform identity', () => {
    const fixture = context();
    const target = createSkuTarget(fixture);
    const changed = {
      ...target,
      rows: [{ ...target.rows[0]!, sourceSpecId: 'spec-black' }],
    };

    expect(summarizeSkuChanges(fixture, changed)).toEqual({ added: 0, changed: 1, deleted: 0 });
    expect(summarizeSkuChanges(fixture, { ...target, rows: [] })).toEqual({
      added: 0,
      changed: 0,
      deleted: 1,
    });
  });

  it('rejects platform identity edits, duplicate routes, invalid prices, and an empty set', () => {
    const fixture = context();
    const target = createSkuTarget(fixture);
    const newRow = {
      ...createNewSkuRow(target, 'spec-white'),
      properties: target.rows[0]!.properties,
      priceCents: 0,
    };
    const errors = validateSkuTarget(fixture, {
      ...target,
      rows: [{ ...target.rows[0]!, platformSkuId: 'changed' }, newRow],
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('平台 SKU ID'),
        expect.stringContaining('1688 规格只能绑定一个'),
        expect.stringContaining('新增售价无效'),
        expect.stringContaining('SKU 规格组合不能重复'),
      ]),
    );
    expect(validateSkuTarget(fixture, { ...target, rows: [] })).toContain('至少保留一个 SKU');
  });

  it('fails closed when the context or official rules contain blockers', () => {
    const fixture = context();
    fixture.editable = false;
    fixture.blockers = ['商品仍在线'];
    fixture.rules.unsupportedReasons = ['商品使用阶梯库存'];
    const target = createSkuTarget(fixture);

    expect(validateSkuTarget(fixture, target)).toEqual(
      expect.arrayContaining(['商品仍在线', '商品使用阶梯库存']),
    );
  });
});
