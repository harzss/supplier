import Link from 'next/link';
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
  const reasons = Array.isArray(product.score?.reason) ? product.score!.reason : [];
  return (
    <article className="product-card">
      <Link
        href={`/products?id=${encodeURIComponent(product.productId1688)}`}
        className="product-card-link"
      >
        <div className="product-card-media">
          {product.mainImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={product.mainImage} alt={product.title} className="product-card-image" />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-[var(--muted)]">
              暂无图片
            </div>
          )}
          {product.score && (
            <span className="absolute left-2.5 top-2.5">
              <ScoreBadge value={product.score.overall} />
            </span>
          )}
        </div>

        <div className="flex flex-1 flex-col gap-2.5 p-3.5 sm:p-4">
          <div className="flex items-center justify-between gap-3 text-xs text-[var(--muted)]">
            <span className="font-medium tabular-nums">#{String(rank).padStart(2, '0')}</span>
            <span className="tabular-nums">月销 {product.monthlySold.toLocaleString('zh-CN')}</span>
          </div>
          <p className="line-clamp-2 min-h-10 text-sm font-semibold leading-5 text-[var(--ink)]">
            {product.title}
          </p>
          <div className="flex items-end justify-between gap-3 border-t border-[var(--line)] pt-2.5">
            <span className="text-lg font-semibold tracking-tight text-[var(--ink)] tabular-nums">
              ¥{product.price}
            </span>
            {product.isOnePieceDrop ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                一件代发
              </span>
            ) : null}
          </div>
          {reasons.length > 0 && (
            <p className="line-clamp-1 rounded-lg bg-brand-50 px-2.5 py-2 text-xs text-brand-700">
              {reasons[0]}
            </p>
          )}
          <div className="mt-auto flex items-center gap-1.5 pt-1">
            {product.categoryL1 && (
              <span className="rounded-full border border-[var(--line)] bg-[var(--surface-strong)] px-2 py-1 text-[10px] text-[var(--muted)]">
                {product.categoryL1}
              </span>
            )}
          </div>
        </div>
      </Link>
      <button
        type="button"
        onClick={onToggleFavorite}
        disabled={favoritePending}
        aria-label={isFavorite ? `取消收藏 ${product.title}` : `收藏 ${product.title}`}
        className={`product-favorite-button absolute right-2.5 top-2.5 z-[1] flex h-11 w-11 items-center justify-center rounded-full border bg-white/90 text-lg shadow-sm backdrop-blur disabled:opacity-50 ${
          isFavorite ? 'border-brand-200 text-brand-600' : 'border-white/70 text-[var(--muted)]'
        }`}
      >
        <svg
          viewBox="0 0 24 24"
          fill={isFavorite ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5"
          aria-hidden="true"
        >
          <path d="M6 4.5A2.5 2.5 0 0 1 8.5 2h7A2.5 2.5 0 0 1 18 4.5V22l-6-4-6 4V4.5Z" />
        </svg>
      </button>
    </article>
  );
}
