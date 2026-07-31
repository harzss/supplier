'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api, type Product } from '@/lib/api';
import { ScoreRadar } from '@/components/score-radar';
import { ScoreBadge } from '@/components/score-badge';
import { TitleStudio } from '@/components/title-studio';
import { PublishPanel } from '@/components/publish-panel';
import { CategoryMappingCard } from '@/components/category-mapping-card';
import { SkuMappingCard } from '@/components/sku-mapping-card';
import { FavoriteToggleButton } from '@/components/favorite-toggle-button';

export default function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [selectedTitle, setSelectedTitle] = useState<{
    title: string;
    platformLabel: string;
  } | null>(null);
  useEffect(() => setSelectedTitle(null), [id]);
  const { data, isLoading, isError, error } = useQuery<Product>({
    queryKey: ['product', id],
    queryFn: () => api.productDetail(id),
  });

  return (
    <main className="app-page app-page-narrow">
      <Link href="/" className="secondary-button">
        ← 返回选品桌
      </Link>

      {isLoading ? (
        <div
          role="status"
          aria-label="正在加载商品详情"
          className="mt-8 grid animate-pulse gap-8 md:grid-cols-[minmax(0,0.86fr)_minmax(0,1.14fr)]"
        >
          <div className="aspect-square rounded-xl border border-[var(--line)] bg-[var(--paper-deep)]" />
          <div className="ledger-panel min-h-80 bg-[var(--surface-strong)]" />
          <span className="sr-only">正在加载商品详情…</span>
        </div>
      ) : null}
      {isError ? (
        <p className="status-message is-danger mt-8" role="alert">
          商品详情加载失败：{(error as Error).message}。请返回选品桌后重试。
        </p>
      ) : null}

      {data && (
        <article className="mt-8 grid gap-8 md:grid-cols-[minmax(0,0.86fr)_minmax(0,1.14fr)]">
          {/* 左：主图 + 基础 */}
          <div className="min-w-0">
            <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-deep)] shadow-[var(--shadow-sm)]">
              {data.mainImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={data.mainImage}
                  alt={data.title}
                  className="aspect-square w-full object-cover"
                />
              ) : (
                <div className="flex aspect-square items-center justify-center text-zinc-300">
                  无图
                </div>
              )}
            </div>
            <p className="page-kicker mt-6">货源商品 · {data.productId1688}</p>
            <h1 className="mt-2 text-2xl font-semibold leading-tight tracking-tight">
              {data.title}
            </h1>
            <div className="mt-3 flex items-center gap-4">
              <span className="text-2xl font-semibold text-[var(--ink)] tabular-nums">
                ¥{data.price}
              </span>
              {data.priceRange && (
                <span className="text-sm text-zinc-400">
                  区间 ¥{data.priceRange[0]}–{data.priceRange[1]}
                </span>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {data.categoryPath && (
                <span className="rounded bg-zinc-100 px-2 py-1 text-zinc-500">
                  {data.categoryPath}
                </span>
              )}
              <span className="rounded bg-zinc-100 px-2 py-1 text-zinc-500">
                月销 {data.monthlySold}
              </span>
              {data.isOnePieceDrop && (
                <span className="rounded bg-emerald-50 px-2 py-1 text-emerald-600">一件代发</span>
              )}
              {data.availability === 'available' ? (
                <span className="rounded bg-blue-50 px-2 py-1 text-blue-600">
                  可售库存 {data.totalStock}
                </span>
              ) : (
                <span className="rounded bg-red-50 px-2 py-1 text-red-600">
                  {data.availability === 'out_of_stock'
                    ? '货源缺货'
                    : data.availability === 'offline'
                      ? '货源已下架'
                      : '库存待核验'}
                </span>
              )}
            </div>
            <div className="mt-4">
              <FavoriteToggleButton productId1688={data.productId1688} />
            </div>
          </div>

          {/* 右：打分 */}
          <div className="min-w-0">
            {data.score ? (
              <div className="ledger-panel p-6">
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-base font-semibold">AI 选品打分</h2>
                  <ScoreBadge value={data.score.overall} />
                </div>
                <div className="flex justify-center">
                  <ScoreRadar score={data.score} />
                </div>
                {Array.isArray(data.score.reason) && data.score.reason.length > 0 && (
                  <div className="mt-4">
                    <p className="mb-2 text-sm font-medium text-zinc-700">推荐理由</p>
                    <ul className="space-y-1.5">
                      {data.score.reason.map((r, i) => (
                        <li key={i} className="flex gap-2 text-sm text-zinc-600">
                          <span className="text-brand-500">•</span>
                          {r}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <div className="ledger-panel p-6 text-[var(--muted)]">暂无打分数据</div>
            )}

            <div className="mt-4">
              <TitleStudio
                originalTitle={data.title}
                category={data.categoryPath ?? data.categoryL1 ?? '通用'}
                selectedTitle={selectedTitle?.title}
                onSelectTitle={(title, platformLabel) => setSelectedTitle({ title, platformLabel })}
              />
            </div>

            <CategoryMappingCard sourceProductId={data.productId1688} />
            <SkuMappingCard sourceProductId={data.productId1688} />

            <PublishPanel
              sourceProductId={data.productId1688}
              titleOverride={selectedTitle?.title}
              titlePlatformLabel={selectedTitle?.platformLabel}
              onClearTitle={() => setSelectedTitle(null)}
              availability={data.availability}
              totalStock={data.totalStock}
            />
          </div>
        </article>
      )}
    </main>
  );
}
