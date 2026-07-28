import { describe, expect, it, vi } from 'vitest';
import type { AssetStorageService } from './asset-storage.service';
import type { ImagePipelineService } from './image-pipeline.service';
import { MediaController } from './media.controller';

describe('MediaController', () => {
  it('reports readiness without exposing credentials', () => {
    const storage = {
      readiness: vi.fn().mockReturnValue({ ready: false, detail: '图片存储未配置' }),
    } as unknown as AssetStorageService;
    const imagePipeline = {
      readiness: vi.fn().mockReturnValue({
        ready: true,
        detail: '远程处理服务已配置：worker.example',
      }),
    } as unknown as ImagePipelineService;

    const result = new MediaController(storage, imagePipeline).readiness();

    expect(result).toMatchObject({ ready: false, readyCount: 1, totalCount: 2 });
    expect(result.checks.map((check) => check.id)).toEqual(['storage', 'image_pipeline']);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
