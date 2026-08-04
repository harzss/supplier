'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useAuthStorageIdentity } from './auth-provider';
import {
  clearProductBatchSessionForTask,
  clearProductBatchWorkbenchSession,
  hasValidOnlineCandidateState,
  productBatchWorkbenchStorageKey,
  readProductBatchWorkbenchSession,
  shouldRestoreProductBatchPreview,
  writeProductBatchWorkbenchSession,
  type ProductBatchComposerDraft,
  type ProductBatchPreviewSession,
  type ProductBatchSessionScope,
} from './product-batch-session';
import {
  ApiError,
  api,
  type ProductBatchAction,
  type ProductBatchCandidate,
  type ProductBatchInventorySnapshot,
  type ProductBatchItem,
  type ProductBatchPreviewRequest,
  type ProductBatchPriceRule,
  type ProductBatchTask,
} from '../lib/api';

const PAGE_SIZE = 50;
const MAX_SELECTION = 100;
const TARGET_PAGE_SIZE = 20;
const ACTIVE_TASK_STATUSES = new Set(['queued', 'running', 'cancelling']);
const ONLINE_RESULT_UNKNOWN_CODES = new Set(['ONLINE_WRITE_STARTED', 'ONLINE_RESULT_UNKNOWN']);
const CURRENCY_FORMATTER = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const STATUS_FILTERS = [
  { value: 'online', label: '在线' },
  { value: 'draft', label: '待审核' },
  { value: 'rejected', label: '已驳回' },
  { value: 'offline', label: '已下架' },
] as const;
const RESULT_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'waiting', label: '等待' },
  { value: 'running', label: '执行中' },
  { value: 'succeeded', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'skipped', label: '跳过' },
  { value: 'cancelled', label: '已停止' },
] as const;

type PriceMode = ProductBatchPriceRule['mode'];
type PriceDirection = Extract<ProductBatchPriceRule, { mode: 'percentage' }>['direction'];
type TargetPriceValidation = { value: string | null; error: string };
type TargetTitleValidation = { value: string | null; error: string };
type ProductBatchPreviewInput =
  | Omit<Extract<ProductBatchPreviewRequest, { action: 'online' }>, 'clientRequestId'>
  | Omit<Extract<ProductBatchPreviewRequest, { action: 'offline' }>, 'clientRequestId'>
  | Omit<Extract<ProductBatchPreviewRequest, { action: 'edit_title' }>, 'clientRequestId'>
  | Omit<Extract<ProductBatchPreviewRequest, { action: 'edit_price' }>, 'clientRequestId'>
  | Omit<Extract<ProductBatchPreviewRequest, { action: 'sync_inventory' }>, 'clientRequestId'>;

const EMPTY_COMPOSER_DRAFT: ProductBatchComposerDraft = {
  page: 1,
  status: 'online',
  searchInput: '',
  query: '',
  action: 'offline',
  priceMode: 'percentage',
  priceDirection: 'increase',
  percentageInput: '10',
  targetInputs: {},
  titleInputs: {},
  bulkTargetInput: '',
  targetPage: 1,
  selected: [],
};

export function ProductBatchWorkbench() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const accountId = useAuthStorageIdentity();
  const taskId = searchParams.get('task');
  const sessionScope = useMemo<ProductBatchSessionScope | null>(
    () => (accountId ? { accountId, pathname } : null),
    [accountId, pathname],
  );

  return (
    <main className="app-page batch-workbench">
      <header className="batch-page-header">
        <div>
          <p className="page-kicker">Batch operations</p>
          <h1 className="page-title">批量经营</h1>
          <p className="page-description">
            先预览每一项变化，再执行平台操作。成功项不会因失败重试而重复执行。
          </p>
        </div>
        <Link href="/published" className="batch-secondary-button">
          返回铺货中心
        </Link>
      </header>

      {!sessionScope ? (
        <BatchLoading />
      ) : taskId ? (
        <BatchTask
          taskId={taskId}
          sessionScope={sessionScope}
          onStartNew={() => router.replace('/published/batch')}
        />
      ) : (
        <BatchComposer sessionScope={sessionScope} />
      )}
    </main>
  );
}

