import { IsArray, IsOptional, IsString } from 'class-validator';
import type { PlatformType, UserPlan } from '@supplier/shared-types';

export class TitleGenerateDto {
  @IsString()
  originalTitle!: string;

  @IsString()
  category!: string;

  @IsArray()
  @IsString({ each: true })
  sellingPoints!: string[];

  @IsString()
  targetPlatform!: PlatformType;

  @IsOptional()
  @IsString()
  userPlan?: UserPlan;
}
