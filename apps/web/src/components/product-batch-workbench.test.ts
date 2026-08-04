import { describe, expect, it } from 'vitest';
import {
  candidateUnavailableReason,
  isCandidateSelectable,
  normalizeTargetPrice,
  normalizeTargetTitle,
  productBatchPreviewFingerprint,
  sameInventorySnapshot,
  shouldAcceptProductBatchPreviewResponse,
  summarizeInventorySnapshot,
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

  it('normalizes target titles using the platform 16 to 60 character-unit rule', () => {
    expect(normalizeTargetTitle('  夏季透气短袖上衣  ')).toEqual({
      value: '夏季透气短袖上衣',
      error: '',
    });
    expect(normalizeTargetTitle('   ')).toMatchObject({ value: null });
    expect(normalizeTargetTitle('好'.repeat(7))).toMatchObject({ value: null });
    expect(normalizeTargetTitle('a'.repeat(15))).toMatchObject({ value: null });
    expect(normalizeTargetTitle('好'.repeat(30))).toMatchObject({ value: '好'.repeat(30) });
    expect(normalizeTargetTitle('好'.repeat(31))).toMatchObject({ value: null });
    expect(normalizeTargetTitle('a'.repeat(60))).toMatchObject({ value: 'a'.repeat(60) });
    expect(normalizeTargetTitle('a'.repeat(61))).toMatchObject({ value: null });
    expect(normalizeTargetTitle('🙂'.repeat(8))).toMatchObject({ value: '🙂'.repeat(8) });
    expect(normalizeTargetTitle('短标题', 'taobao')).toMatchObject({ value: '短标题' });
    expect(normalizeTargetTitle('好'.repeat(31), 'pdd')).toMatchObject({ value: null });
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

  it('keeps inventory-sync fingerprints stable without a price rule', () => {
    const left = productBatchPreviewFingerprint({
      action: 'sync_inventory',
      publishedProductIds: ['2', '1'],
    });
    const right = productBatchPreviewFingerprint({
      action: 'sync_inventory',
      publishedProductIds: ['1', '2'],
    });
    const request = {
      clientRequestId: CLIENT_REQUEST_ID,
      action: 'sync_inventory' as const,
      publishedProductIds: ['2', '1'],
    };

    expect(left).toBe(right);
    expect(
      shouldAcceptProductBatchPreviewResponse(
        { fingerprint: left, clientRequestId: CLIENT_REQUEST_ID },
        request,
      ),
    ).toBe(true);
  });

  it('keeps title-edit fingerprints stable across selection order and rejects stale intent', () => {
    const left = productBatchPreviewFingerprint({
      action: 'edit_title',
      publishedProductIds: ['2', '1'],
      titleTargets: [
        { publishedProductId: '2', expectedMutationRevision: 4, targetTitle: '标题二' },
        { publishedProductId: '1', expectedMutationRevision: 3, targetTitle: '标题一' },
      ],
    });
    const request = {
      clientRequestId: CLIENT_REQUEST_ID,
      action: 'edit_title' as const,
      publishedProductIds: ['1', '2'],
      titleTargets: [
        { publishedProductId: '1', expectedMutationRevision: 3, targetTitle: '标题一' },
        { publishedProductId: '2', expectedMutationRevision: 4, targetTitle: '标题二' },
      ],
    };

    expect(left).toBe(
      productBatchPreviewFingerprint({
        action: request.action,
        publishedProductIds: request.publishedProductIds,
        titleTargets: request.titleTargets,
      }),
    );
    expect(
      shouldAcceptProductBatchPreviewResponse(
        { fingerprint: left, clientRequestId: CLIENT_REQUEST_ID },
        request,
      ),
    ).toBe(true);
    expect(
      shouldAcceptProductBatchPreviewResponse(
        { fingerprint: left, clientRequestId: CLIENT_REQUEST_ID },
        {
          ...request,
          titleTargets: [
            { publishedProductId: '1', expectedMutationRevision: 3, targetTitle: '已变化' },
            { publishedProductId: '2', expectedMutationRevision: 4, targetTitle: '标题二' },
          ],
        },
      ),
    ).toBe(false);
    expect(
      productBatchPreviewFingerprint({
        action: request.action,
        publishedProductIds: request.publishedProductIds,
        titleTargets: request.titleTargets.map((target) => ({
          ...target,
          expectedMutationRevision: target.expectedMutationRevision + 1,
        })),
      }),
    ).not.toBe(left);
  });

  it('selects only inventory-sync eligible products and surfaces the server reason', () => {
    const eligible = candidate('11', '可同步商品');
    const blocked = {
      ...candidate('12', '不可同步商品'),
      inventorySyncEligible: false,
      inventorySyncReason: '1688 货源 SKU 结构已变化，请先换源或下架商品',
    };

    expect(isCandidateSelectable(eligible, 'sync_inventory')).toBe(true);
    expect(isCandidateSelectable(blocked, 'sync_inventory')).toBe(false);
    expect(candidateUnavailableReason(blocked, 'sync_inventory')).toBe(blocked.inventorySyncReason);
  });

  it('selects only title-edit eligible products and surfaces the server reason', () => {
    const eligible = candidate('11', '可改标题商品');
    const blocked = {
      ...candidate('12', '不可改标题商品'),
      titleEditable: false,
      titleEditReason: '请先下架商品后再修改标题',
    };

    expect(isCandidateSelectable(eligible, 'edit_title')).toBe(true);
    expect(isCandidateSelectable(blocked, 'edit_title')).toBe(false);
    expect(candidateUnavailableReason(blocked, 'edit_title')).toBe(blocked.titleEditReason);
  });

  it('summarizes and compares authoritative inventory snapshots by SKU', () => {
    const snapshot = {
      version: 1 as const,
      items: [
        { sourceSkuId: 'sku-a', stock: 7 },
        { sourceSkuId: 'sku-b', stock: 13 },
      ],
    };

    expect(summarizeInventorySnapshot(snapshot)).toEqual({ totalStock: 20, skuCount: 2 });
    expect(
      sameInventorySnapshot(snapshot, {
        version: 1,
        items: [
          { sourceSkuId: 'sku-b', stock: 13 },
          { sourceSkuId: 'sku-a', stock: 7 },
        ],
      }),
    ).toBe(true);
    expect(
      sameInventorySnapshot(snapshot, {
        version: 1,
        items: [
          { sourceSkuId: 'sku-a', stock: 7 },
          { sourceSkuId: 'sku-b', stock: 12 },
        ],
      }),
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
      titleInputs: {},
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

  it('restores inventory-sync action and its eligibility snapshot', () => {
    const storage = new MemoryStorage();
    const inventorySession: ProductBatchWorkbenchSession = {
      ...session,
      draft: {
        ...session.draft,
        action: 'sync_inventory',
        targetInputs: {},
        selected: [candidate('11', '待同步库存商品')],
      },
    };

    expect(writeProductBatchWorkbenchSession(scope, inventorySession, storage)).toBe(true);
    expect(readProductBatchWorkbenchSession(scope, storage)).toEqual(inventorySession);
  });

  it('restores title-edit targets and the candidate eligibility snapshot', () => {
    const storage = new MemoryStorage();
    const titleSession: ProductBatchWorkbenchSession = {
      ...session,
      draft: {
        ...session.draft,
        action: 'edit_title',
        titleInputs: { '11': '新的商品标题' },
        targetInputs: {},
        selected: [candidate('11', '原商品标题')],
      },
    };

    expect(writeProductBatchWorkbenchSession(scope, titleSession, storage)).toBe(true);
    expect(readProductBatchWorkbenchSession(scope, storage)).toEqual(titleSession);
  });

  it.each(['offline', 'edit_price'] as const)(
    'migrates legacy v1 %s drafts without losing their preview identity',
    (action) => {
      const storage = new MemoryStorage();
      const key = productBatchWorkbenchStorageKey(scope);
      const preview = { ...session.preview!, taskId: '42' };
      const selected = legacyCandidate('11', '旧版会话商品');
      storage.setItem(
        key,
        JSON.stringify({
          version: 1,
          ...scope,
          draft: { ...session.draft, action, selected: [selected] },
          preview,
        }),
      );

      const restored = readProductBatchWorkbenchSession(scope, storage);

      expect(restored?.preview).toEqual(preview);
      expect(restored?.draft.selected).toEqual([
        {
          ...selected,
          sourceTotalStock: 0,
          sourceSkuCount: 0,
          sourceInventoryVersion: 0,
          syncedInventoryVersion: 0,
          inventoryLastSyncedAt: null,
          inventorySyncError: null,
          inventorySyncEligible: false,
          inventorySyncReason: '旧版会话缺少库存快照，请刷新商品后再同步库存',
          titleEditable: false,
          titleEditReason: '旧版会话缺少标题编辑状态，请刷新商品后再修改标题',
        },
      ]);
      expect(isCandidateSelectable(restored!.draft.selected[0]!, 'sync_inventory')).toBe(false);
    },
  );

  it('does not migrate legacy candidates into an inventory-sync draft', () => {
    const storage = new MemoryStorage();
    const key = productBatchWorkbenchStorageKey(scope);
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        ...scope,
        draft: {
          ...session.draft,
          action: 'sync_inventory',
          selected: [legacyCandidate('11', '旧版会话商品')],
        },
        preview: session.preview,
      }),
    );

    expect(readProductBatchWorkbenchSession(scope, storage)).toBeNull();
    expect(storage.getItem(key)).toBeNull();
  });

  it('does not migrate a candidate without title eligibility into a title-edit draft', () => {
    const storage = new MemoryStorage();
    const key = productBatchWorkbenchStorageKey(scope);
    const selected = candidate('11', '旧版标题商品') as Record<string, unknown>;
    delete selected.titleEditable;
    delete selected.titleEditReason;
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        ...scope,
        draft: {
          ...session.draft,
          action: 'edit_title',
          selected: [selected],
        },
        preview: session.preview,
      }),
    );

    expect(readProductBatchWorkbenchSession(scope, storage)).toBeNull();
    expect(storage.getItem(key)).toBeNull();
  });

  it('still rejects a partially populated or malformed current candidate', () => {
    const storage = new MemoryStorage();
    const key = productBatchWorkbenchStorageKey(scope);
    const partiallyPopulated = legacyCandidate('11', '字段不完整商品');
    partiallyPopulated.sourceTotalStock = 20;
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        ...scope,
        draft: { ...session.draft, selected: [partiallyPopulated] },
        preview: session.preview,
      }),
    );

    expect(readProductBatchWorkbenchSession(scope, storage)).toBeNull();
    expect(storage.getItem(key)).toBeNull();

    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        ...scope,
        draft: {
          ...session.draft,
          selected: [{ ...candidate('11', '字段错误商品'), sourceTotalStock: -1 }],
        },
        preview: session.preview,
      }),
    );

    expect(readProductBatchWorkbenchSession(scope, storage)).toBeNull();
    expect(storage.getItem(key)).toBeNull();
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
    titleEditable: true,
    titleEditReason: null,
    titleVerificationTaskId: null,
    titleVerificationItemId: null,
    priceEditable: true,
    priceEditReason: null,
    sourceProductId: `source-${publishedProductId}`,
    sourceAvailability: 'available',
    sourceTotalStock: 20,
    sourceSkuCount: 2,
    sourceInventoryVersion: 4,
    inventorySyncStatus: 'synced',
    syncedInventoryVersion: 3,
    inventoryLastSyncedAt: '2026-08-04T00:00:00.000Z',
    inventorySyncError: null,
    inventorySyncEligible: true,
    inventorySyncReason: null,
    mutationRevision: 2,
    publishedAt: '2026-08-04T00:00:00.000Z',
  };
}

function legacyCandidate(publishedProductId: string, title: string): Record<string, unknown> {
  const legacy: Record<string, unknown> = { ...candidate(publishedProductId, title) };
  for (const field of [
    'titleEditable',
    'titleEditReason',
    'sourceTotalStock',
    'sourceSkuCount',
    'sourceInventoryVersion',
    'syncedInventoryVersion',
    'inventoryLastSyncedAt',
    'inventorySyncError',
    'inventorySyncEligible',
    'inventorySyncReason',
  ]) {
    delete legacy[field];
  }
  return legacy;
}
