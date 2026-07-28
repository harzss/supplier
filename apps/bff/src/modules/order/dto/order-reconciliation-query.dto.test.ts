import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { OrderReconciliationQueryDto } from './order-reconciliation-query.dto';

describe('OrderReconciliationQueryDto', () => {
  it('uses safe pagination defaults and converts query strings', async () => {
    const defaults = plainToInstance(OrderReconciliationQueryDto, {});
    const query = plainToInstance(OrderReconciliationQueryDto, { page: '2', pageSize: '50' });

    await expect(validate(defaults)).resolves.toHaveLength(0);
    await expect(validate(query)).resolves.toHaveLength(0);
    expect(defaults).toMatchObject({ page: 1, pageSize: 30 });
    expect(query).toMatchObject({ page: 2, pageSize: 50 });
  });

  it('rejects invalid pages and oversized requests', async () => {
    const invalidPage = plainToInstance(OrderReconciliationQueryDto, { page: '0' });
    const oversized = plainToInstance(OrderReconciliationQueryDto, { pageSize: '101' });

    expect(await validate(invalidPage)).not.toHaveLength(0);
    expect(await validate(oversized)).not.toHaveLength(0);
  });
});
