import { describe, expect, it } from 'vitest';
import {
  normalizeTargetPrice,
  productBatchPreviewFingerprint,
  shouldAcceptProductBatchPreviewResponse,
  validatePercentageInput,
} from './product-batch-workbench';
import {
  clearProductBatchSessionForTask,
  productBatchWorkbenchStorageKey,
  readProductBatchWorkbenchSession,
  shouldRestoreProductBatchPreview,
  writeProductBatchWorkbenchSession,
  type ProductBatchSessionStorage,
  type ProductBatchWorkbenchSession,
} from './product-batch-session';

const CLIENT_REQUEST_ID = '83c85991-91f3-47c4-ac9b-6ef4c14bff87';

class MemoryStorage implements ProductBatchSessionStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe('product batch price inputs', () => {
  it('converts percentage input to integer basis points with direction limits', () => {
    expect(validatePercentageInput('10.25', 'increase')).toEqual({ value: 1025, error: '' });
    expect(validatePercentageInput('99.99', 'decrease')).toEqual({ value: 9999, error: '' });
    expect(validatePercentageInput('100', 'decrease')).toMatchObject({ value: null });
    expect(validatePercentageInput('1000.01', 'increase')).toMatchObject({ value: null });
  });

  it('normalizes target prices without floating point arithmetic', () => {
    expect(normalizeTargetPrice('0039.9')).toEqual({ value: '39.90', error: '' });
    expect(normalizeTargetPrice('0.01')).toEqual({ value: '0.01', error: '' });
    expect(normalizeTargetPrice('0')).toMatchObject({ value: null });
    expect(normalizeTargetPrice('1000000.01')).toMatchObject({ value: null });
  });

  it('keeps the idempotency fingerprint stable across selection and target order', () => {
    const left = productBatchPreviewFingerprint({
      action: 'edit_price',
      publishedProductIds: ['2', '1'],
      priceRule: {
        mode: 'targets',
        targets: [
          { publishedProductId: '2', targetStartPrice: '28.00' },
          { publishedProductId: '1', targetStartPrice: '18.00' },
        ],
      },
    });
    const right = productBatchPreviewFingerprint({
      action: 'edit_price',
      publishedProductIds: ['1', '2'],
      priceRule: {
        mode: 'targets',
        targets: [
          { publishedProductId: '1', targetStartPrice: '18.00' },
          { publishedProductId: '2', targetStartPrice: '28.00' },
        ],
      },
    });

    expect(left).toBe(right);
  });

  it('ignores a late preview response after the current request intent changed', () => {
    const request = {
      clientRequestId: CLIENT_REQUEST_ID,
      action: 'edit_price' as const,
      publishedProductIds: ['2', '1'],
      priceRule: {
        mode: 'percentage' as const,
        direction: 'increase' as const,
        basisPoints: 1000,
      },
    };
    const fingerprint = productBatchPreviewFingerprint({
      action: request.action,
      publishedProductIds: request.publishedProductIds,
      priceRule: request.priceRule,
    });

    expect(
      shouldAcceptProductBatchPreviewResponse(
        { fingerprint, clientRequestId: request.clientRequestId },
        request,
      ),
    ).toBe(true);
    expect(
      shouldAcceptProductBatchPreviewResponse(
        { fingerprint, clientRequestId: '1ae31db4-24c3-48c8-83e8-7d3897b2a982' },
        request,
      ),
    ).toBe(false);
    expect(
      shouldAcceptProductBatchPreviewResponse(
        { fingerprint: 'changed', clientRequestId: request.clientRequestId },
        request,
      ),
    ).toBe(false);
  });
});

