import { describe, expect, it } from 'vitest';
import {
  marketplaceAccessForState,
  projectMarketplaceLifecycle,
  type MarketplaceLifecycleEvent,
  type MarketplaceLifecycleProjection,
  type MarketplaceLifecycleState,
} from './marketplace-lifecycle';

describe('projectMarketplaceLifecycle', () => {
  it.each([
    ['trial_started', 'trialing'],
    ['subscribed', 'active'],
  ] as const)('starts a new lifecycle only from %s', (kind, state) => {
    expect(projectMarketplaceLifecycle(null, event(kind, '1'))).toEqual({
      outcome: 'applied',
      projection: { state, revision: '1' },
      access: 'active',
    });
  });

  it.each([
    ['trialing', 'subscribed', 'active'],
    ['trialing', 'cancelling', 'cancelling'],
    ['active', 'renewed', 'active'],
    ['active', 'refunded', 'refunded'],
    ['active', 'expired', 'expired'],
    ['cancelling', 'cancelled', 'cancelled'],
    ['cancelling', 'uninstalled', 'uninstalled'],
  ] as const)('applies an allowed %s -> %s transition', (currentState, kind, nextState) => {
    expect(projectMarketplaceLifecycle(projection(currentState, '10'), event(kind, '11'))).toEqual({
      outcome: 'applied',
      projection: { state: nextState, revision: '11' },
      access: ['trialing', 'active', 'cancelling'].includes(nextState) ? 'active' : 'suspended',
    });
  });

  it.each(['refunded', 'expired', 'cancelled', 'uninstalled'] as const)(
    'does not let a regular late event revive the %s terminal state',
    (state) => {
      const current = projection(state, '20');
      expect(projectMarketplaceLifecycle(current, event('renewed', '21'))).toEqual({
        outcome: 'blocked_conflict',
        projection: current,
        access: 'suspended',
      });
    },
  );

  it('ignores an older event without changing current access', () => {
    const current = projection('active', '100');
    expect(projectMarketplaceLifecycle(current, event('expired', '99'))).toEqual({
      outcome: 'ignored_stale',
      projection: current,
      access: 'active',
    });
  });

  it('distinguishes a same-revision replay from a conflict', () => {
    const current = projection('active', '100');
    expect(projectMarketplaceLifecycle(current, event('renewed', '100')).outcome).toBe(
      'idempotent_replay',
    );
    expect(projectMarketplaceLifecycle(current, event('expired', '100')).outcome).toBe(
      'blocked_conflict',
    );
  });

  it('allows only an authoritative reconciliation to repair a terminal projection', () => {
    expect(
      projectMarketplaceLifecycle(projection('expired', '20'), {
        kind: 'reconciled',
        revision: '21',
        authoritativeState: 'active',
      }),
    ).toEqual({
      outcome: 'applied',
      projection: { state: 'active', revision: '21' },
      access: 'active',
    });
  });

  it('blocks out-of-order initial terminal events until reconciliation', () => {
    expect(projectMarketplaceLifecycle(null, event('refunded', '3'))).toEqual({
      outcome: 'blocked_conflict',
      projection: null,
      access: 'suspended',
    });
  });

  it.each(['0', '-1', '01', '1.0', 'received-at', ''])('rejects revision %j', (revision) => {
    expect(() => projectMarketplaceLifecycle(null, event('subscribed', revision))).toThrow(
      'positive canonical decimal integer',
    );
  });

  it('requires authoritative state only on reconciliation events', () => {
    expect(() => projectMarketplaceLifecycle(null, { kind: 'reconciled', revision: '1' })).toThrow(
      'requires an authoritative state',
    );
    expect(() =>
      projectMarketplaceLifecycle(null, {
        kind: 'subscribed',
        revision: '1',
        authoritativeState: 'active',
      }),
    ).toThrow('allowed only for reconciliation');
  });
});

describe('marketplaceAccessForState', () => {
  it.each(['trialing', 'active', 'cancelling'] as const)('keeps %s access active', (state) => {
    expect(marketplaceAccessForState(state)).toBe('active');
  });

  it.each(['refunded', 'expired', 'cancelled', 'uninstalled', null] as const)(
    'suspends access for %s',
    (state) => {
      expect(marketplaceAccessForState(state)).toBe('suspended');
    },
  );
});

function projection(
  state: MarketplaceLifecycleState,
  revision: string,
): MarketplaceLifecycleProjection {
  return { state, revision };
}

function event(
  kind: Exclude<MarketplaceLifecycleEvent['kind'], 'reconciled'>,
  revision: string,
): MarketplaceLifecycleEvent {
  return { kind, revision };
}
