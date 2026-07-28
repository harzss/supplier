'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function MediaReadinessSection() {
  const readiness = useQuery({
    queryKey: ['mediaReadiness'],
    queryFn: () => api.mediaReadiness(),
  });

  return (
    <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <h2 className="text-base font-semibold">AI 图片服务</h2>
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700">
              M4
            </span>
          </div>
          <p className="text-xs text-zinc-500">
            详情长图和主图处理都需要公开图片存储；主图去水印/换背景还需要 GPU worker。
          </p>
        </div>
      </div>

      {readiness.data ? (
        <div
          className={`rounded-xl border p-4 ${
            readiness.data.ready
              ? 'border-green-200 bg-green-50/70'
              : 'border-amber-200 bg-amber-50/60'
          }`}
        >
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-semibold text-zinc-800">
              {readiness.data.ready ? '图片服务已就绪' : '图片服务尚未就绪'}
            </span>
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                readiness.data.ready ? 'bg-green-600 text-white' : 'bg-amber-200 text-amber-900'
              }`}
            >
              {readiness.data.readyCount}/{readiness.data.totalCount}
            </span>
          </div>
          <ul className="grid gap-2 sm:grid-cols-2">
            {readiness.data.checks.map((check) => (
              <li key={check.id} className="rounded-lg bg-white/80 px-3 py-2">
                <div className="flex items-center gap-2 text-xs font-medium text-zinc-700">
                  <span className={check.ready ? 'text-green-600' : 'text-amber-600'}>
                    {check.ready ? '✓' : '!'}
                  </span>
                  {check.label}
                </div>
                <p className="mt-1 break-words text-[11px] leading-4 text-zinc-500">
                  {check.detail}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : readiness.isError ? (
        <p className="text-sm text-red-600">图片服务准备度读取失败。</p>
      ) : (
        <div className="h-24 animate-pulse rounded-xl bg-zinc-100" />
      )}
    </section>
  );
}