describe('product batch workbench session recovery', () => {
  const scope = { accountId: 'user-a', pathname: '/published/batch' };
  const session: ProductBatchWorkbenchSession = {
    draft: {
      page: 3,
      status: 'online',
      searchInput: '夏季',
      query: '夏季',
      action: 'edit_price',
      priceMode: 'targets',
      priceDirection: 'decrease',
      percentageInput: '12.34',
      targetInputs: { '11': '39.90', '88': '58' },
      bulkTargetInput: '39.90',
      targetPage: 2,
      selected: [candidate('11', '第一页商品'), candidate('88', '第三页商品')],
    },
    preview: {
      fingerprint: 'same-preview',
      clientRequestId: CLIENT_REQUEST_ID,
    },
  };

  it('restores filters, cross-page selection, price targets, and the idempotency UUID', () => {
    const storage = new MemoryStorage();

    expect(writeProductBatchWorkbenchSession(scope, session, storage)).toBe(true);

    expect(readProductBatchWorkbenchSession(scope, storage)).toEqual(session);
  });

  it('isolates saved state by account and current pathname', () => {
    const storage = new MemoryStorage();
    writeProductBatchWorkbenchSession(scope, session, storage);

    expect(
      readProductBatchWorkbenchSession(
        { accountId: 'user-b', pathname: '/published/batch' },
        storage,
      ),
    ).toBeNull();
    expect(
      readProductBatchWorkbenchSession({ accountId: 'user-a', pathname: '/another-page' }, storage),
    ).toBeNull();
    expect(readProductBatchWorkbenchSession(scope, storage)).toEqual(session);
  });

  it('restores only the exact preview task while it is still awaiting confirmation', () => {
    const preview = { ...session.preview!, taskId: '42' };

    expect(
      shouldRestoreProductBatchPreview(preview, {
        taskId: '42',
        clientRequestId: CLIENT_REQUEST_ID,
        status: 'preview',
      }),
    ).toBe(true);
    expect(
      shouldRestoreProductBatchPreview(preview, {
        taskId: '42',
        clientRequestId: CLIENT_REQUEST_ID,
        status: 'succeeded',
      }),
    ).toBe(false);
    expect(
      shouldRestoreProductBatchPreview(preview, {
        taskId: '43',
        clientRequestId: CLIENT_REQUEST_ID,
        status: 'preview',
      }),
    ).toBe(false);
  });

  it('clears a completed or abandoned task only when it matches the saved preview', () => {
    const storage = new MemoryStorage();
    const saved = { ...session, preview: { ...session.preview!, taskId: '42' } };
    writeProductBatchWorkbenchSession(scope, saved, storage);

    expect(
      clearProductBatchSessionForTask(
        scope,
        { taskId: '41', clientRequestId: CLIENT_REQUEST_ID },
        storage,
      ),
    ).toBe(false);
    expect(readProductBatchWorkbenchSession(scope, storage)).toEqual(saved);
    expect(
      clearProductBatchSessionForTask(
        scope,
        { taskId: '42', clientRequestId: CLIENT_REQUEST_ID },
        storage,
      ),
    ).toBe(true);
    expect(readProductBatchWorkbenchSession(scope, storage)).toBeNull();
  });

  it('fails closed and removes malformed session data', () => {
    const storage = new MemoryStorage();
    const key = productBatchWorkbenchStorageKey(scope);
    storage.setItem(key, JSON.stringify({ ...session, version: 1, ...scope, draft: {} }));

    expect(readProductBatchWorkbenchSession(scope, storage)).toBeNull();
    expect(storage.getItem(key)).toBeNull();
  });
});

function candidate(publishedProductId: string, title: string) {
  return {
    publishedProductId,
    title,
    mainImage: null,
    shopId: '3',
    shopName: '演示店铺',
    platform: 'douyin',
    platformProductId: `platform-${publishedProductId}`,
    status: 'online',
    salePrice: 29.9,
    priceRange: [29.9, 49.9] as [number, number],
    skuCount: 2,
    priceEditable: true,
    priceEditReason: null,
    sourceProductId: `source-${publishedProductId}`,
    sourceAvailability: 'available',
    inventorySyncStatus: 'synced',
    mutationRevision: 2,
    publishedAt: '2026-08-04T00:00:00.000Z',
  };
}
