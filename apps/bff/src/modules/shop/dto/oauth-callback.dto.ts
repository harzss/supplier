import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class OAuthCallbackDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  code!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  state!: string;
}
