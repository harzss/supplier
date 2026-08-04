import type {
  ExceptionCaseDomain,
  ExceptionCasePriority,
  ExceptionCaseStatus,
  ExceptionResponsibleParty,
  RefreshExceptionCasesResult,
} from '@/lib/api';

export const EXCEPTION_DOMAINS: Array<{ value: ExceptionCaseDomain; label: string }> = [
  { value: 'publish', label: '铺货' },
  { value: 'order', label: '订单' },
  { value: 'purchase', label: '采购' },
  { value: 'logistics', label: '物流' },
  { value: 'after_sale', label: '售后' },
  { value: 'entitlement', label: '权益' },
];

export const EXCEPTION_PRIORITIES: Array<{ value: ExceptionCasePriority; label: string }> = [
  { value: 'critical', label: '紧急' },
  { value: 'high', label: '高优先级' },
  { value: 'medium', label: '一般' },
];

export const EXCEPTION_STATUSES: Array<{ value: ExceptionCaseStatus; label: string }> = [
  { value: 'open', label: '待处理' },
  { value: 'acknowledged', label: '跟进中' },
  { value: 'resolved', label: '已关闭' },
];

const ALLOWED_ACTION_ROOTS = [
  '/orders',
  '/after-sales',
  '/published',
  '/settings',
  '/sources',
] as const;

export function parseExceptionStatus(value: string | null): ExceptionCaseStatus {
  return value === 'acknowledged' || value === 'resolved' ? value : 'open';
}

export function parseExceptionDomain(value: string | null): ExceptionCaseDomain | undefined {
  return EXCEPTION_DOMAINS.some((option) => option.value === value)
    ? (value as ExceptionCaseDomain)
    : undefined;
}

export function parseExceptionPriority(value: string | null): ExceptionCasePriority | undefined {
  return EXCEPTION_PRIORITIES.some((option) => option.value === value)
    ? (value as ExceptionCasePriority)
    : undefined;
}

export function parsePositivePage(value: string | null): number {
  if (!value || !/^\d+$/.test(value)) return 1;
  return Math.max(1, Number(value));
}

export function isExceptionCaseConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    'status' in error &&
    typeof error.status === 'number' &&
    error.status === 409
  );
}

/** Only routes already owned by this Web app may be rendered as case actions. */
export function safeInternalActionHref(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//')) return null;
  if (candidate.includes('\\')) return null;
  try {
    const base = 'https://supplier.local';
    const parsed = new URL(candidate, base);
    if (parsed.origin !== base) return null;
    if (
      !ALLOWED_ACTION_ROOTS.some(
        (root) => parsed.pathname === root || parsed.pathname.startsWith(`${root}/`),
      )
    ) {
      return null;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

export function domainLabel(value: ExceptionCaseDomain): string {
  return EXCEPTION_DOMAINS.find((option) => option.value === value)?.label ?? value;
}

export function priorityLabel(value: ExceptionCasePriority): string {
  return EXCEPTION_PRIORITIES.find((option) => option.value === value)?.label ?? value;
}

export function statusLabel(value: ExceptionCaseStatus): string {
  return EXCEPTION_STATUSES.find((option) => option.value === value)?.label ?? value;
}

export function responsiblePartyLabel(value: ExceptionResponsibleParty): string {
  const labels: Record<ExceptionResponsibleParty, string> = {
    merchant: '商家运营',
    supplier: '供应商',
    platform: '平台',
    system: '系统自动检查',
  };
  return labels[value];
}

export function formatRelativeTime(value: string, now = Date.now()): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return '时间未知';
  const elapsed = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return '刚刚';
  if (elapsed < hour) return `${Math.floor(elapsed / minute)} 分钟前`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)} 小时前`;
  if (elapsed < 7 * day) return `${Math.floor(elapsed / day)} 天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export function formatFullTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : '—';
}

export function summarizeRefreshResult(result: RefreshExceptionCasesResult): string {
  let created = 0;
  let updated = 0;
  let reopened = 0;
  let resolved = 0;
  for (const value of Object.values(result.domains ?? {})) {
    if (typeof value === 'number') {
      updated += value;
      continue;
    }
    if (!value) continue;
    created += value.created ?? 0;
    updated += value.updated ?? 0;
    reopened += value.reopened ?? 0;
    resolved += value.resolved ?? 0;
  }
  const changes: string[] = [];
  if (created > 0) changes.push(`新发现 ${created} 件`);
  if (reopened > 0) changes.push(`重新打开 ${reopened} 件`);
  if (resolved > 0) changes.push(`关闭 ${resolved} 件`);
  if (updated > 0 && changes.length === 0) changes.push(`更新 ${updated} 件`);
  const errorCount = result.errors?.length ?? 0;
  const base =
    changes.length > 0 ? `检查完成：${changes.join('，')}。` : '检查完成，当前状态没有变化。';
  return errorCount > 0 ? `${base} ${errorCount} 个业务域检查失败，请稍后重试。` : base;
}

export function createClientRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function eventLabel(value: string): string {
  const labels: Record<string, string> = {
    opened: '发现异常',
    detected: '发现异常',
    updated: '异常信息更新',
    occurrence: '异常再次发生',
    reopened: '重新打开',
    acknowledged: '开始跟进',
    note_added: '补充说明',
    refreshed: '重新检查',
    resolved: '自动关闭',
    status_changed: '状态更新',
    assignee_changed: '责任人更新',
  };
  return labels[value] ?? '状态记录';
}
