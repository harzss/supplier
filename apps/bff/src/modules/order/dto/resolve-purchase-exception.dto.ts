import { IsInt, IsNumber, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class ResolvePurchaseExceptionDto {
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999.99)
  actualCost!: number;

  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @IsString()
  @MinLength(2)
  @MaxLength(500)
  note!: string;
}
