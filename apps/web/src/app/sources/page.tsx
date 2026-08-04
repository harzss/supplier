'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

const PAGE_SIZE = 30;

export default function CollectedSourcesPage() {
  const [page, setPage] = useState(1);
  const sources = useQuery({
    queryKey: ['collectedSourceProducts', page, PAGE_SIZE],
    queryFn: () => api.collectedSourceProducts(page, PAGE_SIZE),
  });
  const totalPages = Math.max(1, Math.ceil((sources.data?.total ?? 0) / PAGE_SIZE));

  useEffect(() => {
    const total = sources.data?.total;
    if (total === undefined) return;
    setPage((current) => Math.min(current, Math.max(1, Math.ceil(total / PAGE_SIZE))));
  }, [sources.data?.total]);

  return (
    <main className="app-page">
      <header className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="page-kicker">Source library</p>
          <h1 className="page-title">我的货源</h1>
          <p className="page-description">查看你采集过的 1688 商品，并继续完成选品、映射与铺货。</p>
        </div>
        <Link href="/sources/import" className="primary-button source-entry-button w-fit">
          批量采集 1688
        </Link>
      </header>

      {sources.isLoading ? <SourceLibrarySkeleton /> : null}
      {sources.isError ? (
        <div className="status-message is-danger mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <span>货源库读取失败：{sources.error.message}</span>
          <button type="button" className="secondary-button" onClick={() => void sources.refetch()}>
            重新读取
          </button>
        </div>
      ) : null}

      {sources.data?.total === 0 ? (
        <section className="ledger-panel border-dashed px-6 py-16 text-center">
          <p className="text-xl font-semibold">还没有采集货源</p>
          <p className="mt-2 text-sm text-[var(--muted)]">
            粘贴 1688 商品链接，检查后一次加入最多 100 件。
          </p>
          <Link href="/sources/import" className="primary-button source-entry-button mt-5">
            开始批量采集
          </Link>
        </section>
      ) : null}

      {sources.data?.items.length ? (
        <>
          <div className="mb-4 flex items-center justify-between text-xs text-[var(--muted)]">
            <span>共 {sources.data.total} 件已采集货源</span>
            {sources.isFetching ? (
              <span className="text-[var(--accent-dark)]">正在更新…</span>
            ) : null}
          </div>
          <section className="product-grid" aria-label="已采集货源">
            {sources.data.items.map((item) => (
              <article key={item.collectionId} className="product-card">
                <Link
                  href={`/products?id=${encodeURIComponent(item.productId1688)}`}
                  className="product-card-link"
                >
                  <div className="product-card-media">
                    {item.mainImage ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.mainImage} alt={item.title} className="product-card-image" />
                    ) : (
                      <div className="flex h-full items-center justify-center text-xs text-[var(--muted)]">
                        暂无图片
                      </div>
                    )}
                    <span className="absolute left-2.5 top-2.5 rounded-full border border-white/70 bg-white/90 px-2 py-1 text-[10px] font-medium text-[var(--ink-soft)] shadow-sm backdrop-blur">
                      {availabilityLabel(item.availability)}
                    </span>
                  </div>
                  <div className="flex flex-1 flex-col gap-2.5 p-3.5 sm:p-4">
                    <p className="line-clamp-2 min-h-10 text-sm font-semibold leading-5 text-[var(--ink)]">
                      {item.title}
                    </p>
                    <div className="flex items-end justify-between gap-3 border-t border-[var(--line)] pt-2.5">
                      <span className="text-lg font-semibold tracking-tight tabular-nums">
                        ¥{item.price}
                      </span>
                      <span className="text-[11px] text-[var(--muted)]">{item.skuCount} SKU</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-[10px] text-[var(--muted)]">
                      {item.categoryL1 ? (
                        <span className="rounded-full border border-[var(--line)] px-2 py-1">
                          {item.categoryL1}
                        </span>
                      ) : null}
                      <span className="rounded-full border border-[var(--line)] px-2 py-1">
                        库存 {item.totalStock}
                      </span>
                    </div>
                    <p className="mt-auto text-[10px] text-[var(--muted-light)]">
                      最近采集 {new Date(item.lastCollectedAt).toLocaleString('zh-CN')}
                    </p>
                  </div>
                </Link>
              </article>
            ))}
          </section>

          <div className="mt-6 flex items-center justify-between gap-3 text-sm text-[var(--muted)]">
            <span>
              第 {page} / {totalPages} 页
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="secondary-button"
                disabled={page <= 1 || sources.isFetching}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                上一页
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={page >= totalPages || sources.isFetching}
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              >
                下一页
              </button>
            </div>
          </div>
        </>
      ) : null}
    </main>
  );
}

function SourceLibrarySkeleton() {
  return (
    <div className="product-grid" role="status" aria-label="正在读取我的货源">
      {Array.from({ length: 8 }).map((_, index) => (
        <div
          key={index}
          className="overflow-hidden rounded-xl border border-[var(--line)] bg-white"
        >
          <div className="skeleton-surface aspect-square" />
          <div className="space-y-2 p-4">
            <div className="skeleton-surface h-3 rounded" />
            <div className="skeleton-surface h-3 w-2/3 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

function availabilityLabel(value: string): string {
  if (value === 'available') return '可售';
  if (value === 'out_of_stock') return '缺货';
  if (value === 'offline') return '已下架';
  return '待核验';
}
