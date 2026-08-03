import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetStorageService } from './asset-storage.service';

afterEach(() => vi.unstubAllGlobals());

describe('AssetStorageService', () => {
  it('uploads a public PNG to Supabase Storage and returns its public URL', async () => {
    const values: Record<string, string> = {
      SUPABASE_URL: 'https://project.supabase.co/',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test_key_that_is_long_enough',
      SUPABASE_STORAGE_BUCKET: 'supplier-assets',
    };
    const config = { get: vi.fn((key: string) => values[key]) } as unknown as ConfigService;
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);

    const url = await new AssetStorageService(config).uploadDetailImage(1n, 9n, Buffer.from('png'));

    expect(url).toBe(
      'https://project.supabase.co/storage/v1/object/public/supplier-assets/details/1/9.png',
    );
    expect(fetcher).toHaveBeenCalledWith(
      'https://project.supabase.co/storage/v1/object/supplier-assets/details/1/9.png',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          apikey: 'sb_secret_test_key_that_is_long_enough',
          'content-type': 'image/png',
          'x-upsert': 'true',
        }),
      }),
    );
    const headers = fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(Object.hasOwn(headers, 'authorization')).toBe(false);
  });

  it('uses a legacy service-role JWT as both apikey and bearer authorization', async () => {
    const serviceRoleKey = jwtWithRole('service_role');
    const values: Record<string, string> = {
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
      SUPABASE_STORAGE_BUCKET: 'supplier-assets',
    };
    const config = { get: vi.fn((key: string) => values[key]) } as unknown as ConfigService;
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);

    await new AssetStorageService(config).uploadDetailImage(1n, 9n, Buffer.from('png'));

    expect(fetcher).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
        }),
      }),
    );
  });

  it('stores processed main images under a separate public path', async () => {
    const values: Record<string, string> = {
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test_key_that_is_long_enough',
      SUPABASE_STORAGE_BUCKET: 'supplier-assets',
    };
    const config = { get: vi.fn((key: string) => values[key]) } as unknown as ConfigService;
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);

    const url = await new AssetStorageService(config).uploadMainImage(1n, 9n, Buffer.from('png'));

    expect(url).toBe(
      'https://project.supabase.co/storage/v1/object/public/supplier-assets/main-images/1/9.png',
    );
  });

  it('fails closed when storage credentials are missing', async () => {
    const config = { get: vi.fn() } as unknown as ConfigService;
    const service = new AssetStorageService(config);
    await expect(service.uploadDetailImage(1n, 9n, Buffer.from('png'))).rejects.toThrow(
      '图片存储未配置',
    );
    expect(service.readiness()).toEqual({ ready: false, detail: '图片存储未配置' });
  });

  it('rejects public or malformed keys before sending storage credentials', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    for (const serviceRoleKey of [
      'sb_publishable_test_key_that_is_long_enough',
      jwtWithRole('anon'),
      jwtWithRole('service_role').replace('.', '!.'),
      'malformed-service-role-key',
    ]) {
      const values: Record<string, string> = {
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
        SUPABASE_STORAGE_BUCKET: 'supplier-assets',
      };
      const config = { get: vi.fn((key: string) => values[key]) } as unknown as ConfigService;
      await expect(
        new AssetStorageService(config).uploadDetailImage(1n, 9n, Buffer.from('png')),
      ).rejects.toThrow('SUPABASE_SERVICE_ROLE_KEY 格式无效');
    }

    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a non-Supabase production host before sending the admin key', async () => {
    const values: Record<string, string> = {
      NODE_ENV: 'production',
      SUPABASE_URL: 'https://attacker.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test_key_that_is_long_enough',
      SUPABASE_STORAGE_BUCKET: 'supplier-assets',
    };
    const config = { get: vi.fn((key: string) => values[key]) } as unknown as ConfigService;
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    await expect(
      new AssetStorageService(config).uploadDetailImage(1n, 9n, Buffer.from('png')),
    ).rejects.toThrow('精确的 Supabase 项目 HTTPS 地址');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

function jwtWithRole(role: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ role, iss: 'supabase', exp: 4_102_444_800 }),
  ).toString('base64url');
  return `${header}.${payload}.${'s'.repeat(43)}`;
}
