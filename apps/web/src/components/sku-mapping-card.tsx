'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, type SkuMappingRow } from '@/lib/api';

interface Props {
  sourceProductId: string;
}

export function SkuMappingCard({ sourceProductId }: Props) {
  const queryClient = useQueryClient();
  const queryKey = ['skuMapping', sourceProductId];
  const mapping = useQuery({ queryKey, queryFn: () => api.skuMapping(sourceProductId) });
  const [dimensions, setDimensions] = useState<string[]>([]);
  const [skus, setSkus] = useState<SkuMappingRow[]>([]);

  useEffect(() => {
    if (!mapping.data) return;
    setDimensions(mapping.data.dimensions);
    setSkus(mapping.data.skus);
  }, [mapping.data]);

  const confirm = useMutation({
    mutationFn: () =>
      api.confirmSkuMapping(sourceProductId, {
        platform: 'douyin',
        dimensions,
        skus: skus.map((sku) => ({
          sourceSkuId: sku.sourceSkuId,
          values: sku.values,
          enabled: sku.enabled,
        })),
      }),
    onSuccess: (data) => queryClient.setQueryData(queryKey, data),
  });
  const remove = useMutation({
    mutationFn: () => api.removeSkuMapping(sourceProductId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const valid =
    dimensions.length > 0 &&
    dimensions.length <= 3 &&
    dimensions.every((dimension) => !!dimension.trim()) &&
    new Set(dimensions.map((dimension) => dimension.trim())).size === dimensions.length &&
    skus.some((sku) => sku.enabled) &&
    skus.every(
      (sku) =>
        sku.values.length === dimensions.length && sku.values.every((value) => !!value.trim()),
    );

  return (
    <section className="mt-4 rounded-2xl border border-zinc-200 bg-white p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">抖店 SKU 规格</h2>
            {mapping.data ? (
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  mapping.data.confirmed
                    ? 'bg-green-50 text-green-600'
                    : 'bg-amber-50 text-amber-600'
                }`}
              >
                {mapping.data.requiresConfirmation
                  ? mapping.data.confirmed
                    ? '已确认'
                    : '待确认'
                  : '默认规格'}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs leading-5 text-zinc-500">
            自动读取 1688 规格并转换为抖店多 SKU；多规格商品确认后才能铺货。
          </p>
        </div>
        {mapping.data?.confirmed && mapping.data.requiresConfirmation ? (
          <button
            type="button"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
            className="shrink-0 text-xs text-zinc-400 hover:text-red-500 disabled:opacity-50"
          >
            清除确认
          </button>
        ) : null}
      </div>

      {mapping.isLoading ? <p className="text-xs text-zinc-400">加载 SKU…</p> : null}
      {mapping.isError ? (
        <p className="text-xs text-red-600">{(mapping.error as ApiError).message}</p>
      ) : null}

      {mapping.data && !mapping.data.requiresConfirmation ? (
        <div className="rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-500">
          货源未提供多规格，将按 1 个默认 SKU 发布。
        </div>
      ) : null}

      {mapping.data?.requiresConfirmation ? (
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-xs text-zinc-500">规格维度（最多 3 个）</div>
            <div className="grid gap-2 sm:grid-cols-3">
              {dimensions.map((dimension, index) => (
                <input
                  key={index}
                  type="text"
                  maxLength={30}
                  value={dimension}
                  onChange={(event) =>
                    setDimensions((current) =>
                      current.map((value, itemIndex) =>
                        itemIndex === index ? event.target.value : value,
                      ),
                    )
                  }
                  className="rounded border border-zinc-200 px-2 py-1.5 text-xs outline-none focus:border-brand-500"
                />
              ))}
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-zinc-100">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-zinc-50 text-zinc-400">
                <tr>
                  <th className="px-2 py-2 font-medium">启用</th>
                  <th className="px-2 py-2 font-medium">货源规格</th>
                  {dimensions.map((dimension, index) => (
                    <th key={index} className="min-w-24 px-2 py-2 font-medium">
                      {dimension || `维度 ${index + 1}`}
                    </th>
                  ))}
                  <th className="px-2 py-2 font-medium">成本 / 库存</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {skus.map((sku, skuIndex) => (
                  <tr key={sku.sourceSkuId}>
                    <td className="px-2 py-2">
                      <input
                        type="checkbox"
                        checked={sku.enabled}
                        onChange={(event) =>
                          setSkus((current) =>
                            current.map((item, index) =>
                              index === skuIndex
                                ? { ...item, enabled: event.target.checked }
                                : item,
                            ),
                          )
                        }
                      />
                    </td>
                    <td className="max-w-36 px-2 py-2 text-zinc-500">{sku.sourceSpecName}</td>
                    {dimensions.map((_, valueIndex) => (
                      <td key={valueIndex} className="px-2 py-2">
                        <input
                          type="text"
                          maxLength={30}
                          value={sku.values[valueIndex] ?? ''}
                          onChange={(event) =>
                            setSkus((current) =>
                              current.map((item, index) =>
                                index === skuIndex
                                  ? {
                                      ...item,
                                      values: dimensions.map((__, itemValueIndex) =>
                                        itemValueIndex === valueIndex
                                          ? event.target.value
                                          : (item.values[itemValueIndex] ?? ''),
                                      ),
                                    }
                                  : item,
                              ),
                            )
                          }
                          className="w-full rounded border border-zinc-200 px-2 py-1 outline-none focus:border-brand-500"
                        />
                      </td>
                    ))}
                    <td className="whitespace-nowrap px-2 py-2 text-zinc-400">
                      ¥{sku.costPrice} / {sku.stock}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {mapping.data.warnings.map((warning) => (
            <p key={warning} className="text-[11px] text-amber-600">
              ⚠ {warning}
            </p>
          ))}
          <button
            type="button"
            onClick={() => confirm.mutate()}
            disabled={!valid || confirm.isPending}
            className="w-full rounded-lg bg-zinc-900 py-2 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-40"
          >
            {confirm.isPending ? '保存中…' : '确认 SKU 映射'}
          </button>
          {confirm.isSuccess ? <p className="text-xs text-green-600">SKU 映射已确认。</p> : null}
          {confirm.isError ? (
            <p className="text-xs text-red-600">{(confirm.error as ApiError).message}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
