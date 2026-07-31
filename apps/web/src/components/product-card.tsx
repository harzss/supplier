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
    <article className="group relative flex flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow-sm)] transition duration-200 hover:-translate-y-1 hover:border-[var(--ink)] hover:shadow-[4px_4px_0_var(--accent)]">
      <Link
        href={`/products/${encodeURIComponent(product.productId1688)}`}
        className="flex flex-1 flex-col"
      >
        <div className="relative aspect-[4/5] overflow-hidden border-b border-[var(--line)] bg-[var(--paper-deep)]">
          {product.mainImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product.mainImage}
              alt={product.title}
              className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.035]"
            />
          ) : (
            <div className="flex h-full items-center justify-center font-mono text-xs uppercase tracking-widest text-[var(--muted)]">
              No image
            </div>
          )}
          <span className="absolute left-2 top-2 border border-white/50 bg-[var(--ink)] px-2 py-1 font-mono text-[10px] font-bold text-white">
            RANK {String(rank).padStart(2, '0')}
          </span>
          {product.score && (
            <span className="absolute right-2 top-2">
              <ScoreBadge value={product.score.overall} />
            </span>
          )}
        </div>

        <div className="flex flex-1 flex-col gap-2.5 p-3.5 sm:p-4">
          <p className="line-clamp-2 min-h-10 text-sm font-semibold leading-5 text-[var(--ink)]">
            {product.title}
          </p>
          <div className="flex items-end justify-between gap-3 border-t border-dashed border-[var(--line)] pt-2.5">
            <span className="font-mono text-lg font-bold tracking-tight text-[var(--accent-dark)]">
              ¥{product.price}
            </span>
            <span className="font-mono text-[10px] text-[var(--muted)]">
              SOLD {product.monthlySold.toLocaleString('zh-CN')}
            </span>
          </div>
          {reasons.length > 0 && (
            <p className="line-clamp-1 text-xs text-[var(--muted)]">{reasons[0]}</p>
          )}
          <div className="mt-auto flex items-center gap-1.5 pr-14 pt-1">
            {product.categoryL1 && (
              <span className="border border-[var(--line)] bg-[var(--surface-strong)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
                {product.categoryL1}
              </span>
            )}
            {product.isOnePieceDrop && (
              <span className="border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">
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
        className={`absolute bottom-2.5 right-2.5 z-[1] flex h-11 w-11 items-center justify-center rounded-full border text-lg shadow-sm transition disabled:opacity-50 ${
          isFavorite
            ? 'border-brand-200 bg-brand-50 text-brand-600'
            : 'border-[var(--line)] bg-[var(--surface)] text-[var(--muted)] hover:border-brand-300 hover:text-brand-500'
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
