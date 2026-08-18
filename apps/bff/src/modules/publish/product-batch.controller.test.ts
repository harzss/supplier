import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../entitlement/user-context.service';
import { ProductBatchController } from './product-batch.controller';
import type { ProductBatchService, ProductSkuEditContext } from './product-batch.service';

const USER: CurrentUser = {
  userId: 1n,
  plan: 'pro',
  entitlementSource: 'internal_beta',
  accessStatus: 'active',
  entitlementRevision: 1,
};

describe('ProductBatchController', () => {
  it('returns the SKU context contract without reshaping current dimensions or full rules', async () => {
    const context = {
      publishedProductId: '11',
      dimensions: [
        {
          propertyId: 'color',
          propertyName: '颜色',
          values: [{ valueId: '0', valueName: '自定义', remark: '雾蓝' }],
        },
      ],
      rules: {
        dimensions: [
          { propertyId: 'color', required: true },
          { propertyId: 'material', required: false },
        ],
      },
    } as unknown as ProductSkuEditContext;
    const getSkuEditContext = vi.fn().mockResolvedValue(context);
    const controller = new ProductBatchController({
      getSkuEditContext,
    } as unknown as ProductBatchService);

    await expect(controller.skuEditContext(USER, '11')).resolves.toBe(context);
    expect(getSkuEditContext).toHaveBeenCalledWith(USER, '11');
  });
});
