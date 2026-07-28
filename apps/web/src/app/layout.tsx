import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { Providers } from './providers';
import { AuthStatus } from '@/components/auth-provider';

export const metadata: Metadata = {
  title: 'Supplier — AI 驱动的 1688 精品铺货工具',
  description: '今天搬什么款，AI 替你选；标题主图详情，AI 替你做。',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-zinc-50 text-zinc-900 antialiased">
        <Providers>
          <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur">
            <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <Link href="/" className="flex items-center gap-2 font-semibold">
                <span className="text-lg">🛒</span> Supplier
              </Link>
              <div className="flex min-w-0 w-full items-center sm:w-auto">
                <nav className="flex min-w-0 flex-1 items-center gap-4 overflow-x-auto whitespace-nowrap pb-1 text-sm sm:gap-5 sm:pb-0">
                  <Link href="/" className="text-zinc-600 transition hover:text-brand-600">
                    今日推荐
                  </Link>
                  <Link href="/published" className="text-zinc-600 transition hover:text-brand-600">
                    我的铺货
                  </Link>
                  <Link href="/orders" className="text-zinc-600 transition hover:text-brand-600">
                    订单代发
                  </Link>
                  <Link href="/analytics" className="text-zinc-600 transition hover:text-brand-600">
                    经营看板
                  </Link>
                  <Link href="/favorites" className="text-zinc-600 transition hover:text-brand-600">
                    收藏对比
                  </Link>
                  <Link href="/settings" className="text-zinc-600 transition hover:text-brand-600">
                    设置 / 套餐
                  </Link>
                </nav>
                <AuthStatus />
              </div>
            </div>
          </header>
          {children}
        </Providers>
      </body>
    </html>
  );
}