function BatchComposer({ sessionScope }: { sessionScope: ProductBatchSessionScope }) {
  const router = useRouter();
  const qc = useQueryClient();
  const storageScopeKey = productBatchWorkbenchStorageKey(sessionScope);
  const [hydratedScopeKey, setHydratedScopeKey] = useState<string | null>(null);
  const storageHydrated = hydratedScopeKey === storageScopeKey;
  const [storedPreview, setStoredPreview] = useState<ProductBatchPreviewSession | null>(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('online');
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [action, setAction] = useState<ProductBatchAction>('offline');
  const [priceMode, setPriceMode] = useState<PriceMode>('percentage');
  const [priceDirection, setPriceDirection] = useState<PriceDirection>('increase');
  const [percentageInput, setPercentageInput] = useState('10');
  const [targetInputs, setTargetInputs] = useState<Record<string, string>>({});
  const [titleInputs, setTitleInputs] = useState<Record<string, string>>({});
  const [bulkTargetInput, setBulkTargetInput] = useState('');
  const [targetPage, setTargetPage] = useState(1);
  const [validationAttempted, setValidationAttempted] = useState(false);
  const [pendingTargetFocusId, setPendingTargetFocusId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, ProductBatchCandidate>>(() => new Map());
  const pageCheckboxRef = useRef<HTMLInputElement>(null);
  const percentageInputRef = useRef<HTMLInputElement>(null);
  const targetInputRefs = useRef(new Map<string, HTMLInputElement>());
  const previewAttempt = useRef<ProductBatchPreviewSession | null>(null);
  const candidates = useQuery({
    queryKey: ['productBatchCandidates', page, PAGE_SIZE, status, query],
    queryFn: () =>
      api.productBatchCandidates({ page, pageSize: PAGE_SIZE, status, q: query || undefined }),
    enabled: storageHydrated,
  });
  const recent = useQuery({
    queryKey: ['productBatchTasks', 1, 5],
    queryFn: () => api.productBatchTasks(1, 5),
    enabled: storageHydrated,
  });
  const createPreview = useMutation({
    mutationFn: (request: ProductBatchPreviewRequest) => api.createProductBatchPreview(request),
    onSuccess: (task, request) => {
      if (
        task.clientRequestId !== request.clientRequestId ||
        !shouldAcceptProductBatchPreviewResponse(previewAttempt.current, request)
      ) {
        return;
      }
      const preview = { ...previewAttempt.current!, taskId: task.taskId };
      previewAttempt.current = preview;
      setStoredPreview(preview);
      writeProductBatchWorkbenchSession(sessionScope, { draft: composerDraft, preview });
      qc.setQueryData(['productBatchTask', task.taskId], task);
      router.replace(`/published/batch?task=${encodeURIComponent(task.taskId)}`);
    },
  });
  const previewRecovery = useQuery({
    queryKey: ['productBatchTask', storedPreview?.taskId],
    queryFn: () => api.productBatchTask(storedPreview!.taskId!),
    enabled: storageHydrated && Boolean(storedPreview?.taskId),
    retry: false,
  });
  const pageItems =
    candidates.data?.items.filter((item) => isCandidateSelectable(item, action)) ?? [];
  const pageIds = pageItems.map((item) => item.publishedProductId);
  const selectedItems = useMemo(() => [...selected.values()], [selected]);
  const selectedIds = useMemo(
    () => selectedItems.map((item) => item.publishedProductId),
    [selectedItems],
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedPageCount = pageIds.filter((id) => selectedSet.has(id)).length;
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedSet.has(id));
  const pageSelectionBlocked =
    pageIds.length === 0 || (selected.size >= MAX_SELECTION && selectedPageCount === 0);
  const totalPages = Math.max(1, Math.ceil((candidates.data?.total ?? 0) / PAGE_SIZE));
  const targetTotalPages = Math.max(1, Math.ceil(selected.size / TARGET_PAGE_SIZE));
  const visibleTargetItems = selectedItems.slice(
    (targetPage - 1) * TARGET_PAGE_SIZE,
    targetPage * TARGET_PAGE_SIZE,
  );
  const percentageValidation = validatePercentageInput(percentageInput, priceDirection);
  const priceTargetValidations = useMemo(
    () =>
      new Map(
        selectedItems.map((item) => [
          item.publishedProductId,
          normalizeTargetPrice(targetInputs[item.publishedProductId] ?? ''),
        ]),
      ),
    [selectedItems, targetInputs],
  );
  const titleTargetValidations = useMemo(
    () =>
      new Map(
        selectedItems.map((item) => [
          item.publishedProductId,
          normalizeTargetTitle(titleInputs[item.publishedProductId] ?? item.title, item.platform),
        ]),
      ),
    [selectedItems, titleInputs],
  );
  const invalidPriceTargetCount = [...priceTargetValidations.values()].filter(
    (value) => !value.value,
  ).length;
  const invalidTitleTargetCount = [...titleTargetValidations.values()].filter(
    (value) => !value.value,
  ).length;
  const composerDraft = useMemo<ProductBatchComposerDraft>(
    () => ({
      page,
      status,
      searchInput,
      query,
      action,
      priceMode,
      priceDirection,
      percentageInput,
      targetInputs,
      titleInputs,
      bulkTargetInput,
      targetPage,
      selected: selectedItems,
    }),
    [
      action,
      bulkTargetInput,
      page,
      percentageInput,
      priceDirection,
      priceMode,
      query,
      searchInput,
      selectedItems,
      status,
      targetInputs,
      titleInputs,
      targetPage,
    ],
  );
  const applyComposerDraft = useCallback((draft: ProductBatchComposerDraft) => {
    setPage(draft.page);
    setStatus(draft.status);
    setSearchInput(draft.searchInput);
    setQuery(draft.query);
    setAction(draft.action);
    setPriceMode(draft.priceMode);
    setPriceDirection(draft.priceDirection);
    setPercentageInput(draft.percentageInput);
    setTargetInputs(draft.targetInputs);
    setTitleInputs(draft.titleInputs);
    setBulkTargetInput(draft.bulkTargetInput);
    setTargetPage(draft.targetPage);
    setSelected(new Map(draft.selected.map((item) => [item.publishedProductId, item] as const)));
    setValidationAttempted(false);
    setPendingTargetFocusId(null);
  }, []);
  const discardRecoveredSession = useCallback(() => {
    clearProductBatchWorkbenchSession(sessionScope);
    previewAttempt.current = null;
    setStoredPreview(null);
    applyComposerDraft(EMPTY_COMPOSER_DRAFT);
  }, [applyComposerDraft, sessionScope]);

  useEffect(() => {
    const session = readProductBatchWorkbenchSession(sessionScope);
    applyComposerDraft(session?.draft ?? EMPTY_COMPOSER_DRAFT);
    previewAttempt.current = session?.preview ?? null;
    setStoredPreview(session?.preview ?? null);
    setHydratedScopeKey(storageScopeKey);
  }, [applyComposerDraft, sessionScope, storageScopeKey]);

  useEffect(() => {
    if (!storageHydrated) return;
    writeProductBatchWorkbenchSession(sessionScope, {
      draft: composerDraft,
      preview: storedPreview,
    });
  }, [composerDraft, sessionScope, storageHydrated, storedPreview]);

  useEffect(() => {
    if (!storedPreview?.taskId) return;
    if (previewRecovery.data) {
      if (shouldRestoreProductBatchPreview(storedPreview, previewRecovery.data)) {
        qc.setQueryData(['productBatchTask', previewRecovery.data.taskId], previewRecovery.data);
        router.replace(`/published/batch?task=${encodeURIComponent(previewRecovery.data.taskId)}`);
      } else {
        discardRecoveredSession();
      }
      return;
    }
    if (previewRecovery.error instanceof ApiError && previewRecovery.error.status === 404) {
      discardRecoveredSession();
    }
  }, [
    discardRecoveredSession,
    previewRecovery.data,
    previewRecovery.error,
    qc,
    router,
    storedPreview,
  ]);

  useEffect(() => {
    if (!storedPreview || storedPreview.taskId || !recent.data) return;
    const recovered = recent.data.items.find(
      (task) => task.clientRequestId === storedPreview.clientRequestId,
    );
    if (!recovered) return;
    if (recovered.status !== 'preview') {
      discardRecoveredSession();
      return;
    }
    const preview = { ...storedPreview, taskId: recovered.taskId };
    previewAttempt.current = preview;
    setStoredPreview(preview);
    writeProductBatchWorkbenchSession(sessionScope, { draft: composerDraft, preview });
    qc.setQueryData(['productBatchTask', recovered.taskId], recovered);
    router.replace(`/published/batch?task=${encodeURIComponent(recovered.taskId)}`);
  }, [
    composerDraft,
    discardRecoveredSession,
    qc,
    recent.data,
    router,
    sessionScope,
    storedPreview,
  ]);

  useEffect(() => {
    if (pageCheckboxRef.current) {
      pageCheckboxRef.current.indeterminate = selectedPageCount > 0 && !allPageSelected;
    }
  }, [allPageSelected, selectedPageCount]);

  useEffect(() => {
    setTargetPage((current) => Math.min(current, targetTotalPages));
  }, [targetTotalPages]);

  useEffect(() => {
    if (!pendingTargetFocusId) return;
    const input = targetInputRefs.current.get(pendingTargetFocusId);
    if (!input) return;
    input.focus();
    setPendingTargetFocusId(null);
  }, [pendingTargetFocusId, targetPage]);

  if (
    !storageHydrated ||
    (storedPreview && !storedPreview.taskId && recent.isPending) ||
    (storedPreview &&
      !storedPreview.taskId &&
      recent.data?.items.some((task) => task.clientRequestId === storedPreview.clientRequestId)) ||
    (storedPreview?.taskId &&
      (!previewRecovery.isError ||
        (previewRecovery.error instanceof ApiError && previewRecovery.error.status === 404)))
  ) {
    return <BatchLoading />;
  }
  if (storedPreview?.taskId && previewRecovery.isError) {
    return <BatchError error={previewRecovery.error} />;
  }

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setPage(1);
    setQuery(searchInput.trim());
  };

  const resetPreviewFeedback = () => {
    previewAttempt.current = null;
    setStoredPreview(null);
    createPreview.reset();
    setValidationAttempted(false);
  };

  const chooseAction = (nextAction: ProductBatchAction) => {
    if (nextAction === action) return;
    setAction(nextAction);
    setStatus(nextAction === 'online' ? 'offline' : 'online');
    setPage(1);
    setSelected(new Map());
    setTargetInputs({});
    setTitleInputs({});
    setTargetPage(1);
    resetPreviewFeedback();
  };

  const choosePriceMode = (nextMode: PriceMode) => {
    if (nextMode === priceMode) return;
    setPriceMode(nextMode);
    resetPreviewFeedback();
  };

  const toggle = (item: ProductBatchCandidate) => {
    const id = item.publishedProductId;
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_SELECTION) next.set(id, item);
      return next;
    });
    resetPreviewFeedback();
  };

  const togglePage = () => {
    setSelected((current) => {
      const next = new Map(current);
      const selectedOnPage = pageIds.filter((id) => next.has(id));
      if (
        (pageIds.length && selectedOnPage.length === pageIds.length) ||
        (current.size >= MAX_SELECTION && selectedOnPage.length > 0)
      ) {
        pageIds.forEach((id) => next.delete(id));
        return next;
      }
      const capacity = MAX_SELECTION - current.size;
      pageItems
        .filter((item) => !next.has(item.publishedProductId))
        .slice(0, Math.max(0, capacity))
        .forEach((item) => next.set(item.publishedProductId, item));
      return next;
    });
    resetPreviewFeedback();
  };

  const setTargetInput = (id: string, value: string) => {
    setTargetInputs((current) => ({ ...current, [id]: value }));
    resetPreviewFeedback();
  };

  const setTitleInput = (id: string, value: string) => {
    setTitleInputs((current) => ({ ...current, [id]: value }));
    resetPreviewFeedback();
  };

  const applyBulkTarget = () => {
    const normalized = normalizeTargetPrice(bulkTargetInput);
    if (!normalized.value) return;
    setTargetInputs((current) => ({
      ...current,
      ...Object.fromEntries(selectedIds.map((id) => [id, normalized.value!])),
    }));
    setBulkTargetInput(normalized.value);
    resetPreviewFeedback();
  };

  const requestPreview = () => {
    setValidationAttempted(true);
    let priceRule: ProductBatchPriceRule | null = null;
    if (action === 'edit_price' && priceMode === 'percentage') {
      if (!percentageValidation.value) {
        percentageInputRef.current?.focus();
        return;
      }
      priceRule = {
        mode: 'percentage',
        direction: priceDirection,
        basisPoints: percentageValidation.value,
      };
    }
    if (action === 'edit_price' && priceMode === 'targets') {
      const firstInvalidIndex = selectedItems.findIndex(
        (item) => !priceTargetValidations.get(item.publishedProductId)?.value,
      );
      if (firstInvalidIndex >= 0) {
        const item = selectedItems[firstInvalidIndex]!;
        setTargetPage(Math.floor(firstInvalidIndex / TARGET_PAGE_SIZE) + 1);
        setPendingTargetFocusId(item.publishedProductId);
        return;
      }
      priceRule = {
        mode: 'targets',
        targets: selectedItems.map((item) => ({
          publishedProductId: item.publishedProductId,
          targetStartPrice: priceTargetValidations.get(item.publishedProductId)!.value!,
        })),
      };
    }
    if (action === 'edit_title') {
      const firstInvalidIndex = selectedItems.findIndex(
        (item) => !titleTargetValidations.get(item.publishedProductId)?.value,
      );
      if (firstInvalidIndex >= 0) {
        const item = selectedItems[firstInvalidIndex]!;
        setTargetPage(Math.floor(firstInvalidIndex / TARGET_PAGE_SIZE) + 1);
        setPendingTargetFocusId(item.publishedProductId);
        return;
      }
    }
    const requestWithoutId = {
      action,
      publishedProductIds: selectedIds,
      ...(priceRule ? { priceRule } : {}),
      ...(action === 'edit_title'
        ? {
            titleTargets: selectedItems.map((item) => ({
              publishedProductId: item.publishedProductId,
              expectedMutationRevision: item.mutationRevision,
              targetTitle: titleTargetValidations.get(item.publishedProductId)!.value!,
            })),
          }
        : {}),
    } as ProductBatchPreviewInput;
    const fingerprint = productBatchPreviewFingerprint(requestWithoutId);
    if (previewAttempt.current?.fingerprint !== fingerprint) {
      previewAttempt.current = { fingerprint, clientRequestId: crypto.randomUUID() };
    }
    const preview = previewAttempt.current;
    setStoredPreview(preview);
    writeProductBatchWorkbenchSession(sessionScope, { draft: composerDraft, preview });
    createPreview.mutate({
      ...requestWithoutId,
      clientRequestId: preview.clientRequestId,
    } as ProductBatchPreviewRequest);
  };

  return (
    <div className="space-y-5">
      <section className="batch-command-panel" aria-labelledby="batch-action-heading">
        <div className="batch-step-marker">01</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="batch-action-heading" className="batch-section-title">
                选择经营动作
              </h2>
              <p className="batch-section-description">{batchActionDescription(action)}</p>
            </div>
            <span className="batch-safety-chip">平台回读确认</span>
          </div>
          <div className="batch-action-grid" role="group" aria-label="经营动作">
            <button
              type="button"
              className={`batch-action-card ${action === 'online' ? 'is-active' : ''}`}
              aria-pressed={action === 'online'}
              onClick={() => chooseAction('online')}
            >
              <span className="batch-action-icon" aria-hidden="true">
                ↑
              </span>
              <span>
                <strong>批量上架</strong>
                <small>已下架商品 → 库存核验 → 在线</small>
              </span>
              <em>已开放</em>
            </button>
            <button
              type="button"
              className={`batch-action-card ${action === 'offline' ? 'is-active' : ''}`}
              aria-pressed={action === 'offline'}
              onClick={() => chooseAction('offline')}
            >
              <span className="batch-action-icon" aria-hidden="true">
                ↓
              </span>
              <span>
                <strong>批量下架</strong>
                <small>在线商品 → 已下架</small>
              </span>
              <em>已开放</em>
            </button>
            <button
              type="button"
              className={`batch-action-card ${action === 'edit_price' ? 'is-active' : ''}`}
              aria-pressed={action === 'edit_price'}
              onClick={() => chooseAction('edit_price')}
            >
              <span className="batch-action-icon" aria-hidden="true">
                ¥
              </span>
              <span>
                <strong>批量改价</strong>
                <small>按比例或设置目标起售价</small>
              </span>
              <em>已开放</em>
            </button>
            <button
              type="button"
              className={`batch-action-card ${action === 'sync_inventory' ? 'is-active' : ''}`}
              aria-pressed={action === 'sync_inventory'}
              onClick={() => chooseAction('sync_inventory')}
            >
              <span className="batch-action-icon" aria-hidden="true">
                ↻
              </span>
              <span>
                <strong>同步库存</strong>
                <small>1688 权威快照 → 平台回读</small>
              </span>
              <em>已开放</em>
            </button>
            <button
              type="button"
              className={`batch-action-card ${action === 'edit_title' ? 'is-active' : ''}`}
              aria-pressed={action === 'edit_title'}
              onClick={() => chooseAction('edit_title')}
            >
              <span className="batch-action-icon" aria-hidden="true">
                T
              </span>
              <span>
                <strong>批量改标题</strong>
                <small>逐件编辑并回读平台标题</small>
              </span>
              <em>已开放</em>
            </button>
            <button type="button" className="batch-action-card" disabled>
              <span className="batch-action-icon" aria-hidden="true">
                ·
              </span>
              <span>
                <strong>换源与清理</strong>
                <small>复用同一批量任务状态机</small>
              </span>
              <em>下一阶段</em>
            </button>
          </div>

          {action === 'edit_price' ? (
            <fieldset className="batch-price-rule-panel">
              <legend>改价方式</legend>
              <div className="batch-price-mode-grid">
                <label data-selected={priceMode === 'percentage'}>
                  <input
                    type="radio"
                    name="batch-price-mode"
                    value="percentage"
                    checked={priceMode === 'percentage'}
                    onChange={() => choosePriceMode('percentage')}
                  />
                  <span>
                    <strong>按比例调整</strong>
                    <small>所有 SKU 使用相同比例，保留商品间价差</small>
                  </span>
                  <em>推荐</em>
                </label>
                <label data-selected={priceMode === 'targets'}>
                  <input
                    type="radio"
                    name="batch-price-mode"
                    value="targets"
                    checked={priceMode === 'targets'}
                    onChange={() => choosePriceMode('targets')}
                  />
                  <span>
                    <strong>逐项设置起售价</strong>
                    <small>每件商品单独定价，也可统一填入后再微调</small>
                  </span>
                </label>
              </div>

              {priceMode === 'percentage' ? (
                <div className="batch-price-rule-controls">
                  <fieldset className="batch-price-direction">
                    <legend>调整方向</legend>
                    <label data-selected={priceDirection === 'increase'}>
                      <input
                        type="radio"
                        name="batch-price-direction"
                        value="increase"
                        checked={priceDirection === 'increase'}
                        onChange={() => {
                          setPriceDirection('increase');
                          resetPreviewFeedback();
                        }}
                      />
                      上调
                    </label>
                    <label data-selected={priceDirection === 'decrease'}>
                      <input
                        type="radio"
                        name="batch-price-direction"
                        value="decrease"
                        checked={priceDirection === 'decrease'}
                        onChange={() => {
                          setPriceDirection('decrease');
                          resetPreviewFeedback();
                        }}
                      />
                      下调
                    </label>
                  </fieldset>
                  <label className="batch-price-number-field" htmlFor="batch-price-percentage">
                    <span>调整幅度</span>
                    <span className="batch-price-input-shell">
                      <input
                        ref={percentageInputRef}
                        id="batch-price-percentage"
                        name="batch-price-percentage"
                        type="number"
                        inputMode="decimal"
                        autoComplete="off"
                        min="0.01"
                        max={priceDirection === 'decrease' ? '99.99' : '1000'}
                        step="0.01"
                        value={percentageInput}
                        aria-invalid={validationAttempted && !percentageValidation.value}
                        aria-describedby="batch-price-percentage-help batch-price-percentage-error"
                        onChange={(event) => {
                          setPercentageInput(event.target.value);
                          resetPreviewFeedback();
                        }}
                      />
                      <span aria-hidden="true">%</span>
                    </span>
                  </label>
                  <div className="batch-price-rule-help">
                    <span id="batch-price-percentage-help">
                      例如：¥100 {priceDirection === 'increase' ? '上调' : '下调'} 10% →{' '}
                      {priceDirection === 'increase' ? '¥110' : '¥90'}；每个 SKU
                      分别计算并取两位小数。
                    </span>
                    <span id="batch-price-percentage-error" role="alert">
                      {validationAttempted && !percentageValidation.value
                        ? percentageValidation.error
                        : ''}
                    </span>
                  </div>
                </div>
              ) : (
                <p className="batch-price-rule-help">
                  选择商品后填写每件商品的目标起售价；其他 SKU
                  会按相同比例调整，并在预览中展示完整价格区间。
                </p>
              )}
            </fieldset>
          ) : null}
          {action === 'sync_inventory' ? (
            <div className="batch-inventory-notice" role="note">
              <span className="batch-action-icon" aria-hidden="true">
                ✓
              </span>
              <span>
                <strong>以 1688 当前 SKU 库存快照为唯一目标</strong>
                <small>系统写入平台后会逐 SKU 回读核验；这里不会手填、估算或人为分配库存。</small>
              </span>
            </div>
          ) : null}
          {action === 'online' ? (
            <div className="batch-inventory-notice" role="note">
              <span className="batch-action-icon" aria-hidden="true">
                ✓
              </span>
              <span>
                <strong>上架前锁定并核对 1688 当前 SKU 库存</strong>
                <small>
                  系统会先补齐平台库存，再执行上架并同时回读在线状态与逐 SKU
                  库存；结果未知时必须先核验，不能直接重试。
                </small>
              </span>
            </div>
          ) : null}
        </div>
      </section>

      <section className="batch-catalog-panel" aria-labelledby="batch-selection-heading">
        <div className="batch-catalog-toolbar">
          <div>
            <p className="batch-step-label">02 · 选择商品</p>
            <h2 id="batch-selection-heading" className="batch-section-title">
              商品目录
            </h2>
          </div>
          <form onSubmit={submitSearch} className="batch-search-form" role="search">
            <label className="sr-only" htmlFor="batch-product-search">
              搜索商品标题
            </label>
            <input
              id="batch-product-search"
              name="batch-product-search"
              type="search"
              autoComplete="off"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="搜索商品标题…"
              maxLength={100}
            />
            <button type="submit">搜索</button>
          </form>
        </div>

        <div className="batch-filter-row" role="group" aria-label="商品状态筛选">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              aria-pressed={status === filter.value}
              className={status === filter.value ? 'is-active' : ''}
              onClick={() => {
                setStatus(filter.value);
                setPage(1);
              }}
            >
              {filter.label}
            </button>
          ))}
        </div>

        {candidates.isLoading ? <BatchLoading /> : null}
        {candidates.isError ? <BatchError error={candidates.error} /> : null}
        {candidates.data ? (
          <div className="batch-table-shell">
            <table className="batch-table">
              <thead>
                <tr>
                  <th className="batch-check-cell">
                    <label className="batch-checkbox-target">
                      <input
                        ref={pageCheckboxRef}
                        type="checkbox"
                        aria-label={
                          allPageSelected ||
                          (selected.size >= MAX_SELECTION && selectedPageCount > 0)
                            ? '取消本页已选商品'
                            : `选择本页可${batchActionVerb(action)}商品`
                        }
                        checked={allPageSelected}
                        disabled={pageSelectionBlocked}
                        onChange={togglePage}
                      />
                    </label>
                  </th>
                  <th>商品</th>
                  <th>店铺 / 平台</th>
                  <th>
                    {action === 'online'
                      ? '1688 上架库存'
                      : action === 'sync_inventory'
                        ? '1688 权威库存'
                        : action === 'edit_title'
                          ? '标题状态'
                          : '起售价 / SKU'}
                  </th>
                  <th>货源</th>
                  <th>
                    {action === 'online'
                      ? '平台库存基线'
                      : action === 'sync_inventory'
                        ? '最近同步'
                        : '库存同步'}
                  </th>
                  <th>当前状态</th>
                </tr>
              </thead>
              <tbody>
                {candidates.data.items.map((item) => (
                  <CandidateRow
                    key={item.publishedProductId}
                    item={item}
                    action={action}
                    selected={selectedSet.has(item.publishedProductId)}
                    selectionFull={selected.size >= MAX_SELECTION}
                    onToggle={() => toggle(item)}
                  />
                ))}
              </tbody>
            </table>
            {candidates.data.items.length === 0 ? (
              <div className="batch-empty-state">当前筛选条件下没有可显示的商品。</div>
            ) : null}
          </div>
        ) : null}

        {candidates.data && candidates.data.total > 0 ? (
          <div className="batch-pagination">
            <span>
              第 {page} / {totalPages} 页 · 共 {candidates.data.total} 件
            </span>
            <div>
              <button
                type="button"
                disabled={page <= 1 || candidates.isFetching}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                上一页
              </button>
              <button
                type="button"
                disabled={page >= totalPages || candidates.isFetching}
                onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              >
                下一页
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {action === 'edit_price' && priceMode === 'targets' && selected.size > 0 ? (
        <TargetPriceEditor
          items={visibleTargetItems}
          page={targetPage}
          totalPages={targetTotalPages}
          values={targetInputs}
          validations={priceTargetValidations}
          validationAttempted={validationAttempted}
          invalidCount={invalidPriceTargetCount}
          bulkValue={bulkTargetInput}
          onBulkValueChange={(value) => {
            setBulkTargetInput(value);
            setValidationAttempted(false);
          }}
          onApplyBulk={applyBulkTarget}
          onValueChange={setTargetInput}
          onPageChange={setTargetPage}
          inputRefs={targetInputRefs}
        />
      ) : null}

      {action === 'edit_title' && selected.size > 0 ? (
        <TargetTitleEditor
          items={visibleTargetItems}
          page={targetPage}
          totalPages={targetTotalPages}
          values={titleInputs}
          validations={titleTargetValidations}
          validationAttempted={validationAttempted}
          invalidCount={invalidTitleTargetCount}
          onValueChange={setTitleInput}
          onPageChange={setTargetPage}
          inputRefs={targetInputRefs}
        />
      ) : null}

      {recent.data?.items.length ? (
        <section className="batch-recent-panel">
          <div>
            <p className="batch-step-label">最近任务</p>
            <p className="text-xs text-zinc-500">刷新页面后仍可从这里恢复预览和执行进度。</p>
          </div>
          <div className="batch-recent-list">
            {recent.data.items.map((task) => (
              <Link
                key={task.taskId}
                href={`/published/batch?task=${encodeURIComponent(task.taskId)}`}
              >
                <span>{formatTaskStatus(task.status)}</span>
                <strong>
                  {task.summary.total} 件{batchActionLabel(task.action)}
                </strong>
                <small>{new Date(task.createdAt).toLocaleString('zh-CN')}</small>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {selected.size > 0 ? (
        <div className="batch-selection-bar" data-visible="true">
          <div>
            <strong>
              已选 {selected.size} / {MAX_SELECTION} 件
            </strong>
            <span>
              {action === 'edit_price' && priceMode === 'targets' && invalidPriceTargetCount > 0
                ? `还需填写 ${invalidPriceTargetCount} 件商品的目标起售价。`
                : action === 'edit_title' && invalidTitleTargetCount > 0
                  ? `还有 ${invalidTitleTargetCount} 件商品的标题不符合目标平台规则。`
                  : '下一步只生成差异预览，不会立即调用平台。'}
            </span>
          </div>
          <div className="batch-selection-actions">
            <button
              type="button"
              className="batch-quiet-button"
              onClick={() => {
                setSelected(new Map());
                setTargetInputs({});
                setTitleInputs({});
                resetPreviewFeedback();
              }}
            >
              清空
            </button>
            <button
              type="button"
              className="batch-primary-button"
              disabled={createPreview.isPending}
              onClick={requestPreview}
            >
              {createPreview.isPending
                ? '生成预览中…'
                : `预览${batchActionLabel(action)} ${selected.size} 件商品`}
            </button>
          </div>
          {createPreview.isError ? (
            <p className="batch-bar-error" role="alert">
              {errorMessage(createPreview.error)}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CandidateRow({
  item,
  action,
  selected,
  selectionFull,
  onToggle,
}: {
  item: ProductBatchCandidate;
  action: ProductBatchAction;
  selected: boolean;
  selectionFull: boolean;
  onToggle: () => void;
}) {
  const selectable = isCandidateSelectable(item, action);
  const unavailableReason = candidateUnavailableReason(item, action);
  return (
    <tr data-selected={selected}>
      <td className="batch-check-cell">
        <label className="batch-checkbox-target">
          <input
            type="checkbox"
            aria-label={
              selectable
                ? `${selected ? '取消选择' : '选择'} ${item.title}`
                : `${item.title} 不可用于${batchActionLabel(action)}：${unavailableReason}`
            }
            checked={selected}
            disabled={!selectable || (!selected && selectionFull)}
            onChange={onToggle}
          />
        </label>
      </td>
      <td>
        <div className="batch-product-cell">
          {item.mainImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.mainImage} alt="" width={37} height={37} loading="lazy" />
          ) : (
            <span className="batch-image-placeholder" aria-hidden="true" />
          )}
          <span>
            <strong>{item.title}</strong>
            <small>1688 · {item.sourceProductId}</small>
          </span>
        </div>
      </td>
      <td>
        <strong className="batch-cell-primary">{item.shopName ?? '未命名店铺'}</strong>
        <small className="batch-cell-secondary">{platformLabel(item.platform)}</small>
      </td>
      <td className="batch-mono">
        {action === 'sync_inventory' || action === 'online' ? (
          <InventorySummary
            totalStock={item.sourceTotalStock}
            skuCount={item.sourceSkuCount}
            inventoryVersion={item.sourceInventoryVersion}
          />
        ) : action === 'edit_title' ? (
          <>
            <strong className="batch-cell-primary">
              {item.titleEditable ? '可修改标题' : '当前不可修改'}
            </strong>
            <small className="batch-cell-secondary">{titleRuleLabel(item.platform)}</small>
          </>
        ) : (
          <>
            <strong className="batch-price-range">
              {formatPriceRange(item.priceRange ?? [item.salePrice, item.salePrice])}
            </strong>
            <small className="batch-cell-secondary">
              {item.skuCount > 0 ? `${item.skuCount} 个 SKU` : 'SKU 价格待核验'}
            </small>
          </>
        )}
        {action !== 'sync_inventory' && !selectable && unavailableReason ? (
          <small className="batch-row-note">{unavailableReason}</small>
        ) : null}
        {action === 'edit_title' && item.titleVerificationTaskId ? (
          <Link
            className="batch-row-link"
            href={`/published/batch?task=${encodeURIComponent(item.titleVerificationTaskId)}`}
          >
            打开待核验任务
          </Link>
        ) : null}
        {action === 'online' && item.onlineVerificationTaskId ? (
          <Link
            className="batch-row-link"
            href={`/published/batch?task=${encodeURIComponent(item.onlineVerificationTaskId)}`}
          >
            打开待核验上架任务
          </Link>
        ) : null}
      </td>
      <td>
        <StatusPill value={item.sourceAvailability} />
      </td>
      <td>
        <StatusPill value={item.inventorySyncStatus} />
        {action === 'sync_inventory' || action === 'online' ? (
          <>
            <small className="batch-cell-secondary">
              {action === 'online' ? '平台记录' : '已同步'} v{item.syncedInventoryVersion}
              {item.inventoryLastSyncedAt
                ? ` · ${new Date(item.inventoryLastSyncedAt).toLocaleString('zh-CN')}`
                : ' · 尚无成功时间'}
            </small>
            {action === 'sync_inventory' && !selectable && unavailableReason ? (
              <small className="batch-row-note">{unavailableReason}</small>
            ) : item.inventorySyncError ? (
              <small className="batch-row-note">上次错误：{item.inventorySyncError}</small>
            ) : null}
          </>
        ) : null}
      </td>
      <td>
        <StatusPill value={item.status} />
      </td>
    </tr>
  );
}

function TargetPriceEditor({
  items,
  page,
  totalPages,
  values,
  validations,
  validationAttempted,
  invalidCount,
  bulkValue,
  onBulkValueChange,
  onApplyBulk,
  onValueChange,
  onPageChange,
  inputRefs,
}: {
  items: ProductBatchCandidate[];
  page: number;
  totalPages: number;
  values: Record<string, string>;
  validations: Map<string, TargetPriceValidation>;
  validationAttempted: boolean;
  invalidCount: number;
  bulkValue: string;
  onBulkValueChange: (value: string) => void;
  onApplyBulk: () => void;
  onValueChange: (id: string, value: string) => void;
  onPageChange: (page: number) => void;
  inputRefs: { current: Map<string, HTMLInputElement> };
}) {
  const bulkValidation = normalizeTargetPrice(bulkValue);
  return (
    <section className="batch-target-panel" aria-labelledby="batch-target-heading">
      <div className="batch-catalog-toolbar">
        <div>
          <p className="batch-step-label">03 · 设置目标价</p>
          <h2 id="batch-target-heading" className="batch-section-title">
            逐项目标起售价
          </h2>
          <p className="batch-target-description">
            目标起售价决定最低 SKU；其余 SKU 按相同比例调整，最终价格区间会在预览中再次确认。
          </p>
        </div>
        <div className="batch-bulk-price-control">
          <label htmlFor="batch-bulk-target-price">统一填入</label>
          <div>
            <span aria-hidden="true">¥</span>
            <input
              id="batch-bulk-target-price"
              name="batch-bulk-target-price"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="例如 39.90"
              value={bulkValue}
              aria-invalid={Boolean(bulkValue && !bulkValidation.value)}
              aria-describedby="batch-bulk-target-help"
              onChange={(event) => onBulkValueChange(event.target.value)}
            />
            <button type="button" disabled={!bulkValidation.value} onClick={onApplyBulk}>
              填入全部
            </button>
          </div>
          <small id="batch-bulk-target-help">
            {bulkValue && !bulkValidation.value
              ? bulkValidation.error
              : '可统一填入后，再修改个别商品。'}
          </small>
        </div>
      </div>

      {validationAttempted && invalidCount > 0 ? (
        <p className="batch-target-error-summary" role="alert">
          还有 {invalidCount} 件商品缺少有效目标起售价，请完成后再生成预览。
        </p>
      ) : null}

      <div className="batch-table-shell">
        <table className="batch-table batch-target-table">
          <thead>
            <tr>
              <th>商品</th>
              <th>当前价格区间</th>
              <th>SKU</th>
              <th>目标起售价</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const id = item.publishedProductId;
              const validation = validations.get(id) ?? normalizeTargetPrice('');
              const errorId = `batch-target-price-error-${id}`;
              return (
                <tr key={id}>
                  <td>
                    <div className="batch-product-cell">
                      {item.mainImage ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.mainImage} alt="" width={37} height={37} loading="lazy" />
                      ) : (
                        <span className="batch-image-placeholder" aria-hidden="true" />
                      )}
                      <span>
                        <strong>{item.title}</strong>
                        <small>{item.shopName ?? '未命名店铺'}</small>
                      </span>
                    </div>
                  </td>
                  <td className="batch-mono">
                    {formatPriceRange(item.priceRange ?? [item.salePrice, item.salePrice])}
                  </td>
                  <td className="batch-mono">{item.skuCount}</td>
                  <td>
                    <label className="batch-target-price-field">
                      <span className="sr-only">{item.title} 的目标起售价</span>
                      <span aria-hidden="true">¥</span>
                      <input
                        ref={(node) => {
                          if (node) inputRefs.current.set(id, node);
                          else inputRefs.current.delete(id);
                        }}
                        name={`target-price-${id}`}
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder="0.00"
                        value={values[id] ?? ''}
                        aria-invalid={validationAttempted && !validation.value}
                        aria-describedby={
                          validationAttempted && !validation.value ? errorId : undefined
                        }
                        onChange={(event) => onValueChange(id, event.target.value)}
                      />
                    </label>
                    {validationAttempted && !validation.value ? (
                      <small id={errorId} className="batch-field-error">
                        {validation.error}
                      </small>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 ? (
        <div className="batch-pagination">
          <span>
            目标价第 {page} / {totalPages} 页
          </span>
          <div>
            <button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
              上一页
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => onPageChange(page + 1)}
            >
              下一页
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function TargetTitleEditor({
  items,
  page,
  totalPages,
  values,
  validations,
  validationAttempted,
  invalidCount,
  onValueChange,
  onPageChange,
  inputRefs,
}: {
  items: ProductBatchCandidate[];
  page: number;
  totalPages: number;
  values: Record<string, string>;
  validations: Map<string, TargetTitleValidation>;
  validationAttempted: boolean;
  invalidCount: number;
  onValueChange: (id: string, value: string) => void;
  onPageChange: (page: number) => void;
  inputRefs: { current: Map<string, HTMLInputElement> };
}) {
  return (
    <section className="batch-target-panel" aria-labelledby="batch-title-target-heading">
      <div className="batch-catalog-toolbar">
        <div>
          <p className="batch-step-label">03 · 设置目标标题</p>
          <h2 id="batch-title-target-heading" className="batch-section-title">
            逐项修改标题
          </h2>
          <p className="batch-target-description">
            每件商品按目标平台规则单独确认标题；执行前后都会核对商品快照和平台结果。
          </p>
        </div>
      </div>

      {validationAttempted && invalidCount > 0 ? (
        <p className="batch-target-error-summary" role="alert">
          还有 {invalidCount} 件商品的目标标题不符合对应平台规则，请修正后再生成预览。
        </p>
      ) : null}

      <div className="batch-table-shell">
        <table className="batch-table batch-target-table">
          <thead>
            <tr>
              <th>商品</th>
              <th>店铺 / 平台</th>
              <th>当前标题</th>
              <th>目标标题</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const id = item.publishedProductId;
              const validation = validations.get(id) ?? normalizeTargetTitle('', item.platform);
              const errorId = `batch-target-title-error-${id}`;
              return (
                <tr key={id}>
                  <td>
                    <div className="batch-product-cell">
                      {item.mainImage ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.mainImage} alt="" width={37} height={37} loading="lazy" />
                      ) : (
                        <span className="batch-image-placeholder" aria-hidden="true" />
                      )}
                      <span>
                        <strong>{item.title}</strong>
                        <small>1688 · {item.sourceProductId}</small>
                      </span>
                    </div>
                  </td>
                  <td>
                    <strong className="batch-cell-primary">{item.shopName ?? '未命名店铺'}</strong>
                    <small className="batch-cell-secondary">{platformLabel(item.platform)}</small>
                  </td>
                  <td>
                    <span className="batch-cell-primary">{item.title}</span>
                  </td>
                  <td>
                    <label className="batch-target-price-field">
                      <span className="sr-only">{item.title} 的目标标题</span>
                      <input
                        ref={(node) => {
                          if (node) inputRefs.current.set(id, node);
                          else inputRefs.current.delete(id);
                        }}
                        name={`target-title-${id}`}
                        type="text"
                        autoComplete="off"
                        maxLength={titleInputMaxLength(item.platform)}
                        value={values[id] ?? item.title}
                        aria-invalid={validationAttempted && !validation.value}
                        aria-describedby={
                          validationAttempted && !validation.value ? errorId : undefined
                        }
                        onChange={(event) => onValueChange(id, event.target.value)}
                      />
                    </label>
                    {validationAttempted && !validation.value ? (
                      <small id={errorId} className="batch-field-error">
                        {validation.error}
                      </small>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 ? (
        <div className="batch-pagination">
          <span>
            标题第 {page} / {totalPages} 页
          </span>
          <div>
            <button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
              上一页
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => onPageChange(page + 1)}
            >
              下一页
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function BatchTask({
  taskId,
  sessionScope,
  onStartNew,
}: {
  taskId: string;
  sessionScope: ProductBatchSessionScope;
  onStartNew: () => void;
}) {
  const qc = useQueryClient();
  const [itemFilter, setItemFilter] = useState<(typeof RESULT_FILTERS)[number]['value']>('all');
  const task = useQuery({
    queryKey: ['productBatchTask', taskId],
    queryFn: () => api.productBatchTask(taskId),
    refetchInterval: (query) =>
      query.state.data && ACTIVE_TASK_STATUSES.has(query.state.data.status) ? 2500 : false,
    refetchIntervalInBackground: false,
  });
  const refresh = (value: ProductBatchTask) => {
    if (value.status !== 'preview') clearProductBatchSessionForTask(sessionScope, value);
    qc.setQueryData(['productBatchTask', taskId], value);
    void qc.invalidateQueries({ queryKey: ['productBatchCandidates'] });
    void qc.invalidateQueries({ queryKey: ['publishTasks'] });
    void qc.invalidateQueries({ queryKey: ['productBatchTasks'] });
  };
  const execute = useMutation({
    mutationFn: (previewRevision: number) => api.executeProductBatch(taskId, previewRevision),
    onSuccess: refresh,
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelProductBatch(taskId),
    onSuccess: refresh,
  });
  const retry = useMutation({
    mutationFn: (itemIds: string[]) => api.retryProductBatch(taskId, itemIds),
    onSuccess: refresh,
  });
  const verifyTitle = useMutation({
    mutationFn: (itemId: string) => api.verifyProductBatchTitle(taskId, itemId),
    onSuccess: refresh,
  });
  const verifyOnline = useMutation({
    mutationFn: (itemId: string) => api.verifyProductBatchOnline(taskId, itemId),
    onSuccess: refresh,
  });
  const taskMutationPending =
    execute.isPending ||
    cancel.isPending ||
    retry.isPending ||
    verifyTitle.isPending ||
    verifyOnline.isPending;

  useEffect(() => {
    if (task.data && task.data.status !== 'preview') {
      clearProductBatchSessionForTask(sessionScope, task.data);
    }
  }, [sessionScope, task.data]);

  if (task.isLoading && !task.data) return <BatchLoading />;
  if (!task.data) return <BatchError error={task.error} />;
  const value = task.data;
  const onlineAction = value.action === 'online';
  const titleAction = value.action === 'edit_title';
  const priceAction = value.action === 'edit_price';
  const inventoryAction = value.action === 'sync_inventory';
  const verifiedAction = onlineAction || titleAction || priceAction || inventoryAction;
  const active = ACTIVE_TASK_STATUSES.has(value.status);
  const preview = value.status === 'preview';
  const retryableFailedIds = value.items
    .filter((item) => item.status === 'failed' && item.retryable)
    .map((item) => item.itemId);
  const unknownTitleResultCount = value.items.filter(
    (item) => item.status === 'failed' && item.errorCode === 'TITLE_RESULT_UNKNOWN',
  ).length;
  const unknownOnlineResultCount = value.items.filter(
    (item) =>
      item.status === 'failed' &&
      item.errorCode !== null &&
      ONLINE_RESULT_UNKNOWN_CODES.has(item.errorCode),
  ).length;
  const canRetry = ['failed', 'partial'].includes(value.status) && retryableFailedIds.length > 0;
  const pendingExecution = value.summary.pending + value.summary.retryWait;
  const visibleItems =
    itemFilter === 'all'
      ? value.items
      : value.items.filter((item) => matchesResultFilter(item.status, itemFilter));
  const priceChanges = priceAction
    ? value.items.reduce(
        (summary, item) => {
          if (item.beforePrice === null || item.desiredPrice === null) return summary;
          if (item.desiredPrice > item.beforePrice) summary.increased += 1;
          if (item.desiredPrice < item.beforePrice) summary.decreased += 1;
          return summary;
        },
        { increased: 0, decreased: 0 },
      )
    : null;

  return (
    <div className="space-y-5">
      <section className="batch-progress-panel">
        <div className="batch-progress-copy">
          <p className="batch-step-label">{preview ? '03 · 差异预览' : '执行任务'}</p>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="batch-section-title">
              {batchActionLabel(value.action)} · {value.summary.total} 件
            </h2>
            <TaskStatusBadge status={value.status} />
          </div>
          <p className="batch-section-description">
            {preview
              ? onlineAction
                ? '确认前请检查上架前状态、1688 目标库存与版本；执行后只有平台在线且逐 SKU 库存一致才会成功。'
                : titleAction
                  ? '确认前请逐件检查当前标题和目标标题；执行后将回读平台标题核验。'
                  : priceAction
                    ? '确认前请检查每件商品的起售价、SKU 价格区间和调整方向。'
                    : inventoryAction
                      ? '确认前请检查同步前库存、1688 权威目标快照及库存版本；执行后将逐 SKU 回读平台核验。'
                      : '确认前请检查每件商品的当前状态与执行后状态。'
              : active
                ? `任务按商品独立${onlineAction ? '补齐库存、上架并回读平台状态与库存' : titleAction ? '改标题并回读平台标题' : priceAction ? '改价并回读平台价格' : inventoryAction ? '同步并回读平台库存' : '执行'}；停止只影响尚未开始的条目。`
                : '任务结果已持久化，可安全刷新或稍后返回查看。'}
          </p>
        </div>
        <div
          className="batch-progress-orbit"
          role="progressbar"
          aria-label="批量任务完成进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={value.summary.progressPercent}
          style={{ '--batch-progress': `${value.summary.progressPercent}%` } as CSSProperties}
        >
          <strong>{value.summary.progressPercent}%</strong>
          <span>完成</span>
        </div>
      </section>

      {task.isError ? (
        <div className="batch-inline-warning" role="alert">
          <span>进度刷新暂时失败，当前仍显示最近一次成功结果。</span>
          <button type="button" onClick={() => void task.refetch()}>
            重新读取
          </button>
        </div>
      ) : null}

      <p className="sr-only" aria-live="polite">
        {formatTaskStatus(value.status)}，已完成 {value.summary.completed} / {value.summary.total}{' '}
        件。
      </p>

      <section className="batch-metrics-grid" aria-label="批量任务汇总">
        <Metric label="总计" value={value.summary.total} />
        <Metric label="等待" value={value.summary.pending + value.summary.retryWait} />
        <Metric label="执行中" value={value.summary.running} tone="indigo" />
        <Metric label="成功" value={value.summary.succeeded} tone="green" />
        <Metric label="失败" value={value.summary.failed} tone="red" />
        <Metric label="跳过 / 停止" value={value.summary.skipped + value.summary.cancelled} />
      </section>

      <section className="batch-catalog-panel">
        <div className="batch-catalog-toolbar">
          <div>
            <p className="batch-step-label">逐项结果</p>
            <h2 className="batch-section-title">变化明细</h2>
          </div>
          <span className="batch-task-id">Task #{value.taskId}</span>
        </div>
        <div className="batch-filter-row" role="group" aria-label="逐项结果筛选">
          {RESULT_FILTERS.map((filter) => {
            const count =
              filter.value === 'all'
                ? value.items.length
                : value.items.filter((item) => matchesResultFilter(item.status, filter.value))
                    .length;
            return (
              <button
                key={filter.value}
                type="button"
                aria-pressed={itemFilter === filter.value}
                className={itemFilter === filter.value ? 'is-active' : ''}
                onClick={() => setItemFilter(filter.value)}
              >
                {filter.label} {count}
              </button>
            );
          })}
        </div>
        <div className="batch-table-shell">
          <table
            className={`batch-table batch-result-table ${verifiedAction ? 'is-verified' : ''}`}
          >
            <thead>
              <tr>
                <th>商品</th>
                <th>店铺 / 平台</th>
                <th>
                  {titleAction
                    ? '修改前'
                    : priceAction
                      ? '改价前'
                      : inventoryAction
                        ? '同步前'
                        : onlineAction
                          ? '上架前'
                          : '当前'}
                </th>
                <th>
                  {titleAction
                    ? '目标标题'
                    : priceAction
                      ? '目标价格'
                      : inventoryAction
                        ? '1688 目标'
                        : onlineAction
                          ? '上架目标'
                          : '执行后'}
                </th>
                {verifiedAction ? <th>平台回读</th> : null}
                <th>执行状态</th>
                <th>尝试</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((item) => (
                <TaskItemRow
                  key={item.itemId}
                  item={item}
                  action={value.action}
                  verifyingTitle={verifyTitle.isPending}
                  verifyingOnline={verifyOnline.isPending}
                  verificationDisabled={taskMutationPending}
                  onVerifyTitle={() => verifyTitle.mutate(item.itemId)}
                  onVerifyOnline={() => verifyOnline.mutate(item.itemId)}
                />
              ))}
            </tbody>
          </table>
          {visibleItems.length === 0 ? (
            <div className="batch-empty-state">当前筛选条件下没有任务条目。</div>
          ) : null}
        </div>
      </section>

      <section className="batch-confirm-panel">
        <div>
          <strong>{preview ? '预览不会产生平台变更' : formatTaskStatus(value.status)}</strong>
          <span>
            {preview
              ? priceAction
                ? `${pendingExecution} 件可执行；${priceChanges?.increased ?? 0} 件上调，${priceChanges?.decreased ?? 0} 件下调，${value.summary.skipped} 件跳过。`
                : `${pendingExecution} 件可执行，${value.summary.skipped} 件将跳过。`
              : active
                ? `已完成 ${value.summary.completed} / ${value.summary.total} 件。`
                : `完成于 ${value.finishedAt ? new Date(value.finishedAt).toLocaleString('zh-CN') : '—'}`}
          </span>
        </div>
        <div className="batch-selection-actions">
          {preview ? (
            <>
              <button
                type="button"
                className="batch-quiet-button"
                disabled={cancel.isPending || execute.isPending}
                onClick={() => cancel.mutate()}
              >
                放弃预览
              </button>
              <button
                type="button"
                className={verifiedAction ? 'batch-primary-button' : 'batch-danger-button'}
                disabled={execute.isPending || cancel.isPending}
                onClick={() => execute.mutate(value.previewRevision)}
              >
                {execute.isPending
                  ? '提交中…'
                  : `确认${batchActionLabel(value.action)} ${pendingExecution} 件商品`}
              </button>
            </>
          ) : active ? (
            <button
              type="button"
              className="batch-danger-outline-button"
              disabled={taskMutationPending || value.status === 'cancelling'}
              onClick={() => cancel.mutate()}
            >
              {value.status === 'cancelling' ? '正在停止剩余操作…' : '停止剩余操作'}
            </button>
          ) : (
            <>
              {canRetry ? (
                <button
                  type="button"
                  className="batch-primary-button"
                  disabled={taskMutationPending}
                  onClick={() => retry.mutate(retryableFailedIds)}
                >
                  {retry.isPending ? '重新入队中…' : `重试 ${retryableFailedIds.length} 个失败项`}
                </button>
              ) : null}
              <button type="button" className="batch-secondary-button" onClick={onStartNew}>
                新建批量任务
              </button>
            </>
          )}
        </div>
        {[execute.error, cancel.error, retry.error, verifyTitle.error, verifyOnline.error].find(
          Boolean,
        ) ? (
          <p className="batch-bar-error" role="alert">
            {errorMessage(
              [
                execute.error,
                cancel.error,
                retry.error,
                verifyTitle.error,
                verifyOnline.error,
              ].find(Boolean),
            )}
          </p>
        ) : null}
        {unknownTitleResultCount > 0 ? (
          <p className="batch-bar-error" role="alert">
            {unknownTitleResultCount}{' '}
            个标题更新结果未知。请等待平台处理完成，再逐项执行“核验平台标题”。
          </p>
        ) : null}
        {unknownOnlineResultCount > 0 ? (
          <p className="batch-bar-error" role="alert">
            {unknownOnlineResultCount}{' '}
            个上架结果未知。不要直接重试，请逐项执行“核验平台上架结果”，确认平台在线状态和库存。
          </p>
        ) : null}
      </section>
    </div>
  );
}

function TaskItemRow({
  item,
  action,
  verifyingTitle,
  verifyingOnline,
  verificationDisabled,
  onVerifyTitle,
  onVerifyOnline,
}: {
  item: ProductBatchItem;
  action: ProductBatchAction;
  verifyingTitle: boolean;
  verifyingOnline: boolean;
  verificationDisabled: boolean;
  onVerifyTitle: () => void;
  onVerifyOnline: () => void;
}) {
  const onlineAction = action === 'online';
  const titleAction = action === 'edit_title';
  const priceAction = action === 'edit_price';
  const inventoryAction = action === 'sync_inventory';
  const actualMismatch =
    priceAction &&
    item.status === 'succeeded' &&
    item.actualPriceRange !== null &&
    item.desiredPriceRange !== null &&
    !samePriceRange(item.actualPriceRange, item.desiredPriceRange);
  const actualInventoryMismatch =
    (onlineAction || inventoryAction) &&
    item.status === 'succeeded' &&
    item.actualInventory !== null &&
    item.desiredInventory !== null &&
    !sameInventorySnapshot(item.actualInventory, item.desiredInventory);
  const actualStatusMismatch =
    onlineAction &&
    item.status === 'succeeded' &&
    item.actualStatus !== null &&
    item.actualStatus !== item.desiredStatus;
  const actualTitleMismatch =
    titleAction &&
    item.status === 'succeeded' &&
    item.actualTitle !== null &&
    item.desiredTitle !== null &&
    item.actualTitle !== item.desiredTitle;
  return (
    <tr>
      <td>
        <div className="batch-product-cell">
          {item.mainImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.mainImage} alt="" width={37} height={37} loading="lazy" />
          ) : (
            <span className="batch-image-placeholder" aria-hidden="true" />
          )}
          <span>
            <strong>{item.title}</strong>
            <small>{item.platformProductId ?? '无平台 ID'}</small>
          </span>
        </div>
      </td>
      <td>
        <strong className="batch-cell-primary">{item.shopName ?? '未命名店铺'}</strong>
        <small className="batch-cell-secondary">{platformLabel(item.platform)}</small>
      </td>
      {onlineAction ? (
        <>
          <td className="batch-mono">
            <StatusPill value={item.beforeStatus} />
            <InventorySnapshotSummary
              value={item.beforeInventory}
              inventoryVersion={item.beforeInventoryVersion}
              emptyLabel="上架前库存快照缺失"
            />
          </td>
          <td className="batch-mono">
            <StatusPill value={item.desiredStatus} />
            <InventorySnapshotSummary
              value={item.desiredInventory}
              inventoryVersion={item.desiredInventoryVersion}
              emptyLabel="1688 上架库存待核验"
            />
          </td>
          <td className="batch-mono">
            {item.actualStatus ? (
              <StatusPill value={item.actualStatus} />
            ) : (
              <span className="batch-cell-secondary">
                {item.status === 'succeeded' ? '状态回读待核验' : '执行后回读'}
              </span>
            )}
            <InventorySnapshotSummary
              value={item.actualInventory}
              inventoryVersion={item.actualInventory === null ? null : item.desiredInventoryVersion}
              emptyLabel={item.status === 'succeeded' ? '库存回读待核验' : '执行后回读库存'}
            />
            {actualStatusMismatch ? (
              <small className="batch-row-error">平台状态与上架目标不一致</small>
            ) : null}
            {actualInventoryMismatch ? (
              <small className="batch-row-error">平台库存与 1688 上架快照不一致</small>
            ) : null}
          </td>
        </>
      ) : titleAction ? (
        <>
          <td>
            <TitleValue value={item.beforeTitle} emptyLabel="修改前标题缺失" />
          </td>
          <td>
            <TitleValue value={item.desiredTitle} emptyLabel="目标标题缺失" />
          </td>
          <td>
            <TitleValue
              value={item.actualTitle}
              emptyLabel={item.status === 'succeeded' ? '回读待核验' : '执行后回读'}
            />
            {actualTitleMismatch ? (
              <small className="batch-row-error">与目标标题不一致</small>
            ) : null}
          </td>
        </>
      ) : priceAction ? (
        <>
          <td className="batch-mono">
            <PriceRange value={item.beforePriceRange} skuCount={item.skuCount} />
          </td>
          <td className="batch-mono">
            <PriceRange value={item.desiredPriceRange} skuCount={item.skuCount} />
            <PriceDelta before={item.beforePrice} desired={item.desiredPrice} />
          </td>
          <td className="batch-mono">
            {item.actualPriceRange ? (
              <>
                <PriceRange value={item.actualPriceRange} skuCount={item.skuCount} />
                {actualMismatch ? (
                  <small className="batch-row-error">与目标价格不一致</small>
                ) : null}
              </>
            ) : (
              <span className="batch-cell-secondary">
                {item.status === 'succeeded' ? '回读待核验' : '执行后回读'}
              </span>
            )}
          </td>
        </>
      ) : inventoryAction ? (
        <>
          <td className="batch-mono">
            <InventorySnapshotSummary
              value={item.beforeInventory}
              inventoryVersion={item.beforeInventoryVersion}
              emptyLabel="同步前快照缺失"
            />
          </td>
          <td className="batch-mono">
            <InventorySnapshotSummary
              value={item.desiredInventory}
              inventoryVersion={item.desiredInventoryVersion}
              emptyLabel="1688 快照待核验"
            />
          </td>
          <td className="batch-mono">
            <InventorySnapshotSummary
              value={item.actualInventory}
              inventoryVersion={item.actualInventory === null ? null : item.desiredInventoryVersion}
              emptyLabel={item.status === 'succeeded' ? '回读待核验' : '执行后回读'}
            />
            {actualInventoryMismatch ? (
              <small className="batch-row-error">与 1688 目标快照不一致</small>
            ) : null}
          </td>
        </>
      ) : (
        <>
          <td>
            <StatusPill value={item.beforeStatus} />
          </td>
          <td>
            <span className="batch-change-arrow">→</span> <StatusPill value={item.desiredStatus} />
          </td>
        </>
      )}
      <td>
        <StatusPill value={item.status} />
        {item.errorMessage ? <small className="batch-row-error">{item.errorMessage}</small> : null}
        {item.errorCode === 'TITLE_RESULT_UNKNOWN' ? (
          <button
            type="button"
            className="batch-inline-action"
            disabled={verificationDisabled}
            onClick={onVerifyTitle}
          >
            {verifyingTitle ? '核验中…' : '核验平台标题'}
          </button>
        ) : null}
        {item.status === 'failed' &&
        item.errorCode !== null &&
        ONLINE_RESULT_UNKNOWN_CODES.has(item.errorCode) ? (
          <button
            type="button"
            className="batch-inline-action"
            disabled={verificationDisabled}
            onClick={onVerifyOnline}
          >
            {verifyingOnline ? '核验中…' : '核验平台上架结果'}
          </button>
        ) : null}
      </td>
      <td className="batch-mono">
        {item.attempts}/{item.maxAttempts}
      </td>
    </tr>
  );
}

function TitleValue({ value, emptyLabel }: { value: string | null; emptyLabel: string }) {
  return value ? (
    <span className="batch-title-value" title={value}>
      {value}
    </span>
  ) : (
    <span className="batch-cell-secondary">{emptyLabel}</span>
  );
}

function PriceRange({ value, skuCount }: { value: [number, number] | null; skuCount: number }) {
  return (
    <span className="batch-price-range-stack">
      <strong>{formatPriceRange(value)}</strong>
      <small>{skuCount > 0 ? `${skuCount} 个 SKU` : 'SKU 待核验'}</small>
    </span>
  );
}

function InventorySummary({
  totalStock,
  skuCount,
  inventoryVersion,
}: {
  totalStock: number;
  skuCount: number;
  inventoryVersion: number | null;
}) {
  return (
    <span className="batch-inventory-stack">
      <strong>{totalStock.toLocaleString('zh-CN')} 件</strong>
      <small>
        {skuCount} 个 SKU · {formatInventoryVersion(inventoryVersion)}
      </small>
    </span>
  );
}

function InventorySnapshotSummary({
  value,
  inventoryVersion,
  emptyLabel,
}: {
  value: ProductBatchInventorySnapshot | null;
  inventoryVersion: number | null;
  emptyLabel: string;
}) {
  const summary = summarizeInventorySnapshot(value);
  return summary ? (
    <InventorySummary {...summary} inventoryVersion={inventoryVersion} />
  ) : (
    <span className="batch-cell-secondary">{emptyLabel}</span>
  );
}

function PriceDelta({ before, desired }: { before: number | null; desired: number | null }) {
  if (before === null || desired === null || before === desired) return null;
  const delta = desired - before;
  const percent = before > 0 ? (delta / before) * 100 : 0;
  const tone = delta > 0 ? 'increase' : 'decrease';
  return (
    <small className="batch-price-delta" data-tone={tone}>
      {delta > 0 ? '+' : '−'}
      {formatCurrency(Math.abs(delta))} · {percent > 0 ? '+' : '−'}
      {Math.abs(percent).toFixed(2)}%
    </small>
  );
}

function Metric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div className="batch-metric" data-tone={tone}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusPill({ value }: { value: string }) {
  return (
    <span className="batch-status-pill" data-status={value}>
      {statusLabel(value)}
    </span>
  );
}

function TaskStatusBadge({ status }: { status: string }) {
  return (
    <span className="batch-task-status" data-status={status}>
      {formatTaskStatus(status)}
    </span>
  );
}

function BatchLoading() {
  return (
    <div className="batch-loading" role="status" aria-live="polite">
      <span aria-hidden="true" />
      正在读取最新商品状态…
    </div>
  );
}

function BatchError({ error }: { error: unknown }) {
  return (
    <div className="batch-error-panel" role="alert">
      <strong>无法读取批量工作台</strong>
      <span>{errorMessage(error)}</span>
    </div>
  );
}

function platformLabel(value: string): string {
  if (value === 'douyin') return '抖音小店';
  if (value === 'taobao') return '淘宝';
  if (value === 'pdd') return '拼多多';
  return value;
}

function statusLabel(value: string): string {
  const labels: Record<string, string> = {
    online: '在线',
    offline: '已下架',
    draft: '待审核',
    rejected: '已驳回',
    reviewing: '审核中',
    approved_pending_online: '审核通过待上架',
    blocked: '已受限',
    deleted: '已删除',
    available: '可售',
    out_of_stock: '缺货',
    unknown: '待核验',
    pending: '等待执行',
    running: '执行中',
    retry_wait: '等待重试',
    succeeded: '成功',
    failed: '失败',
    skipped: '跳过',
    cancelled: '已停止',
    synced: '已同步',
    syncing: '同步中',
    dead: '同步失败',
  };
  return labels[value] ?? value;
}

function formatTaskStatus(value: string): string {
  const labels: Record<string, string> = {
    preview: '等待确认',
    queued: '已排队',
    running: '执行中',
    cancelling: '正在停止',
    cancelled: '已停止',
    partial: '部分完成',
    succeeded: '全部完成',
    failed: '执行失败',
  };
  return labels[value] ?? value;
}

function matchesResultFilter(status: string, filter: string): boolean {
  return filter === 'waiting' ? status === 'pending' || status === 'retry_wait' : status === filter;
}

function batchActionLabel(action: ProductBatchAction): string {
  if (action === 'online') return '批量上架';
  if (action === 'edit_title') return '批量改标题';
  if (action === 'edit_price') return '批量改价';
  if (action === 'sync_inventory') return '同步并核验库存';
  return '批量下架';
}

function batchActionVerb(action: ProductBatchAction): string {
  if (action === 'online') return '上架';
  if (action === 'edit_title') return '改标题';
  if (action === 'edit_price') return '改价';
  if (action === 'sync_inventory') return '同步库存';
  return '下架';
}

function batchActionDescription(action: ProductBatchAction): string {
  if (action === 'online') {
    return '只选择可安全恢复销售的已下架商品；先锁定 1688 库存，上架后同时回读平台状态与逐 SKU 库存。';
  }
  if (action === 'edit_title') {
    return '逐件填写目标标题，执行后回读平台确认；可恢复失败项单独重试，结果未知项必须先核验。';
  }
  if (action === 'edit_price') {
    return '先定义改价规则，再逐件核对 SKU 价格区间；平台回读后才记为成功。';
  }
  if (action === 'sync_inventory') {
    return '按 1688 权威 SKU 库存快照同步，写入后回读平台逐项核验；不是手填库存。';
  }
  return '先生成逐项预览，再安全下架；成功项不会因失败重试而重复执行。';
}

export function isCandidateSelectable(
  item: ProductBatchCandidate,
  action: ProductBatchAction,
): boolean {
  if (action === 'online') {
    return hasValidOnlineCandidateState(item) && item.onlineEligible === true;
  }
  if (action === 'edit_title') return item.titleEditable;
  if (action === 'edit_price') return item.priceEditable;
  if (action === 'sync_inventory') return item.inventorySyncEligible;
  return item.status === 'online';
}

export function candidateUnavailableReason(
  item: ProductBatchCandidate,
  action: ProductBatchAction,
): string | null {
  if (isCandidateSelectable(item, action)) return null;
  if (action === 'online') {
    if (!hasValidOnlineCandidateState(item)) {
      return '商品上架安全状态异常，请刷新商品后再操作';
    }
    return item.onlineReason ?? '当前商品不能安全上架，请刷新后重试';
  }
  if (action === 'edit_title') return item.titleEditReason ?? '当前商品不能安全修改标题';
  if (action === 'edit_price') return item.priceEditReason ?? '当前商品缺少可核对的 SKU 价格';
  if (action === 'sync_inventory') {
    return item.inventorySyncReason ?? '当前商品没有可安全同步的 1688 库存快照';
  }
  return item.status === 'offline' ? '商品已经下架' : '只有在线商品可以下架';
}

function formatCurrency(value: number): string {
  return CURRENCY_FORMATTER.format(value);
}

function formatPriceRange(value: [number, number] | null): string {
  if (!value) return '—';
  return value[0] === value[1]
    ? formatCurrency(value[0])
    : `${formatCurrency(value[0])}–${formatCurrency(value[1])}`;
}

function samePriceRange(left: [number, number], right: [number, number]): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function formatInventoryVersion(value: number | null): string {
  return value === null ? '版本待核验' : `库存 v${value}`;
}

export function summarizeInventorySnapshot(
  value: ProductBatchInventorySnapshot | null,
): { totalStock: number; skuCount: number } | null {
  if (!value) return null;
  return {
    totalStock: value.items.reduce((total, item) => total + item.stock, 0),
    skuCount: value.items.length,
  };
}

export function sameInventorySnapshot(
  left: ProductBatchInventorySnapshot,
  right: ProductBatchInventorySnapshot,
): boolean {
  if (left.items.length !== right.items.length) return false;
  const leftStocks = new Map(left.items.map((item) => [item.sourceSkuId, item.stock] as const));
  return right.items.every((item) => leftStocks.get(item.sourceSkuId) === item.stock);
}

export function validatePercentageInput(
  value: string,
  direction: PriceDirection,
): { value: number | null; error: string } {
  const match = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return { value: null, error: '请输入最多两位小数的调整比例。' };
  const basisPoints = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (basisPoints < 1) return { value: null, error: '调整比例至少为 0.01%。' };
  if (direction === 'decrease' && basisPoints >= 10_000) {
    return { value: null, error: '下调比例必须小于 100%。' };
  }
  if (basisPoints > 100_000) return { value: null, error: '上调比例不能超过 1000%。' };
  return { value: basisPoints, error: '' };
}

export function normalizeTargetPrice(value: string): TargetPriceValidation {
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return { value: null, error: '请输入最多两位小数的目标起售价。' };
  const whole = BigInt(match[1]!);
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const cents = whole * 100n + BigInt(fraction);
  if (cents < 1n || cents > 100_000_000n) {
    return { value: null, error: '目标起售价须在 ¥0.01～¥1,000,000.00 之间。' };
  }
  return { value: `${whole.toString()}.${fraction}`, error: '' };
}

export function normalizeTargetTitle(value: string, platform = 'douyin'): TargetTitleValidation {
  const title = value.trim();
  if (!title) return { value: null, error: '请输入目标标题。' };
  if (/\r|\n/.test(title)) return { value: null, error: '目标标题不能包含换行符。' };
  if (platform !== 'douyin') {
    const maxLength = ['pdd', 'kuaishou', 'wechat_shop'].includes(platform) ? 30 : 60;
    return [...title].length <= maxLength
      ? { value: title, error: '' }
      : { value: null, error: `目标标题不能超过 ${maxLength} 个字符。` };
  }
  const characterUnits = [...title].reduce(
    (total, character) => total + (/^[\x00-\x7f]$/.test(character) ? 1 : 2),
    0,
  );
  if (characterUnits < 16) {
    return { value: null, error: '目标标题至少需要 8 个汉字或 16 个字符。' };
  }
  if (characterUnits > 60) {
    return { value: null, error: '目标标题不能超过 30 个汉字或 60 个字符。' };
  }
  return { value: title, error: '' };
}

function titleRuleLabel(platform: string): string {
  if (platform === 'douyin') return '8～30 个汉字 / 16～60 字符';
  const maxLength = ['pdd', 'kuaishou', 'wechat_shop'].includes(platform) ? 30 : 60;
  return `最多 ${maxLength} 个字符`;
}

function titleInputMaxLength(platform: string): number {
  if (platform === 'douyin') return 60;
  const maxLength = ['pdd', 'kuaishou', 'wechat_shop'].includes(platform) ? 30 : 60;
  return maxLength * 2;
}

export function productBatchPreviewFingerprint(input: ProductBatchPreviewInput): string {
  return JSON.stringify({
    action: input.action,
    publishedProductIds: [...input.publishedProductIds].sort(),
    ...(input.action === 'edit_title'
      ? {
          titleTargets: [...input.titleTargets].sort((left, right) =>
            left.publishedProductId.localeCompare(right.publishedProductId),
          ),
        }
      : {}),
    ...(input.action === 'edit_price'
      ? {
          priceRule:
            input.priceRule.mode === 'targets'
              ? {
                  ...input.priceRule,
                  targets: [...input.priceRule.targets].sort((left, right) =>
                    left.publishedProductId.localeCompare(right.publishedProductId),
                  ),
                }
              : input.priceRule,
        }
      : {}),
  });
}

export function shouldAcceptProductBatchPreviewResponse(
  attempt: { fingerprint: string; clientRequestId: string } | null,
  request: ProductBatchPreviewRequest,
): boolean {
  if (!attempt || attempt.clientRequestId !== request.clientRequestId) return false;
  const input: ProductBatchPreviewInput =
    request.action === 'edit_title'
      ? {
          action: 'edit_title',
          publishedProductIds: request.publishedProductIds,
          titleTargets: request.titleTargets,
        }
      : request.action === 'edit_price'
        ? {
            action: 'edit_price',
            publishedProductIds: request.publishedProductIds,
            priceRule: request.priceRule,
          }
        : { action: request.action, publishedProductIds: request.publishedProductIds };
  return attempt.fingerprint === productBatchPreviewFingerprint(input);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return '请求失败，请稍后重试。';
}
