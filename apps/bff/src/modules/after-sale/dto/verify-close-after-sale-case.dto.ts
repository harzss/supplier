import { IsIn, IsOptional } from 'class-validator';
import { AfterSaleCaseCommandDto } from './after-sale-case-command.dto';

export const AFTER_SALE_RESOLUTION_CODES = [
  'sales_rejected_or_withdrawn',
  'partial_refund_handled',
  'full_refund_handled',
  'price_protection_reconciled',
  'order_closed_handled',
] as const;

export class VerifyCloseAfterSaleCaseDto extends AfterSaleCaseCommandDto {
  @IsOptional()
  @IsIn(AFTER_SALE_RESOLUTION_CODES)
  resolutionCode?: (typeof AFTER_SALE_RESOLUTION_CODES)[number];
}
