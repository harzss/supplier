import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AssetStorageService {
  constructor(private readonly config: ConfigService) {}

  async uploadDetailImage(userId: bigint, taskId: bigint, image: Buffer): Promise<string> {
    return this.uploadPublicImage(`details/${userId}/${taskId}.png`, image);
  }

  async uploadMainImage(userId: bigint, taskId: bigint, image: Buffer): Promise<string> {
    return this.uploadPublicImage(`main-images/${userId}/${taskId}.png`, image);
  }

  assertConfigured(): void {
    this.storageConfig();
  }

  readiness(): { ready: boolean; detail: string } {
    try {
      const { bucket } = this.storageConfig();
      return { ready: true, detail: `Supabase Storage bucket「${bucket}」已配置` };
    } catch (err) {
      return { ready: false, detail: (err as Error).message };
    }
  }

  private async uploadPublicImage(objectPath: string, image: Buffer): Promise<string> {
    const { baseUrl, bucket, serviceRoleKey } = this.storageConfig();
    const encodedObject = encodePath(`${bucket}/${objectPath}`);
    const response = await fetch(`${baseUrl}/storage/v1/object/${encodedObject}`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        'content-type': 'image/png',
        'x-upsert': 'true',
      },
      body: copyToArrayBuffer(image),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`图片上传失败（HTTP ${response.status}）`);
    }
    return `${baseUrl}/storage/v1/object/public/${encodedObject}`;
  }

  private storageConfig(): { baseUrl: string; bucket: string; serviceRoleKey: string } {
    const rawBaseUrl = this.value('SUPABASE_URL');
    const serviceRoleKey = this.value('SUPABASE_SERVICE_ROLE_KEY');
    const bucket = this.value('SUPABASE_STORAGE_BUCKET');
    if (!rawBaseUrl || !serviceRoleKey || !bucket) {
      throw new Error('图片存储未配置');
    }

    let url: URL;
    try {
      url = new URL(rawBaseUrl);
    } catch {
      throw new Error('SUPABASE_URL 必须是绝对地址');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('SUPABASE_URL 无效');
    }
    if (this.value('NODE_ENV') === 'production' && url.protocol !== 'https:') {
      throw new Error('生产环境 SUPABASE_URL 必须使用 HTTPS');
    }

    return {
      baseUrl: url.toString().replace(/\/+$/, ''),
      bucket,
      serviceRoleKey,
    };
  }

  private value(key: string): string {
    return this.config.get<string>(key)?.trim() ?? '';
  }
}

function encodePath(value: string): string {
  return value
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function copyToArrayBuffer(value: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(value.byteLength);
  new Uint8Array(copy).set(value);
  return copy;
}
