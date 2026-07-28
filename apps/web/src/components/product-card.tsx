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
    <article className="group relative flex flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-brand-500 hover:shadow-md">
      <Link
        href={`/products/${encodeURIComponent(product.productId1688)}`}
        className="flex flex-1 flex-col"
      >
        <div className="relative aspect-square overflow-hidden bg-zinc-100">
          {product.mainImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product.mainImage}
              alt={product.title}
              className="h-full w-full object-cover transition group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-zinc-300">无图</div>
          )}
          <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
            #{rank}
          </span>
          {product.score && (
            <span className="absolute right-2 top-2">
              <ScoreBadge value={product.score.overall} />
            </span>
          )}
        </div>

        <div className="flex flex-1 flex-col gap-2 p-3">
          <p className="line-clamp-2 text-sm font-medium leading-snug text-zinc-800">
            {product.title}
          </p>
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold text-brand-600">¥{product.price}</span>
            <span className="text-xs text-zinc-400">月销 {product.monthlySold}</span>
          </div>
          {reasons.length > 0 && <p className="line-clamp-1 text-xs text-zinc-500">{reasons[0]}</p>}
          <div className="mt-auto flex items-center gap-1.5 pt-1 pr-8">
            {product.categoryL1 && (
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500">
                {product.categoryL1}
              </span>
            )}
            {product.isOnePieceDrop && (
              <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-600">
                一件代发
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
        className={`absolute bottom-2.5 right-2.5 z-[1] flex h-8 w-8 items-center justify-center rounded-full border text-lg shadow-sm transition disabled:opacity-50 ${
          isFavorite
            ? 'border-brand-200 bg-brand-50 text-brand-600'
            : 'border-zinc-200 bg-white text-zinc-400 hover:border-brand-300 hover:text-brand-500'
        }`}
      >
        {isFavorite ? '★' : '☆'}
      </button>
    </article>
  );
}
