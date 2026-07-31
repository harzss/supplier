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
    <main className="app-page app-page-narrow">
      <header className="mb-8 grid gap-6 border-b border-[var(--ink)] pb-8 lg:grid-cols-[minmax(0,1fr)_260px] lg:items-end">
        <div>
          <p className="page-kicker">Workspace controls / 06</p>
          <h1 className="page-title">工作区设置</h1>
          <p className="page-description">
            套餐、AI 路由、店铺授权与发布依赖集中在这里。先确认能力状态，再接入真实业务。
          </p>
        </div>
        <div className="ledger-panel overflow-hidden">
          <div className="border-b border-[var(--line)] px-4 py-3">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--muted)]">
              Active workspace
            </p>
            <p className="mt-1 font-serif text-xl font-semibold">
              {ent.data?.planName ?? (ent.isLoading ? '正在同步…' : '状态待恢复')}
            </p>
          </div>
          <div className="flex items-center gap-2 px-4 py-3 text-xs text-[var(--muted)]">
            <span
              className={`h-2 w-2 rounded-full ${
                ent.isLoading ? 'bg-amber-500' : ent.isError ? 'bg-red-500' : 'bg-emerald-500'
              }`}
            />
            {ent.isLoading ? '能力计量同步中' : ent.isError ? '能力计量暂不可用' : '能力计量已连接'}
          </div>
        </div>
      </header>

      {isDemoAuthMode ? (
        <div className="ledger-panel mb-6 flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--accent-dark)]">
              Sandbox control
            </p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              仅改变本地能力预览，不会产生套餐订单。
            </p>
          </div>
          <div className="grid w-full grid-cols-3 gap-1 border border-[var(--line)] bg-[var(--surface-strong)] p-1 sm:w-auto sm:grid-cols-6">
            {PREVIEW_PLANS.map((p) => (
              <button
                key={p.v}
                type="button"
                aria-pressed={preview === p.v}
                onClick={() => applyPreview(p.v)}
                className={`min-h-11 min-w-0 px-2 text-xs font-bold transition sm:px-3 ${
                  preview === p.v
                    ? 'bg-[var(--ink)] text-white'
                    : 'text-[var(--muted)] hover:bg-white hover:text-[var(--ink)]'
                }`}
              >
                {p.l}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.06fr)_minmax(360px,0.94fr)]">
        <section className="ledger-panel-dark overflow-hidden p-5 sm:p-6">
          <div className="mb-8 flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#9fb0a8]">
                Plan ledger / Current
              </p>
              <h2 className="mt-2 font-serif text-3xl font-semibold">
                {ent.data?.planName ?? '当前套餐'}
              </h2>
            </div>
            <span className="border border-[#68756f] px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.14em] text-[#d9e3de]">
              {isDemoAuthMode ? 'Preview' : 'Active'}
            </span>
          </div>

          {ent.isLoading && <p className="text-sm text-[#a7b1ac]">正在读取套餐与额度…</p>}
          {ent.isError ? (
            <p className="border border-[#8f4a42] bg-[#3e2925] px-4 py-3 text-sm leading-6 text-[#ffd7cf]">
              套餐与额度读取失败：{ent.error.message}。在恢复可靠计量前，平台 AI
              与新铺货会安全阻断；自有 API Key 调用不受平台额度限制。
            </p>
          ) : null}
          {ent.data && usage && (
            <>
              <div className="mb-3 flex items-end justify-between gap-4">
                <div>
                  <p className="text-xs text-[#9eaaa4]">本月平台 AI 调用</p>
                  <p className="mt-1 font-mono text-3xl font-bold tracking-tight">
                    {unlimited ? '∞' : usage.remaining}
                    <span className="ml-2 text-[10px] font-medium uppercase tracking-[0.12em] text-[#9eaaa4]">
                      {unlimited ? 'unlimited' : 'remaining'}
                    </span>
                  </p>
                </div>
                <span className="font-mono text-xs text-[#b4beb9]">
                  {unlimited ? '无限' : `${usage.used} / ${usage.limit} 次`}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden bg-[#33403a]">
                <div
                  className={`h-full transition-[width] duration-300 ${
                    pct >= 100 ? 'bg-red-400' : 'bg-[var(--accent)]'
                  }`}
                  style={{ width: unlimited ? '8%' : `${pct}%` }}
                />
              </div>
              <p className="mt-2 text-xs leading-5 text-[#9eaaa4]">
                {unlimited
                  ? '企业版不限额度'
                  : usage.exceeded
                    ? '额度已用完，升级套餐或配置自有 Key 以继续'
                    : `剩余 ${usage.remaining} 次；配置自有 Key 可不限额度`}
              </p>

              <div className="mt-6 grid grid-cols-2 gap-px border border-[#46534d] bg-[#46534d] text-sm">
                <div className="bg-[#202b27] p-4">
                  <div className="text-xs text-[#89968f]">可连接店铺</div>
                  <div className="mt-2 font-mono text-xl font-bold">
                    {ent.data.quotas.shopsMax === -1 ? '无限' : `${ent.data.quotas.shopsMax} 个`}
                  </div>
                </div>
                <div className="bg-[#202b27] p-4">
                  <div className="text-xs text-[#89968f]">每月铺货上限</div>
                  <div className="mt-2 font-mono text-xl font-bold">
                    {ent.data.quotas.publishMonthly === -1
                      ? '无限'
                      : `${ent.data.quotas.publishMonthly} 件`}
                  </div>
                </div>
              </div>
            </>
          )}
        </section>

        <section className="ledger-panel overflow-hidden">
          <div className="ledger-section-heading">
            <div>
              <p className="page-kicker">AI routing / BYOK</p>
              <h2 className="mt-2">自有模型密钥</h2>
              <p>配置后不计入平台额度，费用由你的模型账户承担。</p>
            </div>
          </div>
          <div className="p-5 sm:p-6">
            {key.isError ? (
              <p className="status-message is-danger mb-4">
                密钥状态读取失败：{key.error.message}
                。系统不会把读取故障当成“未配置”，也不会因此改走平台额度。
              </p>
            ) : null}

            {key.data?.configured ? (
              <div
                className={`mb-4 flex items-center justify-between border-l-4 px-3 py-3 text-sm ${
                  key.data.usable === false
                    ? 'border-red-500 bg-red-50'
                    : 'border-emerald-600 bg-emerald-50'
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
                  className="quiet-button min-h-11 text-red-700 hover:bg-red-100 disabled:opacity-50"
                >
                  删除
                </button>
              </div>
            ) : key.isError ? null : (
              <p className="mb-4 border border-dashed border-[var(--line)] bg-[var(--surface-strong)] px-3 py-3 text-sm text-[var(--muted)]">
                尚未配置，当前使用平台额度。
              </p>
            )}

            <div className="space-y-3">
              <label className="field-label">
                模型服务商
                <select
                  name="provider"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  className="field-control"
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                API Key
                <input
                  name="apiKey"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="例如 sk-..."
                  autoComplete="off"
                  className="field-control"
                />
              </label>
              <label className="field-label">
                备注（可选）
                <input
                  name="label"
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="例如：运营团队 DeepSeek"
                  className="field-control"
                />
              </label>
              <button
                type="button"
                onClick={() => saveKey.mutate()}
                disabled={saveKey.isPending || apiKey.length < 8}
                className="primary-button w-full"
              >
                {saveKey.isPending ? '保存中…' : '保存密钥'}
              </button>
              {saveKey.isError && (
                <p className="text-sm text-red-600">
                  保存失败：{(saveKey.error as ApiError).message}
                </p>
              )}
              {saveKey.isSuccess && <p className="status-message is-success">已保存并加密存储。</p>}
              {delKey.isError && (
                <p className="text-sm text-red-600">
                  删除失败：{(delKey.error as ApiError).message}。原密钥仍保留，请重试。
                </p>
              )}
            </div>
          </div>
        </section>
      </div>

      <ShopsSection />
      <MediaReadinessSection />

      <section className="ledger-panel mt-8 overflow-hidden">
        <div className="ledger-section-heading">
          <div>
            <p className="page-kicker">Plan matrix / Reference</p>
            <h2 className="mt-2">套餐能力对照</h2>
            <p>内部测试阶段仅用于核对权限，不在此页面发起支付。</p>
          </div>
        </div>
        <div className="divide-y divide-[var(--line)]">
          {ent.data?.plans.map((p) => {
            const current = p.id === ent.data!.plan;
            return (
              <article
                key={p.id}
                className={`grid gap-4 p-5 sm:p-6 lg:grid-cols-[150px_130px_minmax(0,1fr)_110px] lg:items-center ${
                  current ? 'bg-[var(--accent-soft)]' : 'bg-[var(--surface)]'
                }`}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-serif text-xl font-semibold">{p.name}</h3>
                    {current && (
                      <span className="bg-[var(--ink)] px-2 py-0.5 font-mono text-[9px] font-bold uppercase text-white">
                        当前
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-[var(--muted)]">{p.highlight}</p>
                </div>
                <div className="font-mono text-lg font-bold">{priceLabel(p.priceCnyMonthly)}</div>
                <ul className="flex flex-wrap gap-1.5 text-xs text-[var(--ink-soft)]">
                  {p.features.map((f) => (
                    <li key={f} className="border border-[var(--line)] bg-white/60 px-2 py-1">
                      {FEATURE_LABELS[f] ?? f}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  disabled={current}
                  onClick={() => alert('支付接入开发中，敬请期待')}
                  className={current ? 'primary-button' : 'secondary-button'}
                >
                  {current ? '使用中' : p.priceCnyMonthly < 0 ? '联系我们' : '升级'}
                </button>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
