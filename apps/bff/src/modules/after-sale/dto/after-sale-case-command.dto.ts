import { IsInt, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';

export class AfterSaleCaseCommandDto {
  @IsInt()
  @Min(1)
  expectedRevision: number;

  @IsUUID()
  clientRequestId: string;

  @IsString()
  @MinLength(2)
  @MaxLength(500)
  note: string;
}

export class ClaimAfterSaleCaseDto extends AfterSaleCaseCommandDto {}
