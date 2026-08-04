import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { normalizeSourceReferences, parseOfferId } from './source-import-reference';

describe('source import reference normalization', () => {
  it.each([
    ['573741401425', '573741401425'],
    ['https://detail.1688.com/offer/573741401425.html', '573741401425'],
    ['https://m.1688.com/offer/573741401425.html?spm=a#detail', '573741401425'],
    ['https://www.1688.com/offer/573741401425.html/', '573741401425'],
  ])('extracts an offer ID from %s', (value, expected) => {
    expect(parseOfferId(value)).toBe(expected);
  });

  it.each([
    '0',
    '-1',
    'abc',
    'http://detail.1688.com/offer/1.html',
    'https://detail.1688.com.evil.example/offer/1.html',
    'https://user@detail.1688.com/offer/1.html',
    'https://detail.1688.com:444/offer/1.html',
    'https://detail.1688.com/not-offer/1.html',
    'https://qr.1688.com/s/short',
  ])('rejects unsafe or unsupported reference %s', (value) => {
    expect(() => parseOfferId(value)).toThrow(BadRequestException);
  });

  it('deduplicates and strips URL query or fragment data from the persisted reference', () => {
    expect(
      normalizeSourceReferences([
        'https://detail.1688.com/offer/573741401425.html?spm=tracking-secret#detail',
        ' 573741401425 ',
        '573741401426',
      ]),
    ).toEqual([
      { reference: '573741401425', offerId: '573741401425' },
      { reference: '573741401426', offerId: '573741401426' },
    ]);
  });
});
