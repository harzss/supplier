import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetStorageService } from './asset-storage.service';

afterEach(() => vi.unstubAllGlobals());

describe('AssetStorageService', () => {
  it('uploads a public PNG to Supabase Storage and returns its public URL', async () => {
    const values: Record<string, string> = {
      SUPABASE_URL: 'https://project.supabase.co/',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret',
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
          authorization: 'Bearer service-role-secret',
          'content-type': 'image/png',
          'x-upsert': 'true',
        }),
      }),
    );
  });

  it('stores processed main images under a separate public path', async () => {
    const values: Record<string, string> = {
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret',
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
});
