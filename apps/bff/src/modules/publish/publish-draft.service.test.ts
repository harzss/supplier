import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import { PublishDraftService } from './publish-draft.service';

const CREATED_AT = new Date('2026-08-04T01:00:00.000Z');
const UPDATED_AT = new Date('2026-08-04T01:05:00.000Z');
const REQUEST_ID = '8a4d5b1e-7d9a-4e60-9f81-3ce8f3f5a2d1';

describe('PublishDraftService', () => {
  it('creates an incomplete current-user draft with a server request id', async () => {
    const fixture = createFixture({ existing: null });
    fixture.tx.publishDraft.create.mockImplementation(({ data }) =>
      Promise.resolve(
        record({
          ...data,
          clientRequestId: REQUEST_ID,
          sourceProduct: { productId1688: '1688-1' },
        }),
      ),
    );

    await expect(
      fixture.service.save(1n, {
        expectedRevision: 0,
        sourceProductId: '1688-1',
        targetShopIds: [],
        pricingStrategy: { mode: 'fixed_markup', markupRatio: 0.5 },
      }),
    ).resolves.toMatchObject({
      clientRequestId: REQUEST_ID,
      sourceProductId: '1688-1',
      targetShopIds: [],
      revision: 1,
    });

    expect(fixture.prisma.shop.findMany).not.toHaveBeenCalled();
    expect(fixture.tx.publishDraft.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 1n,
        sourceProductId: 2n,
        targetShopIds: [],
      }),
      include: { sourceProduct: { select: { productId1688: true } } },
    });
  });

  it('returns an exact same-revision save as a no-op', async () => {
    const existing = record({
      targetShopIds: ['10', '9'],
      pricingStrategy: { markupRatio: 0.5, mode: 'fixed_markup' },
      aiOptions: { rewriteTitle: true },
    });
    const fixture = createFixture({ existing });

    const result = await fixture.service.save(1n, {
      expectedRevision: 1,
      expectedClientRequestId: REQUEST_ID,
      sourceProductId: '1688-1',
      targetShopIds: ['9', '10'],
      pricingStrategy: { mode: 'fixed_markup', markupRatio: 0.5 },
      aiOptions: { rewriteTitle: true },
    });

    expect(result.clientRequestId).toBe(REQUEST_ID);
    expect(result.revision).toBe(1);
    expect(fixture.tx.publishDraft.updateMany).not.toHaveBeenCalled();
  });

  it('uses a conditional revision update and rejects a concurrent loser', async () => {
    const fixture = createFixture({
      existing: record({ pricingStrategy: { mode: 'fixed_markup', markupRatio: 0.5 } }),
    });
    fixture.tx.publishDraft.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      fixture.service.save(1n, {
        expectedRevision: 1,
        expectedClientRequestId: REQUEST_ID,
        sourceProductId: '1688-1',
        targetShopIds: ['9'],
        pricingStrategy: { mode: 'fixed_markup', markupRatio: 0.6 },
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'PUBLISH_DRAFT_VERSION_CONFLICT' },
    });
  });

  it('increments the revision and rotates the request id when content changes', async () => {
    const fixture = createFixture({
      existing: record({ pricingStrategy: { mode: 'fixed_markup', markupRatio: 0.5 } }),
      shops: [{ id: 9n }],
    });
    const nextRequestId = 'f28f4a47-9a8f-43e4-8f87-2d9d78ab8d5f';
    fixture.tx.publishDraft.findUniqueOrThrow.mockResolvedValue(
      record({
        clientRequestId: nextRequestId,
        revision: 2,
        pricingStrategy: { mode: 'fixed_markup', markupRatio: 0.6 },
      }),
    );

    await expect(
      fixture.service.save(1n, {
        expectedRevision: 1,
        expectedClientRequestId: REQUEST_ID,
        sourceProductId: '1688-1',
        targetShopIds: ['9'],
        pricingStrategy: { mode: 'fixed_markup', markupRatio: 0.6 },
      }),
    ).resolves.toMatchObject({ clientRequestId: nextRequestId, revision: 2 });

    expect(fixture.tx.publishDraft.updateMany).toHaveBeenCalledWith({
      where: { userId: 1n, revision: 1, clientRequestId: REQUEST_ID },
      data: expect.objectContaining({
        clientRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        revision: { increment: 1 },
      }),
    });
  });

  it('rejects a concurrent no-op when the expected generation no longer locks', async () => {
    const fixture = createFixture({ existing: record() });
    fixture.tx.$queryRaw.mockResolvedValueOnce([]);

    await expect(
      fixture.service.save(1n, {
        expectedRevision: 1,
        expectedClientRequestId: REQUEST_ID,
        sourceProductId: '1688-1',
        targetShopIds: ['9'],
        pricingStrategy: { mode: 'fixed_markup', markupRatio: 0.5 },
        aiOptions: { rewriteTitle: true },
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'PUBLISH_DRAFT_VERSION_CONFLICT' },
    });

    expect(fixture.tx.publishDraft.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an old delete after a draft was deleted and rebuilt at revision one', async () => {
    const rebuiltRequestId = 'f28f4a47-9a8f-43e4-8f87-2d9d78ab8d5f';
    const fixture = createFixture({
      existing: record({ clientRequestId: rebuiltRequestId, revision: 1 }),
    });
    fixture.tx.$queryRaw.mockResolvedValueOnce([]);

    await expect(
      fixture.service.delete(1n, {
        expectedRevision: 1,
        expectedClientRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'PUBLISH_DRAFT_VERSION_CONFLICT' },
    });

    expect(fixture.tx.publishDraft.deleteMany).not.toHaveBeenCalled();
  });

  it('rejects a target that is not a current-user seller shop', async () => {
    const fixture = createFixture({ existing: null, shops: [] });

    await expect(
      fixture.service.save(1n, {
        expectedRevision: 0,
        sourceProductId: '1688-1',
        targetShopIds: ['99'],
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'PUBLISH_DRAFT_TARGET_INVALID' },
    });

    expect(fixture.prisma.shop.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: [99n] },
        userId: 1n,
        role: 'seller',
        NOT: { platformShopId: { startsWith: 'demo-' } },
      },
      select: { id: true },
    });
    expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('consumes only the exact draft revision, request id and payload', async () => {
    const fixture = createFixture({ existing: record() });
    const dto = {
      draftRevision: 1,
      clientRequestId: REQUEST_ID,
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
      pricingStrategy: { mode: 'fixed_markup' as const, markupRatio: 0.5 },
      aiOptions: { rewriteTitle: true },
    };

    await expect(fixture.service.consumeForPublish(fixture.tx, 1n, dto)).resolves.toBeUndefined();
    expect(fixture.tx.publishDraft.deleteMany).toHaveBeenCalledWith({
      where: { userId: 1n, revision: 1, clientRequestId: REQUEST_ID },
    });

    fixture.tx.publishDraft.findUnique.mockResolvedValueOnce(record({ revision: 2 }));
    await expect(fixture.service.consumeForPublish(fixture.tx, 1n, dto)).rejects.toMatchObject({
      status: 409,
      response: { code: 'PUBLISH_DRAFT_STALE' },
    });
  });
});

