import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { OAuthResultDto } from './oauth-result.dto';

describe('OAuthResultDto', () => {
  it('accepts a 256-bit base64url token', async () => {
    const dto = plainToInstance(OAuthResultDto, { token: 'a'.repeat(43) });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it.each([{ token: 'forged' }, { token: 'a'.repeat(42) }, { token: 42 }])(
    'rejects a malformed result token: $token',
    async (input) => {
      const dto = plainToInstance(OAuthResultDto, input);

      expect(await validate(dto)).not.toHaveLength(0);
    },
  );
});
