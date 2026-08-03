import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { DeletePublishDraftDto, SavePublishDraftDto } from './publish-draft.dto';

describe('Publish draft DTOs', () => {
  it('accepts an incomplete draft with no target shops', async () => {
    const dto = plainToInstance(SavePublishDraftDto, {
      expectedRevision: 0,
      sourceProductId: '1688-1',
      targetShopIds: [],
      pricingStrategy: { mode: 'fixed_markup', markupRatio: 0.5 },
      aiOptions: { rewriteTitle: true },
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects invalid revisions and target shop ids', async () => {
    const dto = plainToInstance(SavePublishDraftDto, {
      expectedRevision: -1,
      sourceProductId: '1688-1',
      targetShopIds: ['9', '9', '9223372036854775808'],
    });

    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('requires the current request generation when updating an existing draft', async () => {
    const dto = plainToInstance(SavePublishDraftDto, {
      expectedRevision: 1,
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
    });

    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('transforms and validates the delete query revision', async () => {
    const dto = plainToInstance(DeletePublishDraftDto, {
      expectedRevision: '7',
      expectedClientRequestId: '8a4d5b1e-7d9a-4e60-9f81-3ce8f3f5a2d1',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.expectedRevision).toBe(7);
  });
});
