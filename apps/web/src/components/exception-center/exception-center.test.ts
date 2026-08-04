import { describe, expect, it } from 'vitest';
import type { RefreshExceptionCasesResult } from '@/lib/api';
import {
  createClientRequestId,
  formatRelativeTime,
  isExceptionCaseConflict,
  parseExceptionDomain,
  parseExceptionPriority,
  parseExceptionStatus,
  parsePositivePage,
  safeInternalActionHref,
  summarizeRefreshResult,
} from './exception-center-utils';

describe('exception center query parsing', () => {
  it('uses safe defaults for unknown URL values', () => {
    expect(parseExceptionStatus(null)).toBe('open');
    expect(parseExceptionStatus('unknown')).toBe('open');
    expect(parseExceptionDomain('purchase')).toBe('purchase');
    expect(parseExceptionDomain('unknown')).toBeUndefined();
    expect(parseExceptionPriority('critical')).toBe('critical');
    expect(parseExceptionPriority('urgent')).toBeUndefined();
    expect(parsePositivePage('3')).toBe(3);
    expect(parsePositivePage('0')).toBe(1);
    expect(parsePositivePage('-1')).toBe(1);
    expect(parsePositivePage('1.5')).toBe(1);
  });

  it('recognizes stale case conflicts without treating other failures as stale', () => {
    expect(isExceptionCaseConflict(Object.assign(new Error('已更新'), { status: 409 }))).toBe(true);
    expect(isExceptionCaseConflict(Object.assign(new Error('说明无效'), { status: 400 }))).toBe(
      false,
    );
    expect(isExceptionCaseConflict(new Error('network'))).toBe(false);
  });

  it('creates a UUID request id for acknowledge idempotency', () => {
    expect(createClientRequestId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

describe('exception action navigation', () => {
  it('allows only known same-origin workbench routes', () => {
    expect(safeInternalActionHref('/orders?orderId=42')).toBe('/orders?orderId=42');
    expect(safeInternalActionHref('/after-sales?case=42')).toBe('/after-sales?case=42');
    expect(safeInternalActionHref('/published/batch?task=abc#result')).toBe(
      '/published/batch?task=abc#result',
    );
    expect(safeInternalActionHref('/settings?section=shops')).toBe('/settings?section=shops');
    expect(safeInternalActionHref('/sources/import')).toBe('/sources/import');
  });

  it('rejects external, protocol-relative, malformed and unknown routes', () => {
    expect(safeInternalActionHref('https://evil.example/orders')).toBeNull();
    expect(safeInternalActionHref('//evil.example/orders')).toBeNull();
    expect(safeInternalActionHref('/orders\\evil')).toBeNull();
    expect(safeInternalActionHref('/admin')).toBeNull();
    expect(safeInternalActionHref('javascript:alert(1)')).toBeNull();
    expect(safeInternalActionHref(null)).toBeNull();
  });
});

describe('exception timestamps and refresh feedback', () => {
  it('formats recent timestamps without implying future elapsed time', () => {
    const now = Date.parse('2026-08-04T10:00:00.000Z');
    expect(formatRelativeTime('2026-08-04T09:59:40.000Z', now)).toBe('刚刚');
    expect(formatRelativeTime('2026-08-04T09:45:00.000Z', now)).toBe('15 分钟前');
    expect(formatRelativeTime('2026-08-04T07:00:00.000Z', now)).toBe('3 小时前');
    expect(formatRelativeTime('2026-08-05T10:00:00.000Z', now)).toBe('刚刚');
    expect(formatRelativeTime('not-a-date', now)).toBe('时间未知');
  });

  it('summarizes per-domain changes and partial failures', () => {
    const result: RefreshExceptionCasesResult = {
      domains: {
        publish: { created: 2, updated: 1 },
        order: { reopened: 1 },
        logistics: { resolved: 3 },
      },
      errors: [{ domain: 'entitlement', message: 'timeout' }],
      refreshedAt: '2026-08-04T10:00:00.000Z',
    };
    expect(summarizeRefreshResult(result)).toBe(
      '检查完成：新发现 2 件，重新打开 1 件，关闭 3 件。 1 个业务域检查失败，请稍后重试。',
    );
  });

  it('handles compact numeric domain results without crashing', () => {
    expect(
      summarizeRefreshResult({
        domains: { publish: 2 },
        errors: [],
      }),
    ).toBe('检查完成：更新 2 件。');
  });
});
