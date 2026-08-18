import { Injectable } from '@nestjs/common';
import { Prisma } from '@supplier/db';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/prisma.module';
import { AlertService } from '../observability/alert.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSITIVE_DECIMAL_REVISION = /^[1-9]\d{0,38}$/;
const SAFE_CODE = /^[A-Z0-9_.:-]+$/;
export const MARKETPLACE_MAX_RAW_PAYLOAD_BYTES = 1024 * 1024;
const SENSITIVE_PAYLOAD_KEY =
  /authorization|cookie|password|secret|token|api.?key|credential|signature|raw.?payload/i;

const RECEIPT_SELECT = {
  id: true,
  provider: true,
  integrationKey: true,
  dedupeKey: true,
  payloadDigest: true,
  status: true,
  deliveryCount: true,
  conflictCount: true,
  lastConflictDigest: true,
  lastReceivedAt: true,
} satisfies Prisma.MarketplaceEventInboxSelect;

type MarketplaceEventReceipt = Prisma.MarketplaceEventInboxGetPayload<{
  select: typeof RECEIPT_SELECT;
}>;

export type MarketplaceProviderInput = 'alibaba_1688';
export type MarketplaceEventSourceInput = 'callback' | 'reconciliation' | 'manual_repair';
export type MarketplaceEventKindInput =
  | 'trial_started'
  | 'subscribed'
  | 'renewed'
  | 'cancelling'
  | 'refunded'
  | 'expired'
  | 'cancelled'
  | 'uninstalled'
  | 'reconciled';
export type MarketplaceLifecycleStateInput =
  | 'trialing'
  | 'active'
  | 'cancelling'
  | 'refunded'
  | 'expired'
  | 'cancelled'
  | 'uninstalled';

export interface VerifiedMarketplaceEventInput {
  provider: MarketplaceProviderInput;
  integrationKey: string;
  dedupeKey: string;
  rawPayload: Buffer;
  source: MarketplaceEventSourceInput;
  verifierVersion?: string;
  signatureVerifiedAt?: Date;
  externalEventId?: string;
  externalEventType?: string;
  normalizedKind?: MarketplaceEventKindInput;
  authoritativeState?: MarketplaceLifecycleStateInput;
  externalAccountKey?: string;
  externalSubscriptionKey?: string;
  providerPlanKey?: string;
  providerRevision?: string;
  occurredAt?: Date;
  normalizedPayload?: unknown;
  accountBindingId?: bigint;
  planMappingId?: bigint;
  projectionId?: bigint;
  requestId?: string;
  maxAttempts?: number;
}

export interface ReceiveMarketplaceEventResult {
  outcome: 'created' | 'replay' | 'conflict';
  event: MarketplaceEventReceipt;
}

export interface MarketplaceClaimedEvent {
  id: bigint;
  provider: MarketplaceProviderInput;
  integrationKey: string;
  dedupeKey: string;
  payloadDigest: string;
  source: MarketplaceEventSourceInput;
  externalEventType: string | null;
  normalizedKind: MarketplaceEventKindInput | null;
  authoritativeState: MarketplaceLifecycleStateInput | null;
  externalAccountKey: string | null;
  externalSubscriptionKey: string | null;
  providerPlanKey: string | null;
  providerRevision: string | null;
  occurredAt: Date | null;
  normalizedPayload: Prisma.JsonValue | null;
  accountBindingId: bigint | null;
  planMappingId: bigint | null;
  projectionId: bigint | null;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
}

export interface MarketplaceClaim {
  ownerToken: string;
  event: MarketplaceClaimedEvent;
}

export interface MarketplaceExpiredClaimRecovery {
  recovered: number;
  retryWait: number;
  dead: number;
}

export interface MarkMarketplaceEventAppliedInput {
  normalizedKind: MarketplaceEventKindInput;
  authoritativeState?: MarketplaceLifecycleStateInput;
  providerRevision: string;
  accountBindingId: bigint;
  planMappingId: bigint;
  projectionId: bigint;
  occurredAt?: Date;
  normalizedPayload?: unknown;
  processedAt?: Date;
}

