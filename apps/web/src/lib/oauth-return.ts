const APP_ORIGIN = 'https://supplier.local';
const OAUTH_RESULT_KEYS = [
  'oauthResult',
  'oauth',
  'result',
  'shopId',
  'shopName',
  'message',
] as const;
const RESULT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type OAuthPlatform = 'douyin' | 'alibaba_1688';

export type OAuthCallbackResult =
  | { kind: 'verified_result'; token: string; cleanHref: string }
  | { kind: 'unverified_error'; platform: OAuthPlatform; cleanHref: string };

export function normalizeAppReturnTo(value: string | null | undefined): string | undefined {
  if (
    !value ||
    value.length > 2048 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return undefined;
  }

  const url = new URL(value, APP_ORIGIN);
  if (url.origin !== APP_ORIGIN || !url.pathname.startsWith('/') || url.pathname.startsWith('//')) {
    return undefined;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function settingsHrefWithReturnTo(settingsHref: string, returnTo: string): string {
  const safeReturnTo = normalizeAppReturnTo(returnTo);
  if (!safeReturnTo) return settingsHref;

  const url = new URL(settingsHref, APP_ORIGIN);
  if (url.origin !== APP_ORIGIN || url.pathname !== '/settings') return settingsHref;
  url.searchParams.set('returnTo', safeReturnTo);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function productPublishReturnTo(sourceProductId: string): string {
  const params = new URLSearchParams({ id: sourceProductId });
  return `/products?${params.toString()}#publish`;
}

export function readOAuthCallbackResult(input: string): OAuthCallbackResult | null {
  const url = new URL(input, APP_ORIGIN);
  const resultToken = url.searchParams.get('oauthResult');
  const platform = url.searchParams.get('oauth');
  const result = url.searchParams.get('result');
  const cleanHref = cleanOAuthResultHref(url);
  if (resultToken && RESULT_TOKEN_PATTERN.test(resultToken)) {
    return { kind: 'verified_result', token: resultToken, cleanHref };
  }
  if ((platform === 'douyin' || platform === 'alibaba_1688') && result === 'error') {
    return { kind: 'unverified_error', platform, cleanHref };
  }
  return null;
}

function cleanOAuthResultHref(url: URL): string {
  for (const key of OAUTH_RESULT_KEYS) url.searchParams.delete(key);
  return `${url.pathname}${url.search}${url.hash}`;
}
