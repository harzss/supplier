import { ArrayNotEmpty, IsArray, IsOptional, IsString } from 'class-validator';

export class CreatePublishTaskDto {
  @IsString()
  sourceProductId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  targetShopIds!: string[];

  @IsOptional()
  pricingStrategy?: {
    mode: 'fixed_markup' | 'competitor_anchor' | 'profit_target';
    markupRatio?: number;
    targetMargin?: number;
  };

  @IsOptional()
  aiOptions?: {
    rewriteTitle?: boolean;
    rewriteDetail?: boolean;
    relightImages?: boolean;
    backgroundStyle?: string;
  };
}
