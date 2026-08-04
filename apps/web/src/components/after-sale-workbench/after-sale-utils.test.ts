import { describe, expect, it } from 'vitest';
import type { AfterSalePurchaseLink } from '@/lib/api';
import {
  afterSaleEventLabel,
  closureBlockerAction,
  closureBlockerActionKey,
  countKeyForStatus,
  dueLabel,
  isAfterSaleConflict,
  isAfterSaleStaleMutation,
  normalizedClosureBlockers,
  parseClosureMoney,
  parseAfterSaleOverdue,
  parseAfterSaleStatus,
  parsePositivePage,
  purchaseLinkStage,
  refundAmountInputMax,
  summarizeAfterSaleRefresh,
  waitingOnLabel,
} from './after-sale-utils';

const PURCHASE_LINK: AfterSalePurchaseLink = {
  id: 'link-1',
  purchaseOrderId: 'purchase-1',
  orderId1688: '1688-1',
  status: 'action_required',
  exceptionStatus: 'action_required',
  purchaseExceptionRevision: 3,
  purchaseSyncRevision: 5,
};

describe('after-sale workbench query parsing', () => {
  it('uses safe defaults for unknown status, overdue and page values', () => {
    expect(parseAfterSaleStatus('handling')).toBe('handling');
    expect(parseAfterSaleStatus('unknown')).toBe('open');
    expect(parseAfterSaleStatus(null)).toBe('open');
    expect(parseAfterSaleOverdue('true')).toBe(true);
    expect(parseAfterSaleOverdue('0')).toBe(false);
    expect(parseAfterSaleOverdue('all')).toBeUndefined();
    expect(parsePositivePage('4')).toBe(4);
    expect(parsePositivePage('0')).toBe(1);
    expect(parsePositivePage('-1')).toBe(1);
  });

  it('maps API count and waiting-on values for the UI', () => {
    expect(countKeyForStatus('waiting_external')).toBe('waitingExternal');
    expect(countKeyForStatus('verifying')).toBe('verifying');
    expect(waitingOnLabel('supplier')).toBe('1688 供应商');
    expect(waitingOnLabel('future_party')).toBe('future_party');
  });
});