@Injectable()
export class MarketplaceEventInboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertService,
  ) {}

  async receiveVerified(
    input: VerifiedMarketplaceEventInput,
  ): Promise<ReceiveMarketplaceEventResult> {
    const normalized = normalizeReceiveInput(input);
    try {
      const event = await this.prisma.marketplaceEventInbox.create({
        data: normalized.data,
        select: RECEIPT_SELECT,
      });
      return { outcome: 'created', event };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      return this.resolveDuplicate(normalized.identity, normalized.payloadDigest, error);
    }
  }

  async claim(
    eventId: bigint,
    options: { now?: Date; ownerToken?: string } = {},
  ): Promise<MarketplaceClaim | null> {
    assertPositiveId(eventId, 'marketplace event');
    const now = validDate(options.now ?? new Date(), 'claim time');
    const ownerToken = options.ownerToken ?? randomUUID();
    if (!UUID.test(ownerToken)) throw new Error('marketplace claim owner token must be a UUID');

    const rows = await this.prisma.$queryRaw<MarketplaceClaimedEvent[]>`
      UPDATE "marketplace_event_inbox"
      SET
        "status" = 'processing'::"MarketplaceEventStatus",
        "attempts" = "attempts" + 1,
        "next_attempt_at" = NULL,
        "locked_at" = ${now},
        "locked_by" = ${ownerToken},
        "processed_at" = NULL,
        "last_error_code" = NULL,
        "updated_at" = ${now}
      WHERE "id" = ${eventId}
        AND "attempts" < "max_attempts"
        AND (
          "status" = 'received'::"MarketplaceEventStatus"
          OR (
            "status" = 'retry_wait'::"MarketplaceEventStatus"
            AND "next_attempt_at" <= ${now}
          )
        )
      RETURNING
        "id",
        "provider"::text AS "provider",
        "integration_key" AS "integrationKey",
        "dedupe_key" AS "dedupeKey",
        "payload_digest" AS "payloadDigest",
        "source"::text AS "source",
        "external_event_type" AS "externalEventType",
        "normalized_kind"::text AS "normalizedKind",
        "authoritative_state"::text AS "authoritativeState",
        "external_account_key" AS "externalAccountKey",
        "external_subscription_key" AS "externalSubscriptionKey",
        "provider_plan_key" AS "providerPlanKey",
        "provider_revision"::text AS "providerRevision",
        "occurred_at" AS "occurredAt",
        "normalized_payload" AS "normalizedPayload",
        "account_binding_id" AS "accountBindingId",
        "plan_mapping_id" AS "planMappingId",
        "projection_id" AS "projectionId",
        "attempts",
        "max_attempts" AS "maxAttempts",
        "created_at" AS "createdAt"
    `;
    return rows[0] ? { ownerToken, event: rows[0] } : null;
  }

  async claimNext(
    options: { now?: Date; ownerToken?: string } = {},
  ): Promise<MarketplaceClaim | null> {
    const now = validDate(options.now ?? new Date(), 'claim time');
    const ownerToken = options.ownerToken ?? randomUUID();
    if (!UUID.test(ownerToken)) throw new Error('marketplace claim owner token must be a UUID');

    const rows = await this.prisma.$queryRaw<MarketplaceClaimedEvent[]>`
      UPDATE "marketplace_event_inbox"
      SET
        "status" = 'processing'::"MarketplaceEventStatus",
        "attempts" = "attempts" + 1,
        "next_attempt_at" = NULL,
        "locked_at" = ${now},
        "locked_by" = ${ownerToken},
        "processed_at" = NULL,
        "last_error_code" = NULL,
        "updated_at" = ${now}
      WHERE "id" = (
        SELECT candidate."id"
        FROM "marketplace_event_inbox" AS candidate
        WHERE candidate."attempts" < candidate."max_attempts"
          AND (
            candidate."status" = 'received'::"MarketplaceEventStatus"
            OR (
              candidate."status" = 'retry_wait'::"MarketplaceEventStatus"
              AND candidate."next_attempt_at" <= ${now}
            )
          )
        ORDER BY candidate."created_at", candidate."id"
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING
        "id",
        "provider"::text AS "provider",
        "integration_key" AS "integrationKey",
        "dedupe_key" AS "dedupeKey",
        "payload_digest" AS "payloadDigest",
        "source"::text AS "source",
        "external_event_type" AS "externalEventType",
        "normalized_kind"::text AS "normalizedKind",
        "authoritative_state"::text AS "authoritativeState",
        "external_account_key" AS "externalAccountKey",
        "external_subscription_key" AS "externalSubscriptionKey",
        "provider_plan_key" AS "providerPlanKey",
        "provider_revision"::text AS "providerRevision",
        "occurred_at" AS "occurredAt",
        "normalized_payload" AS "normalizedPayload",
        "account_binding_id" AS "accountBindingId",
        "plan_mapping_id" AS "planMappingId",
        "projection_id" AS "projectionId",
        "attempts",
        "max_attempts" AS "maxAttempts",
        "created_at" AS "createdAt"
    `;
    return rows[0] ? { ownerToken, event: rows[0] } : null;
  }

  async markApplied(
    eventId: bigint,
    ownerToken: string,
    input: MarkMarketplaceEventAppliedInput,
  ): Promise<boolean> {
    const processedAt = validDate(input.processedAt ?? new Date(), 'processed time');
    const providerRevision = decimalRevision(input.providerRevision);
    const normalizedPayload = sanitizeNormalizedPayload(input.normalizedPayload);
    assertAuthoritativeState(input.normalizedKind, input.authoritativeState);
    for (const [label, value] of [
      ['account binding', input.accountBindingId],
      ['plan mapping', input.planMappingId],
      ['subscription projection', input.projectionId],
    ] as const) {
      assertPositiveId(value, label);
    }
    if (input.occurredAt) validDate(input.occurredAt, 'event occurrence time');

    return this.ownedUpdate(eventId, ownerToken, {
      status: 'applied',
      normalizedKind: input.normalizedKind,
      authoritativeState: input.authoritativeState ?? null,
      providerRevision,
      accountBindingId: input.accountBindingId,
      planMappingId: input.planMappingId,
      projectionId: input.projectionId,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      ...(normalizedPayload === undefined ? {} : { normalizedPayload }),
      nextAttemptAt: null,
      lockedAt: null,
      lockedBy: null,
      processedAt,
      lastErrorCode: null,
      updatedAt: processedAt,
    });
  }

  markIgnoredStale(
    eventId: bigint,
    ownerToken: string,
    processedAt = new Date(),
  ): Promise<boolean> {
    return this.completeTerminal(eventId, ownerToken, 'ignored_stale', undefined, processedAt);
  }

  markBlocked(
    eventId: bigint,
    ownerToken: string,
    errorCode: string,
    processedAt = new Date(),
  ): Promise<boolean> {
    return this.completeTerminal(eventId, ownerToken, 'blocked', errorCode, processedAt);
  }

  markDead(
    eventId: bigint,
    ownerToken: string,
    errorCode: string,
    processedAt = new Date(),
  ): Promise<boolean> {
    return this.completeTerminal(eventId, ownerToken, 'dead', errorCode, processedAt);
  }

  async scheduleRetry(
    eventId: bigint,
    ownerToken: string,
    errorCode: string,
    nextAttemptAt: Date,
    now = new Date(),
  ): Promise<'retry_wait' | 'dead' | null> {
    assertPositiveId(eventId, 'marketplace event');
    assertOwnerToken(ownerToken);
    const normalizedErrorCode = safeErrorCode(errorCode);
    const currentTime = validDate(now, 'retry time');
    const retryAt = validDate(nextAttemptAt, 'next attempt time');
    if (retryAt.getTime() <= currentTime.getTime()) {
      throw new Error('marketplace next attempt time must be in the future');
    }

    const rows = await this.prisma.$queryRaw<Array<{ status: 'retry_wait' | 'dead' }>>`
      UPDATE "marketplace_event_inbox"
      SET
        "status" = CASE
          WHEN "attempts" >= "max_attempts" THEN 'dead'::"MarketplaceEventStatus"
          ELSE 'retry_wait'::"MarketplaceEventStatus"
        END,
        "next_attempt_at" = CASE
          WHEN "attempts" >= "max_attempts" THEN NULL
          ELSE ${retryAt}
        END,
        "locked_at" = NULL,
        "locked_by" = NULL,
        "processed_at" = CASE
          WHEN "attempts" >= "max_attempts" THEN ${currentTime}
          ELSE NULL
        END,
        "last_error_code" = ${normalizedErrorCode},
        "updated_at" = ${currentTime}
      WHERE "id" = ${eventId}
        AND "status" = 'processing'::"MarketplaceEventStatus"
        AND "locked_by" = ${ownerToken}
      RETURNING "status"::text AS "status"
    `;
    return rows[0]?.status ?? null;
  }

  async recoverExpiredClaims(
    cutoff: Date,
    now = new Date(),
    limit = 100,
  ): Promise<MarketplaceExpiredClaimRecovery> {
    const cutoffTime = validDate(cutoff, 'claim recovery cutoff');
    const recoveryTime = validDate(now, 'claim recovery time');
    if (cutoffTime.getTime() > recoveryTime.getTime()) {
      throw new Error('marketplace claim recovery cutoff must not be in the future');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('marketplace claim recovery limit must be an integer between 1 and 100');
    }

    const rows = await this.prisma.$queryRaw<MarketplaceExpiredClaimRecovery[]>`
      WITH candidates AS (
        SELECT candidate."id"
        FROM "marketplace_event_inbox" AS candidate
        WHERE candidate."status" = 'processing'::"MarketplaceEventStatus"
          AND candidate."locked_at" <= ${cutoffTime}
        ORDER BY candidate."locked_at", candidate."id"
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      ), recovered AS (
        UPDATE "marketplace_event_inbox" AS event
        SET
          "status" = CASE
            WHEN event."attempts" >= event."max_attempts" THEN 'dead'::"MarketplaceEventStatus"
            ELSE 'retry_wait'::"MarketplaceEventStatus"
          END,
          "next_attempt_at" = CASE
            WHEN event."attempts" >= event."max_attempts" THEN NULL
            ELSE ${recoveryTime}
          END,
          "locked_at" = NULL,
          "locked_by" = NULL,
          "processed_at" = CASE
            WHEN event."attempts" >= event."max_attempts" THEN ${recoveryTime}
            ELSE NULL
          END,
          "last_error_code" = 'CLAIM.LEASE_EXPIRED',
          "updated_at" = ${recoveryTime}
        FROM candidates
        WHERE event."id" = candidates."id"
        RETURNING event."status"
      )
      SELECT
        count(*)::integer AS "recovered",
        count(*) FILTER (WHERE "status" = 'retry_wait')::integer AS "retryWait",
        count(*) FILTER (WHERE "status" = 'dead')::integer AS "dead"
      FROM recovered
    `;
    return rows[0] ?? { recovered: 0, retryWait: 0, dead: 0 };
  }

  private async resolveDuplicate(
    identity: MarketplaceIdentity,
    payloadDigest: string,
    uniqueError: unknown,
  ): Promise<ReceiveMarketplaceEventResult> {
    const replay = await this.prisma.$queryRaw<MarketplaceEventReceipt[]>`
      WITH database_clock AS (
        SELECT clock_timestamp() AS "receivedAt"
      )
      UPDATE "marketplace_event_inbox" AS event
      SET
        "delivery_count" = event."delivery_count" + 1,
        "last_received_at" = GREATEST(
          event."last_received_at",
          event."created_at",
          database_clock."receivedAt"
        ),
        "updated_at" = GREATEST(
          event."updated_at",
          event."created_at",
          database_clock."receivedAt"
        )
      FROM database_clock
      WHERE event."provider" = ${identity.provider}::"MarketplaceProvider"
        AND event."integration_key" = ${identity.integrationKey}
        AND event."dedupe_key" = ${identity.dedupeKey}
        AND event."payload_digest" = ${payloadDigest}
      RETURNING
        event."id",
        event."provider"::text AS "provider",
        event."integration_key" AS "integrationKey",
        event."dedupe_key" AS "dedupeKey",
        event."payload_digest" AS "payloadDigest",
        event."status"::text AS "status",
        event."delivery_count" AS "deliveryCount",
        event."conflict_count" AS "conflictCount",
        event."last_conflict_digest" AS "lastConflictDigest",
        event."last_received_at" AS "lastReceivedAt"
    `;
    if (replay[0]) return { outcome: 'replay', event: replay[0] };

    const conflicts = await this.prisma.$queryRaw<MarketplaceEventReceipt[]>`
      WITH database_clock AS (
        SELECT clock_timestamp() AS "receivedAt"
      )
      UPDATE "marketplace_event_inbox" AS event
      SET
        "conflict_count" = event."conflict_count" + 1,
        "last_conflict_digest" = ${payloadDigest},
        "last_received_at" = GREATEST(
          event."last_received_at",
          event."created_at",
          database_clock."receivedAt"
        ),
        "updated_at" = GREATEST(
          event."updated_at",
          event."created_at",
          database_clock."receivedAt"
        )
      FROM database_clock
      WHERE event."provider" = ${identity.provider}::"MarketplaceProvider"
        AND event."integration_key" = ${identity.integrationKey}
        AND event."dedupe_key" = ${identity.dedupeKey}
        AND event."payload_digest" <> ${payloadDigest}
      RETURNING
        event."id",
        event."provider"::text AS "provider",
        event."integration_key" AS "integrationKey",
        event."dedupe_key" AS "dedupeKey",
        event."payload_digest" AS "payloadDigest",
        event."status"::text AS "status",
        event."delivery_count" AS "deliveryCount",
        event."conflict_count" AS "conflictCount",
        event."last_conflict_digest" AS "lastConflictDigest",
        event."last_received_at" AS "lastReceivedAt"
    `;
    const event = conflicts[0];
    if (!event) throw uniqueError;

    const identityDigest = digestIdentity(identity);
    await this.alerts.raise({
      key: `marketplace.event.digest_conflict.${identityDigest.slice(0, 32)}`,
      type: 'entitlement',
      severity: 'critical',
      summary: '同一服务市场事件标识收到不同正文',
      details: {
        provider: identity.provider,
        integrationKey: identity.integrationKey,
        identityDigest,
        storedPayloadDigest: event.payloadDigest,
        conflictingPayloadDigest: payloadDigest,
      },
    });
    return { outcome: 'conflict', event };
  }

  private completeTerminal(
    eventId: bigint,
    ownerToken: string,
    status: 'ignored_stale' | 'blocked' | 'dead',
    errorCode: string | undefined,
    processedAt: Date,
  ): Promise<boolean> {
    const completedAt = validDate(processedAt, 'processed time');
    return this.ownedUpdate(eventId, ownerToken, {
      status,
      nextAttemptAt: null,
      lockedAt: null,
      lockedBy: null,
      processedAt: completedAt,
      lastErrorCode: errorCode === undefined ? null : safeErrorCode(errorCode),
      updatedAt: completedAt,
    });
  }

  private async ownedUpdate(
    eventId: bigint,
    ownerToken: string,
    data: Prisma.MarketplaceEventInboxUncheckedUpdateManyInput,
  ): Promise<boolean> {
    assertPositiveId(eventId, 'marketplace event');
    assertOwnerToken(ownerToken);
    const result = await this.prisma.marketplaceEventInbox.updateMany({
      where: { id: eventId, status: 'processing', lockedBy: ownerToken },
      data,
    });
    return result.count === 1;
  }
}

