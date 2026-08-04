import { describe, expect, it } from 'vitest';
import type { ProductBatchCandidate, ProductBatchCleanupEvidence } from '../lib/api';
import {
  candidateUnavailableReason,
  isCandidateSelectable,
  normalizeTargetPrice,
  normalizeTargetSource,
  normalizeTargetTitle,
  productBatchPreviewFingerprint,
  requiresProductBatchOfflineVerification,
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

  it('accepts only non-zero numeric 1688 offer IDs', () => {
    expect(normalizeTargetSource(' 673201001001 ')).toEqual({
      value: '673201001001',
      error: '',
    });
    expect(normalizeTargetSource('')).toMatchObject({ value: null });
    expect(normalizeTargetSource('0')).toMatchObject({ value: null });
    expect(normalizeTargetSource('0123')).toMatchObject({ value: null });
    expect(normalizeTargetSource('offer-123')).toMatchObject({ value: null });
    expect(normalizeTargetSource('1'.repeat(33))).toMatchObject({ value: null });
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

  it('keeps online fingerprints stable and accepts only the matching request intent', () => {
    const left = productBatchPreviewFingerprint({
      action: 'online',
      publishedProductIds: ['2', '1'],
    });
    const request = {
      clientRequestId: CLIENT_REQUEST_ID,
      action: 'online' as const,
      publishedProductIds: ['1', '2'],
    };

    expect(left).toBe(
      productBatchPreviewFingerprint({ action: 'online', publishedProductIds: ['1', '2'] }),
    );
    expect(
      shouldAcceptProductBatchPreviewResponse(
        { fingerprint: left, clientRequestId: CLIENT_REQUEST_ID },
        request,
      ),
    ).toBe(true);
  });

  it('keeps cleanup fingerprints stable and rejects a late response from another action', () => {
    const left = productBatchPreviewFingerprint({
      action: 'cleanup',
      publishedProductIds: ['2', '1'],
    });
    const request = {
      clientRequestId: CLIENT_REQUEST_ID,
      action: 'cleanup' as const,
      publishedProductIds: ['1', '2'],
    };

    expect(left).toBe(
      productBatchPreviewFingerprint({ action: 'cleanup', publishedProductIds: ['1', '2'] }),
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
        { ...request, action: 'offline' as const },
      ),
    ).toBe(false);
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

  it('includes ordered source targets and frozen revisions in source-change fingerprints', () => {
    const sourceTargets = [
      {
        publishedProductId: '2',
        expectedMutationRevision: 4,
        targetSourceProductId: '673201001002',
      },
      {
        publishedProductId: '1',
        expectedMutationRevision: 3,
        targetSourceProductId: '673201001001',
      },
    ];
    const left = productBatchPreviewFingerprint({
      action: 'change_source',
      publishedProductIds: ['2', '1'],
      sourceTargets,
    });
    const request = {
      clientRequestId: CLIENT_REQUEST_ID,
      action: 'change_source' as const,
      publishedProductIds: ['1', '2'],
      sourceTargets: [...sourceTargets].reverse(),
    };

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
          sourceTargets: request.sourceTargets.map((target, index) =>
            index === 0 ? { ...target, targetSourceProductId: '673201009999' } : target,
          ),
        },
      ),
    ).toBe(false);
    expect(
      productBatchPreviewFingerprint({
        action: 'change_source',
        publishedProductIds: request.publishedProductIds,
        sourceTargets: request.sourceTargets.map((target) => ({
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

  it('selects only server-approved online candidates and surfaces verification fences', () => {
    const eligible = {
      ...candidate('11', '可上架商品'),
      status: 'offline',
      onlineEligible: true,
      onlineReason: null,
      cleanupEligible: false,
      cleanupReason: '只有在线商品可以进入滞销安全下架',
    };
    const blocked = {
      ...candidate('12', '待核验商品'),
      status: 'offline',
      onlineEligible: false,
      onlineReason: '上一次上架结果未知，请先核验平台状态与库存',
      onlineVerificationTaskId: '41',
      onlineVerificationItemId: '52',
    };
    const malformedType = {
      ...eligible,
      onlineEligible: 'true',
    } as unknown as ProductBatchCandidate;
    const conflictingReason = {
      ...eligible,
      onlineReason: '后端同时返回允许与阻止上架',
    } as ProductBatchCandidate;
    const staleVerification = {
      ...eligible,
      onlineVerificationTaskId: '41',
      onlineVerificationItemId: '52',
    } as ProductBatchCandidate;
    const incompleteVerification = {
      ...blocked,
      onlineVerificationItemId: null,
    } as ProductBatchCandidate;
    const wrongStatus = {
      ...eligible,
      status: 'online',
    } as ProductBatchCandidate;

    expect(isCandidateSelectable(eligible, 'online')).toBe(true);
    expect(isCandidateSelectable(blocked, 'online')).toBe(false);
    expect(candidateUnavailableReason(blocked, 'online')).toBe(blocked.onlineReason);
    for (const malformed of [
      malformedType,
      conflictingReason,
      staleVerification,
      incompleteVerification,
      wrongStatus,
    ]) {
      expect(isCandidateSelectable(malformed, 'online')).toBe(false);
      expect(candidateUnavailableReason(malformed, 'online')).toBe(
        '商品上架安全状态异常，请刷新商品后再操作',
      );
    }
  });

  it('selects only cleanup candidates with complete server evidence', () => {
    const eligible = candidate('11', '可清理商品');
    const blocked = {
      ...candidate('12', '不可清理商品'),
      cleanupEligible: false,
      cleanupReason: '近 30 天已有 2 笔有效订单',
      cleanupEvidence: {
        ...cleanupEvidence(),
        validOrderCount: 2,
        lastPaidAt: '2026-08-03T08:00:00.000Z',
      },
    };
    const malformed = {
      ...eligible,
      cleanupEvidence: null,
    } as ProductBatchCandidate;

    expect(isCandidateSelectable(eligible, 'cleanup')).toBe(true);
    expect(candidateUnavailableReason(eligible, 'cleanup')).toBeNull();
    expect(isCandidateSelectable(blocked, 'cleanup')).toBe(false);
    expect(candidateUnavailableReason(blocked, 'cleanup')).toBe(blocked.cleanupReason);
    expect(isCandidateSelectable(malformed, 'cleanup')).toBe(false);
    expect(candidateUnavailableReason(malformed, 'cleanup')).toBe(
      '商品清理证据异常，请刷新商品后再操作',
    );
  });

  it('selects only offline server-approved source-change candidates', () => {
    const eligible = {
      ...candidate('11', '可换源商品'),
      status: 'offline',
      sourceChangeEligible: true,
      sourceChangeReason: null,
      currentSourceRouteCount: 2,
    };
    const blocked = {
      ...candidate('12', '不可换源商品'),
      status: 'offline',
      sourceChangeEligible: false,
      sourceChangeReason: '商品当前货源绑定缺失或重复，不能安全换源',
    };
    const inconsistent = {
      ...eligible,
      status: 'online',
    } as ProductBatchCandidate;
    const missingRoutes = {
      ...eligible,
      currentSourceRouteCount: 0,
    } as ProductBatchCandidate;

    expect(isCandidateSelectable(eligible, 'change_source')).toBe(true);
    expect(candidateUnavailableReason(eligible, 'change_source')).toBeNull();
    expect(isCandidateSelectable(blocked, 'change_source')).toBe(false);
    expect(candidateUnavailableReason(blocked, 'change_source')).toBe(blocked.sourceChangeReason);
    expect(isCandidateSelectable(inconsistent, 'change_source')).toBe(false);
    expect(candidateUnavailableReason(inconsistent, 'change_source')).toBe(
      '商品换源安全状态异常，请刷新商品后再操作',
    );
    expect(isCandidateSelectable(missingRoutes, 'change_source')).toBe(false);
    expect(candidateUnavailableReason(missingRoutes, 'change_source')).toBe(
      '商品换源安全状态异常，请刷新商品后再操作',
    );
  });

  it('blocks every product mutation while an offline result awaits verification', () => {
    const fenced = {
      ...candidate('11', '待核验下架商品'),
      cleanupEligible: false,
      cleanupReason: '上一次下架结果未知，请先核验平台状态',
      offlineVerificationTaskId: '41',
      offlineVerificationItemId: '52',
    };

    for (const action of [
      'online',
      'offline',
      'edit_title',
      'edit_price',
      'sync_inventory',
      'change_source',
      'cleanup',
    ] as const) {
      expect(isCandidateSelectable(fenced, action)).toBe(false);
      expect(candidateUnavailableReason(fenced, action)).toContain('核验');
    }
  });

  it('requires platform verification for unknown offline writes in both offline flows', () => {
    for (const action of ['offline', 'cleanup'] as const) {
      expect(
        requiresProductBatchOfflineVerification(action, 'failed', 'OFFLINE_WRITE_STARTED'),
      ).toBe(true);
      expect(
        requiresProductBatchOfflineVerification(action, 'failed', 'OFFLINE_RESULT_UNKNOWN'),
      ).toBe(true);
      expect(
        requiresProductBatchOfflineVerification(action, 'succeeded', 'OFFLINE_RESULT_UNKNOWN'),
      ).toBe(false);
    }
    expect(
      requiresProductBatchOfflineVerification('online', 'failed', 'OFFLINE_RESULT_UNKNOWN'),
    ).toBe(false);
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
      sourceTargetInputs: {},
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

  it('restores online action with its frozen eligibility and verification fields', () => {
    const storage = new MemoryStorage();
    const selected = {
      ...candidate('11', '待恢复上架商品'),
      status: 'offline',
      onlineEligible: true,
      onlineReason: null,
      cleanupEligible: false,
      cleanupReason: '只有在线商品可以进入滞销安全下架',
    };
    const onlineSession: ProductBatchWorkbenchSession = {
      ...session,
      draft: {
        ...session.draft,
        status: 'offline',
        action: 'online',
        targetInputs: {},
        selected: [selected],
      },
    };

    expect(writeProductBatchWorkbenchSession(scope, onlineSession, storage)).toBe(true);
    expect(readProductBatchWorkbenchSession(scope, storage)).toEqual(onlineSession);
  });

  it('restores cleanup only with its frozen eligibility and evidence', () => {
    const storage = new MemoryStorage();
    const cleanupSession: ProductBatchWorkbenchSession = {
      ...session,
      draft: {
        ...session.draft,
        status: 'online',
        action: 'cleanup',
        targetInputs: {},
        selected: [candidate('11', '待安全下架商品')],
      },
    };

    expect(writeProductBatchWorkbenchSession(scope, cleanupSession, storage)).toBe(true);
    expect(readProductBatchWorkbenchSession(scope, storage)).toEqual(cleanupSession);
  });

  it('restores an offline source-change draft with frozen eligibility and numeric offer inputs', () => {
    const storage = new MemoryStorage();
    const selected = {
      ...candidate('11', '待换源商品'),
      status: 'offline',
      cleanupEligible: false,
      cleanupReason: '只有在线商品可以进入滞销安全下架',
      sourceChangeEligible: true,
      sourceChangeReason: null,
      currentSourceRouteCount: 2,
    };
    const sourceChangeSession: ProductBatchWorkbenchSession = {
      ...session,
      draft: {
        ...session.draft,
        status: 'offline',
        action: 'change_source',
        targetInputs: {},
        sourceTargetInputs: { '11': '673201001001' },
        selected: [selected],
      },
    };

    expect(writeProductBatchWorkbenchSession(scope, sourceChangeSession, storage)).toBe(true);
    expect(readProductBatchWorkbenchSession(scope, storage)).toEqual(sourceChangeSession);
  });

  it('fails closed for malformed or incomplete source-change recovery state', () => {
    const storage = new MemoryStorage();
    const key = productBatchWorkbenchStorageKey(scope);
    const eligible = {
      ...candidate('11', '待换源商品'),
      status: 'offline',
      cleanupEligible: false,
      cleanupReason: '只有在线商品可以进入滞销安全下架',
      sourceChangeEligible: true,
      sourceChangeReason: null,
      currentSourceRouteCount: 2,
    };
    const drafts = [
      {
        ...session.draft,
        status: 'offline',
        action: 'change_source',
        sourceTargetInputs: undefined,
        selected: [eligible],
      },
      {
        ...session.draft,
        status: 'online',
        action: 'change_source',
        sourceTargetInputs: { '11': '673201001001' },
        selected: [eligible],
      },
      {
        ...session.draft,
        status: 'offline',
        action: 'change_source',
        sourceTargetInputs: { '11': 'offer-673201001001' },
        selected: [eligible],
      },
      {
        ...session.draft,
        status: 'offline',
        action: 'change_source',
        sourceTargetInputs: { '11': '673201001001' },
        selected: [{ ...eligible, sourceChangeReason: '资格字段冲突' }],
      },
      {
        ...session.draft,
        status: 'offline',
        action: 'change_source',
        sourceTargetInputs: { '11': '673201001001' },
        selected: [{ ...eligible, currentSourceRouteCount: 0 }],
      },
    ];

    for (const draft of drafts) {
      storage.setItem(
        key,
        JSON.stringify({ version: 1, ...scope, draft, preview: session.preview }),
      );
      expect(readProductBatchWorkbenchSession(scope, storage)).toBeNull();
      expect(storage.getItem(key)).toBeNull();
    }
  });

  it('migrates a legacy v1 edit_price draft without losing its preview identity', () => {
    const storage = new MemoryStorage();
    const key = productBatchWorkbenchStorageKey(scope);
    const preview = { ...session.preview!, taskId: '42' };
    const selected = legacyCandidate('11', '旧版会话商品');
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        ...scope,
        draft: { ...session.draft, action: 'edit_price', selected: [selected] },
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
        onlineEligible: false,
        onlineReason: '旧版会话缺少安全上架状态，请刷新商品后再上架',
        onlineVerificationTaskId: null,
        onlineVerificationItemId: null,
        offlineVerificationTaskId: null,
        offlineVerificationItemId: null,
        cleanupEligible: false,
        cleanupReason: '旧版会话缺少滞销清理证据，请刷新商品后再操作',
        cleanupEvidence: null,
        sourceChangeEligible: false,
        sourceChangeReason: '旧版会话缺少安全换源状态，请刷新商品后再操作',
        currentSourceRouteCount: 0,
      },
    ]);
    expect(isCandidateSelectable(restored!.draft.selected[0]!, 'sync_inventory')).toBe(false);
  });

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

  it('does not migrate a legacy candidate without safety fields into an online draft', () => {
    const storage = new MemoryStorage();
    const key = productBatchWorkbenchStorageKey(scope);
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        ...scope,
        draft: {
          ...session.draft,
          status: 'offline',
          action: 'online',
          selected: [legacyCandidate('11', '旧版上架商品')],
        },
        preview: session.preview,
      }),
    );

    expect(readProductBatchWorkbenchSession(scope, storage)).toBeNull();
    expect(storage.getItem(key)).toBeNull();
  });

  it('does not migrate a legacy candidate without evidence into a cleanup draft', () => {
    const storage = new MemoryStorage();
    const key = productBatchWorkbenchStorageKey(scope);
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        ...scope,
        draft: {
          ...session.draft,
          status: 'online',
          action: 'cleanup',
          selected: [legacyCandidate('11', '旧版清理商品')],
        },
        preview: session.preview,
      }),
    );

    expect(readProductBatchWorkbenchSession(scope, storage)).toBeNull();
    expect(storage.getItem(key)).toBeNull();
  });

  it('does not migrate a legacy candidate without fence fields into an offline draft', () => {
    const storage = new MemoryStorage();
    const key = productBatchWorkbenchStorageKey(scope);
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        ...scope,
        draft: {
          ...session.draft,
          action: 'offline',
          selected: [legacyCandidate('11', '旧版下架商品')],
        },
        preview: session.preview,
      }),
    );

    expect(readProductBatchWorkbenchSession(scope, storage)).toBeNull();
    expect(storage.getItem(key)).toBeNull();
  });

  it('does not restore any mutation draft with a pending offline verification fence', () => {
    const storage = new MemoryStorage();
    const key = productBatchWorkbenchStorageKey(scope);
    const pendingFence = {
      ...candidate('11', '待核验下架商品'),
      offlineVerificationTaskId: '41',
      offlineVerificationItemId: '52',
    };
    for (const action of [
      'online',
      'offline',
      'edit_title',
      'edit_price',
      'sync_inventory',
      'change_source',
      'cleanup',
    ] as const) {
      storage.setItem(
        key,
        JSON.stringify({
          version: 1,
          ...scope,
          draft: { ...session.draft, action, selected: [pendingFence] },
          preview: session.preview,
        }),
      );

      expect(readProductBatchWorkbenchSession(scope, storage)).toBeNull();
      expect(storage.getItem(key)).toBeNull();
    }
  });

  it('does not restore a draft with an incomplete offline verification pair', () => {
    const storage = new MemoryStorage();
    const key = productBatchWorkbenchStorageKey(scope);
    const partialFence = { ...candidate('12', '核验字段不完整商品') } as Record<string, unknown>;
    delete partialFence.offlineVerificationItemId;
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        ...scope,
        draft: { ...session.draft, action: 'edit_price', selected: [partialFence] },
        preview: session.preview,
      }),
    );

    expect(readProductBatchWorkbenchSession(scope, storage)).toBeNull();
    expect(storage.getItem(key)).toBeNull();
  });

  it('fails closed when cleanup eligibility or evidence is internally inconsistent', () => {
    const storage = new MemoryStorage();
    const key = productBatchWorkbenchStorageKey(scope);
    for (const selected of [
      { ...candidate('11', '缺少证据商品'), cleanupEvidence: null },
      {
        ...candidate('12', '窗口错误商品'),
        cleanupEvidence: { ...cleanupEvidence(), windowDays: 7 },
      },
      {
        ...candidate('13', '理由冲突商品'),
        cleanupReason: '同时允许并阻止清理',
      },
    ]) {
      storage.setItem(
        key,
        JSON.stringify({
          version: 1,
          ...scope,
          draft: { ...session.draft, action: 'cleanup', selected: [selected] },
          preview: session.preview,
        }),
      );

      expect(readProductBatchWorkbenchSession(scope, storage)).toBeNull();
      expect(storage.getItem(key)).toBeNull();
    }
  });

  it('does not restore a blocked candidate as selected in an online draft', () => {
    const storage = new MemoryStorage();
    const key = productBatchWorkbenchStorageKey(scope);
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        ...scope,
        draft: {
          ...session.draft,
          status: 'offline',
          action: 'online',
          selected: [
            {
              ...candidate('11', '待核验上架商品'),
              status: 'offline',
              onlineEligible: false,
              onlineReason: '上一次上架结果未知，请先核验平台状态与库存',
              onlineVerificationTaskId: '41',
              onlineVerificationItemId: '52',
            },
          ],
        },
        preview: session.preview,
      }),
    );

    expect(readProductBatchWorkbenchSession(scope, storage)).toBeNull();
    expect(storage.getItem(key)).toBeNull();
  });

  it('fails closed when online safety fields are partial or internally inconsistent', () => {
    const storage = new MemoryStorage();
    const key = productBatchWorkbenchStorageKey(scope);
    const partial = candidate('11', '字段不完整上架商品') as Record<string, unknown>;
    delete partial.onlineVerificationItemId;
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        ...scope,
        draft: { ...session.draft, selected: [partial] },
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
          selected: [
            {
              ...candidate('12', '资格冲突上架商品'),
              onlineEligible: true,
              onlineReason: '不能同时允许并阻止上架',
            },
          ],
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
    onlineEligible: false,
    onlineReason: '只有已下架商品可以上架',
    onlineVerificationTaskId: null,
    onlineVerificationItemId: null,
    offlineVerificationTaskId: null,
    offlineVerificationItemId: null,
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
    cleanupEligible: true,
    cleanupReason: null,
    cleanupEvidence: cleanupEvidence(),
    sourceChangeEligible: false,
    sourceChangeReason: '只有已下架商品可以安全换源',
    currentSourceRouteCount: 0,
    mutationRevision: 2,
    publishedAt: '2026-08-04T00:00:00.000Z',
  };
}

