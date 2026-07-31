import type { Metadata } from 'next';
import './globals.css';
import { Providers } from './providers';
import { AppShell } from '@/components/app-shell';

export const metadata: Metadata = {
  title: 'Supplier — AI 驱动的 1688 精品铺货工具',
  description: '今天搬什么款，AI 替你选；标题主图详情，AI 替你做。',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