interface MarketplaceIdentity {
  provider: MarketplaceProviderInput;
  integrationKey: string;
  dedupeKey: string;
}

function normalizeReceiveInput(input: VerifiedMarketplaceEventInput): {
  identity: MarketplaceIdentity;
  payloadDigest: string;
  data: Prisma.MarketplaceEventInboxUncheckedCreateInput;
} {
  if (!Buffer.isBuffer(input.rawPayload)) {
    throw new Error('marketplace raw payload must be a Buffer');
  }
  if (input.rawPayload.byteLength > MARKETPLACE_MAX_RAW_PAYLOAD_BYTES) {
    throw new Error('marketplace raw payload exceeds the 1 MiB limit');
  }
  const identity = {
    provider: input.provider,
    integrationKey: opaqueKey(input.integrationKey, 64, 'integration key'),
    dedupeKey: opaqueKey(input.dedupeKey, 255, 'dedupe key'),
  };
  const payloadDigest = createHash('sha256').update(input.rawPayload).digest('hex');
  const verifierVersion = optionalOpaqueKey(input.verifierVersion, 64, 'verifier version');
  const signatureVerifiedAt = input.signatureVerifiedAt
    ? validDate(input.signatureVerifiedAt, 'signature verification time')
    : undefined;
  if (input.source === 'callback' && (!verifierVersion || !signatureVerifiedAt)) {
    throw new Error('verified callback evidence is required');
  }
  const normalizedPayload = sanitizeNormalizedPayload(input.normalizedPayload);
  const maxAttempts = input.maxAttempts ?? 5;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error('marketplace max attempts must be an integer between 1 and 10');
  }
  for (const [label, value] of [
    ['account binding', input.accountBindingId],
    ['plan mapping', input.planMappingId],
    ['subscription projection', input.projectionId],
  ] as const) {
    if (value !== undefined) assertPositiveId(value, label);
  }
  if (input.occurredAt) validDate(input.occurredAt, 'event occurrence time');
  assertAuthoritativeState(input.normalizedKind, input.authoritativeState, input.source);

  return {
    identity,
    payloadDigest,
    data: {
      ...identity,
      payloadDigest,
      source: input.source,
      maxAttempts,
      ...(verifierVersion ? { verifierVersion } : {}),
      ...(signatureVerifiedAt ? { signatureVerifiedAt } : {}),
      ...(input.externalEventId
        ? { externalEventId: opaqueKey(input.externalEventId, 255, 'external event ID') }
        : {}),
      ...(input.externalEventType
        ? { externalEventType: opaqueKey(input.externalEventType, 128, 'external event type') }
        : {}),
      ...(input.normalizedKind ? { normalizedKind: input.normalizedKind } : {}),
      ...(input.authoritativeState ? { authoritativeState: input.authoritativeState } : {}),
      ...(input.externalAccountKey
        ? { externalAccountKey: opaqueKey(input.externalAccountKey, 255, 'external account key') }
        : {}),
      ...(input.externalSubscriptionKey
        ? {
            externalSubscriptionKey: opaqueKey(
              input.externalSubscriptionKey,
              255,
              'external subscription key',
            ),
          }
        : {}),
      ...(input.providerPlanKey
        ? { providerPlanKey: opaqueKey(input.providerPlanKey, 255, 'provider plan key') }
        : {}),
      ...(input.providerRevision
        ? { providerRevision: decimalRevision(input.providerRevision) }
        : {}),
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      ...(normalizedPayload === undefined ? {} : { normalizedPayload }),
      ...(input.accountBindingId === undefined ? {} : { accountBindingId: input.accountBindingId }),
      ...(input.planMappingId === undefined ? {} : { planMappingId: input.planMappingId }),
      ...(input.projectionId === undefined ? {} : { projectionId: input.projectionId }),
      ...(input.requestId ? { requestId: opaqueKey(input.requestId, 64, 'request ID') } : {}),
    },
  };
}

