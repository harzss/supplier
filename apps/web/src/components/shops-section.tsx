'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';
import { isDemoAuthMode } from '@/lib/environment';

const CONNECTABLE = [
  { value: 'douyin', label: '抖音小店' },
  { value: 'taobao', label: '淘宝' },
  { value: 'pdd', label: '拼多多' },
  { value: 'kuaishou', label: '快手小店' },
];

interface OAuthFeedback {
  type: 'success' | 'error';
  message: string;
}

/** 店铺管理：销售店铺与 1688 买家 OAuth + 演示店铺。 */
export function ShopsSection() {
  const qc = useQueryClient();
  const [feedback, setFeedback] = useState<OAuthFeedback | null>(null);
  const shops = useQuery({ queryKey: ['shops'], queryFn: () => api.shops() });
  const readiness = useQuery({
    queryKey: ['douyinReadiness'],
    queryFn: () => api.douyinReadiness(),
  });
  const alibaba1688Readiness = useQuery({
    queryKey: ['alibaba1688Readiness'],
    queryFn: () => api.alibaba1688Readiness(),
  });
  const connect = useMutation({
    mutationFn: (platform: string) => api.connectShop({ platform }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shops'] });
      qc.invalidateQueries({ queryKey: ['entitlements'] });
    },
  });
  const authorize = useMutation({
    mutationFn: (platform: 'douyin' | 'alibaba_1688') =>
      platform === 'douyin' ? api.authorizeDouyin() : api.authorizeAlibaba1688(),
    onSuccess: ({ authorizationUrl }) => window.location.assign(authorizationUrl),
  });
  const disconnect = useMutation({
    mutationFn: (shopId: string) => api.disconnectShop(shopId),
    onSuccess: (shop) => {
      setFeedback({
        type: 'success',
        message: `已在本系统停用「${shop.shopName || shop.platformLabel}」并清除本地授权凭证；历史数据继续保留。`,
      });
      return Promise.all([
        qc.invalidateQueries({ queryKey: ['shops'] }),
        qc.invalidateQueries({ queryKey: ['entitlements'] }),
        qc.invalidateQueries({ queryKey: ['douyinReadiness'] }),
        qc.invalidateQueries({ queryKey: ['alibaba1688Readiness'] }),
      ]);
    },
  });
  const syncOrders = useMutation({
    mutationFn: (shopId: string) => api.syncOrders(shopId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shops'] });
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['analytics'] });
    },
  });

  useEffect(() => {
    const url = new URL(window.location.href);
    const oauthPlatform = url.searchParams.get('oauth');
    if (oauthPlatform !== 'douyin' && oauthPlatform !== 'alibaba_1688') return;
    const platformLabel = oauthPlatform === 'douyin' ? '抖店' : '1688 买家账号';

    const result = url.searchParams.get('result');
    if (result === 'success') {
      const shopName = url.searchParams.get('shopName');
      setFeedback({
        type: 'success',
        message: shopName
          ? `${platformLabel}「${shopName}」授权成功。`
          : `${platformLabel}授权成功。`,
      });
      void qc.invalidateQueries({ queryKey: ['shops'] });
      void qc.invalidateQueries({ queryKey: ['entitlements'] });
      void qc.invalidateQueries({ queryKey: ['douyinReadiness'] });
      void qc.invalidateQueries({ queryKey: ['alibaba1688Readiness'] });
    } else {
      setFeedback({
        type: 'error',
        message: url.searchParams.get('message') || `${platformLabel}授权失败，请重试。`,
      });
    }

    ['oauth', 'result', 'shopId', 'shopName', 'message'].forEach((key) =>
      url.searchParams.delete(key),
    );
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }, [qc]);

  return (
    <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <h2 className="text-base font-semibold">店铺管理</h2>
            <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-white">
              OPENAPI
            </span>
          </div>
          <p className="text-xs text-zinc-500">授权真实店铺后，可直接铺货、同步订单并回传物流。</p>
        </div>
      </div>

      {feedback ? (
        <div
          className={`mb-4 rounded-xl border px-4 py-3 text-sm ${
            feedback.type === 'success'
              ? 'border-green-200 bg-green-50 text-green-700'
              : 'border-red-200 bg-red-50 text-red-700'
          }`}
        >
          {feedback.message}
        </div>
      ) : null}

      <div className="mb-5 grid gap-3 lg:grid-cols-2">
        <div className="flex flex-col gap-4 rounded-2xl border border-zinc-900 bg-zinc-950 p-5 text-white sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-sm font-black text-zinc-950">
              抖店
            </div>
            <div>
              <div className="font-semibold">授权抖音小店</div>
              <p className="mt-1 max-w-xl text-xs leading-5 text-zinc-400">
                用于铺货、同步订单与回传物流；Token 加密保存。
              </p>
            </div>
          </div>
          <button
            onClick={() => authorize.mutate('douyin')}
            disabled={authorize.isPending}
            className="shrink-0 rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:cursor-wait disabled:opacity-60"
          >
            {authorize.isPending && authorize.variables === 'douyin'
              ? '正在准备授权…'
              : '前往官方授权'}
          </button>
        </div>

        <div className="flex flex-col gap-4 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-zinc-900 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500 text-xs font-black text-white">
              1688
            </div>
            <div>
              <div className="font-semibold">授权 1688 买家账号</div>
              <p className="mt-1 max-w-xl text-xs leading-5 text-amber-800/80">
                仅作为采购方，用于创建采购单、查订单与物流。
              </p>
            </div>
          </div>
          <button
            onClick={() => authorize.mutate('alibaba_1688')}
            disabled={authorize.isPending}
            className="shrink-0 rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-60"
          >
            {authorize.isPending && authorize.variables === 'alibaba_1688'
              ? '正在准备授权…'
              : '前往官方授权'}
          </button>
        </div>
      </div>

      {authorize.isError ? (
        <p className="mb-4 text-sm text-red-600">
          无法发起授权：{(authorize.error as ApiError).message}
        </p>
      ) : null}

      <div className="mb-5 grid gap-3 xl:grid-cols-2">
        <ReadinessPanel
          title="抖店联调准备度"
          readyText="已具备测试店铺端到端联调条件"
          pendingText="补齐未通过项后即可开始真实发布"
          data={readiness.data}
          error={readiness.isError}
        />
        <ReadinessPanel
          title="1688 采购准备度"
          readyText="已具备真实采购联调条件"
          pendingText="未通过项会持续阻断真实下单"
          data={alibaba1688Readiness.data}
          error={alibaba1688Readiness.isError}
        />
      </div>

      {shops.data && shops.data.length > 0 ? (
        <ul className="mb-4 space-y-2">
          {shops.data.map((s) => (
            <li
              key={s.id}
              className="flex flex-col gap-2 rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium">{s.shopName || '未命名店铺'}</span>
                  <span className="text-xs text-zinc-400">
                    {s.platformLabel} · {s.platformShopId}
                    {s.role === 'buyer' ? ' · 采购账号' : ''}
                  </span>
                </div>
                <p className="mt-1 text-xs text-zinc-400">
                  {s.status === 'revoked'
                    ? '本系统已清除授权凭证；如需恢复请重新授权'
                    : s.connectionType === 'demo'
                      ? '演示数据，不调用平台接口'
                      : s.tokenExpiresAt
                        ? `Token 到期：${new Date(s.tokenExpiresAt).toLocaleString('zh-CN')}`
                        : 'OAuth 授权店铺'}
                </p>
                {s.connectionType === 'oauth' && s.platform === 'douyin' ? (
                  <p
                    className={`mt-1 break-words text-xs ${s.orderSyncError ? 'text-red-600' : 'text-zinc-400'}`}
                  >
                    {s.orderSyncError
                      ? `订单同步失败：${s.orderSyncError}`
                      : s.lastOrderSyncAt
                        ? `订单上次同步：${new Date(s.lastOrderSyncAt).toLocaleString('zh-CN')}`
                        : '订单尚未同步'}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2 self-end sm:ml-3 sm:self-auto">
                <span className={statusClass(s.status, s.connectionType)}>
                  {statusLabel(s.status, s.connectionType)}
                </span>
                {s.connectionType === 'oauth' &&
                s.platform === 'douyin' &&
                s.role === 'seller' &&
                s.status === 'active' ? (
                  <button
                    onClick={() => syncOrders.mutate(s.id)}
                    disabled={syncOrders.isPending}
                    className="text-xs font-medium text-zinc-700 hover:text-zinc-950 disabled:opacity-50"
                  >
                    {syncOrders.isPending && syncOrders.variables === s.id ? '同步中…' : '同步订单'}
                  </button>
                ) : null}
                {s.connectionType === 'oauth' && isOAuthPlatform(s.platform) ? (
                  <button
                    onClick={() => {
                      if (isOAuthPlatform(s.platform)) authorize.mutate(s.platform);
                    }}
                    disabled={authorize.isPending}
                    className="text-xs font-medium text-brand-600 hover:text-brand-500 disabled:opacity-50"
                  >
                    重新授权
                  </button>
                ) : null}
                {s.connectionType === 'oauth' && s.status !== 'revoked' ? (
                  <button
                    onClick={() => {
                      const confirmed = window.confirm(
                        `确认在本系统停用「${s.shopName || s.platformLabel}」？本地 Token 会被清除，历史订单和铺货记录会保留；如需撤销平台侧授权，请同时前往平台后台操作。`,
                      );
                      if (confirmed) disconnect.mutate(s.id);
                    }}
                    disabled={disconnect.isPending}
                    className="text-xs font-medium text-red-600 hover:text-red-500 disabled:opacity-50"
                  >
                    {disconnect.isPending && disconnect.variables === s.id ? '停用中…' : '停用授权'}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-4 rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-500">尚未连接店铺。</p>
      )}

      {syncOrders.isSuccess ? (
        <p className="mb-4 text-sm text-green-600">
          订单同步完成：写入 {syncOrders.data.synced} 单，跳过 {syncOrders.data.skipped} 单。
        </p>
      ) : null}
      {syncOrders.isError ? (
        <p className="mb-4 text-sm text-red-600">
          订单同步失败：{(syncOrders.error as ApiError).message}
        </p>
      ) : null}
      {disconnect.isError ? (
        <p className="mb-4 text-sm text-red-600">
          停用授权失败：{(disconnect.error as ApiError).message}
        </p>
      ) : null}

      {isDemoAuthMode ? (
        <>
          <div className="mb-2 mt-5 flex items-center gap-3 text-xs text-zinc-400">
            <span className="h-px flex-1 bg-zinc-100" />
            <span>仅用于体验流程的演示店铺</span>
            <span className="h-px flex-1 bg-zinc-100" />
          </div>
          <div className="flex flex-wrap gap-2">
            {CONNECTABLE.map((p) => (
              <button
                key={p.value}
                onClick={() => connect.mutate(p.value)}
                disabled={connect.isPending}
                className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:border-brand-500 hover:text-brand-600 disabled:opacity-50"
              >
                + 添加{p.label}演示店
              </button>
            ))}
          </div>
          {connect.isError ? (
            <p className="mt-2 text-sm text-red-600">{(connect.error as ApiError).message}</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

interface ReadinessData {
  ready: boolean;
  readyCount: number;
  totalCount: number;
  checks: Array<{ id: string; label: string; ready: boolean; detail: string }>;
}

function ReadinessPanel({
  title,
  readyText,
  pendingText,
  data,
  error,
}: {
  title: string;
  readyText: string;
  pendingText: string;
  data: ReadinessData | undefined;
  error: boolean;
}) {
  if (error) {
    return (
      <p className="rounded-xl bg-red-50 p-4 text-sm text-red-600">准备度读取失败，请稍后重试。</p>
    );
  }
  if (!data) return <div className="h-24 animate-pulse rounded-xl bg-zinc-100" />;

  return (
    <div
      className={`rounded-xl border p-4 ${
        data.ready ? 'border-green-200 bg-green-50/70' : 'border-amber-200 bg-amber-50/60'
      }`}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-zinc-800">{title}</div>
          <p className="mt-0.5 text-xs text-zinc-500">{data.ready ? readyText : pendingText}</p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
            data.ready ? 'bg-green-600 text-white' : 'bg-amber-200 text-amber-900'
          }`}
        >
          {data.readyCount}/{data.totalCount}
        </span>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {data.checks.map((check) => (
          <li key={check.id} className="flex items-start gap-2 rounded-lg bg-white/80 px-3 py-2">
            <span
              aria-hidden="true"
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                check.ready ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
              }`}
            >
              {check.ready ? '✓' : '!'}
            </span>
            <div className="min-w-0">
              <div className="text-xs font-medium text-zinc-700">{check.label}</div>
              <p className="mt-0.5 break-words text-[11px] leading-4 text-zinc-500">
                {check.detail}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function statusLabel(status: string, connectionType: 'demo' | 'oauth'): string {
  if (connectionType === 'demo') return '演示';
  if (status === 'active') return '授权有效';
  if (status === 'expired') return '授权已过期';
  if (status === 'revoked') return '授权已撤销';
  return status;
}

function isOAuthPlatform(value: string): value is 'douyin' | 'alibaba_1688' {
  return value === 'douyin' || value === 'alibaba_1688';
}

function statusClass(status: string, connectionType: 'demo' | 'oauth'): string {
  const color =
    connectionType === 'demo'
      ? 'bg-zinc-200 text-zinc-600'
      : status === 'active'
        ? 'bg-green-50 text-green-700'
        : 'bg-red-50 text-red-700';
  return `rounded-full px-2 py-0.5 text-xs ${color}`;
}
