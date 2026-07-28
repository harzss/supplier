import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AssetStorageService } from './asset-storage.service';
import { ImagePipelineService } from './image-pipeline.service';

export interface MediaReadinessCheck {
  id: 'storage' | 'image_pipeline';
  label: string;
  ready: boolean;
  detail: string;
}

@ApiTags('media')
@Controller('media')
export class MediaController {
  constructor(
    private readonly storage: AssetStorageService,
    private readonly imagePipeline: ImagePipelineService,
  ) {}

  @Get('readiness')
  readiness() {
    const storage = this.storage.readiness();
    const imagePipeline = this.imagePipeline.readiness();
    const checks: MediaReadinessCheck[] = [
      { id: 'storage', label: '图片公开存储', ...storage },
      { id: 'image_pipeline', label: 'GPU 主图处理服务', ...imagePipeline },
    ];
    const readyCount = checks.filter((check) => check.ready).length;
    return {
      ready: readyCount === checks.length,
      readyCount,
      totalCount: checks.length,
      checks,
    };
  }
}
