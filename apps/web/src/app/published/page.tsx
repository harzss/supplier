'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ApiError, api } from '@/lib/api';
import { isDemoAuthMode } from '@/lib/environment';

const STATUS_LABELS: Record<string, string> = {
  success: '成功',
  partial: '部分成功',
  failed: '失败',
  optimizing: '优化中',
  publishing: '发布中',
  pending: '待处理',
};

const INVENTORY_STATUS_LABELS: Record<string, string> = {
  pending: '库存待同步',
  syncing: '库存同步中',
  retry_wait: '库存等待重试',
  synced: '库存已同步',
  dead: '库存同步失败',
};

const PUBLISH_PAGE_SIZE = 20;

function statusClass(status: string): string {
  if (status === 'success') return 'bg-green-50 text-green-600';
  if (status === 'partial') return 'bg-amber-50 text-amber-600';
  if (status === 'failed') return 'bg-red-50 text-red-600';
  return 'bg-zinc-100 text-zinc-500';
}

function inventoryStatusClass(status: string): string {
  if (status === 'synced') return 'bg-blue-50 text-blue-600';
  if (status === 'dead') return 'bg-red-50 text-red-600';
  if (status === 'retry_wait') return 'bg-amber-50 text-amber-600';
  return 'bg-zinc-100 text-zinc-500';
}

