'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  api,
  type AfterSaleCaseDetail,
  type AfterSaleCaseEvent,
  type AfterSaleCaseItem,
  type AfterSaleCaseListItem,
  type AfterSaleCaseStatus,
  type AfterSaleClosureBlocker,
  type AfterSalePurchaseAction,
  type AfterSalePurchaseActionResult,
  type AfterSalePurchaseLink,
  type AfterSaleRemoteReferenceType,
  type RefreshAfterSaleCasesResult,
} from '@/lib/api';
import {
  createClientRequestId,
  formatFullTime,
  formatRelativeTime,
} from '@/components/exception-center/exception-center-utils';
import {
  AFTER_SALE_STATUSES,
  afterSaleEventLabel,
  afterSalePriorityLabel,
  afterSaleStatusLabel,
  closureBlockerAction,
  closureBlockerActionKey,
  countKeyForStatus,
  dueLabel,
  isAfterSaleConflict,
  isAfterSaleStaleMutation,
  normalizedClosureBlockers,
  parseAfterSaleOverdue,
  parseClosureMoney,
  parseAfterSaleStatus,
  parsePositivePage,
  purchaseLinkStage,
  refundAmountInputMax,
  summarizeAfterSaleRefresh,
  waitingOnLabel,
} from './after-sale-utils';

const PAGE_SIZE = 30;
const MAX_REFRESH_PAGES = 20;
type QueryUpdate = Record<string, string | number | null | undefined>;

async function refreshAllAfterSaleCases(
  afterOrderId?: string,
): Promise<RefreshAfterSaleCasesResult> {
  const aggregate: RefreshAfterSaleCasesResult = {
    scanned: 0,
    created: 0,
    updated: 0,
    reopened: 0,
    closed: 0,
    hasMore: false,
    nextCursor: null,
    errors: [],
  };
  let cursor = afterOrderId;

  for (let page = 0; page < MAX_REFRESH_PAGES; page++) {
    const result = await api.refreshAfterSaleCases(cursor);
    aggregate.scanned = (aggregate.scanned ?? 0) + (result.scanned ?? 0);
    aggregate.created = (aggregate.created ?? 0) + (result.created ?? 0);
    aggregate.updated = (aggregate.updated ?? 0) + (result.updated ?? 0);
    aggregate.reopened = (aggregate.reopened ?? 0) + (result.reopened ?? 0);
    aggregate.closed = (aggregate.closed ?? 0) + (result.closed ?? 0);
    aggregate.refreshedAt = result.refreshedAt;
    aggregate.errors?.push(
      ...(result.errors ?? []).filter(
        (error) => typeof error === 'string' || error.code !== 'REFRESH_LIMIT_REACHED',
      ),
    );

    if (!result.hasMore) return aggregate;
    if (!result.nextCursor || result.nextCursor === cursor) {
      throw new Error('售后同步游标未推进，已停止继续扫描，请稍后重试。');
    }
    cursor = result.nextCursor;
  }

  aggregate.hasMore = true;
  aggregate.nextCursor = cursor ?? null;
  return aggregate;
}

