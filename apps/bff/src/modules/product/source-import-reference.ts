import { BadRequestException } from '@nestjs/common';

const OFFER_ID = /^[1-9]\d{0,31}$/;
const OFFER_PATH = /^\/offer\/([1-9]\d{0,31})\.html\/?$/;
const ALLOWED_HOSTS = new Set([
  '1688.com',
  'detail.1688.com',
  'm.1688.com',
  'offer.1688.com',
  'www.1688.com',
]);

export interface NormalizedSourceReference {
  reference: string;
  offerId: string;
}

/**
 * 只从受信任的 1688 商品 URL 提取 offer ID，不请求或跟随用户提供的 URL。
 * 短链、分享口令和非 offer 详情页必须由用户先在 1688 转成正式商品链接。
 */
export function normalizeSourceReferences(values: string[]): NormalizedSourceReference[] {
  const normalized = new Map<string, NormalizedSourceReference>();
  for (const raw of values) {
    const reference = raw.trim();
    const offerId = parseOfferId(reference);
    if (!normalized.has(offerId)) normalized.set(offerId, { reference: offerId, offerId });
  }
  return [...normalized.values()];
}

export function parseOfferId(reference: string): string {
  if (OFFER_ID.test(reference)) return reference;

  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    throw invalidReference();
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !ALLOWED_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw invalidReference();
  }
  const match = url.pathname.match(OFFER_PATH);
  if (!match?.[1]) throw invalidReference();
  return match[1];
}

function invalidReference(): BadRequestException {
  return new BadRequestException(
    '只支持 1688 商品数字 ID 或 HTTPS 官方 offer 详情链接，暂不支持短链和分享口令',
  );
}
