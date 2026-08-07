'use client';

import { Suspense, useCallback, useTransition } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  BookmarkSimple,
  ChartLineUp,
  Package,
  RocketLaunch,
  ShieldCheck,
  WarningCircle,
} from '@phosphor-icons/react';
import { ProductFilters, type AppliedProductFilters } from '@/components/product-filters';
import { RecommendationRouteDesk } from '@/components/recommendation-route-desk';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError, type RecommendationList } from '@/lib/api';

const DECISION_ROUTE = [
  { label: '货源确认', detail: '库存与采购价', icon: Package },
  { label: '评分判断', detail: '需求、利润与合规', icon: ChartLineUp },
  { label: '详情复核', detail: '资质、图片与 SKU', icon: ShieldCheck },
  { label: '发布检查', detail: '店铺、额度与任务', icon: RocketLaunch },
] as const;

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

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery<RecommendationList>({
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

  const highestScore = data?.items[0]?.score?.overall;
  const favoriteTotal = favorites.isPending
    ? '读取中'
    : favorites.isError
      ? '读取失败'
      : `${favorites.data?.total ?? 0} 款`;

  return (
    <main className="mx-auto w-full max-w-[100rem] space-y-5 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
        <div className="max-w-3xl">
          <Badge variant="secondary" className="mb-3">
            选品工作台
          </Badge>
          <h1 id="home-title" className="text-3xl font-semibold tracking-tight sm:text-4xl">
            今日选品
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
            核对货源事实与五维评分，再进入详情完成利润、资质和发布检查。系统只呈现已同步证据，不替你跳过关键确认。
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button asChild variant="outline" className="h-11 sm:h-9">
            <Link href="/favorites">
              <BookmarkSimple weight="bold" aria-hidden="true" />
              收藏对比
              <Badge variant="secondary" className="ml-1 px-1.5 py-0 font-normal">
                {favorites.isPending ? '…' : favorites.isError ? '—' : (favorites.data?.total ?? 0)}
              </Badge>
            </Link>
          </Button>
          <Button asChild className="h-11 sm:h-9">
            <Link href="/sources/import">
              批量采集 1688
              <ArrowRight weight="bold" aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </header>

      <Card aria-label="选品判断流程与当前摘要">
        <CardContent className="p-0">
          <ol className="grid sm:grid-cols-2 xl:grid-cols-4" aria-label="选品判断流程">
            {DECISION_ROUTE.map((step, index) => {
              const Icon = step.icon;
              return (
                <li
                  key={step.label}
                  className="flex min-w-0 items-center gap-3 border-b p-4 sm:[&:nth-last-child(-n+2)]:border-b-0 xl:border-b-0 xl:border-r xl:last:border-r-0"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                    <Icon weight="duotone" aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <small className="block text-[11px] text-muted-foreground tabular-nums">
                      步骤 {String(index + 1).padStart(2, '0')}
                    </small>
                    <strong className="mt-0.5 block truncate text-sm font-medium">
                      {step.label}
                    </strong>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {step.detail}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>

          <Separator />

          <dl className="grid grid-cols-2 lg:grid-cols-4" aria-live="polite">
            <SummaryItem
              label="当前候选"
              value={
                data
                  ? `${data.total.toLocaleString('zh-CN')} 款`
                  : isError
                    ? '读取失败'
                    : rangeError
                      ? '待调整筛选'
                      : '读取中'
              }
            />
            <SummaryItem
              label="最高综合评分"
              value={
                highestScore !== undefined
                  ? `${highestScore.toFixed(1)} 分`
                  : isError
                    ? '读取失败'
                    : data
                      ? '待计算'
                      : rangeError
                        ? '待调整筛选'
                        : '读取中'
              }
            />
            <SummaryItem
              label="货源采购价"
              value={
                facets.data?.priceRange
                  ? `¥${formatCompactPrice(facets.data.priceRange.min)} – ¥${formatCompactPrice(facets.data.priceRange.max)}`
                  : facets.isError
                    ? '读取失败'
                    : facets.isLoading
                      ? '读取中'
                      : '暂无范围'
              }
            />
            <SummaryItem label="收藏候选" value={favoriteTotal} />
          </dl>
        </CardContent>
      </Card>

      {isError ? (
        <ActionAlert
          variant="destructive"
          title="货源读取失败"
          description={recommendationErrorMessage(error)}
          actionLabel="重新读取"
          onAction={() => void refetch()}
        />
      ) : null}

      <ProductFilters
        facets={facets.data}
        filters={filters}
        isLoading={facets.isLoading}
        isPending={isFilterPending || isFetching}
        rangeError={rangeError}
        onChange={updateFilters}
      />

      {isLoading && !rangeError ? <SkeletonList /> : null}

      {facets.isError ? (
        <ActionAlert
          title="筛选数据暂时不可用"
          description="类目与价格分布暂时无法读取，当前商品列表仍可继续浏览。"
          actionLabel="重试筛选数据"
          onAction={() => void facets.refetch()}
          role="status"
        />
      ) : null}

      {favorites.isError || favoriteMutation.isError ? (
        <ActionAlert
          variant="warning"
          title="收藏状态未同步"
          description="收藏状态暂时无法同步，请重新读取后再操作。"
          actionLabel="重新同步收藏"
          onAction={() => {
            favoriteMutation.reset();
            void favorites.refetch();
          }}
        />
      ) : null}

      {data?.degraded && data.items.length === 0 ? (
        <Alert variant="warning" role="status">
          <WarningCircle weight="fill" aria-hidden="true" />
          <AlertTitle>当前结果不完整</AlertTitle>
          <AlertDescription>
            选品数据暂时无法从数据库完整读取，请稍后重试；当前空结果不代表没有可推荐商品。
          </AlertDescription>
        </Alert>
      ) : null}

      {data && !data.degraded && data.items.length === 0 ? <EmptyState /> : null}

      {data && data.items.length > 0 ? (
        <RecommendationRouteDesk
          products={data.items}
          total={data.total}
          isFetching={isFetching}
          favoriteIds={favoriteIds}
          favoritePendingId={
            favoriteMutation.isPending ? (favoriteMutation.variables?.productId1688 ?? null) : null
          }
          onToggleFavorite={(productId1688, active) =>
            favoriteMutation.mutate({ productId1688, active })
          }
        />
      ) : null}

      {data?.degraded && data.items.length > 0 ? (
        <Alert variant="warning" role="status">
          <WarningCircle weight="fill" aria-hidden="true" />
          <AlertTitle>候选列表可能缺失</AlertTitle>
          <AlertDescription>数据库读取暂时不完整，请稍后重新读取后再做最终判断。</AlertDescription>
        </Alert>
      ) : null}
    </main>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-b p-4 even:border-l [&:nth-last-child(-n+2)]:border-b-0 lg:border-b-0 lg:border-l lg:first:border-l-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-sm font-semibold tabular-nums sm:text-base">{value}</dd>
    </div>
  );
}

function ActionAlert({
  variant = 'default',
  title,
  description,
  actionLabel,
  onAction,
  role = 'alert',
}: {
  variant?: 'default' | 'destructive' | 'warning';
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
  role?: 'alert' | 'status';
}) {
  return (
    <Alert
      variant={variant}
      role={role}
      className="flex flex-col gap-3 pr-4 sm:flex-row sm:items-center"
    >
      <WarningCircle weight="fill" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{description}</AlertDescription>
      </div>
      <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={onAction}>
        {actionLabel}
      </Button>
    </Alert>
  );
}

function EmptyState() {
  return (
    <Card aria-labelledby="empty-title">
      <CardContent className="grid min-h-64 place-items-center p-8 text-center">
        <div>
          <span className="mx-auto grid size-12 place-items-center rounded-lg bg-muted text-muted-foreground">
            <ShieldCheck className="size-6" weight="duotone" aria-hidden="true" />
          </span>
          <h2 id="empty-title" className="mt-4 text-lg font-semibold">
            没有符合条件的候选商品
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            放宽类目或采购价范围，或者先采集新的 1688 货源。
          </p>
          <Button asChild variant="outline" className="mt-5 h-11 sm:h-9">
            <Link href="/sources/import">批量采集货源</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PageSkeleton() {
  return (
    <main
      className="mx-auto w-full max-w-[100rem] space-y-5 px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
      aria-busy="true"
    >
      <div className="space-y-3">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-5 w-full max-w-2xl" />
      </div>
      <Card>
        <CardContent className="grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div className="flex items-center gap-3" key={index}>
              <Skeleton className="size-9 shrink-0" />
              <div className="w-full space-y-2">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-4 w-24" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      <Skeleton className="h-52 w-full rounded-xl" />
      <SkeletonList />
    </main>
  );
}

function SkeletonList() {
  return (
    <div
      className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(22rem,0.85fr)]"
      aria-hidden="true"
    >
      <Card className="overflow-hidden">
        <CardContent className="space-y-0 p-0">
          {Array.from({ length: 6 }).map((_, index) => (
            <div className="flex items-center gap-3 border-b p-4 last:border-b-0" key={index}>
              <Skeleton className="size-12 shrink-0" />
              <div className="w-full space-y-2">
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-3 w-2/5" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      <Skeleton className="h-[32rem] w-full rounded-xl" />
    </div>
  );
}

function formatCompactPrice(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
}

function recommendationErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '登录状态已失效，请重新登录后再读取货源。';
    if (error.status === 403) return '当前账号暂无选品数据权限，请联系管理员确认权限。';
    if (error.status >= 500) return '货源服务暂时不可用，请稍后重新读取。';
  }
  return '暂时无法连接货源服务，请检查网络后重新读取。';
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
