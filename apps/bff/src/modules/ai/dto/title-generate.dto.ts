import { IsArray, IsString } from 'class-validator';
import type { PlatformType } from '@supplier/shared-types';

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
}
