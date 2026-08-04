import { describe, expect, it } from 'vitest';
import {
  parseSourceImportReferences,
  readSourceImportWorkbenchSession,
  shouldAcceptSourceImportPreviewResponse,
  shouldRestoreSourceImportPreview,
  sourceImportPreviewFingerprint,
  sourceImportWorkbenchStorageKey,
  writeSourceImportWorkbenchSession,
  type SourceImportSessionStorage,
} from './source-import-session';

const CLIENT_REQUEST_ID = '11111111-1111-4111-8111-111111111111';

describe('source import reference parsing', () => {
  it('normalizes official offer URLs and bare IDs while preserving first-seen order', () => {
    const parsed = parseSourceImportReferences(`
      123456
      https://detail.1688.com/offer/987654.html?spm=a2615.7691456.co_0_0
      https://m.1688.com/offer/123456.html
    `);

    expect(parsed.references).toEqual(['123456', '987654']);
    expect(parsed.inputCount).toBe(3);
    expect(parsed.issues).toEqual([
      expect.objectContaining({
        line: 4,
        code: 'duplicate',
        input: expect.stringContaining('123456'),
      }),
    ]);
    expect(parsed.overLimit).toBe(false);
  });

  it('rejects non-HTTPS, non-1688, short links, credentials, and malformed IDs', () => {
    const parsed = parseSourceImportReferences(`
      0
      http://detail.1688.com/offer/123.html
      https://example.com/offer/123.html
      https://qr.1688.com/s/abc
      https://user:pass@detail.1688.com/offer/123.html
      https://detail.1688.com:444/offer/123.html
      https://foo.1688.com/offer/123.html
      https://detail.1688.com/offer/123
      https://detail.1688.com/OFFER/123.HTML
    `);

    expect(parsed.references).toEqual([]);
    expect(parsed.issues).toHaveLength(9);
    expect(parsed.issues.every((issue) => issue.code === 'invalid')).toBe(true);
  });

  it('reports the unique 100-reference limit after de-duplication', () => {
    const input = Array.from({ length: 101 }, (_, index) => String(index + 1)).join('\n');
    const parsed = parseSourceImportReferences(input);

    expect(parsed.references).toHaveLength(101);
    expect(parsed.overLimit).toBe(true);
  });

  it('keeps fingerprints stable across reference order and distinguishes buyer accounts', () => {
    expect(sourceImportPreviewFingerprint({ references: ['2', '1'], buyerShopId: '8' })).toBe(
      sourceImportPreviewFingerprint({ references: ['1', '2'], buyerShopId: '8' }),
    );
    expect(sourceImportPreviewFingerprint({ references: ['1', '2'], buyerShopId: '8' })).not.toBe(
      sourceImportPreviewFingerprint({ references: ['1', '2'], buyerShopId: '9' }),
    );
  });

  it('ignores a preview response after the current request intent changed', () => {
    const pending = {
      fingerprint: sourceImportPreviewFingerprint({ references: ['1'], buyerShopId: '8' }),
      clientRequestId: CLIENT_REQUEST_ID,
    };

    expect(
      shouldAcceptSourceImportPreviewResponse(pending, {
        clientRequestId: CLIENT_REQUEST_ID,
        references: ['1'],
        buyerShopId: '8',
      }),
    ).toBe(true);
    expect(
      shouldAcceptSourceImportPreviewResponse(pending, {
        clientRequestId: CLIENT_REQUEST_ID,
        references: ['2'],
        buyerShopId: '8',
      }),
    ).toBe(false);
  });
});

describe('source import workbench session recovery', () => {
  it('isolates the draft and preview UUID by account and pathname', () => {
    const storage = memoryStorage();
    const scope = { accountId: 'user-a', pathname: '/sources/import' };
    const session = {
      draft: { rawInput: '123', buyerShopId: '8' },
      preview: {
        fingerprint: '{"references":["123"]}',
        clientRequestId: CLIENT_REQUEST_ID,
        taskId: '42',
      },
    };

    expect(writeSourceImportWorkbenchSession(scope, session, storage)).toBe(true);
    expect(readSourceImportWorkbenchSession(scope, storage)).toEqual(session);
    expect(
      readSourceImportWorkbenchSession(
        { accountId: 'user-b', pathname: '/sources/import' },
        storage,
      ),
    ).toBeNull();
    expect(sourceImportWorkbenchStorageKey(scope)).not.toBe(
      sourceImportWorkbenchStorageKey({ accountId: 'user-b', pathname: '/sources/import' }),
    );
  });

  it('restores only the exact preview task while it is still awaiting confirmation', () => {
    const preview = {
      fingerprint: 'fingerprint',
      clientRequestId: CLIENT_REQUEST_ID,
      taskId: '42',
    };

    expect(
      shouldRestoreSourceImportPreview(preview, {
        taskId: '42',
        clientRequestId: CLIENT_REQUEST_ID,
        status: 'preview',
      }),
    ).toBe(true);
    expect(
      shouldRestoreSourceImportPreview(preview, {
        taskId: '42',
        clientRequestId: CLIENT_REQUEST_ID,
        status: 'running',
      }),
    ).toBe(false);
  });

  it('fails closed and removes malformed session data', () => {
    const storage = memoryStorage();
    const scope = { accountId: 'user-a', pathname: '/sources/import' };
    const key = sourceImportWorkbenchStorageKey(scope);
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        accountId: 'user-a',
        pathname: '/sources/import',
        draft: { rawInput: ['not-a-string'], buyerShopId: '8' },
        preview: null,
      }),
    );

    expect(readSourceImportWorkbenchSession(scope, storage)).toBeNull();
    expect(storage.getItem(key)).toBeNull();
  });

  it('fails closed when persisted input exceeds the UI limit or the buyer ID is malformed', () => {
    const storage = memoryStorage();
    const scope = { accountId: 'user-a', pathname: '/sources/import' };
    const key = sourceImportWorkbenchStorageKey(scope);
    for (const draft of [
      { rawInput: '1'.repeat(20_001), buyerShopId: '8' },
      { rawInput: '123', buyerShopId: 'not-a-shop-id' },
    ]) {
      storage.setItem(
        key,
        JSON.stringify({
          version: 1,
          accountId: 'user-a',
          pathname: '/sources/import',
          draft,
          preview: null,
        }),
      );
      expect(readSourceImportWorkbenchSession(scope, storage)).toBeNull();
      expect(storage.getItem(key)).toBeNull();
    }
  });
});

function memoryStorage(): SourceImportSessionStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
