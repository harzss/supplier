import { describe, expect, it, vi } from 'vitest';
import { markPurchaseExceptionsForOrderEvent } from './purchase-exception';

describe('markPurchaseExceptionsForOrderEvent', () => {
  it('stops local purchases and flags created 1688 orders for manual action', async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 2 });

    await expect(
      markPurchaseExceptionsForOrderEvent(
        { purchaseOrder: { updateMany } } as never,
        5n,
        'refunded',
      ),
    ).resolves.toEqual({ stopped: 1, actionRequired: 2 });

    expect(updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          orderId: 5n,
          exceptionStatus: { in: ['none', 'resolved', 'stopped'] },
          orderId1688: null,
        }),
        data: expect.objectContaining({
          exceptionStatus: 'stopped',
          exceptionRevision: { increment: 1 },
          reconciledCost: null,
        }),
      }),
    );
    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          orderId: 5n,
          exceptionStatus: { in: ['none', 'resolved', 'action_required'] },
        }),
        data: expect.objectContaining({
          exceptionStatus: 'action_required',
          exceptionRevision: { increment: 1 },
          reconciledCost: null,
        }),
      }),
    );
  });

  it('stops local purchases and requires reconciliation only after remote creation', async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 2 });

    await expect(
      markPurchaseExceptionsForOrderEvent(
        { purchaseOrder: { updateMany } } as never,
        5n,
        'partial_refund',
      ),
    ).resolves.toEqual({ stopped: 1, actionRequired: 2 });

    expect(updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ orderId1688: null }),
        data: expect.objectContaining({
          exceptionStatus: 'stopped',
          exceptionRevision: { increment: 1 },
          reconciledCost: null,
        }),
      }),
    );
    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ orderId: 5n, OR: expect.any(Array) }),
        data: expect.objectContaining({
          exceptionStatus: 'action_required',
          exceptionRevision: { increment: 1 },
          reconciledCost: null,
        }),
      }),
    );
  });
});
