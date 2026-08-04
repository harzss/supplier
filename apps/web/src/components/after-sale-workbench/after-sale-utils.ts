import type {
  AfterSaleCasePriority,
  AfterSaleCaseStatus,
  AfterSaleClosureBlocker,
  AfterSalePurchaseLink,
  RefreshAfterSaleCasesResult,
} from '@/lib/api';

export const AFTER_SALE_STATUSES: Array<{ value: AfterSaleCaseStatus; label: string }> = [
  { value: 'open', label: '待认领' },
  { value: 'handling', label: '处理中' },
  { value: 'waiting_external', label: '等待外部' },
  { value: 'verifying', label: '待核验' },
  { value: 'closed', label: '已关闭' },
];

export function parseAfterSaleStatus(value: string | null): AfterSaleCaseStatus {
  return AFTER_SALE_STATUSES.some((option) => option.value === value)
    ? (value as AfterSaleCaseStatus)
    : 'open';
}

export function parseAfterSaleOverdue(value: string | null): boolean | undefined {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

export function parsePositivePage(value: string | null): number {
  if (!value || !/^\d+$/.test(value)) return 1;
  return Math.max(1, Number(value));
}

export function afterSaleStatusLabel(value: AfterSaleCaseStatus): string {
  return AFTER_SALE_STATUSES.find((option) => option.value === value)?.label ?? value;
}

export function afterSalePriorityLabel(value: AfterSaleCasePriority): string {
  return { critical: '紧急', high: '高优先级', medium: '一般' }[value];
}

export function waitingOnLabel(value: string | null): string {
  if (!value) return '当前运营';
  const labels: Record<string, string> = {
    merchant: '商家运营',
    supplier: '1688 供应商',
    platform: '销售平台',
    sales_platform: '销售平台',
    system: '系统核验',
    finance: '财务核对',
    none: '无需等待',
  };
  return labels[value] ?? value;
}

export function afterSaleEventLabel(value: string): string {
  const labels: Record<string, string> = {
    opened: '创建售后工单',
    source_updated: '销售售后状态更新',
    reopened: '重新打开工单',
    claimed: '运营认领',
    action_started: '记录 1688 人工动作',
    action_confirmed: '确认 1688 处理结果',
    verification_failed: '关闭校验未通过',
    closed: '工单关闭',
  };
  return labels[value] ?? value.replaceAll('_', ' ');
}

export function isAfterSaleConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    'status' in error &&
    typeof error.status === 'number' &&
    error.status === 409
  );
}

export function isAfterSaleStaleMutation(error: unknown): boolean {
  if (isAfterSaleConflict(error)) return true;
  if (!(error instanceof Error) || !('status' in error) || error.status !== 400) return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code.toUpperCase() : '';
  if (/(?:STALE|REVISION|CONFLICT)/.test(code)) return true;
  return /(?:已更新|已变化|状态(?:已)?变化|修订号无效|已完成处置)/.test(error.message);
}

export function countKeyForStatus(
  status: AfterSaleCaseStatus,
): 'open' | 'handling' | 'waitingExternal' | 'verifying' | 'closed' {
  return status === 'waiting_external' ? 'waitingExternal' : status;
}

export function purchaseLinkStage(
  link: AfterSalePurchaseLink,
): 'not_required' | 'start' | 'confirm' | 'confirmed' {
  if (link.status === 'not_required') return 'not_required';
  if (link.status === 'action_required' || link.status === 'failed') return 'start';
  if (link.status === 'waiting_external') return 'confirm';
  if (link.status === 'confirmed') return 'confirmed';

  if (link.actionConfirmedAt || link.result) return 'confirmed';
  if (
    link.actionStartedAt ||
    (link.action !== null && link.action !== undefined && link.action !== 'none') ||
    link.remoteReferenceId
  ) {
    return 'confirm';
  }
  return 'start';
}

export function normalizedClosureBlockers(
  blockers: Array<AfterSaleClosureBlocker | string>,
): AfterSaleClosureBlocker[] {
  return blockers.map((blocker, index) =>
    typeof blocker === 'string' ? { code: `blocker-${index + 1}`, label: blocker } : blocker,
  );
}