function createFixture({
  existing = record(),
  shops = [{ id: 9n }, { id: 10n }],
}: {
  existing?: ReturnType<typeof record> | null;
  shops?: Array<{ id: bigint }>;
} = {}) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue(existing ? [{ user_id: 1n }] : []),
    publishDraft: {
      findUnique: vi.fn().mockResolvedValue(existing),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    publishDraft: {
      findUnique: vi.fn().mockResolvedValue(existing),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    sourceProduct: { findUnique: vi.fn().mockResolvedValue({ id: 2n }) },
    shop: {
      findMany: vi.fn().mockImplementation(({ where }) => {
        const requested = new Set((where.id.in as bigint[]).map(String));
        return Promise.resolve(shops.filter((shop) => requested.has(shop.id.toString())));
      }),
    },
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
  };
  const service = new PublishDraftService(
    prisma as unknown as PrismaService,
    {
      get: vi.fn((key: string) => (key === 'AUTH_MODE' ? 'supabase' : undefined)),
    } as unknown as ConfigService,
  );
  return { service, prisma, tx };
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    userId: 1n,
    clientRequestId: REQUEST_ID,
    sourceProductId: 2n,
    targetShopIds: ['9'],
    pricingStrategy: { mode: 'fixed_markup', markupRatio: 0.5 },
    aiOptions: { rewriteTitle: true },
    revision: 1,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    sourceProduct: { productId1688: '1688-1' },
    ...overrides,
  };
}
