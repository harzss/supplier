'use client';

import { useState } from 'react';
import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { ApiError, api, type PricingStrategy } from '@/lib/api';

interface Props {
  sourceProductId: string;
  availability: 'available' | 'out_of_stock' | 'offline' | 'unknown';
  totalStock: number;
  titleOverride?: string;
  titlePlatformLabel?: string;
  onClearTitle?: () => void;
}

/** 一键铺货面板：选店铺 + 加价 + AI 标题 → 发布，展示每店结果 */
export function PublishPanel({
  sourceProductId,
  availability,
  totalStock,
  titleOverride,
  titlePlatformLabel,
  onClearTitle,
}: Props) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [pricingMode, setPricingMode] = useState<PricingStrategy['mode']>('fixed_markup');
  const [markup, setMarkup] = useState(50);
  const [targetMargin, setTargetMargin] = useState(30);
  const [competitorLow, setCompetitorLow] = useState('');
  const [competitorHigh, setCompetitorHigh] = useState('');
  const [estimatedShipping, setEstimatedShipping] = useState(4);
  const [platformFeeRate, setPlatformFeeRate] = useState(5);
  const [rewriteTitle, setRewriteTitle] = useState(true);
  const [rewriteDetail, setRewriteDetail] = useState(false);
  const [removeWatermark, setRemoveWatermark] = useState(false);
  const [relightImages, setRelightImages] = useState(false);
  const [backgroundStyle, setBackgroundStyle] = useState<
    '' | 'white_studio' | 'warm_lifestyle' | 'cool_minimal'
  >('');

  const shops = useQuery({ queryKey: ['shops'], queryFn: () => api.shops(), enabled: open });
  const skuMapping = useQuery({
    queryKey: ['skuMapping', sourceProductId],
    queryFn: () => api.skuMapping(sourceProductId),
    enabled: open,
  });
  const pricingStrategy = buildPricingStrategy({
    pricingMode,
    markup,
    targetMargin,
    competitorLow,
    competitorHigh,
    estimatedShipping,
    platformFeeRate,
  });
  const pricingInputValid =
    estimatedShipping >= 0 &&
    platformFeeRate >= 0 &&
    platformFeeRate < 100 &&
    (pricingMode !== 'profit_target' ||
      (targetMargin > 0 && targetMargin + platformFeeRate < 100)) &&
    (pricingMode !== 'competitor_anchor' ||
      (Number(competitorLow) > 0 && Number(competitorHigh) >= Number(competitorLow)));
  const pricingPreview = useMutation({
    mutationFn: () => api.pricingPreview({ sourceProductId, pricingStrategy }),
  });
  const sellerShops = shops.data?.filter((shop) => shop.role === 'seller') ?? [];
  const skuReady = skuMapping.data?.confirmed === true;
  const selectedRealDouyinShops = sellerShops.filter(
    (shop) =>
      selected.includes(shop.id) && shop.platform === 'douyin' && shop.connectionType === 'oauth',
  );
  const qualificationQueries = useQueries({
    queries: selectedRealDouyinShops.map((shop) => ({
      queryKey: ['categoryQualifications', sourceProductId, shop.id],
      queryFn: () => api.categoryQualifications(sourceProductId, shop.id),
      enabled: open,
    })),
  });
  const qualificationsReady = qualificationQueries.every(
    (query) => query.isSuccess && query.data.confirmed,
  );
  const qualificationsLoading = qualificationQueries.some((query) => query.isLoading);
  const qualificationsError = qualificationQueries.find(
    (query) => query.isError || (query.data && !query.data.confirmed),
  );
  const publish = useMutation({
    mutationFn: () =>
      api.publish({
        sourceProductId,
        targetShopIds: selected,
        pricingStrategy,
        aiOptions: {
          ...(titleOverride ? { titleOverride } : {}),
          rewriteTitle: titleOverride ? false : rewriteTitle,
          rewriteDetail,
          removeWatermark,
          relightImages,
          ...(backgroundStyle ? { backgroundStyle } : {}),
        },
      }),
  });

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const unavailableMessage = sourceUnavailableMessage(availability);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!!unavailableMessage}
        className="primary-button mt-4 w-full"
      >
        {unavailableMessage ?? `一键铺货 · 可售库存 ${totalStock}`}
      </button>
    );
  }

  return (
    <div className="ledger-panel mt-4 p-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold">一键铺货</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="quiet-button min-h-11 text-xs"
        >
          收起
        </button>
      </div>

      {unavailableMessage ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {unavailableMessage}，系统已禁止创建新的铺货任务。
        </div>
      ) : null}

      {shops.isLoading && <p className="text-sm text-zinc-400">加载店铺…</p>}
      {shops.data && sellerShops.length === 0 && (
        <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-700">
          还没有可用于铺货的销售店铺，先去{' '}
          <a href="/settings" className="font-medium underline">
            设置 → 店铺管理
          </a>{' '}
          连接一个。
        </div>
      )}

      {shops.data && sellerShops.length > 0 && (
        <>
          <p className="mb-2 text-xs text-zinc-500">选择目标店铺</p>
          <div className="mb-3 space-y-1.5">
            {sellerShops.map((s) => (
              <label key={s.id} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(s.id)}
                  onChange={() => toggle(s.id)}
                />
                <span className="font-medium">{s.shopName}</span>
                <span className="text-zinc-400">{s.platformLabel}</span>
              </label>
            ))}
          </div>

          <fieldset className="mb-3 rounded-xl border border-zinc-200 p-3">
            <legend className="px-1 text-xs font-medium text-zinc-500">定价策略</legend>
            <div className="space-y-3">
              <select
                value={pricingMode}
                onChange={(event) => {
                  setPricingMode(event.target.value as PricingStrategy['mode']);
                  pricingPreview.reset();
                }}
                className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500"
              >
                <option value="fixed_markup">固定加价</option>
                <option value="profit_target">目标毛利 · 专业版+</option>
                <option value="competitor_anchor">竞品对标 · 专业版+</option>
              </select>

              {pricingMode === 'fixed_markup' ? (
                <NumberField
                  label="加价比例"
                  value={markup}
                  suffix="%"
                  min={0}
                  max={500}
                  onChange={(value) => {
                    setMarkup(value);
                    pricingPreview.reset();
                  }}
                />
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <NumberField
                      label="预估运费"
                      value={estimatedShipping}
                      prefix="¥"
                      min={0}
                      onChange={(value) => {
                        setEstimatedShipping(value);
                        pricingPreview.reset();
                      }}
                    />
                    <NumberField
                      label="平台费率"
                      value={platformFeeRate}
                      suffix="%"
                      min={0}
                      max={50}
                      onChange={(value) => {
                        setPlatformFeeRate(value);
                        pricingPreview.reset();
                      }}
                    />
                  </div>
                  {pricingMode === 'profit_target' ? (
                    <NumberField
                      label="目标毛利率"
                      value={targetMargin}
                      suffix="%"
                      min={1}
                      max={80}
                      onChange={(value) => {
                        setTargetMargin(value);
                        pricingPreview.reset();
                      }}
                    />
                  ) : (
                    <div>
                      <div className="mb-1 text-xs text-zinc-500">竞品售价区间</div>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={0.01}
                          step="0.01"
                          value={competitorLow}
                          placeholder="最低价"
                          onChange={(event) => {
                            setCompetitorLow(event.target.value);
                            pricingPreview.reset();
                          }}
                          className="min-w-0 flex-1 rounded border border-zinc-200 px-2 py-1.5 text-sm outline-none focus:border-brand-500"
                        />
                        <span className="text-zinc-400">—</span>
                        <input
                          type="number"
                          min={0.01}
                          step="0.01"
                          value={competitorHigh}
                          placeholder="最高价"
                          onChange={(event) => {
                            setCompetitorHigh(event.target.value);
                            pricingPreview.reset();
                          }}
                          className="min-w-0 flex-1 rounded border border-zinc-200 px-2 py-1.5 text-sm outline-none focus:border-brand-500"
                        />
                      </div>
                      <p className="mt-1 text-[11px] text-zinc-400">
                        请填写真实平台同款价格，不使用经验值冒充竞品行情。
                      </p>
                    </div>
                  )}
                </>
              )}

              <button
                type="button"
                onClick={() => pricingPreview.mutate()}
                disabled={pricingPreview.isPending || !pricingInputValid}
                className="w-full rounded-lg border border-brand-200 bg-brand-50 py-2 text-xs font-medium text-brand-700 transition hover:bg-brand-100 disabled:opacity-50"
              >
                {pricingPreview.isPending ? '计算中…' : '试算售价与保本价'}
              </button>

              {pricingPreview.isError ? (
                <p className="text-xs text-red-600">{(pricingPreview.error as ApiError).message}</p>
              ) : null}
              {pricingPreview.data ? <PricingQuoteCard quote={pricingPreview.data} /> : null}
            </div>
          </fieldset>

          <fieldset className="mb-3 rounded-xl border border-zinc-200 bg-zinc-50/70 p-3">
            <legend className="px-1 text-xs font-medium text-zinc-500">AI 内容优化</legend>
            {titleOverride ? (
              <div className="mb-3 rounded-lg border border-green-200 bg-green-50 p-2.5 text-xs text-green-800">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">
                      已选{titlePlatformLabel ? ` ${titlePlatformLabel}` : ''}标题
                    </div>
                    <div className="mt-1 leading-5">{titleOverride}</div>
                    <div className="mt-1 text-green-700">提交时会按实际目标店铺再次校验。</div>
                  </div>
                  <button
                    type="button"
                    onClick={onClearTitle}
                    className="shrink-0 rounded px-1.5 py-0.5 text-green-700 hover:bg-green-100"
                  >
                    清除
                  </button>
                </div>
              </div>
            ) : null}
            <div className="space-y-2">
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!titleOverride && rewriteTitle}
                  onChange={(e) => setRewriteTitle(e.target.checked)}
                  disabled={!!titleOverride}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium text-zinc-700">优化标题</span>
                  <span className="ml-1 text-xs text-zinc-400">
                    {titleOverride ? '已使用上方选中的候选标题' : '按目标平台 SEO 改写'}
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={rewriteDetail}
                  onChange={(e) => setRewriteDetail(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium text-zinc-700">生成结构化详情</span>
                  <span className="ml-1 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold text-brand-600">
                    基础版+
                  </span>
                  <span className="ml-1 text-xs text-zinc-400">3 段以上，自动规避夸大词</span>
                </span>
              </label>
              <div className="border-t border-zinc-200 pt-2">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-xs font-medium text-zinc-600">主图处理</span>
                  <span className="rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-600">
                    专业版+
                  </span>
                </div>
                <div className="space-y-2">
                  <label className="flex cursor-pointer items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={removeWatermark}
                      onChange={(e) => setRemoveWatermark(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-medium text-zinc-700">检测并去除水印</span>
                      <span className="ml-1 text-xs text-zinc-400">检测、蒙版与重绘</span>
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={relightImages}
                      onChange={(e) => setRelightImages(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-medium text-zinc-700">优化光线</span>
                      <span className="ml-1 text-xs text-zinc-400">统一商品明暗与质感</span>
                    </span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <span className="text-zinc-500">替换背景</span>
                    <select
                      value={backgroundStyle}
                      onChange={(e) =>
                        setBackgroundStyle(
                          e.target.value as '' | 'white_studio' | 'warm_lifestyle' | 'cool_minimal',
                        )
                      }
                      className="rounded border border-zinc-200 bg-white px-2 py-1 text-xs outline-none focus:border-brand-500"
                    >
                      <option value="">不替换</option>
                      <option value="white_studio">白底棚拍</option>
                      <option value="warm_lifestyle">暖色生活方式</option>
                      <option value="cool_minimal">冷色极简</option>
                    </select>
                  </label>
                </div>
              </div>
            </div>
            <p className="mt-2 text-[11px] leading-4 text-zinc-400">
              文本 AI 配置自有 Key 后不计平台额度；主图处理使用平台额度。
            </p>
          </fieldset>

          <button
            onClick={() => publish.mutate()}
            disabled={
              publish.isPending ||
              selected.length === 0 ||
              !pricingInputValid ||
              !skuReady ||
              !qualificationsReady
            }
            className="w-full rounded-xl bg-brand-500 py-2.5 text-sm font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
          >
            {publish.isPending ? '铺货中…' : `发布到 ${selected.length} 个店铺`}
          </button>
          {skuMapping.isLoading ? (
            <p className="mt-2 text-xs text-zinc-400">正在检查 SKU 映射…</p>
          ) : null}
          {skuMapping.data && !skuMapping.data.confirmed ? (
            <p className="mt-2 text-xs text-amber-600">请先在上方确认抖店 SKU 规格。</p>
          ) : null}
          {qualificationsLoading ? (
            <p className="mt-2 text-xs text-zinc-400">正在检查真实抖店类目资质…</p>
          ) : null}
          {qualificationsError ? (
            <p className="mt-2 text-xs text-amber-600">
              真实抖店的必填类目资质尚未满足，请先在上方补齐并确认。
            </p>
          ) : null}
        </>
      )}

      {publish.isError &&
        (() => {
          const err = publish.error as ApiError;
          const upgrade = err.code === 'QUOTA_EXCEEDED' || err.code === 'FEATURE_LOCKED';
          return (
            <div
              className={`mt-3 rounded-lg p-3 text-sm ${
                upgrade ? 'border border-amber-200 bg-amber-50 text-amber-800' : 'text-red-600'
              }`}
            >
              {err.message}
              {upgrade && (
                <a href="/settings" className="ml-1 font-medium underline">
                  升级套餐 →
                </a>
              )}
            </div>
          );
        })()}

      {publish.data && (
        <div className="mt-4 space-y-2">
          {'queued' in publish.data ? (
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
              铺货任务已进入持久化队列，失败店铺会自动重试。任务 ID：{publish.data.taskId}
            </div>
          ) : (
            <>
              <p className="text-sm font-medium text-green-700">
                铺货完成（{publish.data.status}）· 售价 ¥{publish.data.salePrice}
              </p>
              <p className="text-xs text-zinc-500">优化标题：{publish.data.optimizedTitle}</p>
              {rewriteDetail && (
                <p
                  className={`text-xs ${publish.data.detailOptimized ? 'text-green-600' : 'text-amber-600'}`}
                >
                  {publish.data.detailImageHosted
                    ? '✓ 结构化详情已生成，并已转为托管长图'
                    : publish.data.detailOptimized
                      ? '✓ 结构化详情已保存；图片托管未就绪，发布时保留货源详情图'
                      : '详情生成失败，已保留货源详情图片'}
                </p>
              )}
              {publish.data.mainImageRequested && (
                <p
                  className={`text-xs ${publish.data.mainImageProcessed ? 'text-green-600' : 'text-amber-600'}`}
                >
                  {publish.data.mainImageProcessed
                    ? `✓ ${publish.data.mainImageMessage ?? '主图处理完成'}`
                    : `主图未处理，已保留货源图片：${publish.data.mainImageMessage ?? '处理服务不可用'}`}
                </p>
              )}
              <p className="text-xs text-zinc-500">
                SKU：{publish.data.skuCount} 个
                {publish.data.skuDimensions.length
                  ? ` · ${publish.data.skuDimensions.join(' / ')}`
                  : ' · 默认规格'}
              </p>
              {publish.data.results.map((r) => (
                <div
                  key={r.shopId}
                  className="rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2 text-sm"
                >
                  <span className="font-medium">{r.shopName}</span>
                  {r.platformProductId ? (
                    <span className="ml-2 text-green-600">✓ 商品ID {r.platformProductId}</span>
                  ) : (
                    <span className="ml-2 text-red-600">✗ {r.error}</span>
                  )}
                </div>
              ))}
            </>
          )}
          <a href="/published" className="inline-block text-sm text-brand-600 hover:underline">
            查看我的铺货 →
          </a>
        </div>
      )}
    </div>
  );
}

interface PricingFormValues {
  pricingMode: PricingStrategy['mode'];
  markup: number;
  targetMargin: number;
  competitorLow: string;
  competitorHigh: string;
  estimatedShipping: number;
  platformFeeRate: number;
}

function buildPricingStrategy(values: PricingFormValues): PricingStrategy {
  if (values.pricingMode === 'fixed_markup') {
    return { mode: 'fixed_markup', markupRatio: values.markup / 100 };
  }

  const common = {
    estimatedShipping: values.estimatedShipping,
    platformFeeRate: values.platformFeeRate / 100,
  };
  if (values.pricingMode === 'profit_target') {
    return { mode: 'profit_target', targetMargin: values.targetMargin / 100, ...common };
  }
  return {
    mode: 'competitor_anchor',
    competitorPriceRange: [Number(values.competitorLow), Number(values.competitorHigh)],
    ...common,
  };
}

function sourceUnavailableMessage(availability: Props['availability']): string | null {
  if (availability === 'available') return null;
  if (availability === 'out_of_stock') return '1688 货源已缺货';
  if (availability === 'offline') return '1688 货源已下架';
  return '1688 货源库存不可验证';
}

function NumberField({
  label,
  value,
  prefix,
  suffix,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  prefix?: string;
  suffix?: string;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block text-xs text-zinc-500">
      <span className="mb-1 block">{label}</span>
      <span className="flex items-center gap-1 rounded border border-zinc-200 bg-white px-2 py-1.5">
        {prefix ? <span>{prefix}</span> : null}
        <input
          type="number"
          min={min}
          max={max}
          step="0.01"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="min-w-0 flex-1 bg-transparent text-sm text-zinc-800 outline-none"
        />
        {suffix ? <span>{suffix}</span> : null}
      </span>
    </label>
  );
}

function PricingQuoteCard({ quote }: { quote: Awaited<ReturnType<typeof api.pricingPreview>> }) {
  return (
    <div className="rounded-lg bg-zinc-950 p-3 text-white">
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="text-zinc-400">建议售价</div>
          <div className="text-lg font-semibold">¥{quote.suggestedPrice}</div>
        </div>
        <div>
          <div className="text-zinc-400">保本价</div>
          <div className="text-lg font-semibold">¥{quote.breakEvenPrice}</div>
        </div>
        <div>
          <div className="text-zinc-400">预计单件利润</div>
          <div className={quote.estimatedProfit >= 0 ? 'text-green-300' : 'text-red-300'}>
            ¥{quote.estimatedProfit}
          </div>
        </div>
        <div>
          <div className="text-zinc-400">预计毛利率</div>
          <div>{(quote.estimatedMargin * 100).toFixed(1)}%</div>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-zinc-400">
        采购 ¥{quote.costPrice} + 运费 ¥{quote.estimatedShipping} · 平台费率{' '}
        {(quote.platformFeeRate * 100).toFixed(1)}%
      </p>
      {quote.warning ? <p className="mt-2 text-xs text-amber-300">⚠ {quote.warning}</p> : null}
    </div>
  );
}
