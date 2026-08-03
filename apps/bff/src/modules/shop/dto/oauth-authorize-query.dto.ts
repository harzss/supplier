import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class OAuthAuthorizeQueryDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  returnTo?: string;
}
