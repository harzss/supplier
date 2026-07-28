import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../entitlement/current-user.decorator';
import type { CurrentUser as CurrentUserType } from '../entitlement/user-context.service';
import { CategoryQualificationService } from './category-qualification.service';
import { ConfirmCategoryQualificationsDto } from './dto/confirm-category-qualifications.dto';

@ApiTags('categories')
@Controller('categories/mappings/:sourceProductId/qualifications')
export class CategoryQualificationController {
  constructor(private readonly qualifications: CategoryQualificationService) {}

  @Get()
  get(
    @CurrentUser() user: CurrentUserType,
    @Param('sourceProductId') sourceProductId: string,
    @Query('shopId') shopId: string,
  ) {
    return this.qualifications.get(user.userId, sourceProductId, shopId);
  }

  @Post('sync')
  sync(
    @CurrentUser() user: CurrentUserType,
    @Param('sourceProductId') sourceProductId: string,
    @Query('shopId') shopId: string,
  ) {
    return this.qualifications.sync(user.userId, sourceProductId, shopId);
  }

  @Put()
  confirm(
    @CurrentUser() user: CurrentUserType,
    @Param('sourceProductId') sourceProductId: string,
    @Body() dto: ConfirmCategoryQualificationsDto,
  ) {
    return this.qualifications.confirm(user.userId, sourceProductId, dto);
  }

  @Delete()
  remove(
    @CurrentUser() user: CurrentUserType,
    @Param('sourceProductId') sourceProductId: string,
    @Query('shopId') shopId: string,
  ) {
    return this.qualifications.remove(user.userId, sourceProductId, shopId);
  }
}