function decimalRevision(value: string): Prisma.Decimal {
  if (!POSITIVE_DECIMAL_REVISION.test(value)) {
    throw new Error('marketplace provider revision must be a positive canonical decimal integer');
  }
  return new Prisma.Decimal(value);
}

function assertAuthoritativeState(
  kind: MarketplaceEventKindInput | undefined,
  authoritativeState: MarketplaceLifecycleStateInput | undefined,
  source?: MarketplaceEventSourceInput,
): void {
  if (kind === 'reconciled') {
    if (!authoritativeState) {
      throw new Error('marketplace reconciliation requires an authoritative state');
    }
    if (source && source !== 'reconciliation' && source !== 'manual_repair') {
      throw new Error('marketplace reconciliation requires a reconciliation or manual source');
    }
    return;
  }
  if (authoritativeState !== undefined) {
    throw new Error('marketplace authoritative state is allowed only for reconciliation events');
  }
}

function opaqueKey(value: string, maxLength: number, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`marketplace ${label} is invalid`);
  }
  return value;
}

function optionalOpaqueKey(
  value: string | undefined,
  maxLength: number,
  label: string,
): string | undefined {
  return value === undefined ? undefined : opaqueKey(value, maxLength, label);
}

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`marketplace ${label} is invalid`);
  }
  return value;
}

