import { IsNumber, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class ConfirmRefundAmountDto {
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsString()
  @MinLength(2)
  @MaxLength(500)
  note!: string;
}
