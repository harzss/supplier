export type MarketplaceLifecycleState =
  | 'trialing'
  | 'active'
  | 'cancelling'
  | 'refunded'
  | 'expired'
  | 'cancelled'
  | 'uninstalled';

export type MarketplaceLifecycleEventKind =
  | 'trial_started'
  | 'subscribed'
  | 'renewed'
  | 'cancelling'
  | 'refunded'
  | 'expired'
  | 'cancelled'
  | 'uninstalled'
  | 'reconciled';

export type MarketplaceEntitlementAccess = 'active' | 'suspended';

export interface MarketplaceLifecycleProjection {
  state: MarketplaceLifecycleState;
  /** Canonical decimal revision sourced from an official sequence or reconciliation snapshot. */
  revision: string;
}

export interface MarketplaceLifecycleEvent {
  kind: MarketplaceLifecycleEventKind;
  /** Must be supplied by the provider adapter; receive order is never a valid revision. */
  revision: string;
  /** Required only for an authoritative reconciliation snapshot. */
  authoritativeState?: MarketplaceLifecycleState;
}

export interface MarketplaceLifecycleResult {
  outcome: 'applied' | 'ignored_stale' | 'idempotent_replay' | 'blocked_conflict';
  projection: MarketplaceLifecycleProjection | null;
  access: MarketplaceEntitlementAccess;
}

const ACCESS_ACTIVE_STATES = new Set<MarketplaceLifecycleState>([
  'trialing',
  'active',
  'cancelling',
]);

const REGULAR_TARGETS: Record<
  Exclude<MarketplaceLifecycleEventKind, 'reconciled'>,
  MarketplaceLifecycleState
> = {
  trial_started: 'trialing',
  subscribed: 'active',
  renewed: 'active',
  cancelling: 'cancelling',
  refunded: 'refunded',
  expired: 'expired',
  cancelled: 'cancelled',
  uninstalled: 'uninstalled',
};

const ALLOWED_REGULAR_TRANSITIONS: Record<
  MarketplaceLifecycleState,
  ReadonlySet<MarketplaceLifecycleState>
> = {
  trialing: new Set(['active', 'cancelling', 'refunded', 'expired', 'cancelled', 'uninstalled']),
  active: new Set(['active', 'cancelling', 'refunded', 'expired', 'cancelled', 'uninstalled']),
  cancelling: new Set(['refunded', 'expired', 'cancelled', 'uninstalled']),
  refunded: new Set(),
  expired: new Set(),
  cancelled: new Set(),
  uninstalled: new Set(),
};

/**
 * Projects one normalized marketplace event without guessing provider ordering.
 *
 * Provider adapters must derive `revision` from an official monotonic sequence or
 * from an authoritative reconciliation snapshot. A local receive timestamp must
 * never be substituted. Event-id/digest idempotency belongs to the durable inbox;
 * this function protects only lifecycle ordering and access projection.
 */
export function projectMarketplaceLifecycle(
  current: MarketplaceLifecycleProjection | null,
  event: MarketplaceLifecycleEvent,
): MarketplaceLifecycleResult {
  const eventRevision = parseRevision(event.revision, 'event revision');
  const currentRevision = current ? parseRevision(current.revision, 'current revision') : null;
  const target = targetState(event);

  if (currentRevision !== null && eventRevision < currentRevision) {
    return result('ignored_stale', current);
  }

  if (currentRevision !== null && eventRevision === currentRevision) {
    return result(current!.state === target ? 'idempotent_replay' : 'blocked_conflict', current);
  }

  if (event.kind !== 'reconciled' && !regularTransitionAllowed(current?.state ?? null, target)) {
    return result('blocked_conflict', current);
  }

  const next: MarketplaceLifecycleProjection = { state: target, revision: event.revision };
  return result('applied', next);
}

export function marketplaceAccessForState(
  state: MarketplaceLifecycleState | null,
): MarketplaceEntitlementAccess {
  return state !== null && ACCESS_ACTIVE_STATES.has(state) ? 'active' : 'suspended';
}

function result(
  outcome: MarketplaceLifecycleResult['outcome'],
  projection: MarketplaceLifecycleProjection | null,
): MarketplaceLifecycleResult {
  return { outcome, projection, access: marketplaceAccessForState(projection?.state ?? null) };
}

function targetState(event: MarketplaceLifecycleEvent): MarketplaceLifecycleState {
  if (event.kind === 'reconciled') {
    if (!event.authoritativeState) {
      throw new Error('reconciliation event requires an authoritative state');
    }
    return event.authoritativeState;
  }
  if (event.authoritativeState !== undefined) {
    throw new Error('authoritative state is allowed only for reconciliation events');
  }
  return REGULAR_TARGETS[event.kind];
}

function regularTransitionAllowed(
  current: MarketplaceLifecycleState | null,
  target: MarketplaceLifecycleState,
): boolean {
  if (current === null) return target === 'trialing' || target === 'active';
  return ALLOWED_REGULAR_TRANSITIONS[current].has(target);
}

function parseRevision(value: string, label: string): bigint {
  if (!/^[1-9]\d{0,38}$/.test(value)) {
    throw new Error(`${label} must be a positive canonical decimal integer`);
  }
  return BigInt(value);
}
