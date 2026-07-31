'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';
import { isDemoAuthMode } from '@/lib/environment';

const STATUS: Record<string, { label: string; cls: string }> = {
  paid: { label: '待代发', cls: 'bg-amber-50 text-amber-600' },
  purchasing: { label: '采购中', cls: 'bg-blue-50 text-blue-600' },
  shipped: { label: '已发货', cls: 'bg-green-50 text-green-600' },
  received: { label: '已收货', cls: 'bg-zinc-100 text-zinc-500' },
  refunded: { label: '已退款', cls: 'bg-red-50 text-red-600' },
  closed: { label: '已关闭', cls: 'bg-zinc-100 text-zinc-500' },
};

const AFTER_SALE_STATUS: Record<string, string> = {
  pending: '售后处理中',
  partial_refund: '部分退款',
  refunded: '全部退款',
  failed: '售后未通过',
};

const ORDER_PAGE_SIZE = 30;

export default function OrdersPage() {
  const qc = useQueryClient();
  const [resolutionNotes, setResolutionNotes] = useState<Record<string, string>>({});
  const [resolutionCosts, setResolutionCosts] = useState<Record<string, string>>({});
  const [editingPurchaseCosts, setEditingPurchaseCosts] = useState<Record<string, boolean>>({});
  const [partialRefundNotes, setPartialRefundNotes] = useState<Record<string, string>>({});
  const [refundAmounts, setRefundAmounts] = useState<Record<string, string>>({});
  const [refundAmountNotes, setRefundAmountNotes] = useState<Record<string, string>>({});
  const [editingRefundAmounts, setEditingRefundAmounts] = useState<Record<string, boolean>>({});
  const [pendingOnly, setPendingOnly] = useState(false);
  const [orderPage, setOrderPage] = useState(1);
  const [orderShopId, setOrderShopId] = useState('');
  const [orderStatus, setOrderStatus] = useState('');
  const [reconciliationPage, setReconciliationPage] = useState(1);
  const shops = useQuery({ queryKey: ['shops'], queryFn: () => api.shops() });
  const orders = useQuery({
    queryKey: ['orders', orderPage, ORDER_PAGE_SIZE, orderShopId, orderStatus],
    queryFn: () =>
      api.orders(orderPage, ORDER_PAGE_SIZE, {
        shopId: orderShopId || undefined,
        status: orderStatus || undefined,
      }),
    enabled: !pendingOnly,
  });
  const reconciliations = useQuery({
    queryKey: ['order-reconciliations', reconciliationPage, ORDER_PAGE_SIZE],
    queryFn: () => api.orderReconciliations(reconciliationPage, ORDER_PAGE_SIZE),
    enabled: pendingOnly,
  });
  const orderTotal = orders.data?.total;
  const reconciliationTotal = reconciliations.data?.total;
  const orderPages = Math.max(1, Math.ceil((orderTotal ?? 0) / ORDER_PAGE_SIZE));
  const reconciliationPages = Math.max(1, Math.ceil((reconciliationTotal ?? 0) / ORDER_PAGE_SIZE));
  const visibleOrders = pendingOnly ? reconciliations.data?.items : orders.data?.items;
  const ordersLoading = pendingOnly ? reconciliations.isLoading : orders.isLoading;
  const ordersError = pendingOnly ? reconciliations.error : orders.error;
  const activeTotal = pendingOnly ? reconciliationTotal : orderTotal;
  const activePage = pendingOnly ? reconciliationPage : orderPage;
  const activePages = pendingOnly ? reconciliationPages : orderPages;
  const activeFetching = pendingOnly ? reconciliations.isFetching : orders.isFetching;
  const orderFiltersActive = orderShopId !== '' || orderStatus !== '';

  useEffect(() => {
    if (pendingOnly || orderTotal === undefined) return;
    const lastPage = Math.max(1, Math.ceil(orderTotal / ORDER_PAGE_SIZE));
    setOrderPage((current) => Math.min(current, lastPage));
  }, [pendingOnly, orderTotal]);

  useEffect(() => {
    if (!pendingOnly || reconciliationTotal === undefined) return;
    const lastPage = Math.max(1, Math.ceil(reconciliationTotal / ORDER_PAGE_SIZE));
    setReconciliationPage((current) => Math.min(current, lastPage));
  }, [pendingOnly, reconciliationTotal]);

  const invalidateOrderData = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['orders'] }),
      qc.invalidateQueries({ queryKey: ['order-reconciliations'] }),
      qc.invalidateQueries({ queryKey: ['analytics'] }),
    ]);
  const fulfill = useMutation({
    mutationFn: (id: string) => api.fulfillOrder(id),
    onSuccess: invalidateOrderData,
  });
  const resolveException = useMutation({
    mutationFn: ({
      orderId,
      purchaseOrderId,
      actualCost,
      expectedRevision,
      retry,
      note,
    }: {
      orderId: string;
      purchaseOrderId: string;
      actualCost: number;
      expectedRevision: number;
      retry: boolean;
      note: string;
    }) =>
      retry
        ? api.retryFailedPurchase(orderId, purchaseOrderId, actualCost, expectedRevision, note)
        : api.resolvePurchaseException(
            orderId,
            purchaseOrderId,
            actualCost,
            expectedRevision,
            note,
          ),
    onSuccess: (_order, variables) => {
      setEditingPurchaseCosts((current) => ({
        ...current,
        [variables.purchaseOrderId]: false,
      }));
      return invalidateOrderData();
    },
  });
  const resumePurchaseLogistics = useMutation({
    mutationFn: ({
      orderId,
      purchaseOrderId,
      expectedRevision,
      note,
    }: {
      orderId: string;
      purchaseOrderId: string;
      expectedRevision: number;
      note: string;
    }) => api.resumePurchaseLogistics(orderId, purchaseOrderId, expectedRevision, note),
    onSuccess: invalidateOrderData,
  });
  const repairSettledLogistics = useMutation({
    mutationFn: ({
      orderId,
      purchaseOrderId,
      actualCost,
      expectedRevision,
      note,
    }: {
      orderId: string;
      purchaseOrderId: string;
      actualCost: number;
      expectedRevision: number;
      note: string;
    }) => api.repairSettledLogistics(orderId, purchaseOrderId, actualCost, expectedRevision, note),
    onSuccess: invalidateOrderData,
  });
  const resolvePartialRefund = useMutation({
    mutationFn: ({
      orderId,
      action,
      note,
    }: {
      orderId: string;
      action: 'continue_remaining' | 'stop_all';
      note: string;
    }) => api.resolvePartialRefund(orderId, action, note),
    onSuccess: invalidateOrderData,
  });
  const confirmRefundAmount = useMutation({
    mutationFn: ({ orderId, amount, note }: { orderId: string; amount: number; note: string }) =>
      api.confirmRefundAmount(orderId, amount, note),
    onSuccess: (_order, variables) => {
      setEditingRefundAmounts((current) => ({ ...current, [variables.orderId]: false }));
      return invalidateOrderData();
    },
  });

  return (
    <main className="app-page">
      <header className="mb-8 border-b border-[var(--ink)] pb-7">
        <p className="page-kicker">Fulfillment queue / 03</p>
        <h1 className="page-title">订单履约</h1>
        <p className="page-description">
          销售订单、1688 采购、包裹回传与财务核对集中在一条履约队列中处理。
        </p>
      </header>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={!pendingOnly}
          onClick={() => setPendingOnly(false)}
          className={`min-h-11 border px-4 py-2 text-sm font-bold ${
            pendingOnly ? 'border border-zinc-200 bg-white text-zinc-600' : 'bg-zinc-900 text-white'
          }`}
        >
          全部订单
        </button>
        <button
          type="button"
          aria-pressed={pendingOnly}
          onClick={() => {
            setPendingOnly(true);
            setReconciliationPage(1);
          }}
          className={`min-h-11 border px-4 py-2 text-sm font-bold ${
            pendingOnly
              ? 'bg-orange-600 text-white'
              : 'border border-orange-200 bg-white text-orange-700'
          }`}
        >
          财务待办
          {reconciliationTotal === undefined ? '' : `（${reconciliationTotal}）`}
        </button>
        <span className="text-xs text-zinc-400">集中处理退款金额核对和采购成本核销</span>
      </div>

      {!pendingOnly ? (
        <div className="mb-5 grid gap-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3 sm:grid-cols-2">
          <label className="text-xs font-medium text-zinc-600">
            销售店铺
            <select
              value={orderShopId}
              onChange={(event) => {
                setOrderShopId(event.target.value);
                setOrderPage(1);
              }}
              className="mt-1 block w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-normal text-zinc-700"
            >
              <option value="">全部销售店铺</option>
              {shops.data
                ?.filter((shop) => shop.role === 'seller')
                .map((shop) => (
                  <option key={shop.id} value={shop.id}>
                    {shop.shopName || shop.platformLabel}
                  </option>
                ))}
            </select>
          </label>
          <label className="text-xs font-medium text-zinc-600">
            订单状态
            <select
              value={orderStatus}
              onChange={(event) => {
                setOrderStatus(event.target.value);
                setOrderPage(1);
              }}
              className="mt-1 block w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-normal text-zinc-700"
            >
              <option value="">全部状态</option>
              {Object.entries(STATUS).map(([value, status]) => (
                <option key={value} value={value}>
                  {status.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {ordersLoading ? <p className="text-zinc-400">加载中…</p> : null}
      {ordersError ? (
        <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">
          订单读取失败：{(ordersError as ApiError).message}
        </p>
      ) : null}
      {!ordersLoading && !ordersError && visibleOrders?.length === 0 && !pendingOnly ? (
        <p className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-zinc-400">
          {orderFiltersActive ? (
            '当前筛选条件下没有订单。'
          ) : isDemoAuthMode ? (
            <>
              还没有订单。去{' '}
              <a href="/published" className="text-brand-600">
                我的铺货
              </a>{' '}
              模拟一笔买家订单。
            </>
          ) : (
            '还没有订单。授权销售店铺并完成铺货后，系统会自动同步平台订单。'
          )}
        </p>
      ) : null}
      {!ordersLoading && !ordersError && visibleOrders?.length === 0 && pendingOnly ? (
        <p className="rounded-xl border border-dashed border-green-300 bg-green-50 p-8 text-center text-green-700">
          当前没有财务待办，退款金额和采购成本均已核对。
        </p>
      ) : null}

      <div className="space-y-3">
        {visibleOrders?.map((o) => {
          const st = STATUS[o.status] ?? { label: o.status, cls: 'bg-zinc-100 text-zinc-500' };
          const refundAmountValue = Number(refundAmounts[o.orderId] ?? '');
          const refundAmountValid =
            Number.isFinite(refundAmountValue) &&
            refundAmountValue > 0 &&
            refundAmountValue < o.amount &&
            Math.abs(refundAmountValue * 100 - Math.round(refundAmountValue * 100)) < 1e-8;
          return (
            <div key={o.orderId} className="rounded-2xl border border-zinc-200 bg-white p-5">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h3 className="line-clamp-1 text-sm font-medium">{o.productTitle}</h3>
                  <p className="mt-1 text-xs text-zinc-400">
                    {o.shopName} · {o.platform} · 订单 {o.platformOrderId}
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    买家 {o.buyerNick} · 收货 {o.receiverName} {o.receiverPhoneMasked}
                  </p>
                  {o.afterSaleStatus !== 'none' && (
                    <p className="mt-1 text-xs text-red-500">
                      {AFTER_SALE_STATUS[o.afterSaleStatus] ?? o.afterSaleStatus}
                      {o.afterSaleSyncedAt
                        ? ` · 更新于 ${new Date(o.afterSaleSyncedAt).toLocaleString('zh-CN')}`
                        : ''}
                    </p>
                  )}
                </div>
                <div className="ml-3 text-right">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${st.cls}`}>{st.label}</span>
                  <div className="mt-1 text-sm font-semibold">¥{o.amount}</div>
                </div>
              </div>

              {o.fulfillmentExceptionStatus !== 'none' && (
                <div
                  className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
                    o.fulfillmentExceptionStatus === 'action_required'
                      ? 'border-red-200 bg-red-50 text-red-700'
                      : o.fulfillmentExceptionStatus === 'resolved'
                        ? 'border-green-200 bg-green-50 text-green-700'
                        : 'border-amber-200 bg-amber-50 text-amber-700'
                  }`}
                >
                  {o.fulfillmentExceptionMessage}
                </div>
              )}

              {o.refundAmountNeedsConfirmation || editingRefundAmounts[o.orderId] ? (
                <div className="mt-3 rounded-lg border border-orange-200 bg-orange-50 px-3 py-3 text-xs text-orange-800">
                  <p className="font-medium">
                    {o.refundAmountConfirmed ? '重新核对累计实际退款金额' : '核对累计实际退款金额'}
                  </p>
                  <p className="mt-1 text-orange-700">
                    {o.refundAmountConfirmed
                      ? '请按抖店后台最新累计退款实付修正；保存后经营看板将使用新净额。'
                      : '平台订单详情只返回退款状态，不返回实际金额。请按抖店后台累计退款实付填写；未核对前，该订单不进入经营看板的 GMV、毛利与排行。'}
                  </p>
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <input
                      type="number"
                      min="0.01"
                      max={Math.max(0.01, o.amount - 0.01)}
                      step="0.01"
                      aria-label="累计实际退款金额"
                      value={refundAmounts[o.orderId] ?? ''}
                      onChange={(event) =>
                        setRefundAmounts((current) => ({
                          ...current,
                          [o.orderId]: event.target.value,
                        }))
                      }
                      placeholder="累计退款金额"
                      className="w-full rounded border border-orange-200 bg-white px-2.5 py-1.5 text-xs text-zinc-700 outline-none focus:border-orange-400 sm:w-36"
                    />
                    <input
                      aria-label="退款金额核对依据"
                      value={refundAmountNotes[o.orderId] ?? ''}
                      onChange={(event) =>
                        setRefundAmountNotes((current) => ({
                          ...current,
                          [o.orderId]: event.target.value,
                        }))
                      }
                      placeholder="填写后台核对依据"
                      className="min-w-0 flex-1 rounded border border-orange-200 bg-white px-2.5 py-1.5 text-xs text-zinc-700 outline-none focus:border-orange-400"
                    />
                    <button
                      onClick={() =>
                        confirmRefundAmount.mutate({
                          orderId: o.orderId,
                          amount: refundAmountValue,
                          note: refundAmountNotes[o.orderId] ?? '',
                        })
                      }
                      disabled={
                        confirmRefundAmount.isPending ||
                        !refundAmountValid ||
                        (refundAmountNotes[o.orderId] ?? '').trim().length < 2
                      }
                      className="shrink-0 rounded bg-orange-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
                    >
                      确认退款金额
                    </button>
                  </div>
                </div>
              ) : null}

              {o.refundAmountConfirmed && !editingRefundAmounts[o.orderId] ? (
                <div className="mt-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p>
                      已核对累计退款 ¥{o.refundAmount?.toFixed(2)}
                      {o.refundAmountConfirmedAt
                        ? ` · ${new Date(o.refundAmountConfirmedAt).toLocaleString('zh-CN')}`
                        : ''}
                      {o.refundAmountNote ? ` · ${o.refundAmountNote}` : ''}
                    </p>
                    <button
                      onClick={() => {
                        setRefundAmounts((current) => ({
                          ...current,
                          [o.orderId]: o.refundAmount?.toFixed(2) ?? '',
                        }));
                        setRefundAmountNotes((current) => ({
                          ...current,
                          [o.orderId]: o.refundAmountNote ?? '',
                        }));
                        setEditingRefundAmounts((current) => ({
                          ...current,
                          [o.orderId]: true,
                        }));
                      }}
                      className="shrink-0 rounded border border-green-300 bg-white px-2.5 py-1 font-medium text-green-700"
                    >
                      重新核对
                    </button>
                  </div>
                </div>
              ) : null}

              {o.afterSaleStatus === 'partial_refund' && o.partialRefundDisposition === 'none' && (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-800">
                  <p className="font-medium">确认部分退款后的剩余商品如何处理</p>
                  <p className="mt-1 text-amber-700">
                    {o.partialRefundCanContinue
                      ? '当前尚未创建远端 1688 采购，可仅对未退款子单继续代发。'
                      : '当前不满足自动继续条件；如采购已创建，请先完成人工取消、退款或拦截。'}
                  </p>
                  <input
                    aria-label="部分退款处置说明"
                    value={partialRefundNotes[o.orderId] ?? ''}
                    onChange={(event) =>
                      setPartialRefundNotes((current) => ({
                        ...current,
                        [o.orderId]: event.target.value,
                      }))
                    }
                    placeholder="填写核对结果和处置说明"
                    className="mt-2 w-full rounded border border-amber-200 bg-white px-2.5 py-1.5 text-xs text-zinc-700 outline-none focus:border-amber-400"
                  />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      onClick={() =>
                        resolvePartialRefund.mutate({
                          orderId: o.orderId,
                          action: 'continue_remaining',
                          note: partialRefundNotes[o.orderId] ?? '',
                        })
                      }
                      disabled={
                        resolvePartialRefund.isPending ||
                        !o.partialRefundCanContinue ||
                        (partialRefundNotes[o.orderId] ?? '').trim().length < 2
                      }
                      className="rounded bg-brand-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
                    >
                      仅履约未退款商品
                    </button>
                    <button
                      onClick={() =>
                        resolvePartialRefund.mutate({
                          orderId: o.orderId,
                          action: 'stop_all',
                          note: partialRefundNotes[o.orderId] ?? '',
                        })
                      }
                      disabled={
                        resolvePartialRefund.isPending ||
                        (partialRefundNotes[o.orderId] ?? '').trim().length < 2
                      }
                      className="rounded border border-amber-300 bg-white px-3 py-1.5 font-medium text-amber-800 disabled:opacity-50"
                    >
                      停止整单自动履约
                    </button>
                  </div>
                </div>
              )}

              {o.afterSaleStatus === 'partial_refund' && o.partialRefundDisposition !== 'none' && (
                <div className="mt-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700">
                  {o.partialRefundDisposition === 'continue_remaining'
                    ? '已确认仅履约未退款商品'
                    : '已确认停止整单自动履约'}
                  {o.partialRefundDispositionAt
                    ? ` · ${new Date(o.partialRefundDispositionAt).toLocaleString('zh-CN')}`
                    : ''}
                  {o.partialRefundDispositionNote ? ` · ${o.partialRefundDispositionNote}` : ''}
                </div>
              )}

              {o.purchases.length > 0 && (
                <div className="mt-3 space-y-2">
                  {o.purchases.map((purchase) => {
                    const costText = resolutionCosts[purchase.purchaseOrderId] ?? '';
                    const actualCost = Number(costText);
                    const actualCostValid =
                      costText.trim() !== '' &&
                      Number.isFinite(actualCost) &&
                      actualCost >= 0 &&
                      actualCost <= 99_999_999.99 &&
                      Math.abs(actualCost * 100 - Math.round(actualCost * 100)) < 1e-8;
                    const editingCost = editingPurchaseCosts[purchase.purchaseOrderId] === true;
                    return (
                      <div
                        key={purchase.purchaseOrderId}
                        className="rounded-lg bg-zinc-50 px-3 py-2"
                      >
                        <div className="text-xs text-zinc-500">
                          1688 采购单 {purchase.orderId1688 ?? purchase.outOrderId} ·{' '}
                          {purchase.status}
                          {purchase.purchaseCost === null
                            ? ''
                            : ` · 原采购成本 ¥${purchase.purchaseCost.toFixed(2)}`}
                          {purchase.priorIncurredCost > 0
                            ? ` · 历史失败成本 ¥${purchase.priorIncurredCost.toFixed(2)}`
                            : ''}
                          {purchase.attemptNo > 1 ? ` · 第 ${purchase.attemptNo} 次采购` : ''}
                          {purchase.status === 'awaiting_payment' &&
                          purchase.exceptionStatus === 'none'
                            ? ' · 请前往 1688 确认并付款'
                            : ''}
                          {(purchase.shipments.length
                            ? purchase.shipments
                            : purchase.trackingNo
                              ? [
                                  {
                                    trackingNo: purchase.trackingNo,
                                    carrier: purchase.carrier,
                                    status: null,
                                  },
                                ]
                              : []
                          ).map((shipment) => (
                            <span key={shipment.trackingNo}>
                              {' '}
                              · {shipment.carrier} {shipment.trackingNo}
                            </span>
                          ))}
                        </div>
                        {purchase.exceptionStatus !== 'none' ? (
                          <div
                            className={`mt-2 rounded border px-2.5 py-2 text-xs ${
                              purchase.costNeedsReconciliation
                                ? 'border-red-200 bg-white text-red-700'
                                : purchase.exceptionStatus === 'resolved'
                                  ? 'border-green-200 bg-white text-green-700'
                                  : 'border-amber-200 bg-white text-amber-700'
                            }`}
                          >
                            <p>{purchase.exceptionReason}</p>
                            {purchase.logisticsRepairEligible ? (
                              <div className="mt-2">
                                <p className="mb-2 text-amber-700">
                                  系统会重新读取 1688
                                  成本和包裹，确认抖店仍是旧快照后逐包更新，并在平台回读一致后替换本地快照。
                                </p>
                                <div className="flex flex-col gap-2 sm:flex-row">
                                  <input
                                    type="number"
                                    min="0"
                                    max="99999999.99"
                                    step="0.01"
                                    aria-label="最终实际采购成本"
                                    value={costText}
                                    onChange={(event) =>
                                      setResolutionCosts((current) => ({
                                        ...current,
                                        [purchase.purchaseOrderId]: event.target.value,
                                      }))
                                    }
                                    placeholder="最终实际成本"
                                    className="w-full rounded border border-amber-200 bg-white px-2.5 py-1.5 text-xs text-zinc-700 outline-none focus:border-amber-400 sm:w-36"
                                  />
                                  <input
                                    aria-label="1688 与抖店物流核对依据"
                                    value={resolutionNotes[purchase.purchaseOrderId] ?? ''}
                                    onChange={(event) =>
                                      setResolutionNotes((current) => ({
                                        ...current,
                                        [purchase.purchaseOrderId]: event.target.value,
                                      }))
                                    }
                                    placeholder="填写 1688 与抖店物流核对依据"
                                    className="min-w-0 flex-1 rounded border border-amber-200 bg-white px-2.5 py-1.5 text-xs text-zinc-700 outline-none focus:border-amber-400"
                                  />
                                  <button
                                    onClick={() =>
                                      repairSettledLogistics.mutate({
                                        orderId: o.orderId,
                                        purchaseOrderId: purchase.purchaseOrderId,
                                        actualCost,
                                        expectedRevision: purchase.exceptionRevision,
                                        note: resolutionNotes[purchase.purchaseOrderId] ?? '',
                                      })
                                    }
                                    disabled={
                                      repairSettledLogistics.isPending ||
                                      !actualCostValid ||
                                      (resolutionNotes[purchase.purchaseOrderId] ?? '').trim()
                                        .length < 2
                                    }
                                    className="shrink-0 rounded bg-amber-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
                                  >
                                    {repairSettledLogistics.isPending
                                      ? '核对并更新中…'
                                      : '核对并更新抖店物流'}
                                  </button>
                                </div>
                              </div>
                            ) : purchase.recoveryEligible ? (
                              <div className="mt-2">
                                <p className="mb-2 text-amber-700">
                                  请先在 1688
                                  核实原物流是否恢复或已替换。确认后系统会归档并清除旧包裹快照；下一次同步仍须通过远端订单、商品和物流完整校验。
                                </p>
                                <div className="flex flex-col gap-2 sm:flex-row">
                                  <input
                                    aria-label="1688 物流处理依据"
                                    value={resolutionNotes[purchase.purchaseOrderId] ?? ''}
                                    onChange={(event) =>
                                      setResolutionNotes((current) => ({
                                        ...current,
                                        [purchase.purchaseOrderId]: event.target.value,
                                      }))
                                    }
                                    placeholder="填写 1688 物流处理依据"
                                    className="min-w-0 flex-1 rounded border border-amber-200 bg-white px-2.5 py-1.5 text-xs text-zinc-700 outline-none focus:border-amber-400"
                                  />
                                  <button
                                    onClick={() =>
                                      resumePurchaseLogistics.mutate({
                                        orderId: o.orderId,
                                        purchaseOrderId: purchase.purchaseOrderId,
                                        expectedRevision: purchase.exceptionRevision,
                                        note: resolutionNotes[purchase.purchaseOrderId] ?? '',
                                      })
                                    }
                                    disabled={
                                      resumePurchaseLogistics.isPending ||
                                      (resolutionNotes[purchase.purchaseOrderId] ?? '').trim()
                                        .length < 2
                                    }
                                    className="shrink-0 rounded bg-amber-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
                                  >
                                    清除旧包裹并重新校验
                                  </button>
                                </div>
                              </div>
                            ) : purchase.costNeedsReconciliation || editingCost ? (
                              <div className="mt-2">
                                <p className="mb-2 text-red-600">
                                  {purchase.retryEligible
                                    ? '填写本次失败尝试的实际成本：未付款取消或全额追回填 0；确认后将归档旧 1688 单并生成新的幂等采购单号。'
                                    : '填写最终实际采购成本：未付款取消或全额追回填 0；部分追回填无法追回货款、退货运费及手续费合计。'}
                                </p>
                                <div className="flex flex-col gap-2 sm:flex-row">
                                  <input
                                    type="number"
                                    min="0"
                                    max="99999999.99"
                                    step="0.01"
                                    aria-label="最终实际采购成本"
                                    value={costText}
                                    onChange={(event) =>
                                      setResolutionCosts((current) => ({
                                        ...current,
                                        [purchase.purchaseOrderId]: event.target.value,
                                      }))
                                    }
                                    placeholder="最终实际成本"
                                    className="w-full rounded border border-red-200 bg-white px-2.5 py-1.5 text-xs text-zinc-700 outline-none focus:border-red-400 sm:w-36"
                                  />
                                  <input
                                    aria-label="1688 取消退款或拦截处理依据"
                                    value={resolutionNotes[purchase.purchaseOrderId] ?? ''}
                                    onChange={(event) =>
                                      setResolutionNotes((current) => ({
                                        ...current,
                                        [purchase.purchaseOrderId]: event.target.value,
                                      }))
                                    }
                                    placeholder="填写 1688 取消、退款或拦截处理依据"
                                    className="min-w-0 flex-1 rounded border border-red-200 bg-white px-2.5 py-1.5 text-xs text-zinc-700 outline-none focus:border-red-400"
                                  />
                                  <button
                                    onClick={() =>
                                      resolveException.mutate({
                                        orderId: o.orderId,
                                        purchaseOrderId: purchase.purchaseOrderId,
                                        actualCost,
                                        expectedRevision: purchase.exceptionRevision,
                                        retry: purchase.retryEligible,
                                        note: resolutionNotes[purchase.purchaseOrderId] ?? '',
                                      })
                                    }
                                    disabled={
                                      resolveException.isPending ||
                                      !actualCostValid ||
                                      (resolutionNotes[purchase.purchaseOrderId] ?? '').trim()
                                        .length < 2
                                    }
                                    className="shrink-0 rounded bg-red-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
                                  >
                                    {purchase.retryEligible
                                      ? '核销本次成本并重新采购'
                                      : '确认成本核销'}
                                  </button>
                                </div>
                              </div>
                            ) : null}
                            {purchase.costReconciled && !editingCost ? (
                              <div className="mt-2 flex flex-col gap-2 text-green-600 sm:flex-row sm:items-center sm:justify-between">
                                <p>
                                  最终实际采购成本 ¥{purchase.reconciledCost?.toFixed(2) ?? '0.00'}
                                  {purchase.exceptionResolvedAt
                                    ? ` · ${new Date(purchase.exceptionResolvedAt).toLocaleString('zh-CN')}`
                                    : ''}
                                  {purchase.exceptionResolutionNote
                                    ? ` · ${purchase.exceptionResolutionNote}`
                                    : ''}
                                </p>
                                {purchase.exceptionStatus === 'resolved' ? (
                                  <button
                                    onClick={() => {
                                      setResolutionCosts((current) => ({
                                        ...current,
                                        [purchase.purchaseOrderId]:
                                          purchase.reconciledCost?.toFixed(2) ?? '0.00',
                                      }));
                                      setResolutionNotes((current) => ({
                                        ...current,
                                        [purchase.purchaseOrderId]:
                                          purchase.exceptionResolutionNote ?? '',
                                      }));
                                      setEditingPurchaseCosts((current) => ({
                                        ...current,
                                        [purchase.purchaseOrderId]: true,
                                      }));
                                    }}
                                    className="shrink-0 rounded border border-green-300 bg-white px-2.5 py-1 font-medium text-green-700"
                                  >
                                    重新核对
                                  </button>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}

              {o.status === 'paid' && o.fulfillmentExceptionStatus === 'none' && (
                <button
                  onClick={() => fulfill.mutate(o.orderId)}
                  disabled={fulfill.isPending}
                  className="mt-3 rounded-lg bg-brand-500 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
                >
                  {fulfill.isPending ? '代发中…' : '一键代发'}
                </button>
              )}
              {o.status === 'purchasing' && o.fulfillmentExceptionStatus === 'none' && (
                <button
                  onClick={() => fulfill.mutate(o.orderId)}
                  disabled={fulfill.isPending}
                  className="mt-3 rounded-lg bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50"
                >
                  {fulfill.isPending ? '同步中…' : '同步 1688 付款/物流状态'}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {activeTotal !== undefined && activeTotal > 0 ? (
        <div className="mt-5 flex items-center justify-between text-sm text-zinc-600">
          <span>
            第 {activePage} / {activePages} 页 · 共 {activeTotal} 笔
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() =>
                pendingOnly
                  ? setReconciliationPage((current) => Math.max(1, current - 1))
                  : setOrderPage((current) => Math.max(1, current - 1))
              }
              disabled={activePage <= 1 || activeFetching}
              className="rounded border border-zinc-200 bg-white px-3 py-1.5 disabled:opacity-40"
            >
              上一页
            </button>
            <button
              type="button"
              onClick={() =>
                pendingOnly
                  ? setReconciliationPage((current) => Math.min(activePages, current + 1))
                  : setOrderPage((current) => Math.min(activePages, current + 1))
              }
              disabled={activePage >= activePages || activeFetching}
              className="rounded border border-zinc-200 bg-white px-3 py-1.5 disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        </div>
      ) : null}

      {fulfill.isError && (
        <p className="mt-3 text-sm text-red-600">代发失败：{(fulfill.error as ApiError).message}</p>
      )}
      {resolveException.isError && (
        <p className="mt-3 text-sm text-red-600">
          异常处理确认失败：{(resolveException.error as ApiError).message}
        </p>
      )}
      {resolvePartialRefund.isError && (
        <p className="mt-3 text-sm text-red-600">
          部分退款处置失败：{(resolvePartialRefund.error as ApiError).message}
        </p>
      )}
      {confirmRefundAmount.isError ? (
        <p className="mt-3 text-sm text-red-600">
          退款金额核对失败：{(confirmRefundAmount.error as ApiError).message}
        </p>
      ) : null}
    </main>
  );
}
