import { IsOptional, Matches } from 'class-validator';

export class RefreshAfterSaleCasesQueryDto {
  @IsOptional()
  @Matches(/^[1-9][0-9]{0,18}$/)
  afterOrderId?: string;
}
