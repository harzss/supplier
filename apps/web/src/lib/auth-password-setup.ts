export type PasswordSetupReason = 'invite' | 'recovery';

interface PasswordSetupStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PendingPasswordSetup {
  version: 1;
  project: string;
  userId: string;
  reason: PasswordSetupReason;
  expiresAt: number;
}

export type PendingPasswordSetupState =
  | { status: 'pending'; reason: PasswordSetupReason }
  | { status: 'expired' }
  | { status: 'none' }
  | { status: 'unavailable' };

const PENDING_PASSWORD_SETUP_KEY = 'supplier.auth.pending-password-setup.v1';
export const PASSWORD_SETUP_TTL_MS = 60 * 60 * 1000;

export function savePendingPasswordSetup(
  storage: PasswordSetupStorage | undefined,
  project: string,
  userId: string,
  reason: PasswordSetupReason,
  now = Date.now(),
): boolean {
  if (!storage) return false;
  const pending: PendingPasswordSetup = {
    version: 1,
    project,
    userId,
    reason,
    expiresAt: now + PASSWORD_SETUP_TTL_MS,
  };
  try {
    storage.setItem(PENDING_PASSWORD_SETUP_KEY, JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

export function readPendingPasswordSetup(
  storage: PasswordSetupStorage | undefined,
  project: string,
  userId: string,
  now = Date.now(),
): PendingPasswordSetupState {
  if (!storage) return { status: 'unavailable' };
  let raw: string | null;
  try {
    raw = storage.getItem(PENDING_PASSWORD_SETUP_KEY);
  } catch {
    return { status: 'unavailable' };
  }
  if (!raw) return { status: 'none' };

  try {
    const pending = JSON.parse(raw) as Partial<PendingPasswordSetup>;
    if (
      pending.version !== 1 ||
      pending.project !== project ||
      pending.userId !== userId ||
      (pending.reason !== 'invite' && pending.reason !== 'recovery') ||
      typeof pending.expiresAt !== 'number' ||
      !Number.isFinite(pending.expiresAt)
    ) {
      return clearPendingPasswordSetup(storage) ? { status: 'none' } : { status: 'unavailable' };
    }
    if (pending.expiresAt <= now) return { status: 'expired' };
    return { status: 'pending', reason: pending.reason };
  } catch {
    // Invalid browser state must not lock a normal authenticated session.
  }

  return clearPendingPasswordSetup(storage) ? { status: 'none' } : { status: 'unavailable' };
}

export function clearPendingPasswordSetup(storage: PasswordSetupStorage | undefined): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(PENDING_PASSWORD_SETUP_KEY);
    return true;
  } catch {
    return false;
  }
}

export function readPasswordSetupReason(url: string): PasswordSetupReason | undefined {
  try {
    const parsed = new URL(url);
    const hash = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    if (
      hash.has('error') ||
      hash.has('error_code') ||
      parsed.searchParams.has('error') ||
      parsed.searchParams.has('error_code')
    ) {
      return undefined;
    }
    const type = hash.get('type') ?? parsed.searchParams.get('type');
    return type === 'invite' || type === 'recovery' ? type : undefined;
  } catch {
    return undefined;
  }
}

export function getPasswordSetupStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
