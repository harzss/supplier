'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';

interface Props {
  sourceProductId: string;
  shopId: string;
  enabled: boolean;
}

export function CategoryQualificationEditor({ sourceProductId, shopId, enabled }: Props) {
  const queryClient = useQueryClient();
  const qualifications = useQuery({
    queryKey: ['categoryQualifications', sourceProductId, shopId],
    queryFn: () => api.categoryQualifications(sourceProductId, shopId),
    enabled: enabled && !!shopId,
  });
  const [attachmentInputs, setAttachmentInputs] = useState<Record<string, string>>({});
  const [contentNames, setContentNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!qualifications.data) return;
    setAttachmentInputs(
      Object.fromEntries(
        qualifications.data.qualifications.map((item) => [
          item.key,
          (qualifications.data.values[item.key]?.attachmentUrls ?? []).join('\n'),
        ]),
      ),
    );
    setContentNames(
      Object.fromEntries(
        qualifications.data.qualifications.map((item) => [
          item.key,
          qualifications.data.values[item.key]?.qualityContentName ?? '',
        ]),
      ),
    );
  }, [qualifications.data]);

  const confirm = useMutation({
    mutationFn: () =>
      api.confirmCategoryQualifications(sourceProductId, {
        shopId,
        qualifications: (qualifications.data?.qualifications ?? []).map((item) => ({
          qualificationKey: item.key,
          ...(contentNames[item.key]?.trim()
            ? { qualityContentName: contentNames[item.key]!.trim() }
            : {}),
          attachmentUrls: splitUrls(attachmentInputs[item.key] ?? ''),
        })),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['categoryQualifications', sourceProductId, shopId], data);
    },
  });
  const sync = useMutation({
    mutationFn: () => api.syncCategoryQualifications(sourceProductId, shopId),
    onSuccess: (data) => {
      queryClient.setQueryData(['categoryQualifications', sourceProductId, shopId], data);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.removeCategoryQualifications(sourceProductId, shopId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['categoryQualifications', sourceProductId, shopId],
      });
    },
  });

  if (!enabled || !shopId) return null;
  if (qualifications.isLoading) {
    return <div className="h-16 animate-pulse rounded-xl bg-zinc-100" />;
  }
  if (qualifications.isError) {
    return (
      <div className="rounded-lg bg-red-50 p-3 text-xs text-red-700">
        类目资质读取失败：{(qualifications.error as ApiError).message}
      </div>
    );
  }
  if (!qualifications.data) return null;

  const structurallyBlocked =
    qualifications.data.qualifications.some((item) => !!item.unsupportedReason) ||
    qualifications.data.blockers.some((blocker) => blocker.includes('类目属性'));

  return (
    <div className="rounded-xl border border-zinc-200 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-zinc-700">类目商品资质</p>
          <p className="mt-1 text-[11px] text-zinc-400">
            {qualifications.data.categoryName ?? qualifications.data.categoryId} ·{' '}
            {qualifications.data.confirmed
              ? '已满足'
              : qualifications.data.stale
                ? '已失效'
                : '待补充'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            className="text-xs text-brand-600 hover:underline disabled:opacity-50"
          >
            {sync.isPending ? '刷新中…' : '刷新官方规则'}
          </button>
          {qualifications.data.confirmedAt ? (
            <button
              type="button"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              className="text-xs text-red-600 hover:underline disabled:opacity-50"
            >
              清除确认
            </button>
          ) : null}
        </div>
      </div>

      {qualifications.data.blockers.length ? (
        <div className="mt-3 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-700">
          {qualifications.data.blockers.map((blocker) => (
            <p key={blocker}>{blocker}</p>
          ))}
        </div>
      ) : null}

      {qualifications.data.qualifications.length === 0 ? (
        <p className="mt-3 text-xs text-green-700">官方当前未返回需要提交的商品资质。</p>
      ) : (
        <div className="mt-3 space-y-3">
          {qualifications.data.qualifications.map((item) => (
            <div key={item.key} className="rounded-lg border border-zinc-100 bg-zinc-50 p-3">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-medium text-zinc-700">{item.name}</span>
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                    item.required ? 'bg-red-50 text-red-600' : 'bg-zinc-200 text-zinc-500'
                  }`}
                >
                  {item.required
                    ? item.requiredReason === 'property'
                      ? '当前属性必填'
                      : '类目必填'
                    : '选填'}
                </span>
              </div>
              {item.hints.map((hint) => (
                <p key={hint} className="mt-1 text-[11px] leading-4 text-zinc-500">
                  {hint}
                </p>
              ))}
              {item.unsupportedReason ? (
                <p className="mt-2 rounded bg-amber-100 px-2 py-1 text-[11px] text-amber-700">
                  暂不支持：{item.unsupportedReason}
                </p>
              ) : (
                <>
                  <input
                    value={contentNames[item.key] ?? ''}
                    onChange={(event) =>
                      setContentNames((current) => ({
                        ...current,
                        [item.key]: event.target.value,
                      }))
                    }
                    placeholder="资质内容名称（可选）"
                    className="mt-2 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs outline-none focus:border-brand-500"
                  />
                  <textarea
                    value={attachmentInputs[item.key] ?? ''}
                    onChange={(event) =>
                      setAttachmentInputs((current) => ({
                        ...current,
                        [item.key]: event.target.value,
                      }))
                    }
                    rows={3}
                    placeholder="每行一个公开 HTTPS 图片 URL"
                    className="mt-2 w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 font-mono text-xs outline-none focus:border-brand-500"
                  />
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {qualifications.data.qualifications.length ? (
        <button
          type="button"
          onClick={() => confirm.mutate()}
          disabled={confirm.isPending || structurallyBlocked}
          className="mt-3 rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
        >
          {confirm.isPending ? '校验保存中…' : '确认类目资质'}
        </button>
      ) : null}
      {confirm.isSuccess ? <p className="mt-2 text-xs text-green-600">类目资质已确认。</p> : null}
      {confirm.isError ? (
        <p className="mt-2 text-xs text-red-600">{(confirm.error as ApiError).message}</p>
      ) : null}
      {sync.isError ? (
        <p className="mt-2 text-xs text-red-600">{(sync.error as ApiError).message}</p>
      ) : null}
      <p className="mt-3 text-[11px] leading-4 text-zinc-400">{qualifications.data.warning}</p>
    </div>
  );
}

function splitUrls(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}
