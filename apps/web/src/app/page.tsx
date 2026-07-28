'use client';

import { Suspense, useCallback, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type RecommendationList } from '@/lib/api';
import { ProductCard } from '@/components/product-card';
import { ProductFilters, type AppliedProductFilters } from '@/components/product-filters';

export default function HomePage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <RecommendationPage />
    </Suspense>
  );
}

function RecommendationPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const [isFilterPending, startFilterTransition] = useTransition();
  const queryClient = useQueryClient();
  const filters = readFilters(searchParams);
  const rangeError =
    filters.priceMin !== undefined &&
    filters.priceMax !== undefined &&
    filters.priceMin > filters.priceMax
      ? '最低价不能高于最高价，请重新设置价格范围。'
      : undefined;

  const { data, isLoading, isFetching, isError, error } = useQuery<RecommendationList>({
    queryKey: [
      'recommendations',
      filters.categoryL1 ?? '',
      filters.priceMin ?? null,
      filters.priceMax ?? null,
    ],
    queryFn: () =>
      api.recommendations({
        limit: 30,
        ...filters,
      }),
    enabled: !rangeError,
  });
  const facets = useQuery({ queryKey: ['product-facets'], queryFn: () => api.productFacets() });
  const favorites = useQuery({ queryKey: ['favorites'], queryFn: () => api.favorites() });
  const favoriteMutation = useMutation({
    mutationFn: async ({ productId1688, active }: { productId1688: string; active: boolean }) => {
      if (active) await api.removeFavorite(productId1688);
      else await api.addFavorite(productId1688);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['favorites'] }),
  });
  const favoriteIds = new Set(favorites.data?.items.map((item) => item.productId1688) ?? []);
  const updateFilters = useCallback(
    (next: AppliedProductFilters) => {
      const params = new URLSearchParams(search);
      setFilterParam(params, 'categoryL1', next.categoryL1);
      setFilterParam(params, 'priceMin', next.priceMin);
      setFilterParam(params, 'priceMax', next.priceMax);
      const query = params.toString();
      startFilterTransition(() => router.replace(query ? `/?${query}` : '/', { scroll: false }));
    },
    [router, search],
  );

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-widest text-brand-500">
            今日推荐 · AI 选品
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">今天搬什么款</h1>
          <p className="mt-2 text-zinc-600">五维打分 + AI 推荐理由，按综合分排序。</p>
        </div>
        <a
          href="/favorites"
          className="w-fit rounded-full border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-600 transition hover:border-brand-400 hover:text-brand-600"
        >
          收藏对比 {favorites.data ? `· ${favorites.data.total}` : ''} →
        </a>
      </header>

      <ProductFilters
        facets={facets.data}
        filters={filters}
        isLoading={facets.isLoading}
        isPending={isFilterPending || isFetching}
        rangeError={rangeError}
        onChange={updateFilters}
      />

      {isLoading && !rangeError ? <SkeletonGrid /> : null}

      {rangeError ? (
        <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-600">{rangeError}</div>
      ) : null}

      {isError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">
          加载失败：{(error as Error).message}
          <p className="mt-1 text-red-400">
            请确认 BFF 已启动（pnpm --filter @supplier/bff dev）。
          </p>
        </div>
      ) : null}

      {data?.degraded && data.items.length === 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
          选品数据暂时无法从数据库完整读取，请稍后重试；当前空结果不代表没有可推荐商品。
        </div>
      ) : null}

      {data && !data.degraded && data.items.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white p-10 text-center text-zinc-500">
          当前筛选条件下暂无已打分商品，试试放宽类目或价格范围。
        </div>
      ) : null}

      {data && data.items.length > 0 ? (
        <>
          <div className="mb-3 flex items-center justify-between gap-4 text-sm text-zinc-400">
            <p>
              展示 {data.total} 款{data.degraded ? '（数据库降级中，结果可能不完整）' : ''}
            </p>
            {isFetching ? <span className="font-mono text-[10px] uppercase">Updating…</span> : null}
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {data.items.map((p, i) => (
              <ProductCard
                key={p.id}
                product={p}
                rank={i + 1}
                isFavorite={favoriteIds.has(p.productId1688)}
                favoritePending={
                  favoriteMutation.isPending &&
                  favoriteMutation.variables?.productId1688 === p.productId1688
                }
                onToggleFavorite={() =>
                  favoriteMutation.mutate({
                    productId1688: p.productId1688,
                    active: favoriteIds.has(p.productId1688),
                  })
                }
              />
            ))}
          </div>
        </>
      ) : null}
    </main>
  );
}

function PageSkeleton() {
  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <div className="mb-8 h-24 animate-pulse bg-zinc-100" />
      <div className="mb-8 h-64 animate-pulse border border-zinc-200 bg-white" />
      <SkeletonGrid />
    </main>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
          <div className="aspect-square animate-pulse bg-zinc-100" />
          <div className="space-y-2 p-3">
            <div className="h-3 animate-pulse rounded bg-zinc-100" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-zinc-100" />
          </div>
        </div>
      ))}
    </div>
  );
}

function readFilters(searchParams: ReturnType<typeof useSearchParams>): AppliedProductFilters {
  const categoryL1 = searchParams.get('categoryL1')?.trim() || undefined;
  return {
    categoryL1,
    priceMin: readPrice(searchParams.get('priceMin')),
    priceMax: readPrice(searchParams.get('priceMax')),
  };
}

function readPrice(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function setFilterParam(
  params: URLSearchParams,
  name: string,
  value: string | number | undefined,
): void {
  if (value === undefined || value === '') params.delete(name);
  else params.set(name, String(value));
}
