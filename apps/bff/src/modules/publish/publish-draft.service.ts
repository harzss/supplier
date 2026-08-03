import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma as PrismaRuntime } from '@prisma/client';
import type { Prisma } from '@supplier/db';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/prisma.module';
import { runtimeShopWhere } from '../shop/platform-adapter.factory';
import type { CreatePublishTaskDto } from './dto/create-publish-task.dto';
import type { DeletePublishDraftDto, SavePublishDraftDto } from './dto/publish-draft.dto';

type PublishDraftRecord = Prisma.PublishDraftGetPayload<{
  include: { sourceProduct: { select: { productId1688: true } } };
}>;

export interface PublishDraftView {
  clientRequestId: string;
  sourceProductId: string;
  targetShopIds: string[];
  pricingStrategy: SavePublishDraftDto['pricingStrategy'] | null;
  aiOptions: SavePublishDraftDto['aiOptions'] | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class PublishDraftService {
  private readonly demoMode: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.demoMode = (config.get<string>('AUTH_MODE') ?? 'demo') === 'demo';
  }

  async get(userId: bigint): Promise<PublishDraftView | null> {
    const draft = await this.prisma.publishDraft.findUnique({
      where: { userId },
      include: { sourceProduct: { select: { productId1688: true } } },
    });
    return draft ? toView(draft) : null;
  }

  async save(userId: bigint, dto: SavePublishDraftDto): Promise<PublishDraftView> {
    const input = normalizeDraftInput(dto);
    const product = await this.prisma.sourceProduct.findUnique({
      where: { productId1688: dto.sourceProductId },
      select: { id: true },
    });
    if (!product) {
      throw new NotFoundException({
        code: 'PUBLISH_DRAFT_PRODUCT_NOT_FOUND',
        message: '货源不存在',
      });
    }
    await this.assertSellerTargets(userId, input.targetShopIds);

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (dto.expectedRevision === 0) {
          if (dto.expectedClientRequestId) throw versionConflict();
          const existing = await tx.publishDraft.findUnique({
            where: { userId },
            include: { sourceProduct: { select: { productId1688: true } } },
          });
          if (existing) throw versionConflict();
          const created = await tx.publishDraft.create({
            data: {
              userId,
              clientRequestId: randomUUID(),
              sourceProductId: product.id,
              targetShopIds: input.targetShopIds,
              ...(input.pricingStrategy === null ? {} : { pricingStrategy: input.pricingStrategy }),
              ...(input.aiOptions === null ? {} : { aiOptions: input.aiOptions }),
            },
            include: { sourceProduct: { select: { productId1688: true } } },
          });
          return toView(created);
        }

        const existing = await this.lockExpectedDraft(
          tx,
          userId,
          dto.expectedRevision,
          dto.expectedClientRequestId,
        );
        if (matchesDraft(existing, input)) return toView(existing);

        const updated = await tx.publishDraft.updateMany({
          where: {
            userId,
            revision: dto.expectedRevision,
            clientRequestId: dto.expectedClientRequestId,
          },
          data: {
            clientRequestId: randomUUID(),
            sourceProductId: product.id,
            targetShopIds: input.targetShopIds,
            pricingStrategy:
              input.pricingStrategy === null ? PrismaRuntime.JsonNull : input.pricingStrategy,
            aiOptions: input.aiOptions === null ? PrismaRuntime.JsonNull : input.aiOptions,
            revision: { increment: 1 },
          },
        });
        if (updated.count !== 1) throw versionConflict();

        const result = await tx.publishDraft.findUniqueOrThrow({
          where: { userId },
          include: { sourceProduct: { select: { productId1688: true } } },
        });
        return toView(result);
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) throw versionConflict();
      throw error;
    }
  }

  async delete(userId: bigint, dto: DeletePublishDraftDto): Promise<{ deleted: true }> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockExpectedDraft(tx, userId, dto.expectedRevision, dto.expectedClientRequestId);
      const deleted = await tx.publishDraft.deleteMany({
        where: {
          userId,
          revision: dto.expectedRevision,
          clientRequestId: dto.expectedClientRequestId,
        },
      });
      if (deleted.count !== 1) throw versionConflict();
      return { deleted: true };
    });
  }

  async consumeForPublish(
    tx: Prisma.TransactionClient,
    userId: bigint,
    dto: CreatePublishTaskDto,
  ): Promise<void> {
    if (dto.draftRevision === undefined) return;
    const draft = await tx.publishDraft.findUnique({
      where: { userId },
      include: { sourceProduct: { select: { productId1688: true } } },
    });
    const input = normalizePublishInput(dto);
    if (
      !draft ||
      draft.revision !== dto.draftRevision ||
      !dto.clientRequestId ||
      draft.clientRequestId !== dto.clientRequestId ||
      !matchesDraft(draft, input)
    ) {
      throw staleDraft();
    }

    const deleted = await tx.publishDraft.deleteMany({
      where: {
        userId,
        revision: dto.draftRevision,
        clientRequestId: dto.clientRequestId,
      },
    });
    if (deleted.count !== 1) throw staleDraft();
  }

  private async assertSellerTargets(userId: bigint, targetShopIds: string[]): Promise<void> {
    if (targetShopIds.length === 0) return;
    const ids = targetShopIds.map((id) => BigInt(id));
    const shops = await this.prisma.shop.findMany({
      where: {
        id: { in: ids },
        userId,
        role: 'seller',
        ...runtimeShopWhere(this.demoMode),
      },
      select: { id: true },
    });
    if (shops.length !== ids.length) {
      throw new BadRequestException({
        code: 'PUBLISH_DRAFT_TARGET_INVALID',
        message: '部分目标店铺不属于当前用户或不是销售店铺',
      });
    }
  }

  private async lockExpectedDraft(
    tx: Prisma.TransactionClient,
    userId: bigint,
    revision: number,
    expectedClientRequestId: string | undefined,
  ): Promise<PublishDraftRecord> {
    if (!expectedClientRequestId) throw versionConflict();
    const locked = await tx.$queryRaw<Array<{ user_id: bigint }>>(
      PrismaRuntime.sql`
        SELECT "user_id"
        FROM "publish_drafts"
        WHERE "user_id" = ${userId}
          AND "revision" = ${revision}
          AND "client_request_id" = CAST(${expectedClientRequestId} AS UUID)
        FOR UPDATE
      `,
    );
    if (locked.length !== 1) throw versionConflict();
    const draft = await tx.publishDraft.findUnique({
      where: { userId },
      include: { sourceProduct: { select: { productId1688: true } } },
    });
    if (
      !draft ||
      draft.revision !== revision ||
      draft.clientRequestId !== expectedClientRequestId
    ) {
      throw versionConflict();
    }
    return draft;
  }
}

