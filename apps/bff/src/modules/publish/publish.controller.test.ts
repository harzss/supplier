import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../entitlement/user-context.service';
import { AUDIT_ACTION } from '../observability/audit.decorator';
import { PublishController } from './publish.controller';
import type { PublishQueueService } from './publish-queue.service';
import type { PublishService } from './publish.service';

const USER: CurrentUser = { userId: 1n, plan: 'pro' };

describe('PublishController', () => {
  it('delegates preflight to the publish service without touching the queue', async () => {
    const dto = {
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
      pricingPreviewToken: 'preview-token',
    };
    const preflight = vi.fn().mockResolvedValue({ ready: true, checks: [] });
    const isEnabled = vi.fn();
    const controller = new PublishController(
      { preflight } as unknown as PublishService,
      { isEnabled } as unknown as PublishQueueService,
    );

    await expect(controller.preflight(USER, dto)).resolves.toEqual({ ready: true, checks: [] });
    expect(preflight).toHaveBeenCalledWith(USER, dto);
    expect(isEnabled).not.toHaveBeenCalled();
  });

  it('delegates client request recovery to the current-user service lookup', async () => {
    const detailByClientRequestId = vi.fn().mockResolvedValue({ taskId: '17' });
    const controller = new PublishController(
      { detailByClientRequestId } as unknown as PublishService,
      {} as PublishQueueService,
    );
    const clientRequestId = '8a4d5b1e-7d9a-4e60-9f81-3ce8f3f5a2d1';

    await expect(controller.detailByClientRequestId(USER, clientRequestId)).resolves.toEqual({
      taskId: '17',
    });
    expect(detailByClientRequestId).toHaveBeenCalledWith(USER, clientRequestId);
  });

  it('records pricing preview as an activation audit action', () => {
    expect(Reflect.getMetadata(AUDIT_ACTION, PublishController.prototype.pricingPreview)).toEqual({
      action: 'publish.pricing.preview',
      resourceType: 'source_product',
    });
  });
});
