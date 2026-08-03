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
        ...supabaseAdminApiKeyHeaders(serviceRoleKey),
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

  private storageConfig(): {
    baseUrl: string;
    bucket: string;
    serviceRoleKey: SupabaseAdminApiKey;
  } {
    const rawBaseUrl = this.value('SUPABASE_URL');
    const rawServiceRoleKey = this.value('SUPABASE_SERVICE_ROLE_KEY');
    const bucket = this.value('SUPABASE_STORAGE_BUCKET');
    if (!rawBaseUrl || !rawServiceRoleKey || !bucket) {
      throw new Error('图片存储未配置');
    }

    let url: URL;
    try {
      url = new URL(rawBaseUrl);
    } catch {
      throw new Error('SUPABASE_URL 必须是绝对地址');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error('SUPABASE_URL 无效');
    }
    if (
      this.value('NODE_ENV') === 'production' &&
      (url.protocol !== 'https:' ||
        url.port !== '' ||
        !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname))
    ) {
      throw new Error('生产环境 SUPABASE_URL 必须是精确的 Supabase 项目 HTTPS 地址');
    }

    return {
      baseUrl: url.origin,
      bucket,
      serviceRoleKey: parseSupabaseAdminApiKey(rawServiceRoleKey),
    };
  }

  private value(key: string): string {
    return this.config.get<string>(key)?.trim() ?? '';
  }
}

type SupabaseAdminApiKey = { kind: 'modern'; value: string } | { kind: 'legacy'; value: string };

function parseSupabaseAdminApiKey(value: string): SupabaseAdminApiKey {
  if (/^sb_secret_[A-Za-z0-9_-]{20,}$/.test(value)) {
    return { kind: 'modern', value };
  }

  const parts = value.split('.');
  if (parts.length === 3) {
    try {
      const [encodedHeader, encodedPayload, encodedSignature] = parts;
      if (
        !encodedHeader ||
        !encodedPayload ||
        !encodedSignature ||
        !/^[A-Za-z0-9_-]+$/.test(encodedHeader) ||
        !/^[A-Za-z0-9_-]+$/.test(encodedPayload) ||
        !/^[A-Za-z0-9_-]{43}$/.test(encodedSignature)
      ) {
        throw new Error('invalid JWT');
      }
      const headerBytes = Buffer.from(encodedHeader, 'base64url');
      const payloadBytes = Buffer.from(encodedPayload, 'base64url');
      if (
        headerBytes.toString('base64url') !== encodedHeader ||
        payloadBytes.toString('base64url') !== encodedPayload
      ) {
        throw new Error('invalid JWT');
      }
      const header = JSON.parse(headerBytes.toString('utf8')) as unknown;
      const payload = JSON.parse(payloadBytes.toString('utf8')) as unknown;
      if (
        isRecord(header) &&
        header.alg === 'HS256' &&
        header.typ === 'JWT' &&
        isRecord(payload) &&
        payload.role === 'service_role' &&
        payload.iss === 'supabase' &&
        Number.isInteger(payload.exp) &&
        Number(payload.exp) > Math.floor(Date.now() / 1000)
      ) {
        return { kind: 'legacy', value };
      }
    } catch {
      // Fall through to a generic error that never includes key material.
    }
  }
  throw new Error('SUPABASE_SERVICE_ROLE_KEY 格式无效');
}

function supabaseAdminApiKeyHeaders(key: SupabaseAdminApiKey): Record<string, string> {
  if (key.kind === 'modern') return { apikey: key.value };
  return { apikey: key.value, authorization: `Bearer ${key.value}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
