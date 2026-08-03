import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import {
  CreatePublishTaskDto,
  MAX_PUBLISH_TARGET_SHOPS,
  MAX_SOURCE_PRODUCT_ID_LENGTH,
} from './create-publish-task.dto';

describe('CreatePublishTaskDto', () => {
  it('accepts an optional UUID client request id', async () => {
    const dto = plainToInstance(CreatePublishTaskDto, {
      clientRequestId: '8a4d5b1e-7d9a-4e60-9f81-3ce8f3f5a2d1',
      pricingPreviewToken: 'preview-token',
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects a non-UUID client request id', async () => {
    const dto = plainToInstance(CreatePublishTaskDto, {
      clientRequestId: 'publish-click-1',
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
    });

    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rejects an oversized pricing preview receipt', async () => {
    const dto = plainToInstance(CreatePublishTaskDto, {
      pricingPreviewToken: 'x'.repeat(4097),
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
    });

    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rejects an oversized source product id', async () => {
    const dto = plainToInstance(CreatePublishTaskDto, {
      sourceProductId: 'x'.repeat(MAX_SOURCE_PRODUCT_ID_LENGTH + 1),
      targetShopIds: ['9'],
    });

    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rejects more than the maximum number of publish targets', async () => {
    const dto = plainToInstance(CreatePublishTaskDto, {
      sourceProductId: '1688-1',
      targetShopIds: Array.from({ length: MAX_PUBLISH_TARGET_SHOPS + 1 }, (_, index) =>
        String(index + 1),
      ),
    });

    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rejects a target id above the signed 64-bit database limit', async () => {
    const dto = plainToInstance(CreatePublishTaskDto, {
      sourceProductId: '1688-1',
      targetShopIds: ['9223372036854775808'],
    });

    expect(await validate(dto)).not.toHaveLength(0);
  });
});
