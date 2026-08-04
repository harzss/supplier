import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import {
  CreateSourceImportPreviewDto,
  RetrySourceImportDto,
  SOURCE_IMPORT_MAX_ITEMS,
} from './source-import.dto';

const CLIENT_REQUEST_ID = '8a4d5b1e-7d9a-4e60-9f81-3ce8f3f5a2d1';

describe('source import DTOs', () => {
  it.each([1, SOURCE_IMPORT_MAX_ITEMS])('accepts %i source references', async (count) => {
    const dto = plainToInstance(CreateSourceImportPreviewDto, {
      clientRequestId: CLIENT_REQUEST_ID,
      references: Array.from({ length: count }, (_, index) => String(index + 1)),
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it.each([0, SOURCE_IMPORT_MAX_ITEMS + 1])('rejects %i source references', async (count) => {
    const dto = plainToInstance(CreateSourceImportPreviewDto, {
      clientRequestId: CLIENT_REQUEST_ID,
      references: Array.from({ length: count }, (_, index) => String(index + 1)),
    });

    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rejects malformed UUIDs, blank references, and out-of-range buyer IDs', async () => {
    const dto = plainToInstance(CreateSourceImportPreviewDto, {
      clientRequestId: 'not-a-uuid',
      references: ['   '],
      buyerShopId: '9223372036854775808',
    });

    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('bounds explicitly selected retry items to signed Int64 IDs', async () => {
    const valid = plainToInstance(RetrySourceImportDto, { itemIds: ['1', '9223372036854775807'] });
    const invalid = plainToInstance(RetrySourceImportDto, {
      itemIds: ['0', '9223372036854775808'],
    });

    await expect(validate(valid)).resolves.toHaveLength(0);
    expect(await validate(invalid)).not.toHaveLength(0);
  });
});
