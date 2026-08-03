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

  it.each([
    ['a duplicate product ID', { action: 'offline', publishedProductIds: ['1', '1'] }],
    ['an unsupported action', { action: 'online', publishedProductIds: ['1'] }],
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
