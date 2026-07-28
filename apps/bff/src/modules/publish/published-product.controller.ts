import { Body, Controller, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../entitlement/current-user.decorator';
import type { CurrentUser as CurrentUserType } from '../entitlement/user-context.service';
import { UpdatePublishedProductDto } from './dto/update-published-product.dto';
import { PublishService } from './publish.service';

@ApiTags('publish')
@Controller('published-products')
export class PublishedProductController {
  constructor(private readonly publishService: PublishService) {}

  @Put(':id')
  update(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Body() dto: UpdatePublishedProductDto,
  ) {
    return this.publishService.updatePublishedProduct(user, id, dto);
  }

  @Post(':id/status-sync')
  syncStatus(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.publishService.syncPublishedProductStatus(user, id);
  }
}
