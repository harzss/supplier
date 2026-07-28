import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ConfirmCategoryMappingDto {
  @IsIn(['douyin'])
  platform!: 'douyin';

  @IsString()
  @MaxLength(64)
  categoryId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  categoryName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  shopId?: string;
}
