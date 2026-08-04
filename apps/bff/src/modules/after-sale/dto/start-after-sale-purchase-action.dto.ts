import { IsIn, IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { AfterSaleCaseCommandDto } from './after-sale-case-command.dto';

export const AFTER_SALE_PURCHASE_ACTIONS = [
  'cancel',
  'refund',
  'return_refund',
  'intercept',
  'accept_loss',
  'manual_review',
] as const;

export const AFTER_SALE_REMOTE_REFERENCE_TYPES = [
  'purchase_order',
  'refund',
  'return_order',
  'logistics',
  'other',
] as const;

export class StartAfterSalePurchaseActionDto extends AfterSaleCaseCommandDto {
  @IsIn(AFTER_SALE_PURCHASE_ACTIONS)
  action: (typeof AFTER_SALE_PURCHASE_ACTIONS)[number];

  @IsIn(AFTER_SALE_REMOTE_REFERENCE_TYPES)
  remoteReferenceType: (typeof AFTER_SALE_REMOTE_REFERENCE_TYPES)[number];

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  remoteReferenceId: string;

  @IsInt()
  @Min(0)
  expectedPurchaseExceptionRevision: number;

  @IsInt()
  @Min(0)
  expectedPurchaseSyncRevision: number;
}
