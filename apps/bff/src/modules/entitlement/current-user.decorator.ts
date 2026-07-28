import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { CurrentUser as CurrentUserType } from './user-context.service';

/** 取当前请求已解析的用户（由 CurrentUserGuard 挂载到 request.currentUser） */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUserType => {
    const req = ctx.switchToHttp().getRequest<{ currentUser: CurrentUserType }>();
    return req.currentUser;
  },
);