export default function PublishedPage() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitles, setEditTitles] = useState<Record<string, string>>({});
  const { data, isLoading, isFetching, isError, error } = useQuery({
    queryKey: ['publishTasks', page, PUBLISH_PAGE_SIZE],
    queryFn: () => api.publishTasks(page, PUBLISH_PAGE_SIZE),
    refetchInterval: (query) => {
      const tasks = query.state.data?.items;
      return tasks?.some((task) => ['pending', 'optimizing', 'publishing'].includes(task.status))
        ? 2000
        : false;
    },
  });
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PUBLISH_PAGE_SIZE));
  const hasPublishedProduct =
    data?.items.some((task) => task.items.some((item) => Boolean(item.platformProductId))) ?? false;

  useEffect(() => {
    if (data?.total === undefined) return;
    const lastPage = Math.max(1, Math.ceil(data.total / PUBLISH_PAGE_SIZE));
    setPage((current) => Math.min(current, lastPage));
  }, [data?.total]);
  useEffect(() => {
    if (!hasPublishedProduct) return;
    void qc.invalidateQueries({ queryKey: ['activation'] });
  }, [hasPublishedProduct, qc]);
  const simulate = useMutation({
    mutationFn: (publishedProductId: string) => api.simulateOrder(publishedProductId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });
  const retry = useMutation({
    mutationFn: (taskId: string) => api.retryPublishTask(taskId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['publishTasks'] }),
  });
  const retryInventory = useMutation({
    mutationFn: (publishedProductId: string) => api.retryInventorySync(publishedProductId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['publishTasks'] }),
  });
  const updateProduct = useMutation({
    mutationFn: ({ publishedProductId, title }: { publishedProductId: string; title: string }) =>
      api.updatePublishedProduct(publishedProductId, { title }),
    onSuccess: () => {
      setEditingId(null);
      qc.invalidateQueries({ queryKey: ['publishTasks'] });
    },
  });
  const syncStatus = useMutation({
    mutationFn: (publishedProductId: string) => api.syncPublishedProductStatus(publishedProductId),
    onSettled: () => qc.invalidateQueries({ queryKey: ['publishTasks'] }),
  });

  return (
    <main className="app-page">
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="page-kicker">商品管理</p>
          <h1 className="page-title">铺货中心</h1>
          <p className="page-description">
            跟踪铺货任务、平台上架状态、库存同步和需要人工修正的商品。
          </p>
        </div>
        <Link href="/published/batch" className="batch-primary-button w-fit">
          进入批量经营
        </Link>
      </header>

      {isDemoAuthMode && simulate.isSuccess && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          已生成一笔买家订单 ·{' '}
          <Link href="/orders" className="font-medium underline">
            去订单代发 →
          </Link>
        </div>
      )}
      {updateProduct.isSuccess ? (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          商品修正已提交抖店处理，最新属性、资质和 SKU 快照已重新校验。
        </div>
      ) : null}

      {isLoading && <p className="text-zinc-400">加载中…</p>}
      {isError && <p className="text-red-600">加载失败：{(error as Error).message}</p>}
      {data?.total === 0 && (
        <p className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-zinc-400">
          还没有铺货记录，去{' '}
          <Link href="/" className="text-brand-600">
            今日推荐
          </Link>{' '}
          挑个款试试。
        </p>
      )}

      <div className="space-y-4">
        {data?.items.map((t) => (
          <div key={t.taskId} className="ledger-panel p-5">
            <div className="flex items-start gap-4">
              {t.mainImage && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={t.mainImage} alt="" className="h-16 w-16 rounded-lg object-cover" />
              )}
              <div className="flex-1">
                <div className="flex items-start justify-between">
                  <h3 className="line-clamp-1 text-sm font-medium">{t.sourceTitle}</h3>
                  <span
                    className={`ml-2 shrink-0 rounded-full px-2 py-0.5 text-xs ${statusClass(t.status)}`}
                  >
                    {STATUS_LABELS[t.status] ?? t.status}
                  </span>
                </div>
                <p className="mt-1 text-xs text-zinc-400">
                  {new Date(t.createdAt).toLocaleString('zh-CN')} · {t.items.length} 个店铺
                  {t.detailOptimized ? (
                    <span className="ml-2 rounded-full bg-brand-50 px-2 py-0.5 font-medium text-brand-600">
                      {t.detailImageHosted ? 'AI 详情图' : 'AI 详情文案'}
                    </span>
                  ) : null}
                  {t.mainImageProcessed ? (
                    <span className="ml-2 rounded-full bg-violet-50 px-2 py-0.5 font-medium text-violet-600">
                      AI 主图
                    </span>
                  ) : null}
                </p>
                {t.queueStatus ? (
                  <p className="mt-1 text-[11px] text-zinc-400">
                    队列：{t.queueStatus} · 尝试 {t.attempts}/{t.maxAttempts}
                    {t.lastError ? ` · ${t.lastError}` : ''}
                  </p>
                ) : null}
                <p className="mt-1 text-[11px] text-zinc-400">
                  SKU：{t.skuCount} 个
                  {t.skuDimensions.length ? ` · ${t.skuDimensions.join(' / ')}` : ' · 默认规格'}
                </p>
                {t.pricing ? (
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 rounded-lg bg-zinc-50 px-3 py-2 text-[11px] text-zinc-500">
                    <span>建议售价 ¥{t.pricing.suggestedPrice}</span>
                    <span>保本价 ¥{t.pricing.breakEvenPrice}</span>
                    <span>预计利润 ¥{t.pricing.estimatedProfit}</span>
                    <span>毛利率 {(t.pricing.estimatedMargin * 100).toFixed(1)}%</span>
                    {t.pricing.warning ? (
                      <span className="w-full text-amber-600">⚠ {t.pricing.warning}</span>
                    ) : null}
                  </div>
                ) : null}
                <div className="mt-2 space-y-1">
                  {t.items.map((it) => (
                    <div key={it.publishedProductId} className="space-y-1">
                      <div className="flex flex-col items-start gap-1 text-xs sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                        <span className="text-zinc-600">
                          {it.shopName} · {it.platform} · {publishedStatusLabel(it.status)}
                        </span>
                        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] ${inventoryStatusClass(it.inventorySyncStatus)}`}
                          >
                            {INVENTORY_STATUS_LABELS[it.inventorySyncStatus] ??
                              it.inventorySyncStatus}
                          </span>
                          <span className="min-w-0 break-all text-zinc-500">
                            ¥{it.salePrice} · {it.platformProductId}
                          </span>
                          <button
                            onClick={() => syncStatus.mutate(it.publishedProductId)}
                            disabled={
                              syncStatus.isPending && syncStatus.variables === it.publishedProductId
                            }
                            className="shrink-0 rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-blue-700 transition hover:bg-blue-100 disabled:opacity-50"
                          >
                            {syncStatus.isPending && syncStatus.variables === it.publishedProductId
                              ? '刷新中…'
                              : '刷新平台状态'}
                          </button>
                          {isDemoAuthMode ? (
                            <button
                              onClick={() => simulate.mutate(it.publishedProductId)}
                              disabled={simulate.isPending || it.status !== 'online'}
                              className="shrink-0 rounded border border-zinc-200 px-2 py-0.5 text-brand-600 transition hover:border-brand-500 disabled:opacity-50"
                            >
                              模拟下单
                            </button>
                          ) : null}
                          <Link
                            href={`/products?id=${encodeURIComponent(t.sourceProductId)}`}
                            className="shrink-0 rounded border border-zinc-200 px-2 py-0.5 text-zinc-600 transition hover:border-brand-500"
                          >
                            调整属性/资质
                          </Link>
                          <button
                            onClick={() => {
                              setEditingId((current) =>
                                current === it.publishedProductId ? null : it.publishedProductId,
                              );
                              setEditTitles((current) => ({
                                ...current,
                                [it.publishedProductId]: current[it.publishedProductId] ?? it.title,
                              }));
                              updateProduct.reset();
                            }}
                            disabled={t.sourceAvailability !== 'available'}
                            className="shrink-0 rounded border border-brand-200 bg-brand-50 px-2 py-0.5 text-brand-700 transition hover:bg-brand-100 disabled:opacity-50"
                          >
                            修正重提
                          </button>
                        </div>
                      </div>
                      {editingId === it.publishedProductId ? (
                        <div className="rounded-lg border border-brand-100 bg-brand-50/50 p-3">
                          <label className="block text-[11px] font-medium text-zinc-600">
                            修正标题
                            <input
                              value={editTitles[it.publishedProductId] ?? it.title}
                              onChange={(event) =>
                                setEditTitles((current) => ({
                                  ...current,
                                  [it.publishedProductId]: event.target.value,
                                }))
                              }
                              className="mt-1.5 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500"
                            />
                          </label>
                          <p className="mt-1 text-[11px] leading-4 text-zinc-400">
                            提交时会刷新官方资质规则，并重新校验当前类目属性、资质与发布 SKU。
                          </p>
                          <div className="mt-2 flex items-center gap-2">
                            <button
                              onClick={() =>
                                updateProduct.mutate({
                                  publishedProductId: it.publishedProductId,
                                  title: editTitles[it.publishedProductId] ?? it.title,
                                })
                              }
                              disabled={updateProduct.isPending}
                              className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                            >
                              {updateProduct.isPending ? '提交中…' : '重新校验并提交'}
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="rounded-lg px-3 py-1.5 text-xs text-zinc-500 hover:bg-white"
                            >
                              取消
                            </button>
                          </div>
                          {updateProduct.isError ? (
                            <p className="mt-2 text-xs text-red-600">
                              {(updateProduct.error as ApiError).message}
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                      {it.lastEditedAt || it.lastEditError ? (
                        <p className="text-[11px] text-zinc-400">
                          修正尝试 {it.editAttempts} 次
                          {it.lastEditedAt
                            ? ` · 最近成功 ${new Date(it.lastEditedAt).toLocaleString('zh-CN')}`
                            : ''}
                          {it.lastEditError ? ` · 最近失败：${it.lastEditError}` : ''}
                        </p>
                      ) : null}
                      {it.platformStatusSyncedAt || it.platformStatusError ? (
                        <p
                          className={`text-[11px] ${it.platformStatusError ? 'text-red-500' : 'text-zinc-400'}`}
                        >
                          {it.platformStatusSyncedAt
                            ? `平台状态更新于 ${new Date(it.platformStatusSyncedAt).toLocaleString('zh-CN')}`
                            : '平台状态尚未同步成功'}
                          {it.platformStatusError
                            ? ` · 最近同步失败：${it.platformStatusError}`
                            : ''}
                        </p>
                      ) : null}
                      {it.inventorySyncReason || it.inventorySyncError ? (
                        <div className="flex w-full items-center justify-between gap-2 text-[11px] text-zinc-400 sm:ml-auto sm:max-w-[85%] sm:justify-end">
                          <span>
                            {inventoryReasonLabel(it.inventorySyncReason)}
                            {it.inventorySyncError ? ` · ${it.inventorySyncError}` : ''}
                          </span>
                          {['dead', 'retry_wait'].includes(it.inventorySyncStatus) ? (
                            <button
                              onClick={() => retryInventory.mutate(it.publishedProductId)}
                              disabled={retryInventory.isPending}
                              className="shrink-0 rounded border border-amber-200 bg-amber-50 px-2 py-0.5 font-medium text-amber-700 disabled:opacity-50"
                            >
                              重试库存
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
                {['failed', 'partial'].includes(t.status) ? (
                  <button
                    onClick={() => retry.mutate(t.taskId)}
                    disabled={retry.isPending}
                    className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                  >
                    重新入队
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>

      {data && data.total > 0 ? (
        <div className="mt-5 flex items-center justify-between text-sm text-zinc-600">
          <span>
            第 {page} / {totalPages} 页 · 共 {data.total} 条
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page <= 1 || isFetching}
              className="rounded border border-zinc-200 bg-white px-3 py-1.5 disabled:opacity-40"
            >
              上一页
            </button>
            <button
              type="button"
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              disabled={page >= totalPages || isFetching}
              className="rounded border border-zinc-200 bg-white px-3 py-1.5 disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function inventoryReasonLabel(reason: string | null): string {
  if (reason === 'source_offline') return '1688 货源已下架，平台商品已自动下架';
  if (reason === 'out_of_stock') return '1688 货源缺货，平台商品已自动下架';
  if (reason === 'source_sku_changed') return '1688 SKU 结构变化，平台商品已安全下架';
  if (reason === 'inventory_unknown') return '1688 库存无法验证，平台商品已安全下架';
  if (reason === 'stock_updated') return '库存已按最新 1688 SKU 快照更新';
  if (reason === 'published') return '首次铺货库存已同步';
  return reason ?? '库存同步状态已更新';
}

function publishedStatusLabel(status: string): string {
  if (status === 'online') return '在线';
  if (status === 'offline') return '已下架';
  if (status === 'draft') return '待平台审核';
  if (status === 'rejected') return '平台驳回';
  return status;
}
