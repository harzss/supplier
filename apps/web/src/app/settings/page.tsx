'use client';

import { useEffect, useState } from 'react';
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
  { v: '', l: '真实' },
  { v: 'free', l: '免费' },
  { v: 'basic', l: '基础' },
  { v: 'pro', l: '专业' },
  { v: 'flagship', l: '旗舰' },
  { v: 'enterprise', l: '企业' },
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

  const [preview, setPreview] = useState('');
  const [provider, setProvider] = useState('deepseek');
  const [apiKey, setApiKey] = useState('');
  const [label, setLabel] = useState('');

  useEffect(() => setPreview(getPreviewPlan() ?? ''), []);

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
      <header className="settings-page-heading mb-7">
        <h1 className="page-title">工作区设置</h1>
        <p className="page-description">
          套餐、AI 路由、店铺授权与发布依赖集中在这里。先确认能力状态，再接入真实业务。
        </p>
      </header>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.06fr)_minmax(360px,0.94fr)]">
        <section className="ledger-panel-dark settings-plan-hero overflow-hidden p-5 sm:p-6">
          <div className="mb-8 flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-[#949baa]">当前套餐</p>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight">
                {ent.data?.planName ?? '当前套餐'}
              </h2>
            </div>
            <span className="rounded-full border border-[#3b3f4b] bg-white/5 px-2.5 py-1 text-[10px] font-semibold text-[#d9dce4]">
              {isDemoAuthMode ? '演示预览' : '已启用'}
            </span>
          </div>

          {ent.isLoading && <p className="text-sm text-[#9aa1af]">正在读取套餐与额度…</p>}
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
                  <p className="text-xs text-[#949baa]">本月平台 AI 调用</p>
                  <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
                    {unlimited ? '∞' : usage.remaining}
                    <span className="ml-2 text-[10px] font-medium text-[#949baa]">
                      {unlimited ? '不限额度' : '剩余次数'}
                    </span>
                  </p>
                </div>
                <span className="text-xs text-[#b4bac5] tabular-nums">
                  {unlimited ? '无限' : `${usage.used} / ${usage.limit} 次`}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#2c303b]">
                <div
                  className={`plan-usage-progress h-full origin-left rounded-full ${
                    pct >= 100 ? 'bg-red-400' : 'bg-[var(--accent)]'
                  }`}
                  style={{ transform: `scaleX(${unlimited ? 0.08 : pct / 100})` }}
                />
              </div>
              <p className="mt-2 text-xs leading-5 text-[#949baa]">
                {unlimited
                  ? '企业版不限额度'
                  : usage.exceeded
                    ? '额度已用完，升级套餐或配置自有 Key 以继续'
                    : `剩余 ${usage.remaining} 次；配置自有 Key 可不限额度`}
              </p>

              <div className="settings-plan-stats mt-6 grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-xl border border-[#30343f] bg-[#1e212a] p-4">
                  <div className="text-xs text-[#8f96a4]">可连接店铺</div>
                  <div className="mt-2 text-xl font-semibold tabular-nums">
                    {ent.data.quotas.shopsMax === -1 ? '无限' : `${ent.data.quotas.shopsMax} 个`}
                  </div>
                </div>
                <div className="rounded-xl border border-[#30343f] bg-[#1e212a] p-4">
                  <div className="text-xs text-[#8f96a4]">每月铺货上限</div>
                  <div className="mt-2 text-xl font-semibold tabular-nums">
                    {ent.data.quotas.publishMonthly === -1
                      ? '无限'
                      : `${ent.data.quotas.publishMonthly} 件`}
                  </div>
                </div>
              </div>
            </>
          )}

          {isDemoAuthMode ? (
            <div className="settings-plan-preview mt-6 border-t border-white/10 pt-5">
              <div>
                <p className="text-xs font-semibold text-[#d9dce4]">演示能力预览</p>
                <p className="mt-1 text-xs text-[#858d9c]">仅改变本地能力，不会产生套餐订单。</p>
              </div>
              <div className="settings-plan-preview-control mt-3 grid grid-cols-3 gap-1 p-1 sm:grid-cols-6">
                {PREVIEW_PLANS.map((p) => (
                  <button
                    key={p.v}
                    type="button"
                    aria-label={`预览${p.l}套餐`}
                    aria-pressed={preview === p.v}
                    onClick={() => applyPreview(p.v)}
                    className={`settings-preview-option min-h-10 min-w-0 rounded-lg px-2 text-xs font-semibold sm:px-3 ${
                      preview === p.v ? 'is-active' : ''
                    }`}
                  >
                    {p.l}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        <section className="ledger-panel settings-key-card overflow-hidden">
          <div className="ledger-section-heading">
            <div>
              <p className="page-kicker">AI 路由</p>
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

            {key.isLoading ? (
              <p
                className="mb-4 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-3 text-sm text-[var(--muted)]"
                role="status"
              >
                正在读取密钥状态…
              </p>
            ) : key.data?.configured ? (
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
                  className="quiet-button danger-quiet-button min-h-11 disabled:opacity-50"
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
                <p className="text-sm text-red-600" role="alert">
                  保存失败：{(saveKey.error as ApiError).message}
                </p>
              )}
              {saveKey.isSuccess && (
                <p className="status-message is-success" role="status">
                  已保存并加密存储。
                </p>
              )}
              {delKey.isError && (
                <p className="text-sm text-red-600" role="alert">
                  删除失败：{(delKey.error as ApiError).message}。原密钥仍保留，请重试。
                </p>
              )}
            </div>
          </div>
        </section>
      </div>

      <ShopsSection />
      <MediaReadinessSection />

      <section className="ledger-panel settings-plan-table mt-8 overflow-hidden">
        <div className="ledger-section-heading">
          <div>
            <p className="page-kicker">套餐能力</p>
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
                  current ? 'bg-brand-50/70' : 'bg-[var(--surface)]'
                }`}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-semibold tracking-tight">{p.name}</h3>
                    {current && (
                      <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold text-brand-700">
                        当前
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-[var(--muted)]">{p.highlight}</p>
                </div>
                <div className="text-lg font-semibold tabular-nums">
                  {priceLabel(p.priceCnyMonthly)}
                </div>
                <ul className="flex flex-wrap gap-1.5 text-xs text-[var(--ink-soft)]">
                  {p.features.map((f) => (
                    <li
                      key={f}
                      className="rounded-full border border-[var(--line)] bg-white/70 px-2.5 py-1"
                    >
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
