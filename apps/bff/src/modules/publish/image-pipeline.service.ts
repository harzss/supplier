import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@supplier/db';
import { isIP } from 'node:net';
import sharp from 'sharp';
import { z } from 'zod';
import { AiUsageService } from '../entitlement/ai-usage.service';
import type { CurrentUser } from '../entitlement/user-context.service';
import type { MainImageOperations } from './main-image.types';

export interface MainImageProcessResult {
  image: Buffer;
  provider: string;
  model: string;
  watermarkDetected: boolean;
  watermarkCount: number;
  steps: string[];
  complianceFlags: string[];
  costCny: number;
}

const responseSchema = z.object({
  output: z.object({
    imageBase64: z.string().min(16).max(28_000_000),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  }),
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(64),
  costCny: z.number().nonnegative().default(0),
  watermark: z.object({
    detected: z.boolean(),
    boxes: z
      .array(
        z.object({
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1),
          width: z.number().positive().max(1),
          height: z.number().positive().max(1),
          confidence: z.number().min(0).max(1),
        }),
      )
      .max(50),
  }),
  steps: z.array(z.string().min(1).max(64)).max(20),
  compliance: z.object({
    passed: z.boolean(),
    flags: z.array(z.string().min(1).max(160)).max(20),
  }),
});

@Injectable()
export class ImagePipelineService {
  constructor(
    private readonly config: ConfigService,
    private readonly usage: AiUsageService,
  ) {}

  async process(
    user: CurrentUser,
    sourceImageUrl: string,
    operations: MainImageOperations,
  ): Promise<MainImageProcessResult> {
    const sourceUrl = validateSourceUrl(sourceImageUrl);
    const { endpoint, apiKey } = this.pipelineConfig();
    const module = primaryModule(operations);
    const reservation = await this.usage.reservePlatform(
      user.userId,
      user.plan,
      module,
      'image-pipeline',
    );
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sourceImageUrl: sourceUrl,
          operations,
          output: { width: 1000, height: 1000, format: 'png' },
        }),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (error) {
      await this.usage.cancel(
        reservation,
        error instanceof Error ? error.name : 'worker_connection_failed',
      );
      throw new Error('主图处理服务连接失败');
    }
    if (!response.ok) {
      await this.usage.cancel(reservation, `worker_http_${response.status}`);
      throw new Error(`主图处理服务失败（HTTP ${response.status}）`);
    }

    const parsed = responseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      await this.usage.reportUnknownOutcome(reservation, '主图处理服务返回格式无效');
      throw new Error('主图处理服务返回格式无效');
    }
    await this.usage.completeImage(reservation, {
      model: `${parsed.data.provider}/${parsed.data.model}`,
      costCny: parsed.data.costCny,
    });
    if (!parsed.data.compliance.passed) {
      const reason = parsed.data.compliance.flags.join('；') || '图片合规审核未通过';
      throw new Error(`主图合规审核未通过：${reason}`);
    }

    const rawImage = decodeBase64(parsed.data.output.imageBase64);
    const image = await normalizeImage(rawImage);
    const result: MainImageProcessResult = {
      image,
      provider: parsed.data.provider,
      model: parsed.data.model,
      watermarkDetected: parsed.data.watermark.detected,
      watermarkCount: parsed.data.watermark.boxes.length,
      steps: parsed.data.steps,
      complianceFlags: parsed.data.compliance.flags,
      costCny: parsed.data.costCny,
    };
    return result;
  }

  readiness(): { ready: boolean; detail: string } {
    try {
      const { endpoint } = this.pipelineConfig();
      return { ready: true, detail: `远程处理服务已配置：${new URL(endpoint).host}` };
    } catch (err) {
      return { ready: false, detail: (err as Error).message };
    }
  }

  private pipelineConfig(): { endpoint: string; apiKey: string } {
    const rawEndpoint = this.config.get<string>('IMAGE_PIPELINE_URL')?.trim();
    const apiKey = this.config.get<string>('IMAGE_PIPELINE_API_KEY')?.trim();
    if (!rawEndpoint || !apiKey) throw new Error('主图处理服务未配置');

    let endpoint: URL;
    try {
      endpoint = new URL(rawEndpoint);
    } catch {
      throw new Error('IMAGE_PIPELINE_URL 必须是绝对地址');
    }
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password
    ) {
      throw new Error('IMAGE_PIPELINE_URL 无效');
    }
    if (this.config.get<string>('NODE_ENV') === 'production' && endpoint.protocol !== 'https:') {
      throw new Error('生产环境 IMAGE_PIPELINE_URL 必须使用 HTTPS');
    }
    return { endpoint: endpoint.toString(), apiKey };
  }
}

function validateSourceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('货源主图地址无效');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('货源主图地址无效');
  }
  if (isPrivateHostname(url.hostname)) throw new Error('货源主图地址不允许访问私网');
  return url.toString();
}

function isPrivateHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    return true;
  }
  const version = isIP(hostname);
  if (version === 4) {
    const [a = 0, b = 0] = hostname.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (version === 6) {
    return (
      hostname === '::1' ||
      hostname.startsWith('fc') ||
      hostname.startsWith('fd') ||
      hostname.startsWith('fe8')
    );
  }
  return false;
}

function decodeBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('主图处理结果编码无效');
  const image = Buffer.from(value, 'base64');
  if (!image.length) throw new Error('主图处理结果为空');
  return image;
}

async function normalizeImage(value: Buffer): Promise<Buffer> {
  try {
    const metadata = await sharp(value).metadata();
    if (!metadata.width || !metadata.height || metadata.width > 6000 || metadata.height > 6000) {
      throw new Error('invalid dimensions');
    }
    return await sharp(value)
      .rotate()
      .resize(1000, 1000, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .png({ compressionLevel: 9 })
      .toBuffer();
  } catch {
    throw new Error('主图处理结果不是有效图片');
  }
}

function primaryModule(operations: MainImageOperations): Prisma.AiUsageLogCreateInput['module'] {
  if (operations.backgroundStyle) return 'image_compose';
  if (operations.relight) return 'image_relight';
  return 'image_remove_watermark';
}
