import { describe, expect, it } from 'vitest';
import { isLegalDocumentRoute } from './public-routes';

describe('isLegalDocumentRoute', () => {
  it.each(['/privacy', '/terms', '/help', '/account-deletion'])('allows %s', (pathname) => {
    expect(isLegalDocumentRoute(pathname)).toBe(true);
  });

  it.each([
    '/',
    '/settings',
    '/privacy-preview',
    '/privacy/internal',
    '/help/admin',
    '/prototypes/supplier-desk',
  ])('keeps %s behind the application shell', (pathname) => {
    expect(isLegalDocumentRoute(pathname)).toBe(false);
  });
});
