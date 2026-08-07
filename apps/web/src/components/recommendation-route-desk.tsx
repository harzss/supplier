'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  BookmarkSimple,
  CircleNotch,
  Coins,
  Cube,
  Gauge,
  Package,
  ShieldCheck,
} from '@phosphor-icons/react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import type { Product } from '@/lib/api';
import { cn } from '@/lib/utils';

type EvidenceFocus = 'source' | 'profit' | 'compliance' | 'publish';

export interface RecommendationRouteDeskProps {
  products: Product[];
  total: number;
  isFetching: boolean;
  favoriteIds: ReadonlySet<string>;
  favoritePendingId: string | null;
  onToggleFavorite: (productId1688: string, active: boolean) => void;
}

const EVIDENCE_STATIONS: Array<{
  id: EvidenceFocus;
  label: string;
  description: string;
}> = [
  { id: 'source', label: '货源证据', description: '价格与库存' },
  { id: 'profit', label: '利润评分', description: '排序参考' },
  { id: 'compliance', label: '合规评分', description: '风险参考' },
  { id: 'publish', label: '发布复核', description: '进入详情' },
];

const AVAILABILITY_LABELS: Record<Product['availability'], string> = {
  available: '可供货',
  out_of_stock: '已缺货',
  offline: '已下架',
  unknown: '状态待确认',
};

