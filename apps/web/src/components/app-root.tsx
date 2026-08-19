'use client';

import type { ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { isLegalDocumentRoute } from '@/lib/public-routes';

const AuthenticatedApp = dynamic(
  () => import('@/components/authenticated-app').then((module) => module.AuthenticatedApp),
  {
    loading: () => (
      <main className="auth-utility-shell">
        <div className="auth-utility-loading" role="status" aria-live="polite">
          <span>
            <strong>正在加载安全工作区</strong>
            <small>应用边界准备完成后将继续验证会话</small>
          </span>
        </div>
      </main>
    ),
  },
);

export function AppRoot({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (isLegalDocumentRoute(pathname)) return children;
  return <AuthenticatedApp>{children}</AuthenticatedApp>;
}
