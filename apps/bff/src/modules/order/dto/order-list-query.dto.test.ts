import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { OrderListQueryDto } from './order-list-query.dto';

describe('OrderListQueryDto', () => {
  it('uses defaults and accepts supported filters', async () => {
    const defaults = plainToInstance(OrderListQueryDto, {});
    const query = plainToInstance(OrderListQueryDto, {
      page: '2',
      pageSize: '50',
      shopId: '9',
      status: 'shipped',
    });

    await expect(validate(defaults)).resolves.toHaveLength(0);
    await expect(validate(query)).resolves.toHaveLength(0);
    expect(defaults).toMatchObject({ page: 1, pageSize: 30 });
    expect(query).toMatchObject({ page: 2, pageSize: 50, shopId: '9', status: 'shipped' });
  });

  it('rejects unsupported statuses and invalid shop IDs', async () => {
    const invalidStatus = plainToInstance(OrderListQueryDto, { status: 'unknown' });
    const invalidShopId = plainToInstance(OrderListQueryDto, { shopId: '0' });

    expect(await validate(invalidStatus)).not.toHaveLength(0);
    expect(await validate(invalidShopId)).not.toHaveLength(0);
  });
});