function legacyCandidate(publishedProductId: string, title: string): Record<string, unknown> {
  const legacy: Record<string, unknown> = { ...candidate(publishedProductId, title) };
  for (const field of [
    'titleEditable',
    'titleEditReason',
    'onlineEligible',
    'onlineReason',
    'onlineVerificationTaskId',
    'onlineVerificationItemId',
    'offlineVerificationTaskId',
    'offlineVerificationItemId',
    'sourceTotalStock',
    'sourceSkuCount',
    'sourceInventoryVersion',
    'syncedInventoryVersion',
    'inventoryLastSyncedAt',
    'inventorySyncError',
    'inventorySyncEligible',
    'inventorySyncReason',
    'cleanupEligible',
    'cleanupReason',
    'cleanupEvidence',
    'sourceChangeEligible',
    'sourceChangeReason',
    'currentSourceRouteCount',
  ]) {
    delete legacy[field];
  }
  return legacy;
}

function cleanupEvidence(): ProductBatchCleanupEvidence {
  return {
    policyVersion: 1 as const,
    windowDays: 30,
    graceDays: 7,
    observedAt: '2026-08-04T10:00:00.000Z',
    windowStartedAt: '2026-07-05T10:00:00.000Z',
    daysOnline: 40,
    validOrderCount: 0,
    lastPaidAt: null,
    orderSyncAt: '2026-08-04T09:59:00.000Z',
  };
}
