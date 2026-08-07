import Link from 'next/link';
import { BookmarkSimple } from '@phosphor-icons/react';
import type { Product } from '@/lib/api';
import { ScoreBadge } from './score-badge';

export function ProductCard({
  product,
  rank,
  isFavorite,
  favoritePending,
  onToggleFavorite,
}: {
  product: Product;
  rank: number;
  isFavorite: boolean;
  favoritePending: boolean;
  onToggleFavorite: () => void;
}) {
  const reasons = Array.isArray(product.score?.reason) ? product.score.reason : [];
  const availability = availabilityView(product.availability, product.totalStock);

  return (
    <article className="product-card group">
      <Link
        href={`/products?id=${encodeURIComponent(product.productId1688)}`}
        className="product-card-link group/card"
      >
        <div className="product-card-media !aspect-[4/3]">
          {product.mainImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product.mainImage}
              alt={product.title}
              className="product-card-image transition-transform duration-500 ease-out group-hover/card:scale-[1.025] motion-reduce:transform-none"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-[var(--muted)]">
              暂无商品图
            </div>
          )}
        </div>

        <div className="flex flex-1 flex-col gap-3 p-3.5 sm:p-4">
          <div className="flex min-h-7 items-center justify-between gap-3">
            <span className="text-[11px] font-medium text-[var(--muted)] tabular-nums">
              第 {String(rank).padStart(2, '0')} 位
            </span>
            {product.score ? (
              <ScoreBadge value={product.score.overall} />
            ) : (
              <span className="text-[11px] text-[var(--muted)]">待评分</span>
            )}
          </div>

          <p
            className="line-clamp-2 min-h-10 text-sm font-semibold leading-5 text-[var(--ink)]"
            title={product.title}
          >
            {product.title}
          </p>

          {reasons.length > 0 ? (
            <p className="line-clamp-2 min-h-10 text-xs leading-5 text-[var(--accent-dark)]">
              <span className="mr-1 font-semibold text-[var(--ink-soft)]">推荐依据</span>
              {reasons[0]}
            </p>
          ) : null}

          <dl className="grid grid-cols-2 border-y border-[var(--line)]">
            <div className="min-w-0 py-2.5 pr-3">
              <dt className="text-[10px] font-medium text-[var(--muted)]">采购价</dt>
              <dd className="mt-1 truncate text-lg font-semibold tracking-tight text-[var(--ink)] tabular-nums">
                ¥{product.price}
              </dd>
            </div>
            <div className="min-w-0 border-l border-[var(--line)] py-2.5 pl-3">
              <dt className="text-[10px] font-medium text-[var(--muted)]">月销量</dt>
              <dd className="mt-1 truncate text-base font-semibold tracking-tight text-[var(--ink)] tabular-nums">
                {product.monthlySold.toLocaleString('zh-CN')}
              </dd>
            </div>
          </dl>

          <div className="mt-auto flex min-w-0 items-center justify-between gap-3 pt-0.5 text-[11px]">
            <div className="flex min-w-0 items-center gap-2">
              <span className={`shrink-0 font-medium ${availability.className}`}>
                {availability.label}
              </span>
              {product.isOnePieceDrop ? (
                <span className="shrink-0 text-[var(--ink-soft)]">一件代发</span>
              ) : null}
            </div>
            {product.categoryL1 ? (
              <span
                className="max-w-[42%] truncate text-right text-[var(--muted)]"
                title={product.categoryL1}
              >
                {product.categoryL1}
              </span>
            ) : null}
          </div>
        </div>
      </Link>

      <button
        type="button"
        onClick={onToggleFavorite}
        disabled={favoritePending}
        aria-label={isFavorite ? `取消收藏 ${product.title}` : `收藏 ${product.title}`}
        aria-pressed={isFavorite}
        className={`product-favorite-button absolute right-3 top-3 z-[1] flex h-11 w-11 items-center justify-center rounded-xl border bg-white/95 shadow-sm backdrop-blur disabled:cursor-wait disabled:opacity-50 ${
          isFavorite ? 'border-brand-200 text-brand-600' : 'border-white/80 text-[var(--muted)]'
        }`}
      >
        <BookmarkSimple
          className="h-5 w-5"
          aria-hidden="true"
          weight={isFavorite ? 'fill' : 'regular'}
        />
      </button>
    </article>
  );
}

function availabilityView(
  availability: Product['availability'],
  totalStock: number,
): { label: string; className: string } {
  if (availability === 'available') {
    return {
      label: `可售 ${totalStock.toLocaleString('zh-CN')}`,
      className: 'text-[var(--jade)]',
    };
  }
  if (availability === 'out_of_stock') {
    return { label: '当前缺货', className: 'text-[var(--danger)]' };
  }
  if (availability === 'offline') {
    return { label: '货源下架', className: 'text-[var(--muted)]' };
  }
  return { label: '库存待核验', className: 'text-[var(--warning)]' };
}
