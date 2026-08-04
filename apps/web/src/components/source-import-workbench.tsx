'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthStorageIdentity } from './auth-provider';
import {
  clearSourceImportWorkbenchSession,
  parseSourceImportReferences,
  readSourceImportWorkbenchSession,
  shouldAcceptSourceImportPreviewResponse,
  sourceImportPreviewFingerprint,
  writeSourceImportWorkbenchSession,
  type SourceImportPreviewSession,
  type SourceImportSessionScope,
} from './source-import-session';
import { ApiError, api, type Shop, type SourceImportItem, type SourceImportTask } from '../lib/api';
import { isDemoAuthMode } from '../lib/environment';

const ACTIVE_TASK_STATUSES = new Set(['queued', 'running', 'cancelling']);
const RECENT_TASK_LIMIT = 5;
const RESULT_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'waiting', label: '等待' },
  { value: 'running', label: '执行中' },
  { value: 'succeeded', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'skipped', label: '跳过' },
  { value: 'cancelled', label: '已停止' },
] as const;

export function SourceImportWorkbench() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const accountId = useAuthStorageIdentity();
  const taskId = searchParams.get('task')?.trim() || null;
  const sessionScope = useMemo<SourceImportSessionScope | null>(
    () => (accountId ? { accountId, pathname } : null),
    [accountId, pathname],
  );

  return (
    <main className="app-page batch-workbench source-import-workbench">
      <header className="batch-page-header">
        <div>
          <p className="page-kicker">Alibaba 1688 sourcing</p>
          <h1 className="page-title">批量采集货源</h1>
          <p className="page-description">
            一次检查最多 100 个 1688 商品，确认预览后再加入你的货源库。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/sources" className="batch-secondary-button">
            我的货源
          </Link>
          <Link href="/" className="batch-secondary-button">
            返回今日选品
          </Link>
        </div>
      </header>

      {!sessionScope ? (
        <SourceImportLoading label="正在确认当前账号…" />
      ) : taskId ? (
        <SourceImportTaskView
          taskId={taskId}
          sessionScope={sessionScope}
          onStartNew={() => {
            clearSourceImportWorkbenchSession(sessionScope);
            router.replace('/sources/import');
          }}
        />
      ) : (
        <SourceImportComposer sessionScope={sessionScope} />
      )}
    </main>
  );
}