export function AfterSaleWorkbench() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const status = parseAfterSaleStatus(searchParams.get('status'));
  const overdue = parseAfterSaleOverdue(searchParams.get('overdue'));
  const queryText = searchParams.get('q')?.trim().slice(0, 100) ?? '';
  const page = parsePositivePage(searchParams.get('page'));
  const explicitCaseId = searchParams.get('case')?.trim() || null;
  const [searchInput, setSearchInput] = useState(queryText);
  const [refreshMessage, setRefreshMessage] = useState('');
  const refreshCursorRef = useRef<string | null>(null);
  const previousExplicitCaseIdRef = useRef(explicitCaseId);

  useEffect(() => setSearchInput(queryText), [queryText]);
  useEffect(() => {
    const previousId = previousExplicitCaseIdRef.current;
    previousExplicitCaseIdRef.current = explicitCaseId;
    if (!previousId || explicitCaseId) return;
    requestAnimationFrame(() => document.getElementById(`after-sale-case-${previousId}`)?.focus());
  }, [explicitCaseId]);

  const listQuery = useQuery({
    queryKey: ['after-sale-cases', status, overdue ?? 'all', queryText, page, PAGE_SIZE],
    queryFn: () =>
      api.afterSaleCases({
        status,
        overdue,
        q: queryText || undefined,
        page,
        pageSize: PAGE_SIZE,
      }),
    placeholderData: (previous) => previous,
  });
  const selectedCaseId = explicitCaseId ?? listQuery.data?.items[0]?.id ?? null;
  const detailQuery = useQuery({
    queryKey: ['after-sale-case', selectedCaseId],
    queryFn: () => api.afterSaleCase(selectedCaseId!),
    enabled: Boolean(selectedCaseId),
    retry: false,
  });
  const totalPages = Math.max(1, Math.ceil((listQuery.data?.total ?? 0) / PAGE_SIZE));

  useEffect(() => {
    if (listQuery.data === undefined || page <= totalPages) return;
    const next = new URLSearchParams(searchParams.toString());
    next.set('page', String(totalPages));
    next.delete('case');
    router.replace(`${pathname}?${next.toString()}`);
  }, [listQuery.data, page, pathname, router, searchParams, totalPages]);

  const hrefWith = useCallback(
    (updates: QueryUpdate) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === undefined || value === '') next.delete(key);
        else next.set(key, String(value));
      }
      const serialized = next.toString();
      return serialized ? `${pathname}?${serialized}` : pathname;
    },
    [pathname, searchParams],
  );

  const replaceQuery = (updates: QueryUpdate) =>
    router.replace(hrefWith(updates), { scroll: false });
  const refreshMutation = useMutation({
    mutationFn: () => refreshAllAfterSaleCases(refreshCursorRef.current ?? undefined),
    onSuccess: async (result) => {
      refreshCursorRef.current = result.hasMore ? result.nextCursor : null;
      setRefreshMessage(summarizeAfterSaleRefresh(result));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['after-sale-cases'] }),
        queryClient.invalidateQueries({ queryKey: ['after-sale-case'] }),
      ]);
    },
    onError: (error) => setRefreshMessage(`同步失败：${errorMessage(error)}`),
  });

  const activeFilters = Number(overdue !== undefined) + Number(Boolean(queryText));
  const currentCount = listQuery.data?.total;
  const overdueCount = listQuery.data?.overdueCount;

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    replaceQuery({ q: searchInput.trim().slice(0, 100) || null, page: null, case: null });
  };

  return (
    <main
      className="app-page exception-center-page after-sale-page"
      data-mobile-detail={Boolean(explicitCaseId)}
    >
      <header className="exception-page-header">
        <div>
          <p className="page-kicker">After-sales desk</p>
          <h1 className="page-title">售后工单</h1>
          <p className="page-description">
            对齐销售售后与 1688 人工处置，按责任、时限和关闭证据推进每一单。
          </p>
          <p className="exception-focus-summary" aria-live="polite">
            {currentCount === undefined
              ? '正在读取售后工单…'
              : `${afterSaleStatusLabel(status)} ${currentCount} 件`}
            {overdueCount !== undefined ? ` · 当前逾期 ${overdueCount} 件` : ''}
          </p>
        </div>
        <button
          type="button"
          className="exception-refresh-button"
          disabled={refreshMutation.isPending}
          aria-busy={refreshMutation.isPending}
          onClick={() => {
            setRefreshMessage('');
            refreshMutation.mutate();
          }}
        >
          <RefreshIcon spinning={refreshMutation.isPending} />
          {refreshMutation.isPending ? '正在同步售后…' : '同步最新状态'}
        </button>
      </header>

      {refreshMessage ? (
        <p
          className={`exception-refresh-result ${refreshMutation.isError ? 'is-error' : ''}`}
          role={refreshMutation.isError ? 'alert' : 'status'}
        >
          {refreshMessage}
        </p>
      ) : null}

      <section className="exception-controls" aria-label="售后工单筛选">
        <div className="exception-status-switch after-sale-status-switch" role="group">
          {AFTER_SALE_STATUSES.map((option) => {
            const count = listQuery.data?.counts?.[countKeyForStatus(option.value)];
            const visibleCount = count ?? (option.value === status ? currentCount : undefined);
            return (
              <button
                key={option.value}
                type="button"
                className={option.value === status ? 'is-active' : ''}
                aria-pressed={option.value === status}
                onClick={() => replaceQuery({ status: option.value, page: null, case: null })}
              >
                <span>{option.label}</span>
                {visibleCount !== undefined ? <strong>{visibleCount}</strong> : null}
              </button>
            );
          })}
        </div>

        <div className="exception-filter-bar after-sale-filter-bar">
          <form className="exception-search" role="search" onSubmit={submitSearch}>
            <label className="sr-only" htmlFor="after-sale-search-input">
              搜索售后工单
            </label>
            <SearchIcon />
            <input
              id="after-sale-search-input"
              type="search"
              value={searchInput}
              maxLength={100}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="搜索销售订单、商品或 1688 单号"
            />
            <button type="submit">搜索</button>
          </form>
          <label className="exception-select-label">
            <span>处理时限</span>
            <select
              value={overdue === undefined ? '' : String(overdue)}
              onChange={(event) =>
                replaceQuery({ overdue: event.target.value || null, page: null, case: null })
              }
            >
              <option value="">全部时限</option>
              <option value="true">仅看逾期</option>
              <option value="false">仅看未逾期</option>
            </select>
          </label>
          <button
            type="button"
            className="exception-clear-filters"
            disabled={activeFilters === 0}
            onClick={() => {
              setSearchInput('');
              replaceQuery({ overdue: null, q: null, page: null, case: null });
            }}
          >
            清除筛选{activeFilters > 0 ? ` · ${activeFilters}` : ''}
          </button>
        </div>
      </section>

      <div className="exception-workspace" data-mobile-detail={Boolean(explicitCaseId)}>
        <AfterSaleQueue
          items={listQuery.data?.items ?? []}
          selectedCaseId={selectedCaseId}
          status={status}
          page={page}
          totalPages={totalPages}
          total={listQuery.data?.total}
          activeFilters={activeFilters}
          isLoading={listQuery.isLoading}
          error={listQuery.error}
          hrefWith={hrefWith}
          onRetry={() => void listQuery.refetch()}
          onRefresh={() => refreshMutation.mutate()}
        />
        <AfterSaleDetailPanel
          caseId={selectedCaseId}
          explicitCaseId={explicitCaseId}
          value={detailQuery.data}
          isLoading={detailQuery.isLoading}
          error={detailQuery.error}
          backHref={hrefWith({ case: null })}
          onRetry={() => void detailQuery.refetch()}
        />
      </div>
    </main>
  );
}