describe('after-sale command safety', () => {
  it('recognizes revision conflicts without swallowing other failures', () => {
    expect(isAfterSaleConflict(Object.assign(new Error('stale'), { status: 409 }))).toBe(true);
    expect(isAfterSaleConflict(Object.assign(new Error('invalid'), { status: 400 }))).toBe(false);
    expect(isAfterSaleConflict(new Error('network'))).toBe(false);
    expect(isAfterSaleStaleMutation(Object.assign(new Error('stale'), { status: 409 }))).toBe(true);
    expect(
      isAfterSaleStaleMutation(
        Object.assign(new Error('采购异常已更新，请刷新订单后重新核销'), { status: 400 }),
      ),
    ).toBe(true);
    expect(
      isAfterSaleStaleMutation(
        Object.assign(new Error('invalid'), { status: 400, code: 'REVISION_CONFLICT' }),
      ),
    ).toBe(true);
    expect(isAfterSaleStaleMutation(Object.assign(new Error('金额无效'), { status: 400 }))).toBe(
      false,
    );
  });

  it('derives the next purchase action from persisted evidence', () => {
    expect(purchaseLinkStage(PURCHASE_LINK)).toBe('start');
    expect(purchaseLinkStage({ ...PURCHASE_LINK, status: 'not_required' })).toBe('not_required');
    expect(purchaseLinkStage({ ...PURCHASE_LINK, status: 'waiting_external' })).toBe('confirm');
    expect(purchaseLinkStage({ ...PURCHASE_LINK, status: 'failed', result: 'failed' })).toBe(
      'start',
    );
    expect(
      purchaseLinkStage({
        ...PURCHASE_LINK,
        status: 'confirmed',
        action: 'refund',
        result: 'confirmed',
      }),
    ).toBe('confirmed');
  });

  it('labels the persisted after-sale event vocabulary', () => {
    expect(afterSaleEventLabel('source_updated')).toBe('销售售后状态更新');
    expect(afterSaleEventLabel('action_started')).toBe('记录 1688 人工动作');
    expect(afterSaleEventLabel('action_confirmed')).toBe('确认 1688 处理结果');
    expect(afterSaleEventLabel('verification_failed')).toBe('关闭校验未通过');
  });

  it('normalizes textual and structured close blockers', () => {
    expect(
      normalizedClosureBlockers([
        '1688 处理结果待确认',
        { code: 'REFUND_AMOUNT_MISSING', label: '退款金额待核对', detail: '打开订单核对' },
      ]),
    ).toEqual([
      { code: 'blocker-1', label: '1688 处理结果待确认' },
      { code: 'REFUND_AMOUNT_MISSING', label: '退款金额待核对', detail: '打开订单核对' },
    ]);
  });

  it('maps actionable blockers and deduplicates purchase reconciliation by purchase', () => {
    expect(closureBlockerAction('PARTIAL_REFUND_DECISION_REQUIRED')).toBe(
      'partial_refund_decision',
    );
    expect(closureBlockerAction('REFUND_AMOUNT_CONFIRMATION_REQUIRED')).toBe(
      'refund_amount_confirmation',
    );
    expect(closureBlockerAction('REFUND_AMOUNT_REQUIRED')).toBe('refund_amount_confirmation');
    expect(closureBlockerAction('PURCHASE_EXCEPTION_REQUIRED')).toBe(
      'purchase_cost_reconciliation',
    );
    expect(closureBlockerAction('PURCHASE_EXCEPTION_UNRESOLVED')).toBe(
      'purchase_cost_reconciliation',
    );
    expect(closureBlockerAction('PURCHASE_ACTION_REQUIRED')).toBeNull();
    expect(
      closureBlockerActionKey({
        code: 'PURCHASE_EXCEPTION_REQUIRED',
        label: '采购异常待核销',
        purchaseOrderId: 'purchase-7',
      }),
    ).toBe('purchase_cost_reconciliation:purchase-7');
    expect(
      closureBlockerActionKey({
        code: 'PURCHASE_COST_RECONCILIATION_REQUIRED',
        label: '最终成本待核对',
        purchaseOrderId: 'purchase-7',
      }),
    ).toBe('purchase_cost_reconciliation:purchase-7');
  });

  it('accepts only API-compatible refund and purchase amounts', () => {
    expect(parseClosureMoney('12.34', { allowZero: false, maxExclusive: 100 })).toBe(12.34);
    expect(parseClosureMoney('0', { allowZero: true })).toBe(0);
    expect(parseClosureMoney('', { allowZero: true })).toBeNull();
    expect(parseClosureMoney('12.345', { allowZero: true })).toBeNull();
    expect(parseClosureMoney('0', { allowZero: false })).toBeNull();
    expect(parseClosureMoney('100', { allowZero: false, maxExclusive: 100 })).toBeNull();
    expect(refundAmountInputMax(29.9)).toBe('29.89');
    expect(refundAmountInputMax(0.01)).toBeUndefined();
    expect(refundAmountInputMax(undefined)).toBeUndefined();
  });
});

describe('after-sale time and refresh feedback', () => {
  const now = Date.parse('2026-08-04T10:00:00.000Z');

  it('makes overdue and near-due work explicit', () => {
    expect(dueLabel(null, false, now)).toEqual({
      label: '未设置处理时限',
      tone: 'neutral',
    });
    expect(dueLabel('2026-08-04T09:00:00.000Z', false, now)).toEqual({
      label: '已逾期 1 小时',
      tone: 'danger',
    });
    expect(dueLabel('2026-08-04T12:00:00.000Z', false, now)).toEqual({
      label: '2 小时内需处理',
      tone: 'warning',
    });
  });

  it('summarizes changes and partial failures', () => {
    expect(
      summarizeAfterSaleRefresh({
        scanned: 9,
        created: 2,
        updated: 1,
        reopened: 1,
        closed: 3,
        hasMore: false,
        nextCursor: null,
        errors: [{ message: 'timeout' }],
      }),
    ).toBe('同步完成：新建 2 件，重开 1 件，更新 1 件，关闭 3 件。 1 项同步失败，请稍后重试。');
  });

  it('makes a client-side refresh batch limit explicit', () => {
    expect(
      summarizeAfterSaleRefresh({
        scanned: 10_000,
        hasMore: true,
        nextCursor: '10000',
        errors: [],
      }),
    ).toBe('同步完成，工单状态没有变化。 已达到本次安全批次上限，仍有后续订单，请再次点击同步。');
  });
});