function SourceImportComposer({ sessionScope }: { sessionScope: SourceImportSessionScope }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [hydrated, setHydrated] = useState(false);
  const [rawInput, setRawInput] = useState('');
  const [buyerShopId, setBuyerShopId] = useState('');
  const [storedPreview, setStoredPreview] = useState<SourceImportPreviewSession | null>(null);
  const previewAttempt = useRef<SourceImportPreviewSession | null>(null);
  const parsed = useMemo(() => parseSourceImportReferences(rawInput), [rawInput]);
  const invalidIssues = parsed.issues.filter((issue) => issue.code === 'invalid');
  const duplicateIssues = parsed.issues.filter((issue) => issue.code === 'duplicate');
  const shops = useQuery({
    queryKey: ['shops'],
    queryFn: () => api.shops(),
    enabled: hydrated,
  });
  const activeBuyers = useMemo(
    () =>
      (shops.data ?? []).filter(
        (shop): shop is Shop =>
          shop.platform === 'alibaba_1688' && shop.role === 'buyer' && shop.status === 'active',
      ),
    [shops.data],
  );
  const recent = useQuery({
    queryKey: ['sourceImportTasks', 1, RECENT_TASK_LIMIT],
    queryFn: () => api.sourceImportTasks(1, RECENT_TASK_LIMIT),
    enabled: hydrated,
  });
  const recovery = useQuery({
    queryKey: ['sourceImportTaskByClientRequest', storedPreview?.clientRequestId],
    queryFn: () => api.sourceImportTaskByClientRequest(storedPreview!.clientRequestId),
    enabled: hydrated && Boolean(storedPreview && !storedPreview.taskId),
    retry: false,
  });
  const createPreview = useMutation({
    mutationFn: (request: {
      clientRequestId: string;
      references: string[];
      buyerShopId?: string;
    }) => api.createSourceImportPreview(request),
    onSuccess: (task, request) => {
      if (
        task.clientRequestId !== request.clientRequestId ||
        !shouldAcceptSourceImportPreviewResponse(previewAttempt.current, request)
      ) {
        return;
      }
      const preview = { ...previewAttempt.current!, taskId: task.taskId };
      previewAttempt.current = preview;
      setStoredPreview(preview);
      writeSourceImportWorkbenchSession(sessionScope, {
        draft: { rawInput, buyerShopId },
        preview,
      });
      queryClient.setQueryData(['sourceImportTask', task.taskId], task);
      router.replace(`/sources/import?task=${encodeURIComponent(task.taskId)}`);
    },
  });

  useEffect(() => {
    const session = readSourceImportWorkbenchSession(sessionScope);
    setRawInput(session?.draft.rawInput ?? '');
    setBuyerShopId(session?.draft.buyerShopId ?? '');
    previewAttempt.current = session?.preview ?? null;
    setStoredPreview(session?.preview ?? null);
    setHydrated(true);
  }, [sessionScope]);

  useEffect(() => {
    if (!hydrated) return;
    writeSourceImportWorkbenchSession(sessionScope, {
      draft: { rawInput, buyerShopId },
      preview: storedPreview,
    });
  }, [buyerShopId, hydrated, rawInput, sessionScope, storedPreview]);

  useEffect(() => {
    if (!hydrated || isDemoAuthMode || activeBuyers.length !== 1 || buyerShopId) return;
    setBuyerShopId(activeBuyers[0]!.id);
  }, [activeBuyers, buyerShopId, hydrated]);

  useEffect(() => {
    if (!hydrated || !shops.data || !buyerShopId) return;
    if (activeBuyers.some((shop) => shop.id === buyerShopId)) return;
    setBuyerShopId('');
    previewAttempt.current = null;
    setStoredPreview(null);
  }, [activeBuyers, buyerShopId, hydrated, shops.data]);

  useEffect(() => {
    if (
      !recovery.data ||
      !storedPreview ||
      recovery.data.clientRequestId !== storedPreview.clientRequestId
    ) {
      return;
    }
    const preview = { ...storedPreview, taskId: recovery.data.taskId };
    previewAttempt.current = preview;
    setStoredPreview(preview);
    writeSourceImportWorkbenchSession(sessionScope, {
      draft: { rawInput, buyerShopId },
      preview,
    });
    queryClient.setQueryData(['sourceImportTask', recovery.data.taskId], recovery.data);
    router.replace(`/sources/import?task=${encodeURIComponent(recovery.data.taskId)}`);
  }, [buyerShopId, queryClient, rawInput, recovery.data, router, sessionScope, storedPreview]);

  useEffect(() => {
    if (!storedPreview?.taskId) return;
    router.replace(`/sources/import?task=${encodeURIComponent(storedPreview.taskId)}`);
  }, [router, storedPreview?.taskId]);

  const resetPreviewIntent = () => {
    previewAttempt.current = null;
    setStoredPreview(null);
    createPreview.reset();
  };
  const updateRawInput = (value: string) => {
    setRawInput(value);
    resetPreviewIntent();
  };
  const updateBuyerShop = (value: string) => {
    setBuyerShopId(value);
    resetPreviewIntent();
  };
  const buyerRequired =
    !isDemoAuthMode && shops.isSuccess && activeBuyers.length > 0 && !buyerShopId;
  const buyerMissing = !isDemoAuthMode && shops.isSuccess && activeBuyers.length === 0;
  const buyerLookupBlocked = !isDemoAuthMode && (shops.isPending || shops.isError);
  const canPreview =
    parsed.references.length > 0 &&
    !parsed.overLimit &&
    invalidIssues.length === 0 &&
    !buyerRequired &&
    !buyerMissing &&
    !buyerLookupBlocked &&
    !createPreview.isPending;

  const requestPreview = () => {
    if (!canPreview) return;
    const requestWithoutId = {
      references: parsed.references,
      ...(buyerShopId ? { buyerShopId } : {}),
    };
    const fingerprint = sourceImportPreviewFingerprint(requestWithoutId);
    if (previewAttempt.current?.fingerprint !== fingerprint) {
      previewAttempt.current = { fingerprint, clientRequestId: crypto.randomUUID() };
    }
    const preview = previewAttempt.current;
    setStoredPreview(preview);
    writeSourceImportWorkbenchSession(sessionScope, {
      draft: { rawInput, buyerShopId },
      preview,
    });
    createPreview.mutate({ ...requestWithoutId, clientRequestId: preview.clientRequestId });
  };

  if (!hydrated || (storedPreview && !storedPreview.taskId && recovery.isPending)) {
    return <SourceImportLoading label="正在恢复上一次采集预览…" />;
  }

  const recoveryMissing =
    recovery.error instanceof ApiError &&
    recovery.error.status === 404 &&
    storedPreview &&
    !storedPreview.taskId;

  return (
    <div className="space-y-5">
      <section className="source-import-input-panel" aria-labelledby="source-import-input-title">
        <div className="source-import-input-heading">
          <div>
            <p className="batch-step-label">01 · 选择货源</p>
            <h2 id="source-import-input-title" className="batch-section-title">
              粘贴 1688 商品
            </h2>
            <p className="batch-section-description">
              每行一个纯 offerId 或官方 HTTPS 1688 商品链接。重复项会自动合并。
            </p>
          </div>
          <span className="batch-safety-chip">最多 100 件</span>
        </div>

        <label className="source-import-textarea-label" htmlFor="source-import-references">
          商品链接或 offerId
        </label>
        <textarea
          id="source-import-references"
          value={rawInput}
          onChange={(event) => updateRawInput(event.target.value)}
          placeholder={'例如：\nhttps://detail.1688.com/offer/123456789.html\n987654321'}
          maxLength={20_000}
          spellCheck={false}
          aria-invalid={invalidIssues.length > 0 || parsed.overLimit}
          aria-describedby="source-import-input-summary"
          className="source-import-textarea"
        />

        <div
          id="source-import-input-summary"
          className="source-import-input-summary"
          aria-live="polite"
        >
          <span>识别 {parsed.references.length} 件</span>
          <span>重复 {duplicateIssues.length} 行</span>
          <span data-danger={invalidIssues.length > 0 || parsed.overLimit}>
            {parsed.overLimit
              ? `超出上限 ${parsed.references.length - 100} 件`
              : `无效 ${invalidIssues.length} 行`}
          </span>
        </div>

        {parsed.issues.length > 0 ? (
          <ul className="source-import-issue-list" aria-label="输入检查结果">
            {parsed.issues.slice(0, 6).map((issue) => (
              <li key={`${issue.line}-${issue.code}`} data-danger={issue.code === 'invalid'}>
                <strong>第 {issue.line} 行</strong>
                <span>{issue.message}</span>
              </li>
            ))}
            {parsed.issues.length > 6 ? <li>另有 {parsed.issues.length - 6} 行未展开</li> : null}
          </ul>
        ) : null}

        <div className="source-import-buyer-row">
          <div>
            <label htmlFor="source-import-buyer">1688 采购账号</label>
            <p>真实环境使用有效买家授权读取货源；演示环境可不选择。</p>
          </div>
          <select
            id="source-import-buyer"
            value={buyerShopId}
            onChange={(event) => updateBuyerShop(event.target.value)}
            disabled={shops.isPending || activeBuyers.length === 0}
          >
            <option value="">{isDemoAuthMode ? '演示采集（无需账号）' : '请选择采购账号'}</option>
            {activeBuyers.map((shop) => (
              <option key={shop.id} value={shop.id}>
                {shop.shopName ?? shop.platformShopId}
              </option>
            ))}
          </select>
        </div>

        {shops.isError ? (
          <SourceImportInlineWarning
            message={sourceImportErrorMessage(shops.error)}
            onRetry={() => void shops.refetch()}
          />
        ) : null}
        {buyerMissing ? (
          <div className="source-import-blocker" role="alert">
            <span>还没有有效的 1688 买家授权，连接后才能执行真实采集。</span>
            <Link href="/settings">去连接账号</Link>
          </div>
        ) : null}
        {activeBuyers.length > 1 ? (
          <p className="source-import-buyer-help">
            检测到多个有效买家账号，请明确选择本次采集使用的账号。
          </p>
        ) : null}
      </section>

      {recoveryMissing ? (
        <div className="batch-inline-warning" role="status">
          <span>上次预览尚未在服务端创建，可使用相同请求安全重试。</span>
        </div>
      ) : recovery.isError && !recoveryMissing ? (
        <SourceImportInlineWarning
          message={`恢复上次请求失败：${sourceImportErrorMessage(recovery.error)}`}
          onRetry={() => void recovery.refetch()}
        />
      ) : null}

      {recent.data?.items.length ? (
        <section className="batch-recent-panel">
          <div>
            <p className="batch-step-label">最近任务</p>
            <p className="text-xs text-zinc-500">任务保存在服务端，可随时回来查看进度和结果。</p>
          </div>
          <div className="batch-recent-list">
            {recent.data.items.map((task) => (
              <Link
                key={task.taskId}
                href={`/sources/import?task=${encodeURIComponent(task.taskId)}`}
              >
                <span>{sourceImportTaskStatusLabel(task.status)}</span>
                <strong>{task.summary.total} 件货源</strong>
                <small>{new Date(task.createdAt).toLocaleString('zh-CN')}</small>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="source-import-submit-panel">
        <div>
          <strong>下一步只生成采集预览</strong>
          <span>不会在检查阶段写入或刷新货源数据。</span>
        </div>
        <div className="batch-selection-actions">
          {rawInput ? (
            <button type="button" className="batch-quiet-button" onClick={() => updateRawInput('')}>
              清空
            </button>
          ) : null}
          <button
            type="button"
            className="batch-primary-button"
            disabled={!canPreview}
            onClick={requestPreview}
          >
            {createPreview.isPending
              ? '生成预览中…'
              : `预览采集 ${parsed.references.length} 件货源`}
          </button>
        </div>
        {createPreview.isError ? (
          <p className="batch-bar-error" role="alert">
            {sourceImportErrorMessage(createPreview.error)}
          </p>
        ) : null}
      </section>
    </div>
  );
}

function SourceImportTaskView({
  taskId,
  sessionScope,
  onStartNew,
}: {
  taskId: string;
  sessionScope: SourceImportSessionScope;
  onStartNew: () => void;
}) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<(typeof RESULT_FILTERS)[number]['value']>('all');
  const task = useQuery({
    queryKey: ['sourceImportTask', taskId],
    queryFn: () => api.sourceImportTask(taskId),
    refetchInterval: (query) =>
      query.state.data && ACTIVE_TASK_STATUSES.has(query.state.data.status) ? 2500 : false,
    refetchIntervalInBackground: false,
  });
  const refresh = (value: SourceImportTask) => {
    queryClient.setQueryData(['sourceImportTask', taskId], value);
    void queryClient.invalidateQueries({ queryKey: ['sourceImportTasks'] });
    void queryClient.invalidateQueries({ queryKey: ['collectedSourceProducts'] });
  };
  const execute = useMutation({
    mutationFn: (previewRevision: number) => api.executeSourceImport(taskId, previewRevision),
    onSuccess: (value) => {
      clearSourceImportWorkbenchSession(sessionScope);
      refresh(value);
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelSourceImport(taskId),
    onSuccess: (value) => {
      clearSourceImportWorkbenchSession(sessionScope);
      refresh(value);
    },
  });
  const retry = useMutation({
    mutationFn: (itemIds: string[]) => api.retrySourceImport(taskId, itemIds),
    onSuccess: refresh,
  });

  useEffect(() => {
    if (task.data && task.data.status !== 'preview') {
      clearSourceImportWorkbenchSession(sessionScope);
    }
  }, [sessionScope, task.data]);

  if (task.isLoading && !task.data) return <SourceImportLoading label="正在读取采集任务…" />;
  if (!task.data) {
    return (
      <SourceImportReadError
        error={task.error}
        onRetry={() => void task.refetch()}
        onStartNew={onStartNew}
      />
    );
  }

  const value = task.data;
  const preview = value.status === 'preview';
  const active = ACTIVE_TASK_STATUSES.has(value.status);
  const retryableFailedIds = value.items
    .filter((item) => item.status === 'failed' && item.retryable)
    .map((item) => item.itemId);
  const visibleItems =
    filter === 'all'
      ? value.items
      : value.items.filter((item) => sourceImportStatusMatches(item.status, filter));
  const mutationError = execute.error ?? cancel.error ?? retry.error;

  return (
    <div className="space-y-5">
      <section className="batch-progress-panel">
        <div className="batch-progress-copy">
          <p className="batch-step-label">{preview ? '02 · 采集预览' : '采集任务'}</p>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="batch-section-title">1688 货源 · {value.summary.total} 件</h2>
            <span className="batch-task-status" data-status={value.status}>
              {sourceImportTaskStatusLabel(value.status)}
            </span>
          </div>
          <p className="batch-section-description">
            {preview
              ? '确认 existing、collected 和目标动作；执行后才会逐件读取 1688 并写入你的货源库。'
              : active
                ? '任务逐件执行。停止只影响尚未开始的条目，已开始条目会安全收敛。'
                : '结果已持久化，可安全刷新或稍后返回。'}
          </p>
        </div>
        <div
          className="batch-progress-orbit"
          role="progressbar"
          aria-label="采集任务完成进度"
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
        <SourceImportInlineWarning
          message="进度刷新暂时失败，当前仍显示最近一次成功结果。"
          onRetry={() => void task.refetch()}
        />
      ) : null}

      <p className="sr-only" aria-live="polite">
        {sourceImportTaskStatusLabel(value.status)}，已完成 {value.summary.completed} /{' '}
        {value.summary.total} 件。
      </p>

      <section className="batch-metrics-grid" aria-label="采集任务汇总">
        <SourceImportMetric label="总计" value={value.summary.total} />
        <SourceImportMetric label="等待" value={value.summary.pending + value.summary.retryWait} />
        <SourceImportMetric label="执行中" value={value.summary.running} tone="indigo" />
        <SourceImportMetric label="成功" value={value.summary.succeeded} tone="green" />
        <SourceImportMetric label="失败" value={value.summary.failed} tone="red" />
        <SourceImportMetric
          label="跳过 / 停止"
          value={value.summary.skipped + value.summary.cancelled}
        />
      </section>

      <section className="source-import-results-panel">
        <div className="source-import-results-header">
          <div>
            <p className="batch-step-label">逐项结果</p>
            <h2 className="batch-section-title">货源明细</h2>
          </div>
          <span className="batch-task-id">Task #{value.taskId}</span>
        </div>
        <div className="batch-filter-row" role="group" aria-label="采集结果筛选">
          {RESULT_FILTERS.map((itemFilter) => {
            const count =
              itemFilter.value === 'all'
                ? value.items.length
                : value.items.filter((item) =>
                    sourceImportStatusMatches(item.status, itemFilter.value),
                  ).length;
            return (
              <button
                key={itemFilter.value}
                type="button"
                aria-pressed={filter === itemFilter.value}
                className={filter === itemFilter.value ? 'is-active' : ''}
                onClick={() => setFilter(itemFilter.value)}
              >
                {itemFilter.label} {count}
              </button>
            );
          })}
        </div>
        <div className="source-import-item-list">
          {visibleItems.map((item) => (
            <SourceImportItemCard key={item.itemId} item={item} preview={preview} />
          ))}
          {visibleItems.length === 0 ? (
            <div className="batch-empty-state">当前筛选条件下没有任务条目。</div>
          ) : null}
        </div>
      </section>

      <section className="batch-confirm-panel">
        <div>
          <strong>
            {preview ? '预览不会写入货源数据' : sourceImportTaskStatusLabel(value.status)}
          </strong>
          <span>
            {preview
              ? `${value.summary.pending} 件待采集，${value.summary.skipped} 件无需执行。`
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
                className="batch-primary-button"
                disabled={execute.isPending || cancel.isPending || value.summary.pending === 0}
                onClick={() => execute.mutate(value.previewRevision)}
              >
                {execute.isPending ? '提交中…' : `确认采集 ${value.summary.pending} 件货源`}
              </button>
            </>
          ) : active ? (
            <button
              type="button"
              className="batch-danger-outline-button"
              disabled={cancel.isPending || value.status === 'cancelling'}
              onClick={() => cancel.mutate()}
            >
              {value.status === 'cancelling' ? '正在停止未开始项…' : '停止未开始项'}
            </button>
          ) : (
            <>
              {retryableFailedIds.length > 0 ? (
                <button
                  type="button"
                  className="batch-primary-button"
                  disabled={retry.isPending}
                  onClick={() => retry.mutate(retryableFailedIds)}
                >
                  {retry.isPending ? '重新入队中…' : `重试 ${retryableFailedIds.length} 个失败项`}
                </button>
              ) : null}
              <Link href="/sources" className="batch-secondary-button">
                查看我的货源
              </Link>
              <button type="button" className="batch-secondary-button" onClick={onStartNew}>
                继续采集
              </button>
            </>
          )}
        </div>
        {mutationError ? (
          <p className="batch-bar-error" role="alert">
            {sourceImportErrorMessage(mutationError)}
          </p>
        ) : null}
      </section>
    </div>
  );
}

function SourceImportItemCard({ item, preview }: { item: SourceImportItem; preview: boolean }) {
  const detailId = item.sourceProductId ?? (item.existing ? item.offerId : null);
  return (
    <article className="source-import-item" data-status={item.status}>
      <div className="source-import-product">
        {item.mainImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.mainImage} alt="" width={64} height={64} loading="lazy" />
        ) : (
          <span className="source-import-image-placeholder" aria-hidden="true">
            1688
          </span>
        )}
        <div>
          <strong>{item.title ?? `1688 商品 ${item.offerId}`}</strong>
          <small>offerId {item.offerId}</small>
        </div>
      </div>
      <dl className="source-import-item-facts">
        <div>
          <dt>目标动作</dt>
          <dd>{sourceImportActionLabel(item)}</dd>
        </div>
        <div>
          <dt>采购价</dt>
          <dd>
            {item.price === null ? (preview ? '执行后读取' : '—') : `¥${item.price.toFixed(2)}`}
          </dd>
        </div>
        <div>
          <dt>SKU / 库存</dt>
          <dd>
            {item.skuCount === null ? '—' : `${item.skuCount} 个`} / {item.totalStock ?? '—'}
          </dd>
        </div>
      </dl>
      <div className="source-import-item-result">
        <span className="batch-status-pill" data-status={item.status}>
          {sourceImportItemStatusLabel(item.status)}
        </span>
        {sourceImportResultLabel(item) ? <small>{sourceImportResultLabel(item)}</small> : null}
        {item.errorMessage ? <small className="batch-row-error">{item.errorMessage}</small> : null}
        {detailId && ['succeeded', 'skipped'].includes(item.status) ? (
          <Link href={`/products?id=${encodeURIComponent(detailId)}`}>查看商品详情</Link>
        ) : null}
      </div>
    </article>
  );
}

