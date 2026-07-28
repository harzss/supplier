'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';

const PLATFORMS: Array<{ value: string; label: string }> = [
  { value: 'douyin', label: '抖音小店' },
  { value: 'taobao', label: '淘宝' },
  { value: 'pdd', label: '拼多多' },
  { value: 'kuaishou', label: '快手小店' },
];

interface Props {
  originalTitle: string;
  category: string;
  selectedTitle?: string;
  onSelectTitle?: (title: string, platformLabel: string) => void;
}

/** AI 标题工作台：选平台 + 卖点 → 生成 5 条候选，可复制 */
export function TitleStudio({ originalTitle, category, selectedTitle, onSelectTitle }: Props) {
  const [platform, setPlatform] = useState('douyin');
  const [sellingPointsText, setSellingPointsText] = useState('');
  const [copied, setCopied] = useState<number | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.generateTitle({
        originalTitle,
        category,
        sellingPoints: sellingPointsText
          .split(/[，,；;\n]/)
          .map((s) => s.trim())
          .filter(Boolean),
        targetPlatform: platform,
      }),
  });

  const copy = async (text: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(idx);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard 不可用时忽略 */
    }
  };

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold">AI 标题工作台</h2>
        {mutation.data && <span className="text-xs text-zinc-400">模型 {mutation.data.model}</span>}
      </div>

      {/* 平台选择 */}
      <div className="mb-3 flex flex-wrap gap-2">
        {PLATFORMS.map((p) => (
          <button
            key={p.value}
            onClick={() => setPlatform(p.value)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${
              platform === p.value
                ? 'bg-brand-500 text-white'
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* 卖点输入 */}
      <textarea
        value={sellingPointsText}
        onChange={(e) => setSellingPointsText(e.target.value)}
        placeholder="输入卖点，用逗号或换行分隔（如：100%纯棉，透气吸汗，显瘦）"
        rows={2}
        className="mb-3 w-full resize-none rounded-lg border border-zinc-200 p-2.5 text-sm outline-none focus:border-brand-500"
      />

      <button
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        className="w-full rounded-xl bg-brand-500 py-2.5 text-sm font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
      >
        {mutation.isPending ? '生成中…' : '✨ 生成 5 条优化标题'}
      </button>

      {mutation.isError &&
        (() => {
          const err = mutation.error as ApiError;
          if (err.code === 'QUOTA_EXCEEDED') {
            return (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
                <p className="font-medium text-amber-800">本月 AI 额度已用完</p>
                <p className="mt-1 text-amber-700">{err.message}</p>
                <a
                  href="/settings"
                  className="mt-2 inline-block rounded-md bg-amber-500 px-3 py-1 text-xs font-medium text-white hover:bg-amber-600"
                >
                  升级套餐 / 配置自有 Key →
                </a>
              </div>
            );
          }
          return <p className="mt-3 text-sm text-red-600">生成失败：{err.message}</p>;
        })()}

      {/* 结果 */}
      {mutation.data && (
        <div className="mt-4 space-y-2">
          {/* 计费信息 */}
          <div className="flex items-center justify-between rounded-lg bg-zinc-50 px-3 py-2 text-xs">
            {mutation.data.billing.viaByok ? (
              <span className="text-green-600">🔑 使用自有 API Key（不计平台额度）</span>
            ) : mutation.data.billing.quota ? (
              <span className="text-zinc-500">
                本月平台额度剩余{' '}
                <b className="text-zinc-700">{mutation.data.billing.quota.remaining}</b> /{' '}
                {mutation.data.billing.quota.limit} 次
              </span>
            ) : (
              <span />
            )}
            <a href="/settings" className="text-brand-600 hover:underline">
              管理套餐
            </a>
          </div>
          {mutation.data.titles.length === 0 && (
            <p className="text-sm text-zinc-400">未产出合规标题，请调整卖点重试。</p>
          )}
          {mutation.data.titles.map((title, index) => {
            const active = selectedTitle === title;
            const platformLabel =
              PLATFORMS.find((item) => item.value === platform)?.label ?? platform;
            return (
              <div
                key={title}
                className="flex items-center justify-between gap-3 rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2"
              >
                <span className="text-sm text-zinc-700">{title}</span>
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => copy(title, index)}
                    className="rounded-md px-2 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-100"
                  >
                    {copied === index ? '已复制' : '复制'}
                  </button>
                  <button
                    onClick={() => onSelectTitle?.(title, platformLabel)}
                    className={`rounded-md px-2 py-1 text-xs font-medium transition ${
                      active
                        ? 'bg-green-600 text-white'
                        : 'bg-brand-50 text-brand-600 hover:bg-brand-100'
                    }`}
                  >
                    {active ? '已用于铺货' : '用于铺货'}
                  </button>
                </span>
              </div>
            );
          })}

          {mutation.data.rejected.length > 0 && (
            <details className="pt-1 text-xs text-zinc-400">
              <summary className="cursor-pointer">
                被过滤 {mutation.data.rejected.length} 条（合规/长度）
              </summary>
              <ul className="mt-1 space-y-1">
                {mutation.data.rejected.map((r, i) => (
                  <li key={i}>
                    <span className="line-through">{r.title}</span> — {r.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
