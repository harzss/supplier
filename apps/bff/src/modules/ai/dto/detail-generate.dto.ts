import { IsArray, IsObject, IsOptional, IsString } from 'class-validator';
import type { PlatformType } from '@supplier/shared-types';

export class DetailGenerateDto {
  @IsString()
  title!: string;

  @IsString()
  category!: string;

  @IsArray()
  @IsString({ each: true })
  sellingPoints!: string[];

  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;

  @IsString()
  targetPlatform!: PlatformType;
}
