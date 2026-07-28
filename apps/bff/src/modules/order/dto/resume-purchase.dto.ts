import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class ResumePurchaseDto {
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @IsString()
  @MinLength(2)
  @MaxLength(500)
  note!: string;
}
