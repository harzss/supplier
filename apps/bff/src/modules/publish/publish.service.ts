import { Injectable } from '@nestjs/common';
import type { CreatePublishTaskDto } from './dto/create-publish-task.dto';

@Injectable()
export class PublishService {
  /**
   * 创建铺货任务
   * TODO:
   * 1. 写 publish_tasks 表
   * 2. 触发 Temporal Workflow（AI 优化 → 多平台发布）
   */
  async create(dto: CreatePublishTaskDto) {
    return {
      taskId: 'placeholder',
      status: 'pending',
      input: dto,
    };
  }

  async detail(id: string) {
    return {
      id,
      message: 'Not implemented yet',
    };
  }
}
