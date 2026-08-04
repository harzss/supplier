import type { SourceImportTask } from '../lib/api';

const STORAGE_VERSION = 1;
const STORAGE_PREFIX = 'supplier.source-import.workbench.v1';
const MAX_REFERENCES = 100;
const MAX_OFFER_ID_LENGTH = 32;
const MAX_RAW_INPUT_LENGTH = 20_000;
const ALLOWED_1688_HOSTS = new Set([
  '1688.com',
  'detail.1688.com',
  'm.1688.com',
  'offer.1688.com',
  'www.1688.com',
]);

export interface SourceImportReferenceIssue {
  line: number;
  input: string;
  code: 'invalid' | 'duplicate';
  message: string;
}

export interface SourceImportReferenceParseResult {
  references: string[];
  issues: SourceImportReferenceIssue[];
  inputCount: number;
  overLimit: boolean;
}

export interface SourceImportSessionScope {
  accountId: string;
  pathname: string;
}

export interface SourceImportDraft {
  rawInput: string;
  buyerShopId: string;
}

export interface SourceImportPreviewSession {
  fingerprint: string;
  clientRequestId: string;
  taskId?: string;
}

export interface SourceImportWorkbenchSession {
  draft: SourceImportDraft;
  preview: SourceImportPreviewSession | null;
}

export interface SourceImportSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function parseSourceImportReferences(rawInput: string): SourceImportReferenceParseResult {
  const issues: SourceImportReferenceIssue[] = [];
  const references: string[] = [];
  const seen = new Set<string>();
  const lines = rawInput.split(/\r?\n/);
  let inputCount = 0;

  lines.forEach((rawLine, index) => {
    const input = rawLine.trim();
    if (!input) return;
    inputCount += 1;
    const offerId = parseAlibaba1688OfferId(input);
    if (!offerId) {
      issues.push({
        line: index + 1,
        input,
        code: 'invalid',
        message: '请输入纯 offerId 或官方 HTTPS 1688 商品链接',
      });
      return;
    }
    if (seen.has(offerId)) {
      issues.push({
        line: index + 1,
        input,
        code: 'duplicate',
        message: `与前面的商品重复（offerId ${offerId}）`,
      });
      return;
    }
    seen.add(offerId);
    references.push(offerId);
  });

  return {
    references,
    issues,
    inputCount,
    overLimit: references.length > MAX_REFERENCES,
  };
}

export function sourceImportPreviewFingerprint(input: {
  references: string[];
  buyerShopId?: string;
}): string {
  return JSON.stringify({
    references: [...input.references].sort((left, right) => left.localeCompare(right)),
    buyerShopId: input.buyerShopId ?? null,
  });
}

export function shouldAcceptSourceImportPreviewResponse(
  pending: SourceImportPreviewSession | null,
  request: { clientRequestId: string; references: string[]; buyerShopId?: string },
): boolean {
  return (
    pending?.clientRequestId === request.clientRequestId &&
    pending.fingerprint === sourceImportPreviewFingerprint(request)
  );
}

export function shouldRestoreSourceImportPreview(
  preview: SourceImportPreviewSession,
  task: Pick<SourceImportTask, 'taskId' | 'clientRequestId' | 'status'>,
): boolean {
  return (
    task.status === 'preview' &&
    task.taskId === preview.taskId &&
    task.clientRequestId === preview.clientRequestId
  );
}

export function readSourceImportWorkbenchSession(
  scope: SourceImportSessionScope,
  storage: SourceImportSessionStorage | undefined = browserSessionStorage(),
): SourceImportWorkbenchSession | null {
  if (!storage) return null;
  const key = sourceImportWorkbenchStorageKey(scope);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = parseStoredSession(JSON.parse(raw) as unknown, scope);
    if (parsed) return parsed;
    storage.removeItem(key);
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // sessionStorage 不可用时仍依赖服务端幂等与精确请求查询恢复。
    }
  }
  return null;
}

export function writeSourceImportWorkbenchSession(
  scope: SourceImportSessionScope,
  session: SourceImportWorkbenchSession,
  storage: SourceImportSessionStorage | undefined = browserSessionStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      sourceImportWorkbenchStorageKey(scope),
      JSON.stringify({
        version: STORAGE_VERSION,
        accountId: scope.accountId,
        pathname: scope.pathname,
        ...session,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearSourceImportWorkbenchSession(
  scope: SourceImportSessionScope,
  storage: SourceImportSessionStorage | undefined = browserSessionStorage(),
): void {
  try {
    storage?.removeItem(sourceImportWorkbenchStorageKey(scope));
  } catch {
    // 清理失败不影响服务端任务状态。
  }
}

export function sourceImportWorkbenchStorageKey(scope: SourceImportSessionScope): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(scope.accountId)}:${encodeURIComponent(scope.pathname)}`;
}

function parseAlibaba1688OfferId(input: string): string | null {
  if (isOfferId(input)) return input;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !ALLOWED_1688_HOSTS.has(url.hostname.toLowerCase())
  ) {
    return null;
  }
  const match = url.pathname.match(/^\/offer\/([1-9]\d{0,31})\.html\/?$/);
  return match?.[1] && isOfferId(match[1]) ? match[1] : null;
}

function parseStoredSession(
  value: unknown,
  scope: SourceImportSessionScope,
): SourceImportWorkbenchSession | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== STORAGE_VERSION ||
    value.accountId !== scope.accountId ||
    value.pathname !== scope.pathname ||
    !isRecord(value.draft) ||
    typeof value.draft.rawInput !== 'string' ||
    value.draft.rawInput.length > MAX_RAW_INPUT_LENGTH ||
    typeof value.draft.buyerShopId !== 'string' ||
    (value.draft.buyerShopId !== '' && !isPositiveId(value.draft.buyerShopId))
  ) {
    return null;
  }
  const preview = parsePreview(value.preview);
  if (preview === undefined) return null;
  return {
    draft: {
      rawInput: value.draft.rawInput,
      buyerShopId: value.draft.buyerShopId,
    },
    preview,
  };
}

function parsePreview(value: unknown): SourceImportPreviewSession | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.fingerprint !== 'string' ||
    !isUuid(value.clientRequestId) ||
    (value.taskId !== undefined && !isPositiveId(value.taskId))
  ) {
    return undefined;
  }
  return {
    fingerprint: value.fingerprint,
    clientRequestId: value.clientRequestId,
    ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
  };
}

function isOfferId(value: string): boolean {
  return new RegExp(`^[1-9]\\d{0,${MAX_OFFER_ID_LENGTH - 1}}$`).test(value);
}

function isPositiveId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function browserSessionStorage(): SourceImportSessionStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}
