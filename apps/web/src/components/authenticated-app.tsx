'use client';

import type { ReactNode } from 'react';
import { Providers } from '@/app/providers';
import { AppShell } from '@/components/app-shell';

export function AuthenticatedApp({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <AppShell>{children}</AppShell>
    </Providers>
  );
}
