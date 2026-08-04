import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ValidateNested } from 'class-validator';
import { AfterSaleCaseCommandDto } from './after-sale-case-command.dto';
import { AFTER_SALE_REMOTE_REFERENCE_TYPES } from './start-after-sale-purchase-action.dto';

export class AfterSaleActionEvidenceDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  screenshotObjectKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  platformStatus?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  amountRef?: string;

  @IsOptional()
  @IsDateString()
  capturedAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}

export class ConfirmAfterSalePurchaseActionDto extends AfterSaleCaseCommandDto {
  @IsIn(['confirmed', 'failed'])
  result: 'confirmed' | 'failed';

  @IsInt()
  @Min(0)
  expectedPurchaseExceptionRevision: number;

  @IsInt()
  @Min(0)
  expectedPurchaseSyncRevision: number;

  @IsOptional()
  @IsIn(AFTER_SALE_REMOTE_REFERENCE_TYPES)
  remoteReferenceType?: (typeof AFTER_SALE_REMOTE_REFERENCE_TYPES)[number];

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  remoteReferenceId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AfterSaleActionEvidenceDto)
  evidence?: AfterSaleActionEvidenceDto;
}
