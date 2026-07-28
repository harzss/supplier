import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const CONNECTABLE_PLATFORMS = ['douyin', 'taobao', 'pdd', 'kuaishou'] as const;
export type ConnectablePlatform = (typeof CONNECTABLE_PLATFORMS)[number];

export class ConnectShopDto {
  @IsIn(CONNECTABLE_PLATFORMS)
  platform!: ConnectablePlatform;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  shopName?: string;
}
