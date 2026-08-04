import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreateProductBatchPreviewDto, PRODUCT_BATCH_MAX_ITEMS } from './product-batch.dto';

describe('CreateProductBatchPreviewDto', () => {
  it('accepts a preview containing exactly 100 unique products', async () => {
    const dto = plainToInstance(CreateProductBatchPreviewDto, {
      clientRequestId: '8a4d5b1e-7d9a-4e60-9f81-3ce8f3f5a2d1',
      action: 'offline',
      publishedProductIds: Array.from({ length: PRODUCT_BATCH_MAX_ITEMS }, (_, index) =>
        String(index + 1),
      ),
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects a preview containing more than 100 products', async () => {
    const dto = plainToInstance(CreateProductBatchPreviewDto, {
      clientRequestId: '8a4d5b1e-7d9a-4e60-9f81-3ce8f3f5a2d1',
      action: 'offline',
      publishedProductIds: Array.from({ length: PRODUCT_BATCH_MAX_ITEMS + 1 }, (_, index) =>
        String(index + 1),
      ),
    });

    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('accepts a percentage price preview expressed in integer basis points', async () => {
    const dto = plainToInstance(CreateProductBatchPreviewDto, {
      clientRequestId: '8a4d5b1e-7d9a-4e60-9f81-3ce8f3f5a2d1',
      action: 'edit_price',
      publishedProductIds: ['1', '2'],
      priceRule: { mode: 'percentage', direction: 'increase', basisPoints: 1250 },
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('accepts exact per-product target start prices', async () => {
    const dto = plainToInstance(CreateProductBatchPreviewDto, {
      clientRequestId: '8a4d5b1e-7d9a-4e60-9f81-3ce8f3f5a2d1',
      action: 'edit_price',
      publishedProductIds: ['1', '2'],
      priceRule: {
        mode: 'targets',
        targets: [
          { publishedProductId: '1', targetStartPrice: '19.90' },
          { publishedProductId: '2', targetStartPrice: '29' },
        ],
      },
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('accepts an inventory-sync preview without a price rule', async () => {
    const dto = plainToInstance(CreateProductBatchPreviewDto, {
      clientRequestId: '8a4d5b1e-7d9a-4e60-9f81-3ce8f3f5a2d1',
      action: 'sync_inventory',
      publishedProductIds: ['1', '2'],
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('accepts an online preview without edit payloads', async () => {
    const dto = plainToInstance(CreateProductBatchPreviewDto, {
      clientRequestId: '8a4d5b1e-7d9a-4e60-9f81-3ce8f3f5a2d1',
      action: 'online',
      publishedProductIds: ['1', '2'],
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('accepts a slow-product cleanup preview without destructive options', async () => {
    const dto = plainToInstance(CreateProductBatchPreviewDto, {
      clientRequestId: '8a4d5b1e-7d9a-4e60-9f81-3ce8f3f5a2d1',
      action: 'cleanup',
      publishedProductIds: ['1', '2'],
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('accepts exact per-product offline source targets', async () => {
    const dto = plainToInstance(CreateProductBatchPreviewDto, {
      clientRequestId: '8a4d5b1e-7d9a-4e60-9f81-3ce8f3f5a2d1',
      action: 'change_source',
      publishedProductIds: ['1', '2'],
      sourceTargets: [
        {
          publishedProductId: '1',
          expectedMutationRevision: 3,
          targetSourceProductId: '673201001001',
        },
        {
          publishedProductId: '2',
          expectedMutationRevision: 7,
          targetSourceProductId: '673201001002',
        },
      ],
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('accepts exact per-product title targets', async () => {
    const dto = plainToInstance(CreateProductBatchPreviewDto, {
      clientRequestId: '8a4d5b1e-7d9a-4e60-9f81-3ce8f3f5a2d1',
      action: 'edit_title',
      publishedProductIds: ['1', '2'],
      titleTargets: [
        {
          publishedProductId: '1',
          expectedMutationRevision: 1,
          targetTitle: '夏季轻薄纯棉短袖上衣',
        },
        {
          publishedProductId: '2',
          expectedMutationRevision: 2,
          targetTitle: '通勤宽松纯棉圆领短袖',
        },
      ],
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it.each([
    ['missing targets', undefined],
    [
      'a blank title',
      [{ publishedProductId: '1', expectedMutationRevision: 1, targetTitle: '   ' }],
    ],
    [
      'a title over 60 characters',
      [{ publishedProductId: '1', expectedMutationRevision: 1, targetTitle: 'A'.repeat(61) }],
    ],
    [
      'a missing product revision',
      [{ publishedProductId: '1', targetTitle: '夏季轻薄纯棉短袖上衣' }],
    ],
  ])('rejects a title preview with %s', async (_label, titleTargets) => {
    const dto = plainToInstance(CreateProductBatchPreviewDto, {
      clientRequestId: '8a4d5b1e-7d9a-4e60-9f81-3ce8f3f5a2d1',
      action: 'edit_title',
      publishedProductIds: ['1'],
      titleTargets,
    });

    expect(await validate(dto)).not.toHaveLength(0);
  });

  it.each([
    ['missing targets', undefined],
    [
      'a missing product revision',
      [{ publishedProductId: '1', targetSourceProductId: '673201001001' }],
    ],
    [
      'a non-numeric offer ID',
      [
        {
          publishedProductId: '1',
          expectedMutationRevision: 1,
          targetSourceProductId: 'not-an-offer',
        },
      ],
    ],
    [
      'a zero offer ID',
      [
        {
          publishedProductId: '1',
          expectedMutationRevision: 1,
          targetSourceProductId: '0',
        },
      ],
    ],
  ])('rejects a source-change preview with %s', async (_label, sourceTargets) => {
    const dto = plainToInstance(CreateProductBatchPreviewDto, {
      clientRequestId: '8a4d5b1e-7d9a-4e60-9f81-3ce8f3f5a2d1',
      action: 'change_source',
      publishedProductIds: ['1'],
      sourceTargets,
    });

    expect(await validate(dto)).not.toHaveLength(0);
  });

  it.each([
    ['a missing percentage direction', { mode: 'percentage', basisPoints: 100 }],
    ['a fractional basis point', { mode: 'percentage', direction: 'increase', basisPoints: 10.5 }],
    [
      'a target with more than two decimals',
      {
        mode: 'targets',
        targets: [{ publishedProductId: '1', targetStartPrice: '19.999' }],
      },
    ],
  ])('rejects %s', async (_label, priceRule) => {
    const dto = plainToInstance(CreateProductBatchPreviewDto, {
      clientRequestId: '8a4d5b1e-7d9a-4e60-9f81-3ce8f3f5a2d1',
      action: 'edit_price',
      publishedProductIds: ['1'],
      priceRule,
    });

    expect(await validate(dto)).not.toHaveLength(0);
  });

  it.each([
    ['a duplicate product ID', { action: 'offline', publishedProductIds: ['1', '1'] }],
    ['an unsupported action', { action: 'delete', publishedProductIds: ['1'] }],
    ['a zero product ID', { action: 'offline', publishedProductIds: ['0'] }],
    ['a non-numeric product ID', { action: 'offline', publishedProductIds: ['not-an-id'] }],
    [
      'a product ID outside signed int64',
      { action: 'offline', publishedProductIds: ['9223372036854775808'] },
    ],
  ])('rejects %s', async (_label, payload) => {
    const dto = plainToInstance(CreateProductBatchPreviewDto, {
      clientRequestId: '8a4d5b1e-7d9a-4e60-9f81-3ce8f3f5a2d1',
      ...payload,
    });

    expect(await validate(dto)).not.toHaveLength(0);
  });
});
