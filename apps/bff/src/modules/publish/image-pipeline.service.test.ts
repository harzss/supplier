import type { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiUsageService } from '../entitlement/ai-usage.service';
import type { CurrentUser } from '../entitlement/user-context.service';
import { ImagePipelineService } from './image-pipeline.service';

const USER: CurrentUser = {
  userId: 1n,
  plan: 'pro',
  entitlementSource: 'internal_beta',
  accessStatus: 'active',
  entitlementRevision: 1,
};

afterEach(() => vi.unstubAllGlobals());

describe('ImagePipelineService', () => {
  it('fails before calling the paid worker when platform quota cannot be counted', async () => {
    const fixture = createFixture();
    fixture.reservePlatform.mockRejectedValue(new Error('db unavailable'));
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    await expect(
      fixture.service.process(USER, 'https://img.example/source.jpg', {
        removeWatermark: true,
        relight: false,
      }),
    ).rejects.toThrow('db unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('calls the remote visual pipeline, validates the result and meters one image', async () => {
    const source = await sharp({
      create: { width: 32, height: 24, channels: 3, background: '#f97316' },
    })
      .png()
      .toBuffer();
    const fixture = createFixture();
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: { imageBase64: source.toString('base64'), mimeType: 'image/png' },
          provider: 'gpu-worker',
          model: 'yolo-flux-sam2-qwen-vl',
          costCny: 0.055,
          watermark: {
            detected: true,
            boxes: [{ x: 0.8, y: 0.8, width: 0.1, height: 0.1, confidence: 0.96 }],
          },
          steps: ['watermark_detect', 'inpaint', 'segment', 'background', 'compliance'],
          compliance: { passed: true, flags: [] },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetcher);

    const result = await fixture.service.process(USER, 'https://img.example/source.jpg', {
      removeWatermark: true,
      relight: true,
      backgroundStyle: 'white_studio',
    });

    expect(fetcher).toHaveBeenCalledWith(
      'https://worker.example/v1/images/process',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer worker-secret' }),
        body: JSON.stringify({
          sourceImageUrl: 'https://img.example/source.jpg',
          operations: {
            removeWatermark: true,
            relight: true,
            backgroundStyle: 'white_studio',
          },
          output: { width: 1000, height: 1000, format: 'png' },
        }),
      }),
    );
    expect(await sharp(result.image).metadata()).toMatchObject({
      format: 'png',
      width: 1000,
      height: 1000,
    });
    expect(result.watermarkDetected).toBe(true);
    expect(result.watermarkCount).toBe(1);
    expect(fixture.reservePlatform).toHaveBeenCalledWith(
      1n,
      'pro',
      'image_compose',
      'image-pipeline',
    );
    expect(fixture.completeImage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 9n, module: 'image_compose' }),
      {
        model: 'gpu-worker/yolo-flux-sam2-qwen-vl',
        costCny: 0.055,
      },
    );
  });

  it('rejects an image that failed the worker compliance review', async () => {
    const fixture = createFixture();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            output: { imageBase64: 'aW52YWxpZC1pbWFnZQ==', mimeType: 'image/png' },
            provider: 'gpu-worker',
            model: 'qwen-vl',
            costCny: 0,
            watermark: { detected: false, boxes: [] },
            steps: ['compliance'],
            compliance: { passed: false, flags: ['检测到二维码'] },
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      fixture.service.process(USER, 'https://img.example/source.jpg', {
        removeWatermark: true,
        relight: false,
      }),
    ).rejects.toThrow('检测到二维码');
    expect(fixture.completeImage).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'image_remove_watermark' }),
      expect.objectContaining({ model: 'gpu-worker/qwen-vl', costCny: 0 }),
    );
  });

  it('rejects private source image URLs before calling the worker', async () => {
    const fixture = createFixture();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    await expect(
      fixture.service.process(USER, 'http://127.0.0.1/internal.png', {
        removeWatermark: true,
        relight: false,
      }),
    ).rejects.toThrow('不允许访问私网');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cancels the reservation when the worker call fails before producing usage', async () => {
    const fixture = createFixture();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(
      fixture.service.process(USER, 'https://img.example/source.jpg', {
        removeWatermark: true,
        relight: false,
      }),
    ).rejects.toThrow('主图处理服务连接失败');
    expect(fixture.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'image_remove_watermark' }),
      'Error',
    );
  });

  it('keeps and alerts on a reservation when a successful worker response cannot be priced', async () => {
    const fixture = createFixture();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ unexpected: true }), { status: 200 })),
    );

    await expect(
      fixture.service.process(USER, 'https://img.example/source.jpg', {
        removeWatermark: true,
        relight: false,
      }),
    ).rejects.toThrow('主图处理服务返回格式无效');
    expect(fixture.reportUnknownOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'image_remove_watermark' }),
      '主图处理服务返回格式无效',
    );
    expect(fixture.cancel).not.toHaveBeenCalled();
  });

  it('fails before making a request when the worker is not configured', async () => {
    const fixture = createFixture({ IMAGE_PIPELINE_URL: '', IMAGE_PIPELINE_API_KEY: '' });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    await expect(
      fixture.service.process(USER, 'https://img.example/source.jpg', {
        removeWatermark: true,
        relight: false,
      }),
    ).rejects.toThrow('主图处理服务未配置');
    expect(fetcher).not.toHaveBeenCalled();
    expect(fixture.service.readiness()).toEqual({
      ready: false,
      detail: '主图处理服务未配置',
    });
  });
});

function createFixture(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    IMAGE_PIPELINE_URL: 'https://worker.example/v1/images/process',
    IMAGE_PIPELINE_API_KEY: 'worker-secret',
    ...overrides,
  };
  const config = { get: vi.fn((key: string) => values[key]) } as unknown as ConfigService;
  const reservePlatform = vi
    .fn()
    .mockImplementation(async (_userId: bigint, _plan: string, module: string) => ({
      id: 9n,
      module,
      pendingModel: 'pending/image-pipeline',
      traceId: 'image-usage-trace',
      quota: {
        key: 'ai.calls.monthly',
        limit: 3000,
        used: 21,
        remaining: 2979,
        exceeded: false,
      },
    }));
  const completeImage = vi.fn().mockResolvedValue(true);
  const usage = {
    reservePlatform,
    completeImage,
    cancel: vi.fn().mockResolvedValue(true),
    reportUnknownOutcome: vi.fn().mockResolvedValue(undefined),
  } as unknown as AiUsageService;
  return {
    service: new ImagePipelineService(config, usage),
    reservePlatform,
    completeImage,
    cancel: usage.cancel as unknown as ReturnType<typeof vi.fn>,
    reportUnknownOutcome: usage.reportUnknownOutcome as unknown as ReturnType<typeof vi.fn>,
  };
}
