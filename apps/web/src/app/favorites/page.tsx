'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type FavoriteProduct } from '@/lib/api';

const MAX_COMPARE = 5;

export default function FavoritesPage() {
  const queryClient = useQueryClient();
  const favorites = useQuery({ queryKey: ['favorites'], queryFn: () => api.favorites() });
  const [selection, setSelection] = useState<string[] | null>(null);
  const remove = useMutation({
    mutationFn: (productId1688: string) => api.removeFavorite(productId1688),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['favorites'] }),
  });

  const items = favorites.data?.items ?? [];
  const availableIds = new Set(items.map((item) => item.productId1688));
  const defaultSelection = items.slice(0, MAX_COMPARE).map((item) => item.productId1688);
  const selectedIds = (selection ?? defaultSelection).filter((id) => availableIds.has(id));
  const selectedItems = selectedIds.flatMap((id) => {
    const item = items.find((candidate) => candidate.productId1688 === id);
    return item ? [item] : [];
  });

  const toggle = (productId1688: string) => {
    const active = selectedIds.includes(productId1688);
    if (!active && selectedIds.length >= MAX_COMPARE) return;
    setSelection(
      active ? selectedIds.filter((id) => id !== productId1688) : [...selectedIds, productId1688],
    );
  };

  return (
    <main className="min-h-[calc(100vh-57px)] bg-[#f4f1ea] px-4 py-8 text-[#20211e] sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="mb-8 border-b border-[#20211e] pb-6">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-brand-600">
            S-05 · Selection desk
          </p>
          <div className="mt-2 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <h1 className="font-serif text-4xl font-semibold tracking-tight">收藏与选款对比</h1>
              <p className="mt-2 text-sm text-[#686a63]">
                从收藏中选择最多 {MAX_COMPARE} 款，并排核对采购价、月销、五维评分与代发条件。
              </p>
            </div>
            <div className="font-mono text-xs text-[#686a63]">
              已收藏 {items.length} · 已选 {selectedItems.length}/{MAX_COMPARE}
            </div>
          </div>
        </header>

        {favorites.isLoading ? <p className="text-sm text-[#777970]">加载收藏中…</p> : null}
        {favorites.isError ? (
          <p className="border border-red-200 bg-red-50 p-4 text-sm text-red-600">
            收藏加载失败：{favorites.error.message}
          </p>
        ) : null}
        {favorites.data && items.length === 0 ? (
          <div className="border border-dashed border-[#aaa69d] bg-[#faf8f2] px-6 py-16 text-center">
            <p className="font-serif text-2xl font-semibold">收藏夹还是空的</p>
            <p className="mt-2 text-sm text-[#777970]">
              从今日推荐中收藏感兴趣的款，再来这里并排比较。
            </p>
            <Link
              href="/"
              className="mt-5 inline-block border-b border-brand-500 text-sm font-medium text-brand-600"
            >
              去今日推荐选款 →
            </Link>
          </div>
        ) : null}

        {items.length ? (
          <>
            <section className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {items.map((item) => {
                const active = selectedIds.includes(item.productId1688);
                const selectionFull = !active && selectedIds.length >= MAX_COMPARE;
                return (
                  <article
                    key={item.productId1688}
                    className={`relative min-w-0 border bg-[#faf8f2] p-3 transition ${
                      active ? 'border-[#20211e] shadow-[3px_3px_0_#20211e]' : 'border-[#cbc6bb]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggle(item.productId1688)}
                      disabled={selectionFull}
                      aria-pressed={active}
                      className={`absolute right-2 top-2 z-[1] h-7 min-w-7 border px-1 font-mono text-xs ${
                        active
                          ? 'border-[#20211e] bg-[#20211e] text-white'
                          : 'border-[#cbc6bb] bg-white text-[#777970] disabled:opacity-40'
                      }`}
                    >
                      {active ? '✓' : '+'}
                    </button>
                    <Link href={`/products/${encodeURIComponent(item.productId1688)}`}>
                      <div className="aspect-square overflow-hidden bg-[#ebe7dd]">
                        {item.mainImage ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.mainImage}
                            alt={item.title}
                            className="h-full w-full object-cover"
                          />
                        ) : null}
                      </div>
                      <p className="mt-3 line-clamp-2 text-sm font-medium leading-5">
                        {item.title}
                      </p>
                    </Link>
                    <div className="mt-3 flex items-center justify-between text-xs">
                      <span className="font-mono font-semibold text-brand-600">¥{item.price}</span>
                      <span className="text-[#777970]">月销 {item.monthlySold}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => remove.mutate(item.productId1688)}
                      disabled={remove.isPending}
                      className="mt-3 text-xs text-[#8a5548] underline-offset-2 hover:underline disabled:opacity-50"
                    >
                      移出收藏
                    </button>
                  </article>
                );
              })}
            </section>

            {selectedItems.length ? (
              <ComparisonTable products={selectedItems} />
            ) : (
              <p className="border border-dashed border-[#aaa69d] py-10 text-center text-sm text-[#777970]">
                至少选择 1 款开始比较。
              </p>
            )}
          </>
        ) : null}
      </div>
    </main>
  );
}

function ComparisonTable({ products }: { products: FavoriteProduct[] }) {
  const rows: Array<{ label: string; render: (product: FavoriteProduct) => React.ReactNode }> = [
    { label: '1688 采购价', render: (product) => `¥${product.price}` },
    {
      label: '价格区间',
      render: (product) =>
        product.priceRange ? `¥${product.priceRange[0]} – ¥${product.priceRange[1]}` : '单一采购价',
    },
    { label: '月销量', render: (product) => product.monthlySold.toLocaleString('zh-CN') },
    { label: '综合评分', render: (product) => scoreText(product.score?.overall) },
    { label: '需求', render: (product) => scoreText(product.score?.demand) },
    { label: '竞争', render: (product) => scoreText(product.score?.competition) },
    { label: '利润', render: (product) => scoreText(product.score?.profit) },
    { label: '合规', render: (product) => scoreText(product.score?.compliance) },
    { label: '趋势', render: (product) => scoreText(product.score?.trend) },
    { label: '类目', render: (product) => product.categoryPath ?? product.categoryL1 ?? '—' },
    { label: '一件代发', render: (product) => (product.isOnePieceDrop ? '支持' : '未标记') },
    {
      label: '推荐理由',
      render: (product) =>
        Array.isArray(product.score?.reason) ? (product.score.reason[0] ?? '—') : '—',
    },
  ];

  return (
    <section className="min-w-0 border border-[#20211e] bg-[#faf8f2]">
      <div className="border-b border-[#20211e] px-5 py-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-brand-600">
          Compare / {products.length}
        </p>
        <h2 className="mt-1 font-serif text-2xl font-semibold">选款对照表</h2>
      </div>
      <div className="overflow-x-auto">
        <table
          className="border-collapse text-left text-sm"
          style={{ minWidth: 160 + products.length * 220 }}
        >
          <thead>
            <tr className="border-b border-[#20211e]">
              <th className="sticky left-0 z-[1] w-40 min-w-40 bg-[#e9e3d8] px-4 py-4 font-mono text-[10px] uppercase tracking-[0.14em] text-[#686a63]">
                对比项
              </th>
              {products.map((product) => (
                <th
                  key={product.productId1688}
                  className="w-[220px] min-w-[220px] px-4 py-4 align-top"
                >
                  <Link
                    href={`/products/${encodeURIComponent(product.productId1688)}`}
                    className="group"
                  >
                    <p className="line-clamp-3 font-medium leading-5 group-hover:text-brand-600">
                      {product.title}
                    </p>
                    <p className="mt-2 font-mono text-[10px] font-normal text-[#777970]">
                      {product.productId1688}
                    </p>
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-[#d4cec2] last:border-0">
                <th className="sticky left-0 z-[1] bg-[#e9e3d8] px-4 py-3 font-medium">
                  {row.label}
                </th>
                {products.map((product) => (
                  <td key={product.productId1688} className="px-4 py-3 text-[#555750]">
                    {row.render(product)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function scoreText(value: number | undefined): string {
  return value === undefined ? '—' : value.toFixed(1);
}