function AfterSaleQueue({
  items,
  selectedCaseId,
  status,
  page,
  totalPages,
  total,
  activeFilters,
  isLoading,
  error,
  hrefWith,
  onRetry,
  onRefresh,
}: {
  items: AfterSaleCaseListItem[];
  selectedCaseId: string | null;
  status: AfterSaleCaseStatus;
  page: number;
  totalPages: number;
  total: number | undefined;
  activeFilters: number;
  isLoading: boolean;
  error: unknown;
  hrefWith: (updates: QueryUpdate) => string;
  onRetry: () => void;
  onRefresh: () => void;
}) {
  return (
    <section className="exception-queue-panel" aria-labelledby="after-sale-queue-heading">
      <header className="exception-panel-header">
        <div>
          <h2 id="after-sale-queue-heading">工单队列</h2>
          <span>{total === undefined ? '读取中' : `共 ${total} 件`}</span>
        </div>
        <span className="exception-sort-note">逾期与高风险优先</span>
      </header>

      {isLoading ? <QueueSkeleton /> : null}
      {!isLoading && error ? (
        <ErrorState title="无法读取售后工单" error={error} onRetry={onRetry} />
      ) : null}
      {!isLoading && !error && items.length === 0 ? (
        <EmptyState status={status} filtered={activeFilters > 0} onRefresh={onRefresh} />
      ) : null}
      {!isLoading && !error && items.length > 0 ? (
        <ul className="exception-case-list">
          {items.map((item) => {
            const due = dueLabel(item.nextActionDueAt, item.overdue);
            const itemTitle = item.items[0]?.title;
            return (
              <li key={item.id}>
                <Link
                  id={`after-sale-case-${item.id}`}
                  href={hrefWith({ case: item.id })}
                  className="exception-case-row after-sale-case-row"
                  data-priority={item.priority}
                  data-overdue={item.overdue}
                  aria-current={selectedCaseId === item.id ? 'true' : undefined}
                  aria-label={`${afterSalePriorityLabel(item.priority)}，${afterSaleStatusLabel(item.status)}，销售订单 ${item.order.platformOrderId}`}
                >
                  <span className="exception-case-row-topline">
                    <span className="exception-status-badge" data-status={item.status}>
                      {afterSaleStatusLabel(item.status)}
                    </span>
                    <span className="exception-priority-label" data-priority={item.priority}>
                      {afterSalePriorityLabel(item.priority)}
                    </span>
                    <span className="after-sale-due-chip" data-tone={due.tone}>
                      {due.label}
                    </span>
                  </span>
                  <strong className="exception-case-title">
                    {itemTitle || `销售订单 ${item.order.platformOrderId}`}
                  </strong>
                  <span className="exception-case-subject">
                    {item.order.shopName ?? '销售店铺'} · 订单 {item.order.platformOrderId}
                  </span>
                  <span className="exception-case-reason">
                    等待 {waitingOnLabel(item.waitingOn)} · {item.nextAction}
                  </span>
                  <span className="exception-case-meta">
                    <time dateTime={item.updatedAt} title={formatFullTime(item.updatedAt)}>
                      {formatRelativeTime(item.updatedAt)}
                    </time>
                    <span>{item.purchaseLinks.length} 个采购关联</span>
                    {item.assigneeUserId ? <span>已认领</span> : <span>待认领</span>}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}

      {!isLoading && !error && totalPages > 1 ? (
        <nav className="exception-pagination" aria-label="售后工单分页">
          <Link
            href={hrefWith({ page: Math.max(1, page - 1), case: null })}
            aria-disabled={page <= 1}
            tabIndex={page <= 1 ? -1 : undefined}
            className={page <= 1 ? 'is-disabled' : ''}
          >
            上一页
          </Link>
          <span>
            第 {page} / {totalPages} 页
          </span>
          <Link
            href={hrefWith({ page: Math.min(totalPages, page + 1), case: null })}
            aria-disabled={page >= totalPages}
            tabIndex={page >= totalPages ? -1 : undefined}
            className={page >= totalPages ? 'is-disabled' : ''}
          >
            下一页
          </Link>
        </nav>
      ) : null}
    </section>
  );
}

function AfterSaleDetailPanel({
  caseId,
  explicitCaseId,
  value,
  isLoading,
  error,
  backHref,
  onRetry,
}: {
  caseId: string | null;
  explicitCaseId: string | null;
  value: AfterSaleCaseDetail | undefined;
  isLoading: boolean;
  error: unknown;
  backHref: string;
  onRetry: () => void;
}) {
  return (
    <section className="exception-detail-panel" aria-label="售后工单详情">
      {explicitCaseId ? (
        <Link href={backHref} className="exception-mobile-back">
          <BackIcon />
          返回工单列表
        </Link>
      ) : null}
      {!caseId ? <NoSelection /> : null}
      {caseId && isLoading ? <DetailSkeleton /> : null}
      {caseId && !isLoading && error ? (
        <ErrorState title="无法读取工单详情" error={error} onRetry={onRetry} />
      ) : null}
      {caseId && !isLoading && !error && value ? (
        <AfterSaleDetailContent value={value} focusHeading={Boolean(explicitCaseId)} />
      ) : null}
    </section>
  );
}

function AfterSaleDetailContent({
  value,
  focusHeading,
}: {
  value: AfterSaleCaseDetail;
  focusHeading: boolean;
}) {
  const queryClient = useQueryClient();
  const [claimNote, setClaimNote] = useState('');
  const [closeNote, setCloseNote] = useState('');
  const [message, setMessage] = useState('');
  const claimRequestIdRef = useRef<string | null>(null);
  const closeRequestIdRef = useRef<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const blockers = normalizedClosureBlockers(value.closureBlockers);
  const blockerActionOwners = new Map<string, number>();
  blockers.forEach((blocker, index) => {
    const actionKey = closureBlockerActionKey(blocker);
    if (actionKey && !blockerActionOwners.has(actionKey)) blockerActionOwners.set(actionKey, index);
  });
  const due = dueLabel(value.nextActionDueAt, value.overdue);

  useEffect(() => {
    setClaimNote('');
    setCloseNote('');
    setMessage('');
    claimRequestIdRef.current = null;
    closeRequestIdRef.current = null;
  }, [value.id, value.stateRevision]);

  useEffect(() => {
    if (!focusHeading || !window.matchMedia('(max-width: 1279px)').matches) return;
    requestAnimationFrame(() => headingRef.current?.focus());
  }, [focusHeading, value.id]);

  const updateQueries = async (updated?: AfterSaleCaseDetail) => {
    if (updated) queryClient.setQueryData(['after-sale-case', value.id], updated);
    await queryClient.invalidateQueries({ queryKey: ['after-sale-cases'] });
  };
  const handleConflict = async (error: unknown) => {
    if (!isAfterSaleConflict(error)) return false;
    setMessage('工单已被其他操作更新，已重新读取最新状态，请核对后再次提交。');
    claimRequestIdRef.current = null;
    closeRequestIdRef.current = null;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['after-sale-case', value.id] }),
      queryClient.invalidateQueries({ queryKey: ['after-sale-cases'] }),
    ]);
    return true;
  };

  const refreshSalesSource = useMutation({
    mutationFn: () => api.refreshOrder(value.order.id),
    onSuccess: async (order) => {
      setMessage(
        `抖店状态已刷新：订单 ${order.status}，售后 ${order.afterSaleStatus}；工单已重新检查。`,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['after-sale-case', value.id] }),
        queryClient.invalidateQueries({ queryKey: ['after-sale-cases'] }),
      ]);
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setMessage('订单状态已被其他同步更新，已重新读取工单，请核对最新状态。');
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['after-sale-case', value.id] }),
          queryClient.invalidateQueries({ queryKey: ['after-sale-cases'] }),
        ]);
        return;
      }
      if (error instanceof ApiError && error.status === 503) {
        setMessage(`抖店状态暂时无法回读：${error.message} 请稍后重试，系统不会据此关闭工单。`);
        return;
      }
      setMessage(`刷新抖店状态失败：${errorMessage(error)}`);
    },
  });

  const claim = useMutation({
    mutationFn: () =>
      api.claimAfterSaleCase(value.id, {
        expectedRevision: value.stateRevision,
        clientRequestId:
          claimRequestIdRef.current ?? (claimRequestIdRef.current = createClientRequestId()),
        note: claimNote.trim(),
      }),
    onSuccess: async (updated) => {
      claimRequestIdRef.current = null;
      setMessage('已认领工单，处理记录已保存。');
      await updateQueries(updated);
    },
    onError: async (error) => {
      if (await handleConflict(error)) return;
      setMessage(`认领失败：${errorMessage(error)}`);
    },
  });
  const verifyClose = useMutation({
    mutationFn: () =>
      api.verifyCloseAfterSaleCase(value.id, {
        expectedRevision: value.stateRevision,
        clientRequestId:
          closeRequestIdRef.current ?? (closeRequestIdRef.current = createClientRequestId()),
        note: closeNote.trim(),
      }),
    onSuccess: async (updated) => {
      closeRequestIdRef.current = null;
      setMessage(
        updated.status === 'closed' ? '关闭条件已验证，工单已关闭。' : '已重新校验关闭条件。',
      );
      await updateQueries(updated);
    },
    onError: async (error) => {
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === 'AFTER_SALE_NOT_CLOSABLE'
      ) {
        setMessage('关闭条件未满足，已重新读取阻断项，请处理后再次核验。');
        closeRequestIdRef.current = null;
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['after-sale-case', value.id] }),
          queryClient.invalidateQueries({ queryKey: ['after-sale-cases'] }),
        ]);
        return;
      }
      if (await handleConflict(error)) return;
      setMessage(`关闭校验失败：${errorMessage(error)}`);
    },
  });

  return (
    <article className="exception-detail-content" aria-labelledby="after-sale-detail-title">
      <header className="exception-detail-header">
        <div className="exception-detail-badges">
          <span className="exception-domain-chip">售后工单</span>
          <span className="exception-priority-label" data-priority={value.priority}>
            {afterSalePriorityLabel(value.priority)}
          </span>
          <span className="exception-status-badge" data-status={value.status}>
            {afterSaleStatusLabel(value.status)}
          </span>
          <span className="after-sale-due-chip" data-tone={due.tone}>
            {due.label}
          </span>
        </div>
        <h2 ref={headingRef} id="after-sale-detail-title" tabIndex={-1}>
          {value.items[0]?.title || `销售订单 ${value.order.platformOrderId}`}
        </h2>
        <p>
          {value.order.shopName ?? '销售店铺'} · 订单 {value.order.platformOrderId}
        </p>
        <div className="exception-detail-time">
          <span>创建于 {formatFullTime(value.openedAt)}</span>
          <span>更新于 {formatFullTime(value.updatedAt)}</span>
          <strong>来源版本 {value.sourceRevision}</strong>
        </div>
      </header>

      <section className="exception-safety-state" data-resolved={value.status === 'closed'}>
        <ShieldIcon />
        <div>
          <strong>
            {value.status === 'closed'
              ? '关闭证据已验证'
              : value.sourceActive
                ? '销售售后来源仍在跟踪'
                : '来源已收敛，等待完整关闭校验'}
          </strong>
          <p>
            {value.status === 'closed'
              ? '销售状态、1688 人工动作与财务条件均已通过服务端验证。'
              : '认领或记录人工动作不会直接关闭工单；所有阻断项清零后仍需执行关闭校验。'}
          </p>
        </div>
      </section>

      <div className="after-sale-overview-grid">
        <DetailSection title="销售平台状态">
          <dl className="after-sale-summary-list">
            <SummaryItem label="订单状态" value={value.order.status} />
            <SummaryItem label="售后状态" value={value.order.afterSaleStatus} />
            <SummaryItem label="销售子单" value={`${value.items.length} 项`} />
          </dl>
          {value.status !== 'closed' ? (
            <button
              type="button"
              className="after-sale-inline-refresh"
              disabled={refreshSalesSource.isPending}
              onClick={() => {
                setMessage('');
                refreshSalesSource.mutate();
              }}
            >
              <RefreshIcon spinning={refreshSalesSource.isPending} />
              {refreshSalesSource.isPending ? '正在回读抖店…' : '刷新抖店状态'}
            </button>
          ) : null}
        </DetailSection>
        <DetailSection title="当前责任与时限">
          <dl className="after-sale-summary-list">
            <SummaryItem label="等待对象" value={waitingOnLabel(value.waitingOn)} />
            <SummaryItem
              label="责任人"
              value={value.assigneeUserId ? '当前运营已认领' : '等待认领'}
            />
            <SummaryItem label="处理时限" value={due.label} tone={due.tone} />
          </dl>
        </DetailSection>
      </div>

      <section
        className="after-sale-next-action exception-next-action-card"
        data-status={value.status}
      >
        <div>
          <span>建议下一步</span>
          <h3>{value.nextAction}</h3>
        </div>
        {!value.assigneeUserId && value.status !== 'closed' ? (
          <form
            className="exception-acknowledge-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (claimNote.trim().length >= 2 && !claim.isPending) claim.mutate();
            }}
          >
            <label htmlFor={`after-sale-claim-${value.id}`}>认领说明</label>
            <textarea
              id={`after-sale-claim-${value.id}`}
              value={claimNote}
              rows={3}
              maxLength={500}
              aria-invalid={Boolean(claimNote && claimNote.trim().length < 2)}
              onChange={(event) => {
                setClaimNote(event.target.value);
                setMessage('');
                claimRequestIdRef.current = null;
              }}
              placeholder="写明准备核对的销售售后与 1688 动作"
            />
            <p>认领只代表开始处理，不会改变外部平台状态。</p>
            <div className="exception-action-buttons">
              <button
                type="submit"
                className="exception-primary-action"
                disabled={claimNote.trim().length < 2 || claim.isPending}
              >
                {claim.isPending ? '正在认领…' : '认领并开始处理'}
              </button>
            </div>
          </form>
        ) : value.status !== 'closed' ? (
          <p className="after-sale-assigned-note">
            当前工单已认领，继续按下方采购关联记录外部处理结果。
          </p>
        ) : null}
        {message ? (
          <p
            className={`exception-form-message ${claim.isError || verifyClose.isError || refreshSalesSource.isError ? 'is-error' : ''}`}
            role={
              claim.isError || verifyClose.isError || refreshSalesSource.isError
                ? 'alert'
                : 'status'
            }
          >
            {message}
          </p>
        ) : null}
      </section>

      <section className="after-sale-items-section" aria-labelledby="after-sale-items-heading">
        <SectionHeading
          eyebrow="Sales items"
          title="销售售后明细"
          count={`${value.items.length} 项`}
          id="after-sale-items-heading"
        />
        <div className="after-sale-item-list">
          {value.items.map((item) => (
            <AfterSaleItemRow key={item.id} value={item} />
          ))}
        </div>
      </section>

      <section className="after-sale-links-section" aria-labelledby="after-sale-links-heading">
        <SectionHeading
          eyebrow="1688 actions"
          title="采购关联与人工动作"
          count={`${value.purchaseLinks.length} 条`}
          id="after-sale-links-heading"
        />
        {value.purchaseLinks.length > 0 ? (
          <div className="after-sale-link-list">
            {value.purchaseLinks.map((link) => (
              <PurchaseLinkCard key={link.id} caseValue={value} link={link} />
            ))}
          </div>
        ) : (
          <p className="after-sale-section-empty">当前工单没有需要处理的 1688 采购关联。</p>
        )}
      </section>

      <section className="after-sale-close-panel" data-ready={blockers.length === 0}>
        <SectionHeading
          eyebrow="Closure gate"
          title="关闭前核验"
          count={blockers.length === 0 ? '条件已齐' : `${blockers.length} 项阻断`}
        />
        {value.status === 'closed' ? (
          <div className="after-sale-closed-copy">
            <CheckIcon />
            <span>工单已于 {formatFullTime(value.closedAt)} 关闭，事件与证据继续保留。</span>
          </div>
        ) : blockers.length > 0 ? (
          <ul className="after-sale-blocker-list">
            {blockers.map((blocker, index) => {
              const actionKey = closureBlockerActionKey(blocker);
              const ownsAction = actionKey !== null && blockerActionOwners.get(actionKey) === index;
              return (
                <li key={`${blocker.code}:${blocker.purchaseOrderId ?? index}`}>
                  <span aria-hidden="true">!</span>
                  <div>
                    <strong>{blocker.label}</strong>
                    {blocker.detail ? <p>{blocker.detail}</p> : null}
                    {ownsAction ? (
                      <ClosureBlockerAction
                        caseValue={value}
                        blocker={blocker}
                        onResolved={setMessage}
                      />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <form
            className="after-sale-close-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (closeNote.trim().length >= 2 && !verifyClose.isPending) verifyClose.mutate();
            }}
          >
            <label htmlFor={`after-sale-close-${value.id}`}>关闭核验说明</label>
            <textarea
              id={`after-sale-close-${value.id}`}
              value={closeNote}
              rows={3}
              maxLength={500}
              aria-invalid={Boolean(closeNote && closeNote.trim().length < 2)}
              onChange={(event) => {
                setCloseNote(event.target.value);
                setMessage('');
                closeRequestIdRef.current = null;
              }}
              placeholder="写明已核对的销售结果、1688 结果和成本依据"
            />
            <p>服务端会重新读取权威状态；页面无阻断项不等于直接授权关闭。</p>
            <button
              type="submit"
              className="after-sale-verify-button"
              disabled={closeNote.trim().length < 2 || verifyClose.isPending}
            >
              {verifyClose.isPending ? '正在核验…' : '核验并关闭工单'}
            </button>
          </form>
        )}
      </section>

      <details className="exception-technical-details">
        <summary>查看技术信息</summary>
        <dl>
          <div>
            <dt>工单 ID</dt>
            <dd>{value.id}</dd>
          </div>
          <div>
            <dt>状态版本</dt>
            <dd>{value.stateRevision}</dd>
          </div>
          <div>
            <dt>来源版本</dt>
            <dd>{value.sourceRevision}</dd>
          </div>
          <div>
            <dt>销售订单 ID</dt>
            <dd>{value.order.id}</dd>
          </div>
        </dl>
      </details>

      <section className="exception-event-section" aria-labelledby="after-sale-events-title">
        <SectionHeading
          eyebrow="Audit trail"
          title="处理时间线"
          count={`${value.events.length} 条`}
          id="after-sale-events-title"
        />
        {value.events.length > 0 ? (
          <ol className="exception-event-list">
            {value.events.map((event) => (
              <AfterSaleEventItem key={event.id} value={event} />
            ))}
          </ol>
        ) : (
          <p className="exception-events-empty">暂无处理记录。</p>
        )}
      </section>
    </article>
  );
}

function ClosureBlockerAction({
  caseValue,
  blocker,
  onResolved,
}: {
  caseValue: AfterSaleCaseDetail;
  blocker: AfterSaleClosureBlocker;
  onResolved: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const action = closureBlockerAction(blocker.code);
  const purchaseLink = blocker.purchaseOrderId
    ? caseValue.purchaseLinks.find((link) => link.purchaseOrderId === blocker.purchaseOrderId)
    : undefined;
  const [partialRefundAction, setPartialRefundAction] = useState<'continue_remaining' | 'stop_all'>(
    'stop_all',
  );
  const [amountInput, setAmountInput] = useState('');
  const [note, setNote] = useState('');
  const maxRefundAmount =
    typeof caseValue.order.amount === 'number' && caseValue.order.amount > 0
      ? caseValue.order.amount
      : undefined;
  const refundInputMax = refundAmountInputMax(maxRefundAmount);
  const amount =
    action === 'refund_amount_confirmation'
      ? parseClosureMoney(amountInput, { allowZero: false, maxExclusive: maxRefundAmount })
      : parseClosureMoney(amountInput, { allowZero: true });
  const canSubmit =
    note.trim().length >= 2 &&
    (action === 'partial_refund_decision' ||
      (action === 'refund_amount_confirmation' && amount !== null) ||
      (action === 'purchase_cost_reconciliation' && amount !== null && purchaseLink !== undefined));

  const mutation = useMutation({
    mutationFn: async () => {
      if (action === 'partial_refund_decision') {
        return api.resolvePartialRefund(caseValue.order.id, partialRefundAction, note.trim());
      }
      if (action === 'refund_amount_confirmation' && amount !== null) {
        return api.confirmRefundAmount(caseValue.order.id, amount, note.trim());
      }
      if (action === 'purchase_cost_reconciliation' && amount !== null && purchaseLink) {
        return api.resolvePurchaseException(
          caseValue.order.id,
          purchaseLink.purchaseOrderId,
          amount,
          purchaseLink.purchaseExceptionRevision,
          note.trim(),
        );
      }
      throw new Error('当前阻断项缺少可提交的数据，请刷新工单后重试。');
    },
    onSuccess: async () => {
      const successMessage =
        action === 'partial_refund_decision'
          ? '部分退款处置已保存，工单详情已刷新。'
          : action === 'refund_amount_confirmation'
            ? '累计实际退款金额已核对，工单详情已刷新。'
            : '采购异常与最终实际成本已核销，工单详情已刷新。';
      onResolved(successMessage);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['after-sale-case', caseValue.id] }),
        queryClient.invalidateQueries({ queryKey: ['after-sale-cases'] }),
      ]);
    },
    onError: async (error) => {
      if (!isAfterSaleStaleMutation(error)) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['after-sale-case', caseValue.id] }),
        queryClient.invalidateQueries({ queryKey: ['after-sale-cases'] }),
      ]);
      onResolved('提交未生效：数据版本已变化，工单已刷新，请核对最新状态后重试。');
    },
  });

  if (!action) return null;
  if (action === 'purchase_cost_reconciliation' && !purchaseLink) {
    return (
      <p className="after-sale-blocker-action-unavailable" role="status">
        未找到对应采购关联，请先同步售后工单后再核销成本。
      </p>
    );
  }

  const clearMutationError = () => {
    if (mutation.isError) mutation.reset();
  };
  const actionId = `${caseValue.id}-${blocker.code}-${blocker.purchaseOrderId ?? 'order'}`;

  return (
    <form
      className="after-sale-blocker-action"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit && !mutation.isPending) mutation.mutate();
      }}
    >
      {action === 'partial_refund_decision' ? (
        <label htmlFor={`after-sale-partial-refund-${actionId}`}>
          <span>剩余商品处理方式</span>
          <select
            id={`after-sale-partial-refund-${actionId}`}
            value={partialRefundAction}
            onChange={(event) => {
              setPartialRefundAction(event.target.value as 'continue_remaining' | 'stop_all');
              clearMutationError();
            }}
          >
            <option value="stop_all">停止整单自动履约</option>
            <option value="continue_remaining">仅继续未退款子单</option>
          </select>
          <small>继续履约仅在尚未创建远端采购且剩余子单完整时可用，服务端会再次校验。</small>
        </label>
      ) : (
        <label htmlFor={`after-sale-amount-${actionId}`}>
          <span>
            {action === 'refund_amount_confirmation' ? '累计实际退款金额' : '最终实际采购成本'}
          </span>
          <input
            id={`after-sale-amount-${actionId}`}
            type="number"
            min={action === 'refund_amount_confirmation' ? '0.01' : '0'}
            max={action === 'refund_amount_confirmation' ? refundInputMax : '99999999.99'}
            step="0.01"
            inputMode="decimal"
            value={amountInput}
            onChange={(event) => {
              setAmountInput(event.target.value);
              clearMutationError();
            }}
            placeholder={action === 'refund_amount_confirmation' ? '例如 18.50' : '例如 76.20'}
          />
          <small>
            {action === 'refund_amount_confirmation'
              ? '填写抖店后台显示的累计退款实付，必须小于订单实付金额。'
              : '填写已退款、未退款及历史失败尝试合并后的最终实际成本。'}
          </small>
        </label>
      )}
      <label htmlFor={`after-sale-blocker-note-${actionId}`}>
        <span>核对依据</span>
        <textarea
          id={`after-sale-blocker-note-${actionId}`}
          rows={3}
          maxLength={500}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
            clearMutationError();
          }}
          placeholder="写明平台后台结果、金额或人工处理依据"
        />
      </label>
      <button type="submit" disabled={!canSubmit || mutation.isPending}>
        {mutation.isPending
          ? '正在提交…'
          : action === 'partial_refund_decision'
            ? '确认剩余履约方式'
            : action === 'refund_amount_confirmation'
              ? '确认退款金额'
              : '核销异常与最终成本'}
      </button>
      {mutation.isError ? (
        <p className="after-sale-blocker-action-message is-error" role="alert">
          {isAfterSaleStaleMutation(mutation.error)
            ? '提交未生效：数据版本已变化，工单已刷新，请核对最新状态后重试。'
            : `提交失败：${errorMessage(mutation.error)}`}
        </p>
      ) : null}
    </form>
  );
}