interface NormalizedDraftInput {
  sourceProductId: string;
  targetShopIds: string[];
  pricingStrategy: Prisma.InputJsonValue | null;
  aiOptions: Prisma.InputJsonValue | null;
}

function normalizeDraftInput(dto: SavePublishDraftDto): NormalizedDraftInput {
  return normalizeInput(dto);
}

function normalizePublishInput(dto: CreatePublishTaskDto): NormalizedDraftInput {
  return normalizeInput(dto);
}

function normalizeInput(input: {
  sourceProductId: string;
  targetShopIds: string[];
  pricingStrategy?: unknown;
  aiOptions?: unknown;
}): NormalizedDraftInput {
  const targetShopIds = [...input.targetShopIds].sort();
  if (new Set(targetShopIds).size !== targetShopIds.length) {
    throw new BadRequestException({
      code: 'PUBLISH_DRAFT_TARGET_INVALID',
      message: '目标店铺不能重复',
    });
  }
  return {
    sourceProductId: input.sourceProductId,
    targetShopIds,
    pricingStrategy: jsonInput(input.pricingStrategy),
    aiOptions: jsonInput(input.aiOptions),
  };
}

function matchesDraft(draft: PublishDraftRecord, input: NormalizedDraftInput): boolean {
  return (
    draft.sourceProduct.productId1688 === input.sourceProductId &&
    isDeepStrictEqual(jsonStringArray(draft.targetShopIds).sort(), input.targetShopIds) &&
    isDeepStrictEqual(normalizeJson(draft.pricingStrategy), normalizeJson(input.pricingStrategy)) &&
    isDeepStrictEqual(normalizeJson(draft.aiOptions), normalizeJson(input.aiOptions))
  );
}

function toView(draft: PublishDraftRecord): PublishDraftView {
  return {
    clientRequestId: draft.clientRequestId,
    sourceProductId: draft.sourceProduct.productId1688,
    targetShopIds: jsonStringArray(draft.targetShopIds).sort(),
    pricingStrategy: normalizeJson(draft.pricingStrategy) as PublishDraftView['pricingStrategy'],
    aiOptions: normalizeJson(draft.aiOptions) as PublishDraftView['aiOptions'],
    revision: draft.revision,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
}

function jsonInput(value: unknown): Prisma.InputJsonValue | null {
  return normalizeJson(value) as Prisma.InputJsonValue | null;
}

function normalizeJson(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value !== 'object') return value;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) normalized[key] = normalizeJson(item);
  }
  return normalized;
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function versionConflict(): ConflictException {
  return new ConflictException({
    code: 'PUBLISH_DRAFT_VERSION_CONFLICT',
    message: '铺货草稿已在其他页面更新，请刷新后继续',
  });
}

function staleDraft(): ConflictException {
  return new ConflictException({
    code: 'PUBLISH_DRAFT_STALE',
    message: '铺货草稿已变更，请刷新并重新检查发布条件',
  });
}

function isUniqueConstraintError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'P2002';
}
