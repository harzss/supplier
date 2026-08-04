import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsPositiveInt64String } from '../../publish/dto/create-publish-task.dto';

export const SOURCE_IMPORT_MAX_ITEMS = 100;

export class CreateSourceImportPreviewDto {
  @IsUUID()
  clientRequestId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SOURCE_IMPORT_MAX_ITEMS)
  @IsString({ each: true })
  @MaxLength(1024, { each: true })
  @Matches(/\S/, { each: true })
  references!: string[];

  @IsOptional()
  @IsString()
  @IsPositiveInt64String()
  buyerShopId?: string;
}

export class ExecuteSourceImportDto {
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  previewRevision!: number;
}

export class RetrySourceImportDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SOURCE_IMPORT_MAX_ITEMS)
  @IsString({ each: true })
  @IsPositiveInt64String({ each: true })
  itemIds?: string[];
}

export class SourceImportListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}

export class CollectedSourceProductQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}
