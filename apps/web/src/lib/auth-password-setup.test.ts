import { describe, expect, it } from 'vitest';
import {
  clearPendingPasswordSetup,
  PASSWORD_SETUP_TTL_MS,
  readPasswordSetupReason,
  readPendingPasswordSetup,
  savePendingPasswordSetup,
} from './auth-password-setup';

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

describe('pending password setup', () => {
  it.each(['invite', 'recovery'] as const)(
    'survives a reload for the same project and user (%s)',
    (reason) => {
      const storage = new MemoryStorage();
      expect(
        savePendingPasswordSetup(storage, 'https://project.supabase.co', 'user-1', reason, 10),
      ).toBe(true);

      expect(
        readPendingPasswordSetup(storage, 'https://project.supabase.co', 'user-1', 11),
      ).toEqual({ status: 'pending', reason });
    },
  );

  it('does not lock a different project or user and removes the stale marker', () => {
    const storage = new MemoryStorage();
    savePendingPasswordSetup(storage, 'https://project-a.supabase.co', 'user-1', 'invite', 10);

    expect(
      readPendingPasswordSetup(storage, 'https://project-b.supabase.co', 'user-1', 11),
    ).toEqual({ status: 'none' });
    expect(
      readPendingPasswordSetup(storage, 'https://project-a.supabase.co', 'user-1', 11),
    ).toEqual({ status: 'none' });

    savePendingPasswordSetup(storage, 'https://project-a.supabase.co', 'user-1', 'invite', 10);
    expect(
      readPendingPasswordSetup(storage, 'https://project-a.supabase.co', 'user-2', 11),
    ).toEqual({ status: 'none' });
  });

  it('reports an expired marker so the provider can sign out before clearing it', () => {
    const storage = new MemoryStorage();
    savePendingPasswordSetup(storage, 'https://project.supabase.co', 'user-1', 'recovery', 10);
    expect(
      readPendingPasswordSetup(
        storage,
        'https://project.supabase.co',
        'user-1',
        10 + PASSWORD_SETUP_TTL_MS,
      ),
    ).toEqual({ status: 'expired' });
    expect(storage.values.size).toBe(1);
  });

  it('removes malformed markers instead of locking a normal login', () => {
    const storage = new MemoryStorage();
    storage.setItem('supplier.auth.pending-password-setup.v1', '{not-json');
    expect(readPendingPasswordSetup(storage, 'https://project.supabase.co', 'user-1', 11)).toEqual({
      status: 'none',
    });
    expect(storage.values.size).toBe(0);
  });

  it('clears the pending marker after logout or successful completion', () => {
    const storage = new MemoryStorage();
    savePendingPasswordSetup(storage, 'https://project.supabase.co', 'user-1', 'invite', 10);
    clearPendingPasswordSetup(storage);

    expect(readPendingPasswordSetup(storage, 'https://project.supabase.co', 'user-1', 11)).toEqual({
      status: 'none',
    });
  });

  it('does not lock an ordinary session when readable storage has no marker', () => {
    expect(
      readPendingPasswordSetup(new MemoryStorage(), 'https://project.supabase.co', 'ordinary-user'),
    ).toEqual({ status: 'none' });
  });

  it('reports unavailable browser storage so an authenticated session fails closed', () => {
    const brokenStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };

    expect(
      savePendingPasswordSetup(brokenStorage, 'https://project.supabase.co', 'user-1', 'invite'),
    ).toBe(false);
    expect(
      readPendingPasswordSetup(brokenStorage, 'https://project.supabase.co', 'user-1'),
    ).toEqual({ status: 'unavailable' });
    expect(clearPendingPasswordSetup(brokenStorage)).toBe(false);
    expect(readPendingPasswordSetup(undefined, 'https://project.supabase.co', 'user-1')).toEqual({
      status: 'unavailable',
    });
  });
});

describe('password setup callback detection', () => {
  it('detects invite and recovery callbacks in hash or query parameters', () => {
    expect(readPasswordSetupReason('https://app.example/#access_token=token&type=invite')).toBe(
      'invite',
    );
    expect(readPasswordSetupReason('https://app.example/?code=code&type=recovery')).toBe(
      'recovery',
    );
  });

  it('ignores ordinary and failed callbacks', () => {
    expect(readPasswordSetupReason('https://app.example/?code=code')).toBeUndefined();
    expect(
      readPasswordSetupReason(
        'https://app.example/#error=access_denied&error_code=otp_expired&type=recovery',
      ),
    ).toBeUndefined();
    expect(readPasswordSetupReason('not a url')).toBeUndefined();
  });
});
