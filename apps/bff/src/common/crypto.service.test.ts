import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { CryptoService } from './crypto.module';

function makeService(key = 'unit-test-secret-key'): CryptoService {
  const config = { get: () => key } as unknown as ConfigService;
  return new CryptoService(config);
}

describe('CryptoService', () => {
  it('encrypt → decrypt round-trips to original plaintext', () => {
    const svc = makeService();
    const secret = 'sk-abcdef0123456789';
    const enc = svc.encrypt(secret);
    expect(enc).not.toContain(secret);
    expect(svc.decrypt(enc)).toBe(secret);
  });

  it('produces different ciphertext each time (random IV)', () => {
    const svc = makeService();
    const a = svc.encrypt('same-input');
    const b = svc.encrypt('same-input');
    expect(a).not.toBe(b);
    expect(svc.decrypt(a)).toBe('same-input');
    expect(svc.decrypt(b)).toBe('same-input');
  });

  it('throws on tampered ciphertext (GCM auth)', () => {
    const svc = makeService();
    const enc = svc.encrypt('tamper-me');
    const [iv, tag, data] = enc.split('.');
    const flipped = data!.slice(0, -2) + (data!.endsWith('AA') ? 'BB' : 'AA');
    expect(() => svc.decrypt([iv, tag, flipped].join('.'))).toThrow();
  });

  it('throws on malformed ciphertext', () => {
    const svc = makeService();
    expect(() => svc.decrypt('not-a-valid-payload')).toThrow('Invalid ciphertext format');
  });

  it('cannot decrypt with a different key', () => {
    const enc = makeService('key-one').encrypt('secret');
    expect(() => makeService('key-two').decrypt(enc)).toThrow();
  });

  it('mask hides the middle of the key', () => {
    const svc = makeService();
    expect(svc.mask('sk-abcdef0123456789')).toBe('sk-a****6789');
    expect(svc.mask('short')).toBe('****');
  });
});