function assertPositiveId(value: bigint, label: string): void {
  if (typeof value !== 'bigint' || value <= 0n) {
    throw new Error(`marketplace ${label} ID must be positive`);
  }
}

function assertOwnerToken(value: string): void {
  if (!UUID.test(value)) throw new Error('marketplace claim owner token must be a UUID');
}

function safeErrorCode(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 64 ||
    value !== value.trim() ||
    !SAFE_CODE.test(value)
  ) {
    throw new Error('marketplace error code is invalid');
  }
  return value;
}

function sanitizeNormalizedPayload(value: unknown, depth = 0): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null || depth > 5 || Buffer.isBuffer(value))
    return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value.slice(0, 500);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeNormalizedPayload(item, depth + 1) ?? null);
  }
  if (typeof value === 'object') {
    const result: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      const safeKey = key.slice(0, 100);
      if (!safeKey || SENSITIVE_PAYLOAD_KEY.test(safeKey)) continue;
      const sanitized = sanitizeNormalizedPayload(item, depth + 1);
      if (sanitized !== undefined) result[safeKey] = sanitized;
    }
    return result;
  }
  return String(value).slice(0, 500);
}

function isUniqueConstraintError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'P2002';
}

function digestIdentity(identity: MarketplaceIdentity): string {
  return createHash('sha256')
    .update(`${identity.provider}\u0000${identity.integrationKey}\u0000${identity.dedupeKey}`)
    .digest('hex');
}
