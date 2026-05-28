export type PlatformType =
  | 'alibaba_1688'
  | 'taobao'
  | 'tmall'
  | 'douyin'
  | 'pdd'
  | 'kuaishou'
  | 'wechat_shop';

export type ShopRole = 'seller' | 'buyer';

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scope?: string[];
}

export interface PlatformShop {
  id: string;
  platform: PlatformType;
  platformShopId: string;
  shopName: string;
  role: ShopRole;
}