export type AfterSaleClosureAction =
  | 'partial_refund_decision'
  | 'refund_amount_confirmation'
  | 'purchase_cost_reconciliation';

export function closureBlockerAction(code: string): AfterSaleClosureAction | null {
  if (code === 'PARTIAL_REFUND_DECISION_REQUIRED') return 'partial_refund_decision';
  if (
    code === 'REFUND_AMOUNT_CONFIRMATION_REQUIRED' ||
    code === 'REFUND_AMOUNT_REQUIRED' ||
    code === 'REFUND_AMOUNT_STALE'
  ) {
    return 'refund_amount_confirmation';
  }
  if (
    code === 'PURCHASE_EXCEPTION_REQUIRED' ||
    code === 'PURCHASE_EXCEPTION_UNRESOLVED' ||
    code === 'PURCHASE_COST_RECONCILIATION_REQUIRED'
  ) {
    return 'purchase_cost_reconciliation';
  }
  return null;
}

export function closureBlockerActionKey(blocker: AfterSaleClosureBlocker): string | null {
  const action = closureBlockerAction(blocker.code);
  if (!action) return null;
  if (action === 'purchase_cost_reconciliation') {
    return blocker.purchaseOrderId ? `${action}:${blocker.purchaseOrderId}` : null;
  }
  return action;
}

export function parseClosureMoney(
  value: string,
  options: { allowZero: boolean; maxExclusive?: number },
): number | null {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount > 99_999_999.99) return null;
  if (options.allowZero ? amount < 0 : amount < 0.01) return null;
  if (options.maxExclusive !== undefined && amount >= options.maxExclusive) return null;
  return amount;
}

export function refundAmountInputMax(orderAmount: number | undefined): string | undefined {
  if (orderAmount === undefined || !Number.isFinite(orderAmount)) return undefined;
  const maximumCents = Math.round(orderAmount * 100) - 1;
  return maximumCents >= 1 ? (maximumCents / 100).toFixed(2) : undefined;
}

export function dueLabel(
  dueAt: string | null,
  overdue: boolean,
  now = Date.now(),
): { label: string; tone: 'neutral' | 'warning' | 'danger' } {
  if (!dueAt) return { label: '未设置处理时限', tone: 'neutral' };
  const timestamp = new Date(dueAt).getTime();
  if (!Number.isFinite(timestamp)) return { label: '处理时限未知', tone: 'warning' };
  const delta = timestamp - now;
  const absoluteMinutes = Math.max(1, Math.ceil(Math.abs(delta) / 60_000));
  const duration =
    absoluteMinutes >= 24 * 60
      ? `${Math.ceil(absoluteMinutes / (24 * 60))} 天`
      : absoluteMinutes >= 60
        ? `${Math.ceil(absoluteMinutes / 60)} 小时`
        : `${absoluteMinutes} 分钟`;
  if (overdue || delta < 0) return { label: `已逾期 ${duration}`, tone: 'danger' };
  if (delta <= 6 * 60 * 60_000) return { label: `${duration}内需处理`, tone: 'warning' };
  return { label: `${duration}内需处理`, tone: 'neutral' };
}

export function summarizeAfterSaleRefresh(result: RefreshAfterSaleCasesResult): string {
  const changes: string[] = [];
  if (result.created) changes.push(`新建 ${result.created} 件`);
  if (result.reopened) changes.push(`重开 ${result.reopened} 件`);
  if (result.updated) changes.push(`更新 ${result.updated} 件`);
  if (result.closed) changes.push(`关闭 ${result.closed} 件`);
  const errorCount = result.errors?.length ?? 0;
  const base = changes.length
    ? `同步完成：${changes.join('，')}。`
    : '同步完成，工单状态没有变化。';
  const failure = errorCount > 0 ? ` ${errorCount} 项同步失败，请稍后重试。` : '';
  const continuation = result.hasMore
    ? ' 已达到本次安全批次上限，仍有后续订单，请再次点击同步。'
    : '';
  return `${base}${failure}${continuation}`;
}