const INTEGER_FORMATTER = new Intl.NumberFormat('zh-CN');
const COMPACT_FORMATTER = new Intl.NumberFormat('zh-CN', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function RecommendationRouteDesk({
  products,
  total,
  isFetching,
  favoriteIds,
  favoritePendingId,
  onToggleFavorite,
}: RecommendationRouteDeskProps) {
  const [selectedProductId, setSelectedProductId] = useState<string | null>(
    products[0]?.productId1688 ?? null,
  );
  const [evidenceFocus, setEvidenceFocus] = useState<EvidenceFocus>('source');
  const selectedProduct =
    products.find((product) => product.productId1688 === selectedProductId) ?? products[0] ?? null;

  if (!selectedProduct) {
    return (
      <Card aria-labelledby="route-desk-empty-title">
        <CardContent className="grid min-h-56 place-items-center p-8 text-center">
          <div>
            <Cube
              className="mx-auto size-8 text-muted-foreground"
              weight="duotone"
              aria-hidden="true"
            />
            <h2 id="route-desk-empty-title" className="mt-3 font-semibold">
              当前没有候选商品
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              调整真实货源筛选后，候选商品会显示在这里。
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const selectedIsFavorite = favoriteIds.has(selectedProduct.productId1688);
  const selectedFavoritePending = favoritePendingId === selectedProduct.productId1688;

  return (
    <section
      className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(22rem,0.85fr)]"
      aria-labelledby="route-desk-title"
    >
      <Card className="min-w-0 overflow-hidden">
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0 border-b p-4 sm:p-5">
          <div className="min-w-0">
            <CardTitle id="route-desk-title" className="text-base">
              候选商品
            </CardTitle>
            <CardDescription className="mt-1">
              选择商品查看真实字段；评分不代表已通过利润、合规或发布检查。
            </CardDescription>
          </div>
          <Badge variant="outline" className="shrink-0 gap-1.5 bg-background tabular-nums">
            {isFetching ? (
              <CircleNotch className="animate-spin" weight="bold" aria-hidden="true" />
            ) : null}
            {products.length}/{total}
          </Badge>
        </CardHeader>

        <div className="divide-y">
          {products.map((product, index) => (
            <CandidateRow
              key={product.id}
              product={product}
              rank={index + 1}
              selected={product.productId1688 === selectedProduct.productId1688}
              favorite={favoriteIds.has(product.productId1688)}
              favoritePending={favoritePendingId === product.productId1688}
              onSelect={() => setSelectedProductId(product.productId1688)}
              onToggleFavorite={() =>
                onToggleFavorite(product.productId1688, favoriteIds.has(product.productId1688))
              }
            />
          ))}
        </div>
      </Card>

      <DecisionCard
        product={selectedProduct}
        focus={evidenceFocus}
        favorite={selectedIsFavorite}
        favoritePending={selectedFavoritePending}
        onFocusChange={setEvidenceFocus}
        onToggleFavorite={() => onToggleFavorite(selectedProduct.productId1688, selectedIsFavorite)}
      />
    </section>
  );
}

function CandidateRow({
  product,
  rank,
  selected,
  favorite,
  favoritePending,
  onSelect,
  onToggleFavorite,
}: {
  product: Product;
  rank: number;
  selected: boolean;
  favorite: boolean;
  favoritePending: boolean;
  onSelect: () => void;
  onToggleFavorite: () => void;
}) {
  return (
    <article
      className={cn(
        'flex min-w-0 items-stretch transition-colors [content-visibility:auto] [contain-intrinsic-size:76px]',
        selected ? 'bg-accent/80' : 'hover:bg-muted/40',
      )}
    >
      <Button
        type="button"
        variant="ghost"
        aria-pressed={selected}
        aria-label={`选择候选 ${product.title}`}
        onClick={onSelect}
        className="h-auto min-w-0 flex-1 justify-start rounded-none px-3 py-3 text-left hover:bg-transparent sm:px-4"
      >
        <span className="grid w-full min-w-0 grid-cols-[2rem_3rem_minmax(0,1fr)] items-center gap-3 lg:grid-cols-[2rem_3rem_minmax(0,1fr)_7rem_5.5rem_4.5rem]">
          <span className="text-xs font-medium text-muted-foreground tabular-nums">
            {String(rank).padStart(2, '0')}
          </span>
          <ProductImage
            product={product}
            size={48}
            className="size-12 rounded-md border object-cover"
          />
          <span className="min-w-0 whitespace-normal">
            <strong className="line-clamp-2 block text-sm font-medium leading-5">
              {product.title}
            </strong>
            <small className="mt-1 block truncate text-xs font-normal text-muted-foreground">
              {product.categoryL1 ?? product.categoryPath ?? '类目待确认'} ·{' '}
              {AVAILABILITY_LABELS[product.availability]}
            </small>
          </span>
          <RowMetric label="采购价" value={formatProductPrice(product)} />
          <RowMetric label="库存" value={INTEGER_FORMATTER.format(product.totalStock)} />
          <RowMetric
            label="评分"
            value={product.score ? product.score.overall.toFixed(1) : '待计算'}
          />
        </span>
      </Button>

      <div className="flex shrink-0 items-center gap-1 pr-2 sm:pr-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-10 sm:size-9"
          disabled={favoritePending}
          aria-label={favorite ? `取消收藏 ${product.title}` : `收藏 ${product.title}`}
          aria-pressed={favorite}
          onClick={onToggleFavorite}
        >
          {favoritePending ? (
            <CircleNotch className="animate-spin" weight="bold" aria-hidden="true" />
          ) : (
            <BookmarkSimple weight={favorite ? 'fill' : 'regular'} aria-hidden="true" />
          )}
        </Button>
        <Button asChild variant="ghost" size="icon" className="hidden size-9 sm:inline-flex">
          <Link href={productDetailHref(product)} aria-label={`查看 ${product.title} 的详情`}>
            <ArrowRight weight="bold" aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </article>
  );
}

function RowMetric({ label, value }: { label: string; value: string }) {
  return (
    <span className="hidden min-w-0 whitespace-normal lg:block">
      <small className="block text-xs font-normal text-muted-foreground">{label}</small>
      <strong className="mt-1 block truncate text-sm font-semibold tabular-nums">{value}</strong>
    </span>
  );
}

function DecisionCard({
  product,
  focus,
  favorite,
  favoritePending,
  onFocusChange,
  onToggleFavorite,
}: {
  product: Product;
  focus: EvidenceFocus;
  favorite: boolean;
  favoritePending: boolean;
  onFocusChange: (focus: EvidenceFocus) => void;
  onToggleFavorite: () => void;
}) {
  const reasons = scoreReasons(product.score?.reason).slice(0, 2);
  const evidence = evidencePanelCopy(product, focus);

  return (
    <Card
      className="overflow-hidden xl:sticky xl:top-[4.5rem]"
      aria-labelledby="decision-card-title"
    >
      <CardHeader className="border-b p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 gap-3">
            <ProductImage
              product={product}
              size={64}
              className="size-16 shrink-0 rounded-lg border object-cover"
            />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">
                {product.categoryL1 ?? product.categoryPath ?? '类目待确认'}
              </p>
              <CardTitle id="decision-card-title" className="mt-1 line-clamp-2 text-base leading-5">
                {product.title}
              </CardTitle>
              <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                1688 {product.productId1688}
              </p>
            </div>
          </div>
          <Badge variant="outline" className="shrink-0">
            {AVAILABILITY_LABELS[product.availability]}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-5 p-4 sm:p-5">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-2 2xl:grid-cols-4">
          {EVIDENCE_STATIONS.map((station) => (
            <Button
              key={station.id}
              type="button"
              variant={focus === station.id ? 'default' : 'outline'}
              size="sm"
              className="h-auto min-h-11 justify-start whitespace-normal px-3 py-2 text-left"
              aria-pressed={focus === station.id}
              onClick={() => onFocusChange(station.id)}
            >
              <EvidenceIcon focus={station.id} />
              <span>
                <strong className="block text-xs">{station.label}</strong>
                <small className="block text-[10px] font-normal opacity-70">
                  {evidenceValue(product, station.id)}
                </small>
              </span>
            </Button>
          ))}
        </div>

        <div className="rounded-lg border bg-muted/40 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-muted-foreground">{evidence.label}</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
                {evidence.value}
              </p>
            </div>
            <Gauge className="size-5 text-muted-foreground" weight="duotone" aria-hidden="true" />
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">{evidence.note}</p>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
            {evidence.facts.map((fact) => (
              <div key={fact.label} className="min-w-0">
                <dt className="text-[11px] text-muted-foreground">{fact.label}</dt>
                <dd className="mt-0.5 truncate text-sm font-medium tabular-nums">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </div>

        {product.score ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">五维评分</p>
              <Badge className="tabular-nums">综合 {product.score.overall.toFixed(1)}</Badge>
            </div>
            <SignalScale label="需求" value={product.score.demand} />
            <SignalScale label="利润" value={product.score.profit} />
            <SignalScale label="合规" value={product.score.compliance} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">评分尚未生成，仍可查看真实货源详情。</p>
        )}

        <Separator />

        <dl className="grid grid-cols-2 gap-4">
          <Fact label="采购价" value={formatProductPrice(product)} />
          <Fact label="月销量" value={COMPACT_FORMATTER.format(product.monthlySold)} />
          <Fact label="可售库存" value={INTEGER_FORMATTER.format(product.totalStock)} />
          <Fact
            label="代发条件"
            value={product.isOnePieceDrop ? '支持一件代发' : '不支持一件代发'}
          />
        </dl>

        <div>
          <p className="text-sm font-medium">推荐依据</p>
          {reasons.length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm leading-5 text-muted-foreground">
              {reasons.map((reason) => (
                <li key={reason} className="flex gap-2">
                  <span
                    className="mt-2 size-1 shrink-0 rounded-full bg-primary"
                    aria-hidden="true"
                  />
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm leading-5 text-muted-foreground">
              暂无评分依据。发布资格、利润和资质仍需进入详情复核。
            </p>
          )}
        </div>

        <p className="text-xs text-muted-foreground">最近同步 {formatDateTime(product.syncedAt)}</p>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          <Button
            type="button"
            variant={favorite ? 'secondary' : 'outline'}
            className="h-11"
            disabled={favoritePending}
            aria-pressed={favorite}
            onClick={onToggleFavorite}
          >
            {favoritePending ? (
              <CircleNotch className="animate-spin" weight="bold" aria-hidden="true" />
            ) : (
              <BookmarkSimple weight={favorite ? 'fill' : 'regular'} aria-hidden="true" />
            )}
            {favoritePending ? '处理中' : favorite ? '已收藏' : '收藏候选'}
          </Button>
          <Button asChild className="h-11">
            <Link href={productDetailHref(product)}>
              进入详情复核
              <ArrowRight weight="bold" aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SignalScale({ label, value }: { label: string; value: number }) {
  const normalized = Math.max(0, Math.min(100, value));
  return (
    <div className="grid grid-cols-[2.5rem_minmax(0,1fr)_2rem] items-center gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <span
          className="block h-full rounded-full bg-primary"
          style={{ width: `${normalized}%` }}
        />
      </span>
      <strong className="text-right tabular-nums">{value.toFixed(0)}</strong>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-sm font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function ProductImage({
  product,
  size,
  className,
}: {
  product: Product;
  size: number;
  className?: string;
}) {
  if (!product.mainImage) {
    return (
      <span
        className={cn('grid place-items-center bg-muted text-muted-foreground', className)}
        aria-hidden="true"
      >
        <Cube weight="duotone" />
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className}
      src={product.mainImage}
      alt={product.title}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
    />
  );
}

function EvidenceIcon({ focus }: { focus: EvidenceFocus }) {
  if (focus === 'source') return <Package weight="duotone" aria-hidden="true" />;
  if (focus === 'profit') return <Coins weight="duotone" aria-hidden="true" />;
  if (focus === 'compliance') return <ShieldCheck weight="duotone" aria-hidden="true" />;
  return <ArrowRight weight="bold" aria-hidden="true" />;
}

function evidenceValue(product: Product, focus: EvidenceFocus): string {
  if (focus === 'source') return AVAILABILITY_LABELS[product.availability];
  if (focus === 'profit') return product.score ? product.score.profit.toFixed(0) : '待计算';
  if (focus === 'compliance') {
    return product.score ? product.score.compliance.toFixed(0) : '待计算';
  }
  return '进入详情';
}

function evidencePanelCopy(
  product: Product,
  focus: EvidenceFocus,
): {
  label: string;
  value: string;
  note: string;
  facts: Array<{ label: string; value: string }>;
} {
  if (focus === 'source') {
    return {
      label: '货源事实',
      value: AVAILABILITY_LABELS[product.availability],
      note: '以下价格、库存和代发条件来自当前货源快照。',
      facts: [
        { label: '采购价', value: formatProductPrice(product) },
        { label: '可售库存', value: INTEGER_FORMATTER.format(product.totalStock) },
        { label: '月销量', value: COMPACT_FORMATTER.format(product.monthlySold) },
        { label: '代发', value: product.isOnePieceDrop ? '支持' : '不支持' },
      ],
    };
  }

  if (focus === 'profit') {
    return {
      label: '利润评分',
      value: product.score ? product.score.profit.toFixed(0) : '待计算',
      note: '利润评分用于候选排序，不代表实际毛利率或最终成交利润。',
      facts: [
        { label: '综合评分', value: product.score ? product.score.overall.toFixed(1) : '待计算' },
        { label: '利润评分', value: product.score ? product.score.profit.toFixed(0) : '待计算' },
        {
          label: '竞争评分',
          value: product.score ? product.score.competition.toFixed(0) : '待计算',
        },
        { label: '采购价', value: formatProductPrice(product) },
      ],
    };
  }

  if (focus === 'compliance') {
    return {
      label: '合规评分',
      value: product.score ? product.score.compliance.toFixed(0) : '待计算',
      note: '合规评分是选品参考，类目资质与商品描述仍需在详情页确认。',
      facts: [
        {
          label: '合规评分',
          value: product.score ? product.score.compliance.toFixed(0) : '待计算',
        },
        { label: '货源状态', value: AVAILABILITY_LABELS[product.availability] },
        { label: '一级类目', value: product.categoryL1 ?? '待确认' },
        { label: '二级类目', value: product.categoryL2 ?? '待确认' },
      ],
    };
  }

  return {
    label: '发布复核',
    value: '状态待核实',
    note: '候选列表不包含发布任务或已铺货状态，请进入详情核实后再操作。',
    facts: [
      { label: '货源状态', value: AVAILABILITY_LABELS[product.availability] },
      { label: '当前库存', value: INTEGER_FORMATTER.format(product.totalStock) },
      { label: '综合评分', value: product.score ? product.score.overall.toFixed(1) : '待计算' },
      { label: '下一步', value: '进入详情复核' },
    ],
  };
}

function scoreReasons(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (reason): reason is string => typeof reason === 'string' && reason.trim().length > 0,
  );
}

function formatProductPrice(product: Product): string {
  if (!product.priceRange) return `¥${product.price}`;
  const [min, max] = product.priceRange;
  return min === max ? `¥${min}` : `¥${min} 至 ¥${max}`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间待确认' : DATE_TIME_FORMATTER.format(date);
}

function productDetailHref(product: Product): string {
  return `/products?id=${encodeURIComponent(product.productId1688)}`;
}
