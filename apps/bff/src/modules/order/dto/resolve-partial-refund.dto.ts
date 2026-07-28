import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export type PartialRefundDispositionAction = 'continue_remaining' | 'stop_all';

export class ResolvePartialRefundDto {
  @IsIn(['continue_remaining', 'stop_all'])
  action!: PartialRefundDispositionAction;

  @IsString()
  @MinLength(2)
  @MaxLength(500)
  note!: string;
}
