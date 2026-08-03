import { Body, Controller, Delete, Get, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../entitlement/current-user.decorator';
import type { CurrentUser as CurrentUserType } from '../entitlement/user-context.service';
import { DeletePublishDraftDto, SavePublishDraftDto } from './dto/publish-draft.dto';
import { PublishDraftService } from './publish-draft.service';

@ApiTags('publish')
@Controller('publish-drafts')
export class PublishDraftController {
  constructor(private readonly drafts: PublishDraftService) {}

  @Get('current')
  get(@CurrentUser() user: CurrentUserType) {
    return this.drafts.get(user.userId);
  }

  @Put('current')
  save(@CurrentUser() user: CurrentUserType, @Body() dto: SavePublishDraftDto) {
    return this.drafts.save(user.userId, dto);
  }

  @Delete('current')
  delete(@CurrentUser() user: CurrentUserType, @Query() dto: DeletePublishDraftDto) {
    return this.drafts.delete(user.userId, dto);
  }
}
