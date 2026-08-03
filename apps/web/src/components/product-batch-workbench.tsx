'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ApiError,
  api,
  type ProductBatchCandidate,
  type ProductBatchItem,
  type ProductBatchTask,
} from '@/lib/api';

const PAGE_SIZE = 50;
const MAX_SELECTION = 100;
const ACTIVE_TASK_STATUSES = new Set(['queued', 'running', 'cancelling']);
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

export function ProductBatchWorkbench() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const taskId = searchParams.get('task');

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

      {taskId ? (
        <BatchTask taskId={taskId} onStartNew={() => router.replace('/published/batch')} />
      ) : (
        <BatchComposer />
      )}
    </main>
  );
}

function BatchComposer() {
  const router = useRouter();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('online');
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const pageCheckboxRef = useRef<HTMLInputElement>(null);
  const previewAttempt = useRef<{ fingerprint: string; clientRequestId: string } | null>(null);
  const candidates = useQuery({
    queryKey: ['productBatchCandidates', page, PAGE_SIZE, status, query],
    queryFn: () =>
      api.productBatchCandidates({ page, pageSize: PAGE_SIZE, status, q: query || undefined }),
  });
  const recent = useQuery({
    queryKey: ['productBatchTasks', 1, 5],
    queryFn: () => api.productBatchTasks(1, 5),
  });
  const createPreview = useMutation({
    mutationFn: (request: { clientRequestId: string; publishedProductIds: string[] }) =>
      api.createProductBatchPreview({
        clientRequestId: request.clientRequestId,
        action: 'offline',
        publishedProductIds: request.publishedProductIds,
      }),
    onSuccess: (task) => {
      previewAttempt.current = null;
      qc.setQueryData(['productBatchTask', task.taskId], task);
      router.replace(`/published/batch?task=${encodeURIComponent(task.taskId)}`);
    },
  });
  const pageIds =
    candidates.data?.items
      .filter((item) => item.status === 'online')
      .map((item) => item.publishedProductId) ?? [];
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selectedPageCount = pageIds.filter((id) => selectedSet.has(id)).length;
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedSet.has(id));
  const pageSelectionBlocked =
    pageIds.length === 0 || (selected.length >= MAX_SELECTION && selectedPageCount === 0);
  const totalPages = Math.max(1, Math.ceil((candidates.data?.total ?? 0) / PAGE_SIZE));

  useEffect(() => {
    if (pageCheckboxRef.current) {
      pageCheckboxRef.current.indeterminate = selectedPageCount > 0 && !allPageSelected;
    }
  }, [allPageSelected, selectedPageCount]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setPage(1);
    setQuery(searchInput.trim());
  };

  const toggle = (id: string) => {
    setSelected((current) => {
      if (current.includes(id)) return current.filter((value) => value !== id);
      if (current.length >= MAX_SELECTION) return current;
      return [...current, id];
    });
  };

  const togglePage = () => {
    setSelected((current) => {
      const currentSet = new Set(current);
      const selectedOnPage = pageIds.filter((id) => currentSet.has(id));
      if (
        (pageIds.length && selectedOnPage.length === pageIds.length) ||
        (current.length >= MAX_SELECTION && selectedOnPage.length > 0)
      ) {
        return current.filter((id) => !pageIds.includes(id));
      }
      const capacity = MAX_SELECTION - current.length;
      const selectableIds = pageIds.filter((id) => !currentSet.has(id));
      return [...current, ...selectableIds.slice(0, Math.max(0, capacity))];
    });
  };

  const requestPreview = () => {
    const fingerprint = [...selected].sort().join(',');
    if (previewAttempt.current?.fingerprint !== fingerprint) {
      previewAttempt.current = { fingerprint, clientRequestId: crypto.randomUUID() };
    }
    createPreview.mutate({
      clientRequestId: previewAttempt.current.clientRequestId,
      publishedProductIds: [...selected],
    });
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
              <p className="batch-section-description">
                首个安全闭环开放批量下架；其他动作会沿用相同的预览与逐项恢复机制。
              </p>
            </div>
            <span className="batch-safety-chip">平台回读确认</span>
          </div>
          <div className="batch-action-grid">
            <button type="button" className="batch-action-card is-active" aria-pressed="true">
              <span className="batch-action-icon" aria-hidden="true">
                ↓
              </span>
              <span>
                <strong>批量下架</strong>
                <small>在线商品 → 已下架</small>
              </span>
              <em>已开放</em>
            </button>
            {['改标题', '改价格', '同步库存', '换源与清理'].map((label) => (
              <button key={label} type="button" className="batch-action-card" disabled>
                <span className="batch-action-icon" aria-hidden="true">
                  ·
                </span>
                <span>
                  <strong>{label}</strong>
                  <small>复用同一批量任务状态机</small>
                </span>
                <em>下一阶段</em>
              </button>
            ))}
          </div>
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
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="搜索商品标题"
              maxLength={100}
            />
            <button type="submit">搜索</button>
          </form>
        </div>

        <div className="batch-filter-row" aria-label="商品状态筛选">
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
                          (selected.length >= MAX_SELECTION && selectedPageCount > 0)
                            ? '取消本页已选商品'
                            : '选择本页在线商品'
                        }
                        checked={allPageSelected}
                        disabled={pageSelectionBlocked}
                        onChange={togglePage}
                      />
                    </label>
                  </th>
                  <th>商品</th>
                  <th>店铺 / 平台</th>
                  <th>售价</th>
                  <th>货源</th>
                  <th>库存同步</th>
                  <th>当前状态</th>
                </tr>
              </thead>
              <tbody>
                {candidates.data.items.map((item) => (
                  <CandidateRow
                    key={item.publishedProductId}
                    item={item}
                    selected={selectedSet.has(item.publishedProductId)}
                    selectionFull={selected.length >= MAX_SELECTION}
                    onToggle={() => toggle(item.publishedProductId)}
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
                <strong>{task.summary.total} 件批量下架</strong>
                <small>{new Date(task.createdAt).toLocaleString('zh-CN')}</small>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <div className="batch-selection-bar" data-visible={selected.length > 0}>
        <div>
          <strong>
            已选 {selected.length} / {MAX_SELECTION} 件
          </strong>
          <span>下一步只生成差异预览，不会立即调用平台。</span>
        </div>
        <div className="batch-selection-actions">
          <button type="button" className="batch-quiet-button" onClick={() => setSelected([])}>
            清空
          </button>
          <button
            type="button"
            className="batch-primary-button"
            disabled={!selected.length || createPreview.isPending}
            onClick={requestPreview}
          >
            {createPreview.isPending ? '生成预览中…' : `预览下架 ${selected.length} 件商品`}
          </button>
        </div>
        {createPreview.isError ? (
          <p className="batch-bar-error" role="alert">
            {errorMessage(createPreview.error)}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function CandidateRow({
  item,
  selected,
  selectionFull,
  onToggle,
}: {
  item: ProductBatchCandidate;
  selected: boolean;
  selectionFull: boolean;
  onToggle: () => void;
}) {
  const selectable = item.status === 'online';
  return (
    <tr data-selected={selected}>
      <td className="batch-check-cell">
        <label className="batch-checkbox-target">
          <input
            type="checkbox"
            aria-label={`${selected ? '取消选择' : '选择'} ${item.title}`}
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
            <img src={item.mainImage} alt="" />
          ) : (
            <span className="batch-image-placeholder" />
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
      <td className="batch-mono">¥{item.salePrice.toFixed(2)}</td>
      <td>
        <StatusPill value={item.sourceAvailability} />
      </td>
      <td>
        <StatusPill value={item.inventorySyncStatus} />
      </td>
      <td>
        <StatusPill value={item.status} />
      </td>
    </tr>
  );
}

function BatchTask({ taskId, onStartNew }: { taskId: string; onStartNew: () => void }) {
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
    mutationFn: () => api.retryProductBatch(taskId),
    onSuccess: refresh,
  });

  if (task.isLoading && !task.data) return <BatchLoading />;
  if (!task.data) return <BatchError error={task.error} />;
  const value = task.data;
  const active = ACTIVE_TASK_STATUSES.has(value.status);
  const preview = value.status === 'preview';
  const canRetry = ['failed', 'partial'].includes(value.status) && value.summary.failed > 0;
  const pendingExecution = value.summary.pending + value.summary.retryWait;
  const visibleItems =
    itemFilter === 'all'
      ? value.items
      : value.items.filter((item) => matchesResultFilter(item.status, itemFilter));

  return (
    <div className="space-y-5">
      <section className="batch-progress-panel">
        <div className="batch-progress-copy">
          <p className="batch-step-label">{preview ? '03 · 差异预览' : '执行任务'}</p>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="batch-section-title">批量下架 · {value.summary.total} 件</h2>
            <TaskStatusBadge status={value.status} />
          </div>
          <p className="batch-section-description">
            {preview
              ? '确认前请检查每件商品的当前状态与执行后状态。'
              : active
                ? '任务按商品独立执行；停止只影响尚未开始的条目。'
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
        <p className="batch-inline-warning" role="alert">
          进度刷新暂时失败，当前仍显示最近一次成功结果；你可以稍后重试或刷新页面。
        </p>
      ) : null}

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
        <div className="batch-filter-row" aria-label="逐项结果筛选">
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
          <table className="batch-table batch-result-table">
            <thead>
              <tr>
                <th>商品</th>
                <th>店铺 / 平台</th>
                <th>当前</th>
                <th>执行后</th>
                <th>执行状态</th>
                <th>尝试</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((item) => (
                <TaskItemRow key={item.itemId} item={item} />
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
              ? `${pendingExecution} 件可执行，${value.summary.skipped} 件将跳过。`
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
                disabled={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                放弃预览
              </button>
              <button
                type="button"
                className="batch-danger-button"
                disabled={execute.isPending}
                onClick={() => execute.mutate(value.previewRevision)}
              >
                {execute.isPending ? '提交中…' : `确认下架 ${pendingExecution} 件商品`}
              </button>
            </>
          ) : active ? (
            <button
              type="button"
              className="batch-danger-outline-button"
              disabled={cancel.isPending || value.status === 'cancelling'}
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
                  disabled={retry.isPending}
                  onClick={() => retry.mutate()}
                >
                  {retry.isPending ? '重新入队中…' : `重试 ${value.summary.failed} 个失败项`}
                </button>
              ) : null}
              <button type="button" className="batch-secondary-button" onClick={onStartNew}>
                新建批量任务
              </button>
            </>
          )}
        </div>
        {[execute.error, cancel.error, retry.error].find(Boolean) ? (
          <p className="batch-bar-error" role="alert">
            {errorMessage([execute.error, cancel.error, retry.error].find(Boolean))}
          </p>
        ) : null}
      </section>
    </div>
  );
}

function TaskItemRow({ item }: { item: ProductBatchItem }) {
  return (
    <tr>
      <td>
        <div className="batch-product-cell">
          {item.mainImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.mainImage} alt="" />
          ) : (
            <span className="batch-image-placeholder" />
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
      <td>
        <StatusPill value={item.beforeStatus} />
      </td>
      <td>
        <span className="batch-change-arrow">→</span> <StatusPill value={item.desiredStatus} />
      </td>
      <td>
        <StatusPill value={item.status} />
        {item.errorMessage ? <small className="batch-row-error">{item.errorMessage}</small> : null}
      </td>
      <td className="batch-mono">
        {item.attempts}/{item.maxAttempts}
      </td>
    </tr>
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
    <div className="batch-loading">
      <span />
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

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return '请求失败，请稍后重试。';
}
