import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ProductQueryDto } from './product-query.dto';

describe('ProductQueryDto', () => {
  it('accepts purchase prices with up to two decimal places', async () => {
    const query = plainToInstance(ProductQueryDto, { priceMin: '4.5', priceMax: '18.99' });

    await expect(validate(query)).resolves.toHaveLength(0);
    expect(query).toMatchObject({ priceMin: 4.5, priceMax: 18.99 });
  });

  it('rejects negative prices and values with more than two decimal places', async () => {
    const negative = plainToInstance(ProductQueryDto, { priceMin: '-1' });
    const tooPrecise = plainToInstance(ProductQueryDto, { priceMax: '18.999' });

    expect(await validate(negative)).not.toHaveLength(0);
    expect(await validate(tooPrecise)).not.toHaveLength(0);
  });
});
