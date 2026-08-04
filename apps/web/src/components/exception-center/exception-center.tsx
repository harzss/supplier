'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  api,
  type ExceptionCaseDetail,
  type ExceptionCaseEvent,
  type ExceptionCaseListItem,
  type ExceptionCaseStatus,
} from '@/lib/api';
import {
  createClientRequestId,
  domainLabel,
  eventLabel,
  EXCEPTION_DOMAINS,
  EXCEPTION_PRIORITIES,
  EXCEPTION_STATUSES,
  formatFullTime,
  formatRelativeTime,
  isExceptionCaseConflict,
  parseExceptionDomain,
  parseExceptionPriority,
  parseExceptionStatus,
  parsePositivePage,
  priorityLabel,
  responsiblePartyLabel,
  safeInternalActionHref,
  statusLabel,
  summarizeRefreshResult,
} from './exception-center-utils';

const PAGE_SIZE = 30;
type QueryUpdate = Record<string, string | number | null | undefined>;

export function ExceptionCenter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const status = parseExceptionStatus(searchParams.get('status'));
  const domain = parseExceptionDomain(searchParams.get('domain'));
  const priority = parseExceptionPriority(searchParams.get('priority'));
  const queryText = searchParams.get('q')?.trim().slice(0, 100) ?? '';
  const page = parsePositivePage(searchParams.get('page'));
  const explicitCaseId = searchParams.get('case')?.trim() || null;
  const [searchInput, setSearchInput] = useState(queryText);
  const [refreshMessage, setRefreshMessage] = useState('');
  const previousExplicitCaseIdRef = useRef(explicitCaseId);

  useEffect(() => setSearchInput(queryText), [queryText]);
  useEffect(() => {
    const previousId = previousExplicitCaseIdRef.current;
    previousExplicitCaseIdRef.current = explicitCaseId;
    if (!previousId || explicitCaseId) return;
    requestAnimationFrame(() => document.getElementById(`exception-case-${previousId}`)?.focus());
  }, [explicitCaseId]);

  const listQuery = useQuery({
    queryKey: ['exception-cases', status, domain ?? '', priority ?? '', queryText, page, PAGE_SIZE],
    queryFn: () =>
      api.exceptionCases({
        status,
        domain,
        priority,
        q: queryText || undefined,
        page,
        pageSize: PAGE_SIZE,
      }),
    placeholderData: (previous) => previous,
  });
  const selectedCaseId = explicitCaseId ?? listQuery.data?.items[0]?.id ?? null;
  const detailQuery = useQuery({
    queryKey: ['exception-case', selectedCaseId],
    queryFn: () => api.exceptionCase(selectedCaseId!),
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
    mutationFn: () => api.refreshExceptionCases(),
    onSuccess: async (result) => {
      setRefreshMessage(summarizeRefreshResult(result));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['exception-cases'] }),
        queryClient.invalidateQueries({ queryKey: ['exception-case'] }),
      ]);
    },
    onError: (error) => setRefreshMessage(`重新检查失败：${errorMessage(error)}`),
  });

  const activeFilters =
    Number(Boolean(domain)) + Number(Boolean(priority)) + Number(Boolean(queryText));
  const currentCount = listQuery.data?.total;
  const criticalCount = listQuery.data?.criticalOpenCount;

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    replaceQuery({ q: searchInput.trim().slice(0, 100) || null, page: null, case: null });
  };

  return (
    <main className="app-page exception-center-page" data-mobile-detail={Boolean(explicitCaseId)}>
      <header className="exception-page-header">
        <div>
          <p className="page-kicker">Operations</p>
          <h1 className="page-title">待办与异常</h1>
          <p className="page-description">
            发布、订单、采购、物流、售后与权益问题按风险集中排序，并明确下一步。
          </p>
          <p className="exception-focus-summary" aria-live="polite">
            {currentCount === undefined
              ? '正在读取最新异常…'
              : `${statusLabel(status)} ${currentCount} 件`}
            {status === 'open' && criticalCount !== undefined
              ? ` · 未关闭紧急 ${criticalCount} 件`
              : ''}
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
          {refreshMutation.isPending ? '正在检查 6 类异常…' : '重新检查'}
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

      <section className="exception-controls" aria-label="异常筛选">
        <div className="exception-status-switch" role="group" aria-label="处理状态">
          {EXCEPTION_STATUSES.map((option) => {
            const count = listQuery.data?.counts?.[option.value];
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

        <div className="exception-filter-bar">
          <form className="exception-search" role="search" onSubmit={submitSearch}>
            <label className="sr-only" htmlFor="exception-search-input">
              搜索异常
            </label>
            <SearchIcon />
            <input
              id="exception-search-input"
              type="search"
              value={searchInput}
              maxLength={100}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="搜索订单、任务或商品"
            />
            <button type="submit">搜索</button>
          </form>
          <label className="exception-select-label">
            <span>业务域</span>
            <select
              value={domain ?? ''}
              onChange={(event) =>
                replaceQuery({ domain: event.target.value || null, page: null, case: null })
              }
            >
              <option value="">全部业务</option>
              {EXCEPTION_DOMAINS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="exception-select-label">
            <span>优先级</span>
            <select
              value={priority ?? ''}
              onChange={(event) =>
                replaceQuery({ priority: event.target.value || null, page: null, case: null })
              }
            >
              <option value="">全部优先级</option>
              {EXCEPTION_PRIORITIES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="exception-clear-filters"
            disabled={activeFilters === 0}
            onClick={() => {
              setSearchInput('');
              replaceQuery({ domain: null, priority: null, q: null, page: null, case: null });
            }}
          >
            清除筛选{activeFilters > 0 ? `（${activeFilters}）` : ''}
          </button>
        </div>
      </section>

      <section
        className="exception-workspace"
        data-mobile-detail={Boolean(explicitCaseId)}
        aria-label="异常处置工作区"
      >
        <ExceptionQueue
          items={listQuery.data?.items ?? []}
          total={listQuery.data?.total ?? 0}
          page={page}
          totalPages={totalPages}
          selectedCaseId={selectedCaseId}
          status={status}
          activeFilters={activeFilters}
          hrefWith={hrefWith}
          isLoading={listQuery.isLoading}
          isFetching={listQuery.isFetching}
          error={listQuery.error}
          onRetry={() => listQuery.refetch()}
          onRefresh={() => refreshMutation.mutate()}
        />

        <ExceptionDetailPanel
          caseId={selectedCaseId}
          explicitCaseId={explicitCaseId}
          value={detailQuery.data}
          isLoading={
            detailQuery.isLoading ||
            (Boolean(selectedCaseId) && !detailQuery.data && !detailQuery.error)
          }
          error={detailQuery.error}
          backHref={hrefWith({ case: null })}
          onRetry={() => detailQuery.refetch()}
          onRefresh={() => refreshMutation.mutate()}
          refreshPending={refreshMutation.isPending}
        />
      </section>
    </main>
  );
}

function ExceptionQueue({
  items,
  total,
  page,
  totalPages,
  selectedCaseId,
  status,
  activeFilters,
  hrefWith,
  isLoading,
  isFetching,
  error,
  onRetry,
  onRefresh,
}: {
  items: ExceptionCaseListItem[];
  total: number;
  page: number;
  totalPages: number;
  selectedCaseId: string | null;
  status: ExceptionCaseStatus;
  activeFilters: number;
  hrefWith: (updates: QueryUpdate) => string;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  onRetry: () => void;
  onRefresh: () => void;
}) {
  return (
    <section className="exception-queue-panel" aria-labelledby="exception-queue-heading">
      <header className="exception-panel-header">
        <div>
          <h2 id="exception-queue-heading">异常队列</h2>
          <span>{isFetching && !isLoading ? '正在更新…' : `共 ${total} 件`}</span>
        </div>
        <span className="exception-sort-note">风险优先</span>
      </header>

      {isLoading ? <ExceptionQueueSkeleton /> : null}
      {!isLoading && error ? (
        <ExceptionErrorState title="无法读取异常队列" error={error} onRetry={onRetry} />
      ) : null}
      {!isLoading && !error && items.length === 0 ? (
        <ExceptionEmptyState status={status} filtered={activeFilters > 0} onRefresh={onRefresh} />
      ) : null}
      {!isLoading && !error && items.length > 0 ? (
        <ul className="exception-case-list">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                id={`exception-case-${item.id}`}
                href={hrefWith({ case: item.id })}
                className="exception-case-row"
                data-priority={item.priority}
                aria-current={selectedCaseId === item.id ? 'true' : undefined}
                aria-label={`${priorityLabel(item.priority)}，${domainLabel(item.domain)}，${item.title}`}
              >
                <span className="exception-case-row-topline">
                  <span className="exception-domain-chip">{domainLabel(item.domain)}</span>
                  <span className="exception-priority-label" data-priority={item.priority}>
                    {priorityLabel(item.priority)}
                  </span>
                </span>
                <strong className="exception-case-title">{item.title}</strong>
                <span className="exception-case-subject">{item.subject.label}</span>
                <span className="exception-case-reason">{item.reason}</span>
                <span className="exception-case-next">
                  <ArrowIcon />
                  {item.nextAction}
                </span>
                <span className="exception-case-meta">
                  <time dateTime={item.lastSeenAt} title={formatFullTime(item.lastSeenAt)}>
                    {formatRelativeTime(item.lastSeenAt)}
                  </time>
                  {item.occurrences > 1 ? <span>重复 {item.occurrences} 次</span> : null}
                  {item.assigneeUserId ? <span>已有运营跟进</span> : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      {!isLoading && !error && totalPages > 1 ? (
        <nav className="exception-pagination" aria-label="异常队列分页">
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

function ExceptionDetailPanel({
  caseId,
  explicitCaseId,
  value,
  isLoading,
  error,
  backHref,
  onRetry,
  onRefresh,
  refreshPending,
}: {
  caseId: string | null;
  explicitCaseId: string | null;
  value: ExceptionCaseDetail | undefined;
  isLoading: boolean;
  error: unknown;
  backHref: string;
  onRetry: () => void;
  onRefresh: () => void;
  refreshPending: boolean;
}) {
  return (
    <section className="exception-detail-panel" aria-label="异常详情">
      {explicitCaseId ? (
        <Link href={backHref} className="exception-mobile-back">
          <BackIcon />
          返回异常列表
        </Link>
      ) : null}
      {!caseId ? <ExceptionNoSelection /> : null}
      {caseId && isLoading ? <ExceptionDetailSkeleton /> : null}
      {caseId && !isLoading && error ? (
        <ExceptionErrorState title="无法读取异常详情" error={error} onRetry={onRetry} />
      ) : null}
      {caseId && !isLoading && !error && value ? (
        <ExceptionDetailContent
          value={value}
          onRefresh={onRefresh}
          refreshPending={refreshPending}
          focusHeading={Boolean(explicitCaseId)}
        />
      ) : null}
    </section>
  );
}

function ExceptionDetailContent({
  value,
  onRefresh,
  refreshPending,
  focusHeading = false,
}: {
  value: ExceptionCaseDetail;
  onRefresh: () => void;
  refreshPending: boolean;
  focusHeading?: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [formMessage, setFormMessage] = useState('');
  const requestIdRef = useRef<string | null>(null);
  const navigateAfterAcknowledgeRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const safeActionHref = safeInternalActionHref(value.actionHref);
  const unsafeActionHref = Boolean(value.actionHref && !safeActionHref);

  useEffect(() => {
    setNote('');
    setFormMessage('');
    requestIdRef.current = null;
    navigateAfterAcknowledgeRef.current = false;
  }, [value.id, value.stateRevision]);

  useEffect(() => {
    if (!focusHeading || !window.matchMedia('(max-width: 1279px)').matches) return;
    requestAnimationFrame(() => headingRef.current?.focus());
  }, [focusHeading, value.id]);

  const acknowledge = useMutation({
    mutationFn: () =>
      api.acknowledgeExceptionCase(value.id, {
        expectedRevision: value.stateRevision,
        clientRequestId: requestIdRef.current ?? (requestIdRef.current = createClientRequestId()),
        note: note.trim(),
      }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(['exception-case', value.id], updated);
      await queryClient.invalidateQueries({ queryKey: ['exception-cases'] });
      setFormMessage('已保存跟进说明。');
      const shouldNavigate = navigateAfterAcknowledgeRef.current;
      navigateAfterAcknowledgeRef.current = false;
      requestIdRef.current = null;
      if (shouldNavigate && safeActionHref) router.push(safeActionHref);
    },
    onError: async (mutationError) => {
      navigateAfterAcknowledgeRef.current = false;
      if (isExceptionCaseConflict(mutationError)) {
        setFormMessage('该异常已被更新，已重新读取最新状态，请核对后再次提交。');
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['exception-case', value.id] }),
          queryClient.invalidateQueries({ queryKey: ['exception-cases'] }),
        ]);
        return;
      }
      setFormMessage(`保存失败：${errorMessage(mutationError)}`);
    },
  });

  const submitAcknowledge = (navigate: boolean) => {
    if (note.trim().length < 2 || acknowledge.isPending) return;
    navigateAfterAcknowledgeRef.current = navigate;
    acknowledge.mutate();
  };

  return (
    <article className="exception-detail-content" aria-labelledby="exception-detail-title">
      <header className="exception-detail-header">
        <div className="exception-detail-badges">
          <span className="exception-domain-chip">{domainLabel(value.domain)}</span>
          <span className="exception-priority-label" data-priority={value.priority}>
            {priorityLabel(value.priority)}
          </span>
          <span className="exception-status-badge" data-status={value.status}>
            {statusLabel(value.status)}
          </span>
        </div>
        <h2 ref={headingRef} id="exception-detail-title" tabIndex={-1}>
          {value.title}
        </h2>
        <p>{value.subject.label}</p>
        <div className="exception-detail-time">
          <span>首次发现 {formatFullTime(value.firstSeenAt)}</span>
          <span>最近发生 {formatFullTime(value.lastSeenAt)}</span>
          {value.occurrences > 1 ? <strong>重复 {value.occurrences} 次</strong> : null}
        </div>
      </header>

      <section className="exception-safety-state" data-resolved={!value.sourceActive}>
        <ShieldIcon />
        <div>
          <strong>{value.sourceActive ? '源异常仍然存在' : '源异常已消失'}</strong>
          <p>
            {value.sourceActive
              ? '系统不会把“开始跟进”当作完成；只有重新检查确认源问题消失后才会关闭。'
              : '系统已通过源状态检查自动关闭，处理记录仍完整保留。'}
          </p>
        </div>
      </section>

      <div className="exception-detail-grid">
        <DetailSection title="发生了什么">
          <p>{value.reason}</p>
        </DetailSection>
        <DetailSection title="当前影响">
          <p>{value.impact}</p>
        </DetailSection>
        <DetailSection title="责任与跟进">
          <dl className="exception-responsibility-list">
            <div>
              <dt>当前责任</dt>
              <dd>{responsiblePartyLabel(value.responsibleParty)}</dd>
            </div>
            <div>
              <dt>跟进状态</dt>
              <dd>{value.assigneeUserId ? '已有运营接手' : '等待运营接手'}</dd>
            </div>
          </dl>
        </DetailSection>
      </div>

      <section className="exception-next-action-card" data-status={value.status}>
        <div>
          <span>建议下一步</span>
          <h3>{value.nextAction}</h3>
        </div>

        {unsafeActionHref ? (
          <p className="exception-action-warning" role="alert">
            系统返回的处理入口不安全，已阻止打开。请重新检查或联系支持。
          </p>
        ) : null}

        {value.status === 'open' ? (
          <form
            className="exception-acknowledge-form"
            onSubmit={(event) => {
              event.preventDefault();
              submitAcknowledge(Boolean(safeActionHref));
            }}
          >
            <label htmlFor={`exception-note-${value.id}`}>跟进说明</label>
            <textarea
              id={`exception-note-${value.id}`}
              value={note}
              maxLength={500}
              rows={3}
              aria-invalid={Boolean(note && note.trim().length < 2)}
              aria-describedby={`exception-note-help-${value.id}`}
              onChange={(event) => {
                setNote(event.target.value);
                setFormMessage('');
                requestIdRef.current = null;
              }}
              placeholder="写明准备核对什么，或已在平台完成了什么"
            />
            <p id={`exception-note-help-${value.id}`}>
              至少 2 个字符；提交后会写入不可变处理记录。
            </p>
            <div className="exception-action-buttons">
              <button
                type="submit"
                className="exception-primary-action"
                disabled={note.trim().length < 2 || acknowledge.isPending}
                aria-busy={acknowledge.isPending}
              >
                {acknowledge.isPending
                  ? '正在保存…'
                  : safeActionHref
                    ? `保存并${value.actionLabel ?? '去处理'}`
                    : '开始跟进'}
              </button>
              {safeActionHref ? (
                <button
                  type="button"
                  className="exception-secondary-action"
                  disabled={note.trim().length < 2 || acknowledge.isPending}
                  onClick={() => submitAcknowledge(false)}
                >
                  仅保存跟进
                </button>
              ) : null}
            </div>
          </form>
        ) : null}

        {value.status === 'acknowledged' ? (
          <div className="exception-action-buttons">
            {safeActionHref ? (
              <Link href={safeActionHref} className="exception-primary-action">
                {value.actionLabel ?? '继续处理'}
                <ArrowIcon />
              </Link>
            ) : null}
            <button
              type="button"
              className={safeActionHref ? 'exception-secondary-action' : 'exception-primary-action'}
              disabled={refreshPending}
              aria-busy={refreshPending}
              onClick={onRefresh}
            >
              {refreshPending ? '正在检查…' : '重新检查状态'}
            </button>
          </div>
        ) : null}

        {value.status === 'resolved' ? (
          <div className="exception-resolved-message" role="status">
            <CheckIcon />
            <span>已于 {formatFullTime(value.resolvedAt)} 自动关闭</span>
            {safeActionHref ? <Link href={safeActionHref}>查看来源</Link> : null}
          </div>
        ) : null}

        {formMessage ? (
          <p
            className={`exception-form-message ${acknowledge.isError ? 'is-error' : ''}`}
            role={acknowledge.isError ? 'alert' : 'status'}
          >
            {formMessage}
          </p>
        ) : null}
      </section>

      <details className="exception-technical-details">
        <summary>查看技术信息</summary>
        <dl>
          <div>
            <dt>异常代码</dt>
            <dd>{value.code}</dd>
          </div>
          <div>
            <dt>来源类型</dt>
            <dd>{value.subject.type}</dd>
          </div>
          <div>
            <dt>来源 ID</dt>
            <dd>{value.subject.id}</dd>
          </div>
          <div>
            <dt>状态版本</dt>
            <dd>{value.stateRevision}</dd>
          </div>
        </dl>
      </details>

      <section className="exception-event-section" aria-labelledby="exception-events-title">
        <header>
          <div>
            <span>Audit trail</span>
            <h3 id="exception-events-title">处理记录</h3>
          </div>
          <strong>{value.events.length} 条</strong>
        </header>
        {value.events.length > 0 ? (
          <ol className="exception-event-list">
            {value.events.map((event) => (
              <ExceptionEventItem key={event.id} value={event} />
            ))}
          </ol>
        ) : (
          <p className="exception-events-empty">暂无处理记录。</p>
        )}
      </section>
    </article>
  );
}

function ExceptionEventItem({ value }: { value: ExceptionCaseEvent }) {
  const actor =
    value.actor.type === 'user' ? '运营人员' : value.actor.type === 'worker' ? '自动任务' : '系统';
  return (
    <li>
      <span className="exception-event-marker" aria-hidden="true" />
      <div>
        <div className="exception-event-heading">
          <strong>{eventLabel(value.type)}</strong>
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

function ExceptionEmptyState({
  status,
  filtered,
  onRefresh,
}: {
  status: ExceptionCaseStatus;
  filtered: boolean;
  onRefresh: () => void;
}) {
  const copy = filtered
    ? '当前筛选条件下没有异常。'
    : status === 'open'
      ? '暂时没有需要你处理的异常。'
      : status === 'acknowledged'
        ? '还没有跟进中的异常。'
        : '尚无已关闭记录。';
  return (
    <div className="exception-empty-state">
      <span aria-hidden="true">
        <CheckIcon />
      </span>
      <strong>{copy}</strong>
      <p>{filtered ? '调整筛选条件后再试。' : '系统会继续检查六类核心业务状态。'}</p>
      {!filtered && status === 'open' ? (
        <button type="button" onClick={onRefresh}>
          重新检查
        </button>
      ) : null}
    </div>
  );
}

function ExceptionNoSelection() {
  return (
    <div className="exception-no-selection">
      <span aria-hidden="true">
        <InboxIcon />
      </span>
      <strong>选择一条异常查看上下文</strong>
      <p>这里会说明影响、责任对象、下一动作和完整处理记录。</p>
    </div>
  );
}

function ExceptionErrorState({
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

function ExceptionQueueSkeleton() {
  return (
    <div className="exception-queue-skeleton" role="status" aria-live="polite">
      <span className="sr-only">正在读取异常队列…</span>
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index}>
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}

function ExceptionDetailSkeleton() {
  return (
    <div className="exception-detail-skeleton" role="status" aria-live="polite">
      <span className="sr-only">正在读取异常详情…</span>
      <div />
      <div />
      <div />
      <div />
    </div>
  );
}

export function ExceptionCenterPageSkeleton() {
  return (
    <main className="app-page exception-center-page" aria-busy="true">
      <header className="exception-page-header">
        <div>
          <p className="page-kicker">Operations</p>
          <h1 className="page-title">待办与异常</h1>
          <p className="page-description">正在打开异常中心…</p>
        </div>
      </header>
      <div className="exception-workspace">
        <section className="exception-queue-panel">
          <ExceptionQueueSkeleton />
        </section>
        <section className="exception-detail-panel">
          <ExceptionDetailSkeleton />
        </section>
      </div>
    </main>
  );
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

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M5 12h14m-5-5 5 5-5 5" />
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
