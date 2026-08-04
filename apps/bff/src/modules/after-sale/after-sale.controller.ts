import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../entitlement/current-user.decorator';
import type { CurrentUser as CurrentUserType } from '../entitlement/user-context.service';
import { AuditAction } from '../observability/audit.decorator';
import { AfterSaleService } from './after-sale.service';
import { ClaimAfterSaleCaseDto } from './dto/after-sale-case-command.dto';
import { AfterSaleCaseListQueryDto } from './dto/after-sale-case-list-query.dto';
import { ConfirmAfterSalePurchaseActionDto } from './dto/confirm-after-sale-purchase-action.dto';
import { StartAfterSalePurchaseActionDto } from './dto/start-after-sale-purchase-action.dto';
import { VerifyCloseAfterSaleCaseDto } from './dto/verify-close-after-sale-case.dto';
import { RefreshAfterSaleCasesQueryDto } from './dto/refresh-after-sale-cases-query.dto';

@ApiTags('after-sale-cases')
@Controller('after-sale-cases')
export class AfterSaleController {
  constructor(private readonly afterSales: AfterSaleService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserType, @Query() query: AfterSaleCaseListQueryDto) {
    return this.afterSales.list(user.userId, query);
  }

  @Post('refresh')
  @HttpCode(200)
  @AuditAction('after_sale.refresh', 'after_sale_case')
  refresh(@CurrentUser() user: CurrentUserType, @Query() query: RefreshAfterSaleCasesQueryDto) {
    return this.afterSales.refreshUser(user.userId, new Date(), query.afterOrderId);
  }

  @Get(':id')
  detail(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.afterSales.detail(user.userId, id);
  }

  @Post(':id/claim')
  @HttpCode(200)
  @AuditAction('after_sale.claim', 'after_sale_case')
  claim(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Body() dto: ClaimAfterSaleCaseDto,
  ) {
    return this.afterSales.claim(user.userId, id, dto);
  }

  @Post(':caseId/purchase-links/:linkId/start')
  @HttpCode(200)
  @AuditAction('after_sale.purchase_action.start', 'after_sale_case')
  startPurchaseAction(
    @CurrentUser() user: CurrentUserType,
    @Param('caseId') caseId: string,
    @Param('linkId') linkId: string,
    @Body() dto: StartAfterSalePurchaseActionDto,
  ) {
    return this.afterSales.startPurchaseAction(user.userId, caseId, linkId, dto);
  }

  @Post(':caseId/purchase-links/:linkId/confirm')
  @HttpCode(200)
  @AuditAction('after_sale.purchase_action.confirm', 'after_sale_case')
  confirmPurchaseAction(
    @CurrentUser() user: CurrentUserType,
    @Param('caseId') caseId: string,
    @Param('linkId') linkId: string,
    @Body() dto: ConfirmAfterSalePurchaseActionDto,
  ) {
    return this.afterSales.confirmPurchaseAction(user.userId, caseId, linkId, dto);
  }

  @Post(':id/verify-close')
  @HttpCode(200)
  @AuditAction('after_sale.verify_close', 'after_sale_case')
  verifyClose(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Body() dto: VerifyCloseAfterSaleCaseDto,
  ) {
    return this.afterSales.verifyClose(user.userId, id, dto);
  }
}