function SourceImportMetric({
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

function SourceImportLoading({ label }: { label: string }) {
  return (
    <div className="batch-loading" role="status" aria-live="polite">
      <span aria-hidden="true" />
      {label}
    </div>
  );
}

function SourceImportInlineWarning({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="batch-inline-warning" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onRetry}>
        重新读取
      </button>
    </div>
  );
}

function SourceImportReadError({
  error,
  onRetry,
  onStartNew,
}: {
  error: unknown;
  onRetry: () => void;
  onStartNew: () => void;
}) {
  return (
    <div className="batch-error-panel" role="alert">
      <strong>无法读取采集任务</strong>
      <span>{sourceImportErrorMessage(error)}</span>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="batch-secondary-button" onClick={onRetry}>
          重新读取
        </button>
        <button type="button" className="batch-secondary-button" onClick={onStartNew}>
          新建采集
        </button>
      </div>
    </div>
  );
}

function sourceImportActionLabel(item: SourceImportItem): string {
  if (item.action === 'create') return '新采集';
  if (item.collected) return '刷新我的货源';
  return '加入我的货源';
}

function sourceImportResultLabel(item: SourceImportItem): string | null {
  const reason = typeof item.result?.reason === 'string' ? item.result.reason : null;
  if (reason === 'created') return '已新建并加入我的货源';
  if (reason === 'refreshed') return '已刷新并加入我的货源';
  if (reason === 'offline_existing') return '货源已下架，保留已有记录';
  if (reason === 'not_found') return '1688 商品不存在或已下架';
  if (item.retryable && item.status === 'failed') return '可安全重试';
  return null;
}

function sourceImportTaskStatusLabel(status: string): string {
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
  return labels[status] ?? status;
}

function sourceImportItemStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: '等待执行',
    running: '执行中',
    retry_wait: '等待重试',
    succeeded: '成功',
    failed: '失败',
    skipped: '跳过',
    cancelled: '已停止',
  };
  return labels[status] ?? status;
}

function sourceImportStatusMatches(status: string, filter: string): boolean {
  return filter === 'waiting' ? status === 'pending' || status === 'retry_wait' : status === filter;
}

function sourceImportErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '登录状态已失效，请重新登录后继续。';
    if (error.status === 403) return '当前账号没有访问该采集任务或 1688 授权不可用。';
    if (error.status === 409) return `${error.message} 请刷新任务后重新确认。`;
    if (error.status === 429) return '1688 请求额度暂时受限，任务已保留，请稍后重试。';
    if (error.status >= 500) return '采集服务暂时不可用，任务状态已保留，请稍后重试。';
    return error.message;
  }
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}