function PurchaseLinkCard({
  caseValue,
  link,
}: {
  caseValue: AfterSaleCaseDetail;
  link: AfterSalePurchaseLink;
}) {
  const queryClient = useQueryClient();
  const stage = purchaseLinkStage(link);
  const [action, setAction] = useState<AfterSalePurchaseAction>('refund');
  const [referenceType, setReferenceType] =
    useState<AfterSaleRemoteReferenceType>('purchase_order');
  const [referenceId, setReferenceId] = useState('');
  const [startNote, setStartNote] = useState('');
  const [result, setResult] = useState<AfterSalePurchaseActionResult>('confirmed');
  const [confirmNote, setConfirmNote] = useState('');
  const [message, setMessage] = useState('');
  const startRequestIdRef = useRef<string | null>(null);
  const confirmRequestIdRef = useRef<string | null>(null);

  useEffect(() => {
    setReferenceId(link.remoteReferenceId ?? '');
    setMessage('');
    startRequestIdRef.current = null;
    confirmRequestIdRef.current = null;
  }, [link.id, link.purchaseExceptionRevision, link.purchaseSyncRevision, link.remoteReferenceId]);

  const updateQueries = async (updated?: AfterSaleCaseDetail) => {
    if (updated) queryClient.setQueryData(['after-sale-case', caseValue.id], updated);
    await queryClient.invalidateQueries({ queryKey: ['after-sale-cases'] });
  };
  const handleError = async (error: unknown, label: string) => {
    if (isAfterSaleConflict(error)) {
      setMessage('采购关联已更新，已重新读取最新状态，请核对后再次提交。');
      startRequestIdRef.current = null;
      confirmRequestIdRef.current = null;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['after-sale-case', caseValue.id] }),
        queryClient.invalidateQueries({ queryKey: ['after-sale-cases'] }),
      ]);
      return;
    }
    setMessage(`${label}失败：${errorMessage(error)}`);
  };

  const startMutation = useMutation({
    mutationFn: () =>
      api.startAfterSalePurchaseAction(caseValue.id, link.id, {
        expectedRevision: caseValue.stateRevision,
        clientRequestId:
          startRequestIdRef.current ?? (startRequestIdRef.current = createClientRequestId()),
        note: startNote.trim(),
        action,
        remoteReferenceType: referenceType,
        remoteReferenceId: referenceId.trim(),
        expectedPurchaseExceptionRevision: link.purchaseExceptionRevision,
        expectedPurchaseSyncRevision: link.purchaseSyncRevision,
      }),
    onSuccess: async (updated) => {
      startRequestIdRef.current = null;
      setMessage('1688 人工动作已记录，等待结果确认。');
      await updateQueries(updated);
    },
    onError: (error) => void handleError(error, '记录人工动作'),
  });
  const confirmMutation = useMutation({
    mutationFn: () =>
      api.confirmAfterSalePurchaseAction(caseValue.id, link.id, {
        expectedRevision: caseValue.stateRevision,
        clientRequestId:
          confirmRequestIdRef.current ?? (confirmRequestIdRef.current = createClientRequestId()),
        note: confirmNote.trim(),
        result,
        expectedPurchaseExceptionRevision: link.purchaseExceptionRevision,
        expectedPurchaseSyncRevision: link.purchaseSyncRevision,
      }),
    onSuccess: async (updated) => {
      confirmRequestIdRef.current = null;
      setMessage('1688 处理结果已确认并写入审计记录。');
      await updateQueries(updated);
    },
    onError: (error) => void handleError(error, '确认处理结果'),
  });

  return (
    <article className="after-sale-link-card" data-stage={stage}>
      <header>
        <div>
          <span>1688 采购</span>
          <strong>{link.orderId1688 ?? link.outOrderId ?? link.purchaseOrderId}</strong>
        </div>
        <span className="after-sale-link-status">{purchaseStageLabel(stage)}</span>
      </header>
      <dl className="after-sale-link-meta">
        <SummaryItem label="关联状态" value={link.status} />
        <SummaryItem label="异常状态" value={link.exceptionStatus} />
        <SummaryItem label="异常版本" value={String(link.purchaseExceptionRevision)} />
        <SummaryItem label="同步版本" value={String(link.purchaseSyncRevision)} />
      </dl>

      {stage === 'start' && caseValue.status !== 'closed' ? (
        <form
          className="after-sale-link-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (
              referenceId.trim().length >= 1 &&
              startNote.trim().length >= 2 &&
              !startMutation.isPending
            ) {
              startMutation.mutate();
            }
          }}
        >
          <div className="after-sale-link-fields">
            <label>
              <span>人工动作</span>
              <select
                value={action}
                onChange={(event) => {
                  setAction(event.target.value as AfterSalePurchaseAction);
                  startRequestIdRef.current = null;
                }}
              >
                <option value="refund">申请退款</option>
                <option value="cancel">取消采购</option>
                <option value="return_refund">退货退款</option>
                <option value="intercept">拦截物流</option>
                <option value="accept_loss">接受损失并结案</option>
                <option value="manual_review">转人工复核</option>
              </select>
            </label>
            <label>
              <span>外部凭证类型</span>
              <select
                value={referenceType}
                onChange={(event) => {
                  setReferenceType(event.target.value as AfterSaleRemoteReferenceType);
                  startRequestIdRef.current = null;
                }}
              >
                <option value="purchase_order">采购单号</option>
                <option value="refund">退款单号</option>
                <option value="return_order">退货单号</option>
                <option value="logistics">物流凭证</option>
                <option value="other">其他平台凭证</option>
              </select>
            </label>
          </div>
          <label>
            <span>1688 凭证编号</span>
            <input
              value={referenceId}
              maxLength={128}
              onChange={(event) => {
                setReferenceId(event.target.value);
                startRequestIdRef.current = null;
              }}
              placeholder="粘贴退款单号或平台工单号"
            />
          </label>
          <label>
            <span>处理依据</span>
            <textarea
              value={startNote}
              rows={3}
              maxLength={500}
              onChange={(event) => {
                setStartNote(event.target.value);
                startRequestIdRef.current = null;
              }}
              placeholder="写明已在 1688 完成的操作和核对依据"
            />
          </label>
          <button
            type="submit"
            disabled={
              referenceId.trim().length < 1 ||
              startNote.trim().length < 2 ||
              startMutation.isPending
            }
          >
            {startMutation.isPending ? '正在记录…' : '记录 1688 人工动作'}
          </button>
        </form>
      ) : null}

      {stage === 'confirm' && caseValue.status !== 'closed' ? (
        <form
          className="after-sale-link-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (confirmNote.trim().length >= 2 && !confirmMutation.isPending) {
              confirmMutation.mutate();
            }
          }}
        >
          <div className="after-sale-reference-copy">
            <span>{link.remoteReferenceType ?? '外部凭证'}</span>
            <code>{link.remoteReferenceId ?? '—'}</code>
          </div>
          <label>
            <span>处理结果</span>
            <select
              value={result}
              onChange={(event) => {
                setResult(event.target.value as AfterSalePurchaseActionResult);
                confirmRequestIdRef.current = null;
              }}
            >
              <option value="confirmed">已确认退款/取消/拦截</option>
              <option value="failed">处理失败，需继续跟进</option>
            </select>
          </label>
          <label>
            <span>结果依据</span>
            <textarea
              value={confirmNote}
              rows={3}
              maxLength={500}
              onChange={(event) => {
                setConfirmNote(event.target.value);
                confirmRequestIdRef.current = null;
              }}
              placeholder="写明平台结果、退款到账或物流拦截依据"
            />
          </label>
          <button
            type="submit"
            disabled={confirmNote.trim().length < 2 || confirmMutation.isPending}
          >
            {confirmMutation.isPending ? '正在确认…' : '确认 1688 处理结果'}
          </button>
        </form>
      ) : null}

      {stage === 'confirmed' ? (
        <div className="after-sale-link-confirmed">
          <CheckIcon />
          <div>
            <strong>处理结果已确认：{link.result}</strong>
            <span>
              {link.remoteReferenceType ?? '外部凭证'} {link.remoteReferenceId ?? '—'}
            </span>
          </div>
        </div>
      ) : null}

      {stage === 'not_required' ? (
        <div className="after-sale-link-confirmed">
          <CheckIcon />
          <div>
            <strong>无需人工动作</strong>
            <span>当前采购关联无需在 1688 侧额外处理。</span>
          </div>
        </div>
      ) : null}

      {message ? (
        <p
          className={`after-sale-link-message ${startMutation.isError || confirmMutation.isError ? 'is-error' : ''}`}
          role={startMutation.isError || confirmMutation.isError ? 'alert' : 'status'}
        >
          {message}
        </p>
      ) : null}
    </article>
  );
}

