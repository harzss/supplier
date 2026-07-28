import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdatePublishedProductDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  title?: string;
}
