'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, getPreviewPlan, setPreviewPlan } from '@/lib/api';
import { ShopsSection } from '@/components/shops-section';
import { MediaReadinessSection } from '@/components/media-readiness-section';
import { isDemoAuthMode } from '@/lib/supabase';

const FEATURE_LABELS: Record<string, string> = {
  'product.browse': '浏览今日推荐',
  'product.detail': '商品详情与打分',
  'ai.title': 'AI 标题生成',
  'publish.single': '单店铺铺货',
  'shops.connect': '连接店铺',
  'ai.detail': 'AI 详情页优化',
  'ai.image.watermark': '主图去水印',
  'ai.image.relight': '主图重打光',
  'ai.image.compose': '主图换背景',
  'ai.customer_service': 'AI 客服',
  'ai.pricing': '智能定价',
  'publish.batch': '批量铺货',
  'analytics.dashboard': '经营数据看板',
  'crawler.custom': '自定义采集',
};

const PROVIDERS = [
  { value: 'deepseek', label: 'DeepSeek（性价比高）' },
  { value: 'dashscope', label: '通义千问 Qwen' },
  { value: 'openai', label: 'OpenAI GPT' },
  { value: 'anthropic', label: 'Anthropic Claude' },
];

const PREVIEW_PLANS = [
  { v: '', l: '真实套餐' },
  { v: 'free', l: '免费版' },
  { v: 'basic', l: '基础版' },
  { v: 'pro', l: '专业版' },
  { v: 'flagship', l: '旗舰版' },
  { v: 'enterprise', l: '企业版' },
];

function priceLabel(price: number): string {
  if (price === 0) return '免费';
  if (price < 0) return '定制';
  return `¥${price}/月`;
}

