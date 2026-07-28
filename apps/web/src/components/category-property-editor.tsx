'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';
import { CategoryQualificationEditor } from './category-qualification-editor';

interface Props {
  sourceProductId: string;
  shopId: string;
  enabled: boolean;
}

export function CategoryPropertyEditor({ sourceProductId, shopId, enabled }: Props) {
  const queryClient = useQueryClient();
  const properties = useQuery({
    queryKey: ['categoryProperties', sourceProductId, shopId],
    queryFn: () => api.categoryProperties(sourceProductId, shopId),
    enabled: enabled && !!shopId,
  });
  const [inputs, setInputs] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!properties.data) return;
    setInputs(
      Object.fromEntries(
        properties.data.attributes.map((attribute) => [
          attribute.id,
          (properties.data.values[attribute.id] ?? []).map((value) => value.name).join('，'),
        ]),
      ),
    );
  }, [properties.data]);

  const confirm = useMutation({
    mutationFn: () =>
      api.confirmCategoryProperties(sourceProductId, {
        shopId,
        values: (properties.data?.attributes ?? [])
          .filter((attribute) => attribute.inputType !== 'unsupported')
          .map((attribute) => ({
            propertyId: attribute.id,
            selections: splitValues(inputs[attribute.id] ?? '').map((name) => ({
              name,
              valueId: attribute.values?.find((option) => option.name === name)?.id,
            })),
          })),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['categoryProperties', sourceProductId, shopId], data);
      queryClient.invalidateQueries({
        queryKey: ['categoryQualifications', sourceProductId, shopId],
      });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.removeCategoryProperties(sourceProductId, shopId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['categoryProperties', sourceProductId, shopId] });
      queryClient.invalidateQueries({
        queryKey: ['categoryQualifications', sourceProductId, shopId],
      });
    },
  });
  const sync = useMutation({
    mutationFn: () => api.syncCategoryProperties(sourceProductId, shopId),
    onSuccess: (data) => {
      queryClient.setQueryData(['categoryProperties', sourceProductId, shopId], data);
      queryClient.invalidateQueries({
        queryKey: ['categoryQualifications', sourceProductId, shopId],
      });
    },
  });

  if (!enabled || !shopId) return null;
  if (properties.isLoading) {
    return <div className="h-16 animate-pulse rounded-xl bg-zinc-100" />;
  }
  if (properties.isError) {
    return (
      <div className="rounded-lg bg-red-50 p-3 text-xs text-red-700">
        类目属性读取失败：{(properties.error as ApiError).message}
      </div>
    );
  }
  if (!properties.data) return null;

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-zinc-200 p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-xs font-semibold text-zinc-700">类目必填属性</p>
            <p className="mt-1 text-[11px] text-zinc-400">
              {properties.data.categoryName ?? properties.data.categoryId} ·{' '}
              {properties.data.confirmed ? '已确认' : properties.data.stale ? '已失效' : '待确认'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => sync.mutate()}
              disabled={sync.isPending}
              className="text-xs text-brand-600 hover:underline disabled:opacity-50"
            >
              {sync.isPending ? '刷新中…' : '刷新官方属性'}
            </button>
            {properties.data.confirmed ? (
              <button
                type="button"
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
                className="text-xs text-red-600 hover:underline disabled:opacity-50"
              >
                清除属性确认
              </button>
            ) : null}
          </div>
        </div>

        {properties.data.blockers.length ? (
          <div className="mt-3 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-700">
            {properties.data.blockers.map((blocker) => (
              <p key={blocker}>{blocker}</p>
            ))}
            <p>该类目暂不能由系统安全发布，请改选类目或等待复杂属性组件支持。</p>
          </div>
        ) : null}

        {properties.data.attributes.length === 0 ? (
          <p className="mt-3 text-xs text-zinc-500">该类目没有返回需要填写的商品属性。</p>
        ) : (
          <div className="mt-3 space-y-3">
            {properties.data.attributes.map((attribute) => (
              <label key={attribute.id} className="block text-xs text-zinc-600">
                <span className="font-medium">
                  {attribute.name}
                  {attribute.required ? <span className="ml-1 text-red-500">*</span> : null}
                </span>
                {attribute.inputType === 'unsupported' ? (
                  <div className="mt-1 rounded-lg bg-zinc-100 px-3 py-2 text-zinc-500">
                    暂不支持：{attribute.unsupportedReason ?? '复杂属性规则'}
                  </div>
                ) : (
                  <>
                    <input
                      value={inputs[attribute.id] ?? ''}
                      onChange={(event) =>
                        setInputs((current) => ({
                          ...current,
                          [attribute.id]: event.target.value,
                        }))
                      }
                      list={`category-property-${attribute.id}`}
                      placeholder={
                        attribute.multiValue
                          ? '多个值用逗号分隔'
                          : attribute.supportsCustom
                            ? '选择官方值或输入自定义值'
                            : '请输入官方选项中的值'
                      }
                      className="mt-1.5 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-brand-500"
                    />
                    {attribute.values?.length ? (
                      <datalist id={`category-property-${attribute.id}`}>
                        {attribute.values.map((option) => (
                          <option key={option.id} value={option.name} />
                        ))}
                      </datalist>
                    ) : null}
                    <p className="mt-1 text-[11px] text-zinc-400">
                      {attribute.values?.length
                        ? `官方选项 ${attribute.values.length} 个${attribute.supportsCustom ? '，也支持自定义' : ''}`
                        : attribute.supportsCustom
                          ? '支持自定义填写'
                          : '平台未返回可选值'}
                    </p>
                  </>
                )}
              </label>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => confirm.mutate()}
          disabled={confirm.isPending || properties.data.blockers.length > 0}
          className="mt-3 rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
        >
          {confirm.isPending ? '校验保存中…' : '确认类目属性'}
        </button>
        {confirm.isSuccess ? <p className="mt-2 text-xs text-green-600">类目属性已确认。</p> : null}
        {confirm.isError ? (
          <p className="mt-2 text-xs text-red-600">{(confirm.error as ApiError).message}</p>
        ) : null}
        {sync.isError ? (
          <p className="mt-2 text-xs text-red-600">{(sync.error as ApiError).message}</p>
        ) : null}
      </div>
      <CategoryQualificationEditor
        sourceProductId={sourceProductId}
        shopId={shopId}
        enabled={properties.data.confirmed}
      />
    </div>
  );
}

function splitValues(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}
