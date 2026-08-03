import { describe, expect, it, vi } from 'vitest';
import {
  clearPublishAttempt,
  draftWriteExpectation,
  getPublishAttempt,
  recoverPublishAttempt,
  type PublishAttempt,
} from './publish-draft-client';

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class UnavailableStorage extends MemoryStorage {
  override getItem(): string | null {
    throw new Error('storage unavailable');
  }

  override setItem(): void {
    throw new Error('storage unavailable');
  }

  override removeItem(): void {
    throw new Error('storage unavailable');
  }
}

const SOURCE_ID = '1688/1001';
const OTHER_SOURCE_ID = '1688/2002';
const STORAGE_KEY = 'supplier.publish.request.1688%2F1001';
const OLD_REQUEST_ID = '8a4d5b1e-7d9a-4e60-9f81-3ce8f3f5a2d1';
const NEW_REQUEST_ID = '6b341b8c-6f33-43a2-a167-ec0ad038a606';

describe('publish draft client concurrency', () => {
  it('sends the server generation with an existing draft', () => {
    expect(draftWriteExpectation({ clientRequestId: 'current-id', revision: 7 })).toEqual({
      expectedRevision: 7,
      expectedClientRequestId: 'current-id',
    });
    expect(draftWriteExpectation(null)).toEqual({ expectedRevision: 0 });
  });

  it('reuses an attempt only for the exact current draft identity', () => {
    const storage = new MemoryStorage();
    const memory = new Map<string, PublishAttempt>();
    const payload = { targetShopIds: ['9'] };
    getPublishAttempt(
      SOURCE_ID,
      payload,
      { clientRequestId: 'stale-id', revision: 1 },
      memory,
      storage,
    );

    expect(
      getPublishAttempt(
        SOURCE_ID,
        payload,
        { clientRequestId: 'current-id', revision: 2 },
        memory,
        storage,
      ),
    ).toEqual({ clientRequestId: 'current-id', draftRevision: 2 });
    expect(JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({
      clientRequestId: 'current-id',
      draftRevision: 2,
    });
  });

  it('reuses and clears the exact attempt in memory and session storage', () => {
    const storage = new MemoryStorage();
    const memory = new Map<string, PublishAttempt>();
    const payload = { targetShopIds: ['9'] };
    const draft = { clientRequestId: 'current-id', revision: 2 };
    const first = getPublishAttempt(SOURCE_ID, payload, draft, memory, storage);

    expect(getPublishAttempt(SOURCE_ID, payload, draft, memory, storage)).toBe(first);
    clearPublishAttempt(SOURCE_ID, memory, storage);
    expect(memory.size).toBe(0);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('recovers the accepted task after a refresh when the draft was consumed', async () => {
    const storage = new MemoryStorage();
    getPublishAttempt(
      SOURCE_ID,
      { targetShopIds: ['9'] },
      { clientRequestId: OLD_REQUEST_ID, revision: 3 },
      new Map(),
      storage,
    );
    const refreshedMemory = new Map<string, PublishAttempt>();
    const task = { taskId: '17', status: 'pending' };
    const lookup = vi.fn().mockResolvedValue(task);

    await expect(
      recoverPublishAttempt(SOURCE_ID, refreshedMemory, lookup, storage),
    ).resolves.toEqual({ kind: 'recovered', task });
    expect(lookup).toHaveBeenCalledWith(OLD_REQUEST_ID);
    expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
    clearPublishAttempt(SOURCE_ID, refreshedMemory, storage);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('checks and clears a mismatched generation before using the current draft identity', async () => {
    const storage = new MemoryStorage();
    const memory = new Map<string, PublishAttempt>();
    const oldPayload = { targetShopIds: ['9'] };
    getPublishAttempt(
      SOURCE_ID,
      oldPayload,
      { clientRequestId: OLD_REQUEST_ID, revision: 3 },
      memory,
      storage,
    );
    const lookup = vi.fn().mockResolvedValue(null);

    await expect(recoverPublishAttempt(SOURCE_ID, memory, lookup, storage)).resolves.toEqual({
      kind: 'not_found',
    });
    expect(lookup).toHaveBeenCalledWith(OLD_REQUEST_ID);
    expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
    clearPublishAttempt(SOURCE_ID, memory, storage);

    const current = getPublishAttempt(
      SOURCE_ID,
      { targetShopIds: ['10'] },
      { clientRequestId: NEW_REQUEST_ID, revision: 1 },
      memory,
      storage,
    );
    expect(current).toEqual({ clientRequestId: NEW_REQUEST_ID, draftRevision: 1 });
    expect(JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject(current);
  });

  it('keeps the stored attempt when recovery cannot confirm a 404', async () => {
    const storage = new MemoryStorage();
    getPublishAttempt(
      SOURCE_ID,
      { targetShopIds: ['9'] },
      { clientRequestId: OLD_REQUEST_ID, revision: 3 },
      new Map(),
      storage,
    );
    const stored = storage.getItem(STORAGE_KEY);

    await expect(
      recoverPublishAttempt(
        SOURCE_ID,
        new Map(),
        vi.fn().mockRejectedValue(new Error('network unavailable')),
        storage,
      ),
    ).rejects.toThrow('network unavailable');
    expect(storage.getItem(STORAGE_KEY)).toBe(stored);
  });

  it('recovers a same-page attempt after a lost response when session storage is unavailable', async () => {
    const storage = new UnavailableStorage();
    const memory = new Map<string, PublishAttempt>();
    getPublishAttempt(
      SOURCE_ID,
      { targetShopIds: ['9'] },
      { clientRequestId: OLD_REQUEST_ID, revision: 3 },
      memory,
      storage,
    );
    const task = { taskId: '17', status: 'pending' };
    const lookup = vi.fn().mockResolvedValue(task);

    await expect(recoverPublishAttempt(SOURCE_ID, memory, lookup, storage)).resolves.toEqual({
      kind: 'recovered',
      task,
    });
    expect(lookup).toHaveBeenCalledWith(OLD_REQUEST_ID);
    clearPublishAttempt(SOURCE_ID, memory, storage);
    expect(memory.size).toBe(0);
  });

  it('keeps another source attempt when clearing the recovered source', async () => {
    const storage = new UnavailableStorage();
    const memory = new Map<string, PublishAttempt>();
    getPublishAttempt(
      SOURCE_ID,
      { sourceProductId: SOURCE_ID },
      { clientRequestId: OLD_REQUEST_ID, revision: 3 },
      memory,
      storage,
    );
    getPublishAttempt(
      OTHER_SOURCE_ID,
      { sourceProductId: OTHER_SOURCE_ID },
      { clientRequestId: NEW_REQUEST_ID, revision: 1 },
      memory,
      storage,
    );

    clearPublishAttempt(SOURCE_ID, memory, storage);
    const lookup = vi.fn().mockResolvedValue({ taskId: '29' });
    await expect(recoverPublishAttempt(OTHER_SOURCE_ID, memory, lookup, storage)).resolves.toEqual({
      kind: 'recovered',
      task: { taskId: '29' },
    });
    expect(lookup).toHaveBeenCalledWith(NEW_REQUEST_ID);
  });
});