export default function SettingsPage() {
  const qc = useQueryClient();
  const ent = useQuery({ queryKey: ['entitlements'], queryFn: () => api.entitlements() });
  const key = useQuery({ queryKey: ['llmKey'], queryFn: () => api.getLlmKey() });

  const [preview, setPreview] = useState<string>(getPreviewPlan() ?? '');
  const [provider, setProvider] = useState('deepseek');
  const [apiKey, setApiKey] = useState('');
  const [label, setLabel] = useState('');

  const saveKey = useMutation({
    mutationFn: () => api.saveLlmKey({ provider, apiKey, label: label || undefined }),
    onSuccess: () => {
      setApiKey('');
      setLabel('');
      qc.invalidateQueries({ queryKey: ['llmKey'] });
      qc.invalidateQueries({ queryKey: ['entitlements'] });
    },
  });

  const delKey = useMutation({
    mutationFn: () => api.deleteLlmKey(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['llmKey'] }),
  });

  const applyPreview = (v: string) => {
    setPreview(v);
    setPreviewPlan(v || null);
    qc.invalidateQueries({ queryKey: ['entitlements'] });
  };

  const usage = ent.data?.aiUsage;
  const unlimited = usage?.limit === -1;
  const pct =
    usage && usage.limit > 0 ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="mb-1 text-2xl font-bold">设置 / 套餐</h1>
      <p className="mb-6 text-sm text-zinc-500">管理你的套餐、AI 额度与自有 API Key。</p>

      {isDemoAuthMode ? (
        <div className="mb-6 flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-3 text-sm">
          <span className="text-zinc-500">🧪 演示预览：</span>
          {PREVIEW_PLANS.map((p) => (
            <button
              key={p.v}
              onClick={() => applyPreview(p.v)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                preview === p.v
                  ? 'bg-zinc-800 text-white'
                  : 'bg-white text-zinc-600 hover:bg-zinc-100'
              }`}
            >
              {p.l}
            </button>
          ))}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 当前套餐 + 用量 */}
        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-semibold">当前套餐</h2>
            {ent.data && (
              <span className="rounded-full bg-brand-50 px-3 py-1 text-sm font-semibold text-brand-700">
                {ent.data.planName}
              </span>
            )}
          </div>

          {ent.isLoading && <p className="text-sm text-zinc-400">加载中…</p>}
          {ent.isError ? (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
              套餐与额度读取失败：{ent.error.message}。在恢复可靠计量前，平台 AI
              与新铺货会安全阻断；自有 API Key 调用不受平台额度限制。
            </p>
          ) : null}
          {ent.data && usage && (
            <>
              <div className="mb-2 flex items-baseline justify-between text-sm">
                <span className="text-zinc-500">本月 AI 额度（平台调用）</span>
                <span className="font-medium">
                  {unlimited ? '无限' : `${usage.used} / ${usage.limit} 次`}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100">
                <div
                  className={`h-full rounded-full transition-all ${
                    pct >= 100 ? 'bg-red-500' : 'bg-brand-500'
                  }`}
                  style={{ width: unlimited ? '8%' : `${pct}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-zinc-400">
                {unlimited
                  ? '企业版不限额度'
                  : usage.exceeded
                    ? '额度已用完，升级套餐或配置自有 Key 以继续'
                    : `剩余 ${usage.remaining} 次；配置自有 Key 可不限额度`}
              </p>

              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg bg-zinc-50 p-3">
                  <div className="text-zinc-400">可连接店铺</div>
                  <div className="font-medium">
                    {ent.data.quotas.shopsMax === -1 ? '无限' : `${ent.data.quotas.shopsMax} 个`}
                  </div>
                </div>
                <div className="rounded-lg bg-zinc-50 p-3">
                  <div className="text-zinc-400">每月铺货上限</div>
                  <div className="font-medium">
                    {ent.data.quotas.publishMonthly === -1
                      ? '无限'
                      : `${ent.data.quotas.publishMonthly} 件`}
                  </div>
                </div>
              </div>
            </>
          )}
        </section>

        {/* BYOK 密钥 */}
        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="mb-1 text-base font-semibold">自有 API Key（BYOK）</h2>
          <p className="mb-4 text-xs text-zinc-500">
            配置后 AI 调用走你自己的账户、
            <span className="font-medium text-zinc-700">不计入平台额度</span>
            ，成本由你的模型账户承担。
          </p>

          {key.isError ? (
            <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
              密钥状态读取失败：{key.error.message}
              。系统不会把读取故障当成“未配置”，也不会因此改走平台额度。
            </p>
          ) : null}

          {key.data?.configured ? (
            <div
              className={`mb-4 flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${
                key.data.usable === false
                  ? 'border-red-200 bg-red-50'
                  : 'border-green-200 bg-green-50'
              }`}
            >
              <div>
                <span
                  className={`font-medium ${key.data.usable === false ? 'text-red-800' : 'text-green-800'}`}
                >
                  {key.data.usable === false ? '已配置但不可用，请重新保存' : '已配置'}
                </span>
                <span
                  className={`ml-2 ${key.data.usable === false ? 'text-red-700' : 'text-green-700'}`}
                >
                  {key.data.provider} · {key.data.masked}
                </span>
              </div>
              <button
                onClick={() => delKey.mutate()}
                disabled={delKey.isPending}
                className="rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                删除
              </button>
            </div>
          ) : key.isError ? null : (
            <p className="mb-4 rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-500">
              尚未配置，当前使用平台额度。
            </p>
          )}

          <div className="space-y-3">
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 p-2.5 text-sm outline-none focus:border-brand-500"
            >
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="粘贴你的 API Key（sk-...）"
              className="w-full rounded-lg border border-zinc-200 p-2.5 text-sm outline-none focus:border-brand-500"
            />
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="备注（可选）"
              className="w-full rounded-lg border border-zinc-200 p-2.5 text-sm outline-none focus:border-brand-500"
            />
            <button
              onClick={() => saveKey.mutate()}
              disabled={saveKey.isPending || apiKey.length < 8}
              className="w-full rounded-xl bg-brand-500 py-2.5 text-sm font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
            >
              {saveKey.isPending ? '保存中…' : '保存密钥'}
            </button>
            {saveKey.isError && (
              <p className="text-sm text-red-600">
                保存失败：{(saveKey.error as ApiError).message}
              </p>
            )}
            {saveKey.isSuccess && <p className="text-sm text-green-600">已保存并加密存储。</p>}
            {delKey.isError && (
              <p className="text-sm text-red-600">
                删除失败：{(delKey.error as ApiError).message}。原密钥仍保留，请重试。
              </p>
            )}
          </div>
        </section>
      </div>

      {/* 店铺管理 */}
      <ShopsSection />

      {/* AI 图片服务准备度 */}
      <MediaReadinessSection />

      {/* 套餐对比 */}
      <section className="mt-8">
        <h2 className="mb-4 text-base font-semibold">套餐对比</h2>
        <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-5">
          {ent.data?.plans.map((p) => {
            const current = p.id === ent.data!.plan;
            return (
              <div
                key={p.id}
                className={`flex flex-col rounded-2xl border p-5 ${
                  current ? 'border-brand-500 bg-brand-50/40' : 'border-zinc-200 bg-white'
                }`}
              >
                <div className="mb-1 flex items-center justify-between">
                  <h3 className="font-semibold">{p.name}</h3>
                  {current && (
                    <span className="rounded-full bg-brand-500 px-2 py-0.5 text-[10px] font-medium text-white">
                      当前
                    </span>
                  )}
                </div>
                <div className="mb-1 text-xl font-bold">{priceLabel(p.priceCnyMonthly)}</div>
                <p className="mb-3 text-xs text-zinc-500">{p.highlight}</p>
                <ul className="mb-4 flex-1 space-y-1.5 text-xs text-zinc-600">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-1.5">
                      <span className="mt-0.5 text-green-500">✓</span>
                      {FEATURE_LABELS[f] ?? f}
                    </li>
                  ))}
                </ul>
                <button
                  disabled={current}
                  onClick={() => alert('支付接入开发中，敬请期待')}
                  className={`rounded-xl py-2 text-sm font-medium transition ${
                    current
                      ? 'cursor-default bg-zinc-100 text-zinc-400'
                      : 'bg-zinc-900 text-white hover:bg-zinc-700'
                  }`}
                >
                  {current ? '使用中' : p.priceCnyMonthly < 0 ? '联系我们' : '升级'}
                </button>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}
