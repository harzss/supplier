import { SetMetadata } from '@nestjs/common';

export const AUDIT_ACTION = Symbol('audit-action');

export interface AuditActionMetadata {
  action: string;
  resourceType?: string;
}

/** 标记会产生状态变化但不是标准写请求的操作（例如 OAuth authorize GET）。 */
export function AuditAction(action: string, resourceType?: string) {
  return SetMetadata(AUDIT_ACTION, { action, resourceType } satisfies AuditActionMetadata);
}
