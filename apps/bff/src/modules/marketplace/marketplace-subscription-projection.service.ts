import { Injectable } from '@nestjs/common';
import {
  projectMarketplaceLifecycle,
  type MarketplaceLifecycleEvent,
  type MarketplaceLifecycleProjection,
} from '@supplier/entitlements';
import { Prisma } from '@supplier/db';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma.module';
import { AlertService } from '../observability/alert.service';
import type { MarketplaceClaim } from './marketplace-event-inbox.service';

const MAX_TRANSACTION_ATTEMPTS = 3;

export type MarketplaceProjectionProcessResult =
  | { outcome: 'applied'; eventId: bigint; projectionId: bigint }
  | { outcome: 'ignored_stale'; eventId: bigint; projectionId: bigint }
  | { outcome: 'blocked'; eventId: bigint; code: string };

export class MarketplaceProjectionProcessingError extends Error {
  constructor(
    readonly code: 'CLAIM.OWNER_LOST' | 'PROJECTION.CAS_CONFLICT' | 'USER.CAS_CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'MarketplaceProjectionProcessingError';
  }
}

interface TransactionResult {
  result: MarketplaceProjectionProcessResult;
  blockedAlert?: {
    code: string;
    provider: string;
    integrationKey: string;
  };
}

@Injectable()
export class MarketplaceSubscriptionProjectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertService,
  ) {}

  async processClaim(claim: MarketplaceClaim): Promise<MarketplaceProjectionProcessResult> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt++) {
      try {
        const transactionResult = await this.prisma.$transaction(
          (transaction) => this.processTransaction(transaction, claim, new Date()),
          { isolationLevel: 'Serializable' },
        );
        if (transactionResult.blockedAlert) {
          await this.raiseBlockedAlert(claim.event.id, transactionResult.blockedAlert);
        }
        return transactionResult.result;
      } catch (error) {
        lastError = error;
        if (!isRetryableTransactionConflict(error) || attempt === MAX_TRANSACTION_ATTEMPTS) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  private async processTransaction(
    transaction: Prisma.TransactionClient,
    claim: MarketplaceClaim,
    now: Date,
  ): Promise<TransactionResult> {
    const event = await transaction.marketplaceEventInbox.findFirst({
      where: { id: claim.event.id, status: 'processing', lockedBy: claim.ownerToken },
      select: {
        id: true,
        provider: true,
        integrationKey: true,
        normalizedKind: true,
        authoritativeState: true,
        externalAccountKey: true,
        externalSubscriptionKey: true,
        providerPlanKey: true,
        providerRevision: true,
        occurredAt: true,
        accountBindingId: true,
        planMappingId: true,
        projectionId: true,
      },
    });
    if (!event) {
      throw new MarketplaceProjectionProcessingError(
        'CLAIM.OWNER_LOST',
        'marketplace claim is no longer owned by this processor',
      );
    }

    const missing = requiredEventFields(event);
    if (missing) return this.blockEvent(transaction, claim, event, missing, now);

    const binding = await transaction.marketplaceAccountBinding.findFirst({
      where: {
        provider: event.provider,
        integrationKey: event.integrationKey,
        externalAccountKey: event.externalAccountKey!,
      },
      select: { id: true, userId: true, status: true },
    });
    if (!binding) {
      return this.blockEvent(transaction, claim, event, 'BINDING.NOT_FOUND', now);
    }
    if (binding.status !== 'active') {
      return this.blockEvent(transaction, claim, event, 'BINDING.NOT_ACTIVE', now);
    }
    if (event.accountBindingId !== null && event.accountBindingId !== binding.id) {
      return this.blockEvent(transaction, claim, event, 'BINDING.MISMATCH', now);
    }

    const mapping = await transaction.marketplacePlanMapping.findFirst({
      where: {
        provider: event.provider,
        integrationKey: event.integrationKey,
        providerPlanKey: event.providerPlanKey!,
      },
      select: { id: true, internalPlan: true, enabled: true },
    });
    if (!mapping) {
      return this.blockEvent(transaction, claim, event, 'PLAN_MAPPING.NOT_FOUND', now);
    }
    if (!mapping.enabled) {
      return this.blockEvent(transaction, claim, event, 'PLAN_MAPPING.NOT_ENABLED', now);
    }
    if (event.planMappingId !== null && event.planMappingId !== mapping.id) {
      return this.blockEvent(transaction, claim, event, 'PLAN_MAPPING.MISMATCH', now);
    }

    const user = await transaction.user.findUnique({
      where: { id: binding.userId },
      select: { id: true, status: true, entitlementRevision: true },
    });
    if (!user) return this.blockEvent(transaction, claim, event, 'USER.NOT_FOUND', now);

    const projectionKey = marketplaceProjectionKey(
      event.provider,
      event.integrationKey,
      event.externalSubscriptionKey!,
    );
    const current = await transaction.marketplaceSubscriptionProjection.findUnique({
      where: { projectionKey },
    });
    if (current) {
      const mismatch = projectionMismatch(current, event, binding.id, binding.userId);
      if (mismatch) return this.blockEvent(transaction, claim, event, mismatch, now);
    } else if (event.projectionId !== null) {
      return this.blockEvent(transaction, claim, event, 'PROJECTION.MISMATCH', now);
    }

    let lifecycle;
    try {
      lifecycle = projectMarketplaceLifecycle(
        current
          ? ({
              state: current.lifecycleState,
              revision: current.providerRevision!.toFixed(0),
            } satisfies MarketplaceLifecycleProjection)
          : null,
        {
          kind: event.normalizedKind!,
          revision: event.providerRevision!.toFixed(0),
          ...(event.authoritativeState ? { authoritativeState: event.authoritativeState } : {}),
        } satisfies MarketplaceLifecycleEvent,
      );
    } catch {
      return this.blockEvent(transaction, claim, event, 'EVENT.LIFECYCLE_INVALID', now);
    }

    if (lifecycle.outcome === 'blocked_conflict') {
      return this.blockEvent(transaction, claim, event, 'LIFECYCLE.CONFLICT', now);
    }
    if (lifecycle.outcome === 'ignored_stale' || lifecycle.outcome === 'idempotent_replay') {
      if (!current) {
        return this.blockEvent(transaction, claim, event, 'PROJECTION.NOT_FOUND', now);
      }
      await this.finishEvent(
        transaction,
        claim,
        'ignored_stale',
        now,
        binding.id,
        mapping.id,
        current.id,
      );
      return {
        result: { outcome: 'ignored_stale', eventId: event.id, projectionId: current.id },
      };
    }

    const projected = lifecycle.projection!;
    let projectionId: bigint;
    if (!current) {
      const created = await transaction.marketplaceSubscriptionProjection.create({
        data: {
          projectionKey,
          origin: 'marketplace',
          provider: event.provider,
          integrationKey: event.integrationKey,
          externalSubscriptionKey: event.externalSubscriptionKey!,
          accountBindingId: binding.id,
          planMappingId: mapping.id,
          userId: binding.userId,
          internalPlan: mapping.internalPlan,
          lifecycleState: projected.state,
          accessStatus: lifecycle.access,
          providerRevision: new Prisma.Decimal(projected.revision),
          projectionRevision: 1,
          lastEventOccurredAt: event.occurredAt,
          ...(event.normalizedKind === 'reconciled' ? { lastReconciledAt: now } : {}),
          createdAt: now,
          updatedAt: now,
        },
        select: { id: true },
      });
      projectionId = created.id;
    } else {
      const updated = await transaction.marketplaceSubscriptionProjection.updateMany({
        where: { id: current.id, projectionRevision: current.projectionRevision },
        data: {
          planMappingId: mapping.id,
          internalPlan: mapping.internalPlan,
          lifecycleState: projected.state,
          accessStatus: lifecycle.access,
          providerRevision: new Prisma.Decimal(projected.revision),
          projectionRevision: { increment: 1 },
          lastEventOccurredAt: event.occurredAt,
          ...(event.normalizedKind === 'reconciled' ? { lastReconciledAt: now } : {}),
          updatedAt: now,
        },
      });
      if (updated.count !== 1) {
        throw new MarketplaceProjectionProcessingError(
          'PROJECTION.CAS_CONFLICT',
          'marketplace projection changed during processing',
        );
      }
      projectionId = current.id;
    }

    const userUpdated = await transaction.user.updateMany({
      where: { id: user.id, entitlementRevision: user.entitlementRevision },
      data: {
        entitlementSource: 'marketplace',
        entitlementAccessStatus: lifecycle.access,
        plan: lifecycle.access === 'active' ? mapping.internalPlan : 'free',
        entitlementRevision: { increment: 1 },
        entitlementUpdatedAt: now,
      },
    });
    if (userUpdated.count !== 1) {
      throw new MarketplaceProjectionProcessingError(
        'USER.CAS_CONFLICT',
        'marketplace user entitlement changed during processing',
      );
    }

    await this.finishEvent(
      transaction,
      claim,
      'applied',
      now,
      binding.id,
      mapping.id,
      projectionId,
    );
    return { result: { outcome: 'applied', eventId: event.id, projectionId } };
  }

  private async blockEvent(
    transaction: Prisma.TransactionClient,
    claim: MarketplaceClaim,
    event: { id: bigint; provider: string; integrationKey: string },
    code: string,
    now: Date,
  ): Promise<TransactionResult> {
    const updated = await transaction.marketplaceEventInbox.updateMany({
      where: { id: event.id, status: 'processing', lockedBy: claim.ownerToken },
      data: {
        status: 'blocked',
        nextAttemptAt: null,
        lockedAt: null,
        lockedBy: null,
        processedAt: now,
        lastErrorCode: code,
        updatedAt: now,
      },
    });
    if (updated.count !== 1) throw ownerLost();
    return {
      result: { outcome: 'blocked', eventId: event.id, code },
      blockedAlert: { code, provider: event.provider, integrationKey: event.integrationKey },
    };
  }

  private async finishEvent(
    transaction: Prisma.TransactionClient,
    claim: MarketplaceClaim,
    status: 'applied' | 'ignored_stale',
    now: Date,
    accountBindingId: bigint,
    planMappingId: bigint,
    projectionId: bigint,
  ): Promise<void> {
    const updated = await transaction.marketplaceEventInbox.updateMany({
      where: { id: claim.event.id, status: 'processing', lockedBy: claim.ownerToken },
      data: {
        status,
        accountBindingId,
        planMappingId,
        projectionId,
        nextAttemptAt: null,
        lockedAt: null,
        lockedBy: null,
        processedAt: now,
        lastErrorCode: null,
        updatedAt: now,
      },
    });
    if (updated.count !== 1) throw ownerLost();
  }

  private async raiseBlockedAlert(
    eventId: bigint,
    blocked: NonNullable<TransactionResult['blockedAlert']>,
  ): Promise<void> {
    const identity = createHash('sha256')
      .update(`${blocked.provider}\u0000${blocked.integrationKey}\u0000${eventId.toString()}`)
      .digest('hex');
    await this.alerts.raise({
      key: `marketplace.projection.blocked.${identity.slice(0, 32)}`,
      type: 'entitlement',
      severity: 'critical',
      summary: '服务市场权益事件无法安全投影',
      details: {
        eventId: eventId.toString(),
        code: blocked.code,
        provider: blocked.provider,
        integrationKey: blocked.integrationKey,
      },
    });
  }
}

function requiredEventFields(event: {
  normalizedKind: string | null;
  authoritativeState: string | null;
  externalAccountKey: string | null;
  externalSubscriptionKey: string | null;
  providerPlanKey: string | null;
  providerRevision: Prisma.Decimal | null;
}): string | null {
  if (!event.normalizedKind) return 'EVENT.KIND_MISSING';
  if (!event.externalAccountKey) return 'EVENT.ACCOUNT_KEY_MISSING';
  if (!event.externalSubscriptionKey) return 'EVENT.SUBSCRIPTION_KEY_MISSING';
  if (!event.providerPlanKey) return 'EVENT.PLAN_KEY_MISSING';
  if (!event.providerRevision) return 'EVENT.REVISION_MISSING';
  if (event.normalizedKind === 'reconciled' && !event.authoritativeState) {
    return 'EVENT.AUTHORITATIVE_STATE_MISSING';
  }
  if (event.normalizedKind !== 'reconciled' && event.authoritativeState) {
    return 'EVENT.AUTHORITATIVE_STATE_INVALID';
  }
  return null;
}

function projectionMismatch(
  projection: {
    origin: string;
    provider: string | null;
    integrationKey: string | null;
    externalSubscriptionKey: string | null;
    accountBindingId: bigint | null;
    userId: bigint;
    id: bigint;
  },
  event: {
    provider: string;
    integrationKey: string;
    externalSubscriptionKey: string | null;
    projectionId: bigint | null;
  },
  bindingId: bigint,
  userId: bigint,
): string | null {
  if (projection.origin !== 'marketplace') return 'PROJECTION.ORIGIN_MISMATCH';
  if (
    projection.provider !== event.provider ||
    projection.integrationKey !== event.integrationKey ||
    projection.externalSubscriptionKey !== event.externalSubscriptionKey
  ) {
    return 'PROJECTION.IDENTITY_MISMATCH';
  }
  if (projection.accountBindingId !== bindingId) return 'PROJECTION.BINDING_MISMATCH';
  if (projection.userId !== userId) return 'PROJECTION.USER_MISMATCH';
  if (event.projectionId !== null && event.projectionId !== projection.id) {
    return 'PROJECTION.MISMATCH';
  }
  return null;
}

function marketplaceProjectionKey(
  provider: string,
  integrationKey: string,
  externalSubscriptionKey: string,
): string {
  const hash = createHash('sha256');
  for (const value of [provider, integrationKey, externalSubscriptionKey]) {
    const encoded = Buffer.from(value, 'utf8');
    hash.update(Buffer.from(`${encoded.byteLength}:`, 'ascii'));
    hash.update(encoded);
  }
  return hash.digest('hex');
}

function isRetryableTransactionConflict(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'P2034' || code === 'PROJECTION.CAS_CONFLICT' || code === 'USER.CAS_CONFLICT';
}

function ownerLost(): MarketplaceProjectionProcessingError {
  return new MarketplaceProjectionProcessingError(
    'CLAIM.OWNER_LOST',
    'marketplace claim ownership was lost before commit',
  );
}
