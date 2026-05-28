import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PublishService } from './publish.service';
import { CreatePublishTaskDto } from './dto/create-publish-task.dto';

@ApiTags('publish')
@Controller('publish-tasks')
export class PublishController {
  constructor(private readonly publishService: PublishService) {}

  @Post()
  create(@Body() dto: CreatePublishTaskDto) {
    return this.publishService.create(dto);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.publishService.detail(id);
  }
}