function AfterSaleItemRow({ value }: { value: AfterSaleCaseItem }) {
  return (
    <article>
      <div>
        <strong>{value.title}</strong>
        <span>销售子单 {value.platformOrderItemId}</span>
      </div>
      <dl>
        <SummaryItem label="数量" value={String(value.quantity)} />
        <SummaryItem label="售后状态" value={rawStatus(value.afterSaleStatusRaw)} />
        <SummaryItem label="售后类型" value={rawStatus(value.afterSaleTypeRaw)} />
        <SummaryItem label="退款结果" value={rawStatus(value.refundStatusRaw)} />
      </dl>
    </article>
  );
}

function AfterSaleEventItem({ value }: { value: AfterSaleCaseEvent }) {
  const actor =
    value.actor.type === 'user' ? '运营人员' : value.actor.type === 'worker' ? '自动任务' : '系统';
  return (
    <li>
      <span className="exception-event-marker" aria-hidden="true" />
      <div>
        <div className="exception-event-heading">
          <strong>{afterSaleEventLabel(value.type)}</strong>
          <time dateTime={value.createdAt}>{formatFullTime(value.createdAt)}</time>
        </div>
        <small>{actor}</small>
        {value.note ? <p>{value.note}</p> : null}
        {value.evidence.length > 0 ? (
          <ul className="exception-evidence-list" aria-label="处理证据">
            {value.evidence.map((evidence, index) => (
              <li key={`${evidence.type}-${index}`}>
                <span>{evidence.label}</span>
                {evidence.value ? <code>{evidence.value}</code> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="exception-detail-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function SummaryItem({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'warning' | 'danger';
}) {
  return (
    <div data-tone={tone}>
      <dt>{label}</dt>
      <dd>{value || '—'}</dd>
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  count,
  id,
}: {
  eyebrow: string;
  title: string;
  count: string;
  id?: string;
}) {
  return (
    <header className="after-sale-section-heading">
      <div>
        <span>{eyebrow}</span>
        <h3 id={id}>{title}</h3>
      </div>
      <strong>{count}</strong>
    </header>
  );
}

function EmptyState({
  status,
  filtered,
  onRefresh,
}: {
  status: AfterSaleCaseStatus;
  filtered: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="exception-empty-state">
      <span aria-hidden="true">
        <CheckIcon />
      </span>
      <strong>
        {filtered ? '当前筛选条件下没有工单。' : `${afterSaleStatusLabel(status)}暂无工单。`}
      </strong>
      <p>{filtered ? '调整时限或搜索条件后再试。' : '系统会持续同步销售售后并保留处理证据。'}</p>
      {!filtered && status === 'open' ? (
        <button type="button" onClick={onRefresh}>
          同步最新状态
        </button>
      ) : null}
    </div>
  );
}

function NoSelection() {
  return (
    <div className="exception-no-selection">
      <span aria-hidden="true">
        <InboxIcon />
      </span>
      <strong>选择一条售后工单</strong>
      <p>这里会并排展示销售售后、1688 人工动作、关闭阻断项和处理时间线。</p>
    </div>
  );
}

function ErrorState({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <div className="exception-error-state" role="alert">
      <strong>{title}</strong>
      <p>{errorMessage(error)}</p>
      <button type="button" onClick={onRetry}>
        重试读取
      </button>
    </div>
  );
}

function QueueSkeleton() {
  return (
    <div className="exception-queue-skeleton" role="status" aria-live="polite">
      <span className="sr-only">正在读取售后工单…</span>
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index}>
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="exception-detail-skeleton" role="status" aria-live="polite">
      <span className="sr-only">正在读取售后工单详情…</span>
      <div />
      <div />
      <div />
      <div />
    </div>
  );
}

export function AfterSaleWorkbenchPageSkeleton() {
  return (
    <main className="app-page exception-center-page after-sale-page" aria-busy="true">
      <header className="exception-page-header">
        <div>
          <p className="page-kicker">After-sales desk</p>
          <h1 className="page-title">售后工单</h1>
          <p className="page-description">正在打开售后工作台…</p>
        </div>
      </header>
      <div className="exception-workspace">
        <section className="exception-queue-panel">
          <QueueSkeleton />
        </section>
        <section className="exception-detail-panel">
          <DetailSkeleton />
        </section>
      </div>
    </main>
  );
}

function purchaseStageLabel(stage: ReturnType<typeof purchaseLinkStage>): string {
  if (stage === 'not_required') return '无需人工动作';
  if (stage === 'confirmed') return '结果已确认';
  if (stage === 'confirm') return '等待结果确认';
  return '待记录动作';
}

function rawStatus(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : String(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return '服务暂时不可用，请稍后重试。';
}

function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg
      className={spinning ? 'is-spinning' : ''}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m16.2 16.2 4 4" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

function InboxIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M4 4h16v13H15.5l-1.8 3h-3.4l-1.8-3H4V4Zm0 9h4.7l1.8 2.5h3L15.3 13H20" />
    </svg>
  );
}
