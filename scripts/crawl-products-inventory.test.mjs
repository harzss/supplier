import assert from 'node:assert/strict';
import test from 'node:test';
import {
  persistCrawledProduct,
  persistOfflineProduct,
  queueInventorySync,
} from './crawl-products-inventory.mjs';

const NOW = new Date('2026-08-04T12:00:00.000Z');

test('persists the source update and repairs a lagging published target in one transaction', async () => {
  const events = [];
  const tx = {
    sourceProduct: {
      findUnique: async () => {
        events.push('source-read');
        return {
          availability: 'available',
          inventoryFingerprint: 'fingerprint-v4',
          inventoryVersion: 4,
        };
      },
      upsert: async (input) => {
        events.push('source-upsert');
        assert.equal(input.update.inventoryVersion, 4);
        return { id: 7n };
      },
    },
    publishedProduct: {
      updateMany: async (input) => {
        events.push(input.where.status === 'online' ? 'queue-online' : 'record-non-online');
        return { count: 1 };
      },
    },
  };
  const prisma = {
    $transaction: async (callback) => {
      events.push('transaction-start');
      const result = await callback(tx);
      events.push('transaction-commit');
      return result;
    },
  };

  await persistCrawledProduct(
    prisma,
    {
      productId1688: '1688-1',
      supplierId: 'supplier-1',
      title: '测试商品',
      price: 10,
      skuList: [{ skuId: 'sku-1', stock: 5 }],
    },
    { availability: 'available', totalStock: 5, fingerprint: 'fingerprint-v4' },
    NOW,
  );

  assert.deepEqual(events, [
    'transaction-start',
    'source-read',
    'source-upsert',
    'queue-online',
    'record-non-online',
    'transaction-commit',
  ]);
});

test('queues online products but only records the target for non-online products', async () => {
  const calls = [];
  const tx = {
    publishedProduct: {
      updateMany: async (input) => {
        calls.push(input);
        return { count: 1 };
      },
    },
  };

  await queueInventorySync(tx, 7n, 'fingerprint-v5', 5, NOW);

  assert.deepEqual(calls[0].where, {
    sourceProductId: 7n,
    status: 'online',
    OR: [
      { inventoryTargetFingerprint: null },
      { inventoryTargetFingerprint: { not: 'fingerprint-v5' } },
      { inventoryTargetVersion: { not: 5 } },
    ],
  });
  assert.deepEqual(calls[0].data, {
    inventorySyncStatus: 'pending',
    inventoryTargetFingerprint: 'fingerprint-v5',
    inventoryTargetVersion: 5,
    inventorySyncAttempts: 0,
    inventoryNextRunAt: NOW,
    inventoryLockedAt: null,
    inventoryLockedBy: null,
    inventorySyncError: null,
  });
  assert.deepEqual(calls[1].where, {
    sourceProductId: 7n,
    status: { not: 'online' },
    OR: [
      { inventoryTargetFingerprint: null },
      { inventoryTargetFingerprint: { not: 'fingerprint-v5' } },
      { inventoryTargetVersion: { not: 5 } },
    ],
  });
  assert.deepEqual(calls[1].data, {
    inventoryTargetFingerprint: 'fingerprint-v5',
    inventoryTargetVersion: 5,
  });
});

test('persists an offline source and its published targets atomically even when already fingerprinted', async () => {
  const events = [];
  const tx = {
    sourceProduct: {
      findUnique: async () => ({
        id: 7n,
        availability: 'offline',
        inventoryFingerprint: 'offline-v2',
        inventoryVersion: 2,
      }),
      update: async (input) => {
        events.push('source-update');
        assert.equal(input.data.inventoryVersion, 2);
      },
    },
    publishedProduct: {
      updateMany: async () => {
        events.push('target-update');
        return { count: 1 };
      },
    },
  };
  const prisma = {
    $transaction: async (callback) => callback(tx),
  };

  await persistOfflineProduct(
    prisma,
    '1688-1',
    { availability: 'offline', totalStock: 0, fingerprint: 'offline-v2' },
    NOW,
  );

  assert.deepEqual(events, ['source-update', 'target-update', 'target-update']);
});
