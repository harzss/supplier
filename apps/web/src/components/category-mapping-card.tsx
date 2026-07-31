'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';
import { CategoryPropertyEditor } from './category-property-editor';

export function CategoryMappingCard({ sourceProductId }: { sourceProductId: string }) {
  const queryClient = useQueryClient();
  const mapping = useQuery({
    queryKey: ['categoryMapping', sourceProductId, 'douyin'],
    queryFn: () => api.categoryMapping(sourceProductId),
  });
  const shops = useQuery({ queryKey: ['shops'], queryFn: () => api.shops() });
  const douyinShops = useMemo(
    () =>
      shops.data?.filter(
        (shop) => shop.platform === 'douyin' && shop.role === 'seller' && shop.status === 'active',
      ) ?? [],
    [shops.data],
  );
  const [shopId, setShopId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [categoryName, setCategoryName] = useState('');

  useEffect(() => {
    if (!shopId && douyinShops[0]) setShopId(douyinShops[0].id);
  }, [douyinShops, shopId]);
  useEffect(() => {
    if (!mapping.data) return;
    setCategoryId(mapping.data.categoryId ?? '');
    setCategoryName(mapping.data.categoryName ?? '');
  }, [mapping.data]);

  const catalog = useQuery({
    queryKey: ['categoryCatalog', shopId],
    queryFn: () => api.categoryCatalogStatus(shopId),
    enabled: !!shopId,
  });
  const syncCatalog = useMutation({
    mutationFn: () => api.syncCategoryCatalog(shopId),
    onSuccess: (data) => {
      queryClient.setQueryData(['categoryCatalog', shopId], data);
    },
  });
  const suggestions = useMutation({
    mutationFn: () => api.categorySuggestions(sourceProductId, shopId),
  });
  const confirm = useMutation({
    mutationFn: () =>
      api.confirmCategoryMapping(sourceProductId, {
        platform: 'douyin',
        categoryId,
        categoryName: categoryName || undefined,
        shopId: shopId || undefined,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['categoryMapping', sourceProductId, 'douyin'], data);
      queryClient.invalidateQueries({ queryKey: ['douyinReadiness'] });
      queryClient.invalidateQueries({ queryKey: ['categoryProperties', sourceProductId] });
      queryClient.invalidateQueries({ queryKey: ['categoryQualifications', sourceProductId] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.removeCategoryMapping(sourceProductId),
    onSuccess: () => {
      setCategoryId('');
      setCategoryName('');
      suggestions.reset();
      queryClient.invalidateQueries({ queryKey: ['categoryMapping', sourceProductId, 'douyin'] });
      queryClient.invalidateQueries({ queryKey: ['douyinReadiness'] });
      queryClient.invalidateQueries({ queryKey: ['categoryProperties', sourceProductId] });
      queryClient.invalidateQueries({ queryKey: ['categoryQualifications', sourceProductId] });
    },
  });

  const catalogRequired = !!shopId && catalog.data?.synced !== true;

  return (
    <section className="ledger-panel mt-4 p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">抖店发布类目</h2>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                mapping.data?.confirmed
                  ? 'bg-green-50 text-green-700'
                  : 'bg-amber-50 text-amber-700'
              }`}
            >
              {mapping.data?.confirmed ? '已确认' : '待确认'}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-zinc-500">
            真实抖店发布必须使用当前店铺可用的官方叶子类目。货源类目：
            {mapping.data?.sourceCategoryPath ?? '未提供'}
          </p>
        </div>
      </div>

      {mapping.isLoading || shops.isLoading ? (
        <div className="h-20 animate-pulse rounded-xl bg-zinc-100" />
      ) : mapping.isError || shops.isError ? (
        <p className="text-sm text-red-600">类目映射读取失败。</p>
      ) : (
        <div className="space-y-3">
          {douyinShops.length ? (
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
              <label className="text-xs font-medium text-zinc-600" htmlFor="category-shop">
                用于同步与预测的抖店
              </label>
              <select
                id="category-shop"
                value={shopId}
                onChange={(event) => {
                  setShopId(event.target.value);
                  suggestions.reset();
                }}
                className="mt-2 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500"
              >
                {douyinShops.map((shop) => (
                  <option key={shop.id} value={shop.id}>
                    {shop.shopName ?? shop.platformLabel} ·{' '}
                    {shop.connectionType === 'oauth' ? '真实授权' : '演示'}
                  </option>
                ))}
              </select>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span className={catalog.data?.synced ? 'text-green-700' : 'text-amber-700'}>
                  {catalog.isLoading
                    ? '读取目录状态…'
                    : catalog.data?.synced
                      ? `已同步 ${catalog.data.nodeCount} 个节点 / ${catalog.data.leafCount} 个可用叶子类目`
                      : '尚未同步官方类目目录'}
                </span>
                <button
                  type="button"
                  onClick={() => syncCatalog.mutate()}
                  disabled={!shopId || syncCatalog.isPending}
                  className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
                >
                  {syncCatalog.isPending
                    ? '同步中…'
                    : catalog.data?.synced
                      ? '重新同步'
                      : '同步官方类目'}
                </button>
                <button
                  type="button"
                  onClick={() => suggestions.mutate()}
                  disabled={!catalog.data?.synced || suggestions.isPending}
                  className="rounded-lg bg-brand-500 px-2.5 py-1.5 font-medium text-white hover:bg-brand-600 disabled:opacity-50"
                >
                  {suggestions.isPending ? '预测中…' : '获取官方 Top3'}
                </button>
              </div>
              {syncCatalog.isError ? (
                <p className="mt-2 text-xs text-red-600">
                  {(syncCatalog.error as ApiError).message}
                </p>
              ) : null}
              {suggestions.isError ? (
                <p className="mt-2 text-xs text-red-600">
                  {(suggestions.error as ApiError).message}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-700">
              暂无可用抖店。请先在设置页连接演示抖店或完成真实抖店授权。
            </div>
          )}

          {suggestions.data?.candidates.length ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-zinc-600">官方类目预测候选</p>
              {suggestions.data.candidates.map((candidate) => {
                const selectable = candidate.qualificationStatus === 0;
                return (
                  <button
                    key={candidate.categoryId}
                    type="button"
                    onClick={() => {
                      setCategoryId(candidate.categoryId);
                      setCategoryName(candidate.categoryName);
                    }}
                    disabled={!selectable}
                    className={`block w-full rounded-xl border p-3 text-left transition ${
                      categoryId === candidate.categoryId
                        ? 'border-brand-500 bg-brand-50'
                        : 'border-zinc-200 hover:border-zinc-300'
                    } disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:opacity-60`}
                  >
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-semibold">Top {candidate.rank}</span>
                      <span className={selectable ? 'text-green-700' : 'text-amber-700'}>
                        {qualificationLabel(candidate.qualificationStatus)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-zinc-800">{candidate.categoryPath}</p>
                    <p className="mt-1 font-mono text-[11px] text-zinc-400">
                      ID {candidate.categoryId}
                    </p>
                  </button>
                );
              })}
              <p className="text-[11px] leading-4 text-zinc-400">
                抖店官方接口未返回置信度，系统仅按官方推荐顺序展示，不伪造概率。
              </p>
            </div>
          ) : null}

          <input
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            placeholder="抖店官方叶子类目 ID（正整数）"
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-brand-500"
          />
          <input
            value={categoryName}
            onChange={(event) => setCategoryName(event.target.value)}
            placeholder="类目名称（可选，例如：女式T恤）"
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-brand-500"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => confirm.mutate()}
              disabled={confirm.isPending || !categoryId || catalogRequired}
              className="rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50"
            >
              {confirm.isPending ? '保存中…' : '确认类目映射'}
            </button>
            {mapping.data?.confirmed ? (
              <button
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
                className="rounded-lg px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                清除
              </button>
            ) : null}
          </div>
          {confirm.isSuccess ? <p className="text-xs text-green-600">类目映射已确认。</p> : null}
          {confirm.isError ? (
            <p className="text-xs text-red-600">{(confirm.error as ApiError).message}</p>
          ) : null}
          {catalogRequired ? (
            <p className="text-[11px] leading-4 text-amber-600">
              请先同步所选店铺的官方目录，确认时系统会校验该 ID 是否为可用叶子类目。
            </p>
          ) : null}
          <CategoryPropertyEditor
            sourceProductId={sourceProductId}
            shopId={shopId}
            enabled={mapping.data?.confirmed === true && catalog.data?.synced === true}
          />
        </div>
      )}
    </section>
  );
}

function qualificationLabel(status: 0 | 1 | 2 | null): string {
  if (status === 0) return '资质可用';
  if (status === 1) return '类目资质已过期';
  if (status === 2) return '店铺缺少类目资质';
  return '资质状态未知';
}
