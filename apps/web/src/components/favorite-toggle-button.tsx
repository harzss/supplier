'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function FavoriteToggleButton({ productId1688 }: { productId1688: string }) {
  const queryClient = useQueryClient();
  const favorites = useQuery({ queryKey: ['favorites'], queryFn: () => api.favorites() });
  const active =
    favorites.data?.items.some((item) => item.productId1688 === productId1688) ?? false;
  const mutation = useMutation({
    mutationFn: async () => {
      if (active) await api.removeFavorite(productId1688);
      else await api.addFavorite(productId1688);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['favorites'] }),
  });

  return (
    <button
      type="button"
      onClick={() => mutation.mutate()}
      disabled={favorites.isLoading || mutation.isPending}
      className={`rounded-full border px-4 py-2 text-sm font-medium transition disabled:opacity-50 ${
        active
          ? 'border-brand-200 bg-brand-50 text-brand-600'
          : 'border-zinc-200 bg-white text-zinc-600 hover:border-brand-400 hover:text-brand-600'
      }`}
    >
      {mutation.isPending ? '处理中…' : active ? '★ 已收藏' : '☆ 加入收藏对比'}
    </button>
  );
}
