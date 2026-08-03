export interface PublishDraftIdentity {
  clientRequestId: string;
  revision: number;
}

export interface PublishAttempt {
  clientRequestId: string;
  draftRevision: number;
}

export interface StoredPublishAttempt extends PublishAttempt {
  fingerprint: string;
}

export type PublishAttemptRecovery<T> =
  | { kind: 'none' }
  | { kind: 'not_found' }
  | { kind: 'recovered'; task: T };

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function draftWriteExpectation(draft: PublishDraftIdentity | null): {
  expectedRevision: number;
  expectedClientRequestId?: string;
} {
  return draft
    ? {
        expectedRevision: draft.revision,
        expectedClientRequestId: draft.clientRequestId,
      }
    : { expectedRevision: 0 };
}

export function getPublishAttempt(
  sourceProductId: string,
  payload: unknown,
  draft: PublishDraftIdentity,
  memory: Map<string, PublishAttempt>,
  storage: StorageLike | undefined = browserSessionStorage(),
): PublishAttempt {
  const fingerprint = JSON.stringify(payload);
  const memoryKey = publishAttemptMemoryKey(sourceProductId, fingerprint);
  const remembered = memory.get(memoryKey);
  if (remembered && attemptMatchesDraft(remembered, draft)) return remembered;
  if (remembered) memory.delete(memoryKey);

  const storageKey = publishAttemptStorageKey(sourceProductId);
  try {
    const stored = storage?.getItem(storageKey);
    if (stored) {
      const parsed = JSON.parse(stored) as {
        fingerprint?: unknown;
        clientRequestId?: unknown;
        draftRevision?: unknown;
      };
      if (
        parsed.fingerprint === fingerprint &&
        typeof parsed.clientRequestId === 'string' &&
        Number.isInteger(parsed.draftRevision)
      ) {
        const attempt = {
          clientRequestId: parsed.clientRequestId,
          draftRevision: Number(parsed.draftRevision),
        };
        if (attemptMatchesDraft(attempt, draft)) {
          memory.set(memoryKey, attempt);
          return attempt;
        }
      }
    }
  } catch {
    // 会话缓存不可用时仍由服务端幂等约束保护当前请求。
  }

  const attempt = {
    clientRequestId: draft.clientRequestId,
    draftRevision: draft.revision,
  };
  memory.set(memoryKey, attempt);
  try {
    storage?.setItem(storageKey, JSON.stringify({ fingerprint, ...attempt }));
  } catch {
    // 隐私模式可能禁用会话缓存；保留本次请求 ID 即可。
  }
  return attempt;
}

export async function recoverPublishAttempt<T>(
  sourceProductId: string,
  memory: Map<string, PublishAttempt>,
  lookup: (clientRequestId: string) => Promise<T | null>,
  storage: StorageLike | undefined = browserSessionStorage(),
): Promise<PublishAttemptRecovery<T>> {
  const stored =
    readPublishAttempt(sourceProductId, storage) ??
    readMemoryPublishAttempt(sourceProductId, memory);
  if (!stored) return { kind: 'none' };

  const task = await lookup(stored.clientRequestId);
  return task === null ? { kind: 'not_found' } : { kind: 'recovered', task };
}

function readMemoryPublishAttempt(
  sourceProductId: string,
  memory: Map<string, PublishAttempt>,
): StoredPublishAttempt | null {
  const prefix = `${publishAttemptStorageKey(sourceProductId)}:`;
  let stored: StoredPublishAttempt | null = null;
  for (const [key, attempt] of memory) {
    if (!key.startsWith(prefix)) continue;
    stored = {
      fingerprint: key.slice(prefix.length),
      clientRequestId: attempt.clientRequestId,
      draftRevision: attempt.draftRevision,
    };
  }
  return stored;
}

export function clearPublishAttempt(
  sourceProductId: string,
  memory: Map<string, PublishAttempt>,
  storage: StorageLike | undefined = browserSessionStorage(),
): void {
  const memoryPrefix = `${publishAttemptStorageKey(sourceProductId)}:`;
  for (const key of memory.keys()) {
    if (key.startsWith(memoryPrefix)) memory.delete(key);
  }
  try {
    storage?.removeItem(publishAttemptStorageKey(sourceProductId));
  } catch {
    // 会话缓存不可用不影响服务端任务结果。
  }
}

function readPublishAttempt(
  sourceProductId: string,
  storage: StorageLike | undefined,
): StoredPublishAttempt | null {
  try {
    const value = storage?.getItem(publishAttemptStorageKey(sourceProductId));
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<StoredPublishAttempt>;
    if (
      typeof parsed.fingerprint === 'string' &&
      typeof parsed.clientRequestId === 'string' &&
      Number.isInteger(parsed.draftRevision) &&
      Number(parsed.draftRevision) > 0
    ) {
      return {
        fingerprint: parsed.fingerprint,
        clientRequestId: parsed.clientRequestId,
        draftRevision: Number(parsed.draftRevision),
      };
    }
    storage?.removeItem(publishAttemptStorageKey(sourceProductId));
  } catch {
    // 无法读取的缓存不能作为恢复依据；保留 fail-closed 的调用方状态。
  }
  return null;
}

function attemptMatchesDraft(attempt: PublishAttempt, draft: PublishDraftIdentity): boolean {
  return (
    attempt.clientRequestId === draft.clientRequestId && attempt.draftRevision === draft.revision
  );
}

function publishAttemptStorageKey(sourceProductId: string): string {
  return `supplier.publish.request.${encodeURIComponent(sourceProductId)}`;
}

function publishAttemptMemoryKey(sourceProductId: string, fingerprint: string): string {
  return `${publishAttemptStorageKey(sourceProductId)}:${fingerprint}`;
}

function browserSessionStorage(): StorageLike | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}
