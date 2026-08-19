export const LEGAL_DOCUMENT_ROUTES = ['/privacy', '/terms', '/help', '/account-deletion'] as const;

export function isLegalDocumentRoute(pathname: string): boolean {
  return LEGAL_DOCUMENT_ROUTES.some((route) => pathname === route);
}
