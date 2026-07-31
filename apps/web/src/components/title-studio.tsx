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
    <div className="ledger-panel overflow-hidden">
      <div className="ledger-section-heading">
        <div>
          <p className="page-kicker">AI 内容</p>
          <h2 className="mt-2">AI 标题工作台</h2>
          <p>选择渠道并补充商品卖点，生成可直接用于铺货的标题。</p>
        </div>
        {mutation.data ? (
          <span className="font-mono text-[10px] text-[var(--muted)]">{mutation.data.model}</span>
        ) : null}
      </div>

      <div className="p-5 sm:p-6">
        {/* 平台选择 */}
        <fieldset className="mb-4">
          <legend className="mb-2 text-xs font-bold text-[var(--ink-soft)]">目标平台</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {PLATFORMS.map((p) => (
              <button
                key={p.value}
                type="button"
                aria-pressed={platform === p.value}
                onClick={() => setPlatform(p.value)}
                className={`min-h-10 rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                  platform === p.value
                    ? 'border-brand-200 bg-brand-50 text-brand-700'
                    : 'border-[var(--line)] bg-[var(--surface-strong)] text-[var(--muted)] hover:border-brand-300 hover:text-[var(--ink)]'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </fieldset>

        {/* 卖点输入 */}
        <label className="field-label mb-4" htmlFor="selling-points">
          商品卖点（可选）
          <textarea
            id="selling-points"
            value={sellingPointsText}
            onChange={(e) => setSellingPointsText(e.target.value)}
            placeholder="例如：100%纯棉，透气吸汗，显瘦"
            rows={3}
            className="field-control resize-none"
          />
          <span className="font-normal text-[var(--muted)]">
            使用逗号、分号或换行分隔多个卖点。
          </span>
        </label>

        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
          className="primary-button w-full gap-2"
        >
          {mutation.isPending ? null : (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Zm6 11 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14Z" />
            </svg>
          )}
          {mutation.isPending ? '生成中…' : '生成 5 条优化标题'}
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
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-2 text-xs">
              {mutation.data.billing.viaByok ? (
                <span className="inline-flex items-center gap-1.5 text-green-700">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    className="h-4 w-4"
                    aria-hidden="true"
                  >
                    <circle cx="8" cy="15" r="4" />
                    <path d="m11 12 8-8m-3 3 3 3m-6 0 3 3" />
                  </svg>
                  使用自有 API Key（不计平台额度）
                </span>
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
                  className="flex flex-col items-start justify-between gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-3 sm:flex-row sm:items-center"
                >
                  <span className="text-sm text-[var(--ink-soft)]">{title}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => copy(title, index)}
                      className="min-h-11 px-3 text-xs font-bold text-[var(--muted)] hover:bg-white"
                    >
                      {copied === index ? '已复制' : '复制'}
                    </button>
                    <button
                      type="button"
                      onClick={() => onSelectTitle?.(title, platformLabel)}
                      className={`min-h-11 px-3 text-xs font-bold transition ${
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
    </div>
  );
}
