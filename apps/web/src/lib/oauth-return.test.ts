import { describe, expect, it } from 'vitest';
import {
  normalizeAppReturnTo,
  productPublishReturnTo,
  readOAuthCallbackResult,
  settingsHrefWithReturnTo,
} from './oauth-return';

describe('OAuth return context', () => {
  it('keeps a product query and publish hash in a relative return target', () => {
    const returnTo = productPublishReturnTo('1688/1001');

    expect(returnTo).toBe('/products?id=1688%2F1001#publish');
    expect(settingsHrefWithReturnTo('/settings#shops', returnTo)).toBe(
      '/settings?returnTo=%2Fproducts%3Fid%3D1688%252F1001%23publish#shops',
    );
  });

  it.each([
    'https://evil.example/products',
    '//evil.example/products',
    '/catalog/..//evil.example/products',
    '/\\evil.example/products',
    'products?id=1001',
    '/products\n?id=1001',
  ])('rejects an unsafe application return target: %s', (value) => {
    expect(normalizeAppReturnTo(value)).toBeUndefined();
  });

  it('cleans OAuth result parameters without dropping product identity or hash', () => {
    const result = readOAuthCallbackResult(
      `https://supplier.example/products?id=1688%2F1001&oauthResult=${'a'.repeat(43)}&shopName=%E4%BC%AA%E9%80%A0%E5%BA%97%E5%90%8D#publish`,
    );

    expect(result).toEqual({
      kind: 'verified_result',
      token: 'a'.repeat(43),
      cleanHref: '/products?id=1688%2F1001#publish',
    });
  });

  it('accepts only a generic unverified failure marker', () => {
    expect(readOAuthCallbackResult('/settings?oauth=douyin&result=error&message=forged')).toEqual({
      kind: 'unverified_error',
      platform: 'douyin',
      cleanHref: '/settings',
    });
  });

  it('ignores a forged success without a one-time result token', () => {
    expect(
      readOAuthCallbackResult('/products?oauth=douyin&result=success&shopId=9#publish'),
    ).toBeNull();
  });

  it('ignores incomplete callback markers', () => {
    expect(readOAuthCallbackResult('/products?id=1001&oauth=douyin#publish')).toBeNull();
  });
});
