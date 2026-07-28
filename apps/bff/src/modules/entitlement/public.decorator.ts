import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_ROUTE = 'supplier:is-public-route';

/** 跳过用户认证，仅用于健康探针和第三方 OAuth 回调。 */
export const Public = () => SetMetadata(IS_PUBLIC_ROUTE, true);
