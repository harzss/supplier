import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { OAuthAuthorizeQueryDto } from './oauth-authorize-query.dto';

describe('OAuthAuthorizeQueryDto', () => {
  it('accepts an omitted or bounded return target', async () => {
    const empty = plainToInstance(OAuthAuthorizeQueryDto, {});
    const query = plainToInstance(OAuthAuthorizeQueryDto, {
      returnTo: '/products?id=offer%2F1001#publish',
    });

    await expect(validate(empty)).resolves.toHaveLength(0);
    await expect(validate(query)).resolves.toHaveLength(0);
  });

  it('rejects empty, non-string and oversized return targets', async () => {
    const empty = plainToInstance(OAuthAuthorizeQueryDto, { returnTo: '' });
    const nonString = plainToInstance(OAuthAuthorizeQueryDto, { returnTo: 42 });
    const oversized = plainToInstance(OAuthAuthorizeQueryDto, { returnTo: `/${'a'.repeat(2048)}` });

    expect(await validate(empty)).not.toHaveLength(0);
    expect(await validate(nonString)).not.toHaveLength(0);
    expect(await validate(oversized)).not.toHaveLength(0);
  });
});
