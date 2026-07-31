'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AuthStatus } from '@/components/auth-provider';
import { isDemoAuthMode } from '@/lib/environment';

const NAV_ITEMS = [
  { href: '/', label: '今日选品', eyebrow: 'Sourcing', icon: 'spark' },
  { href: '/published', label: '铺货中心', eyebrow: 'Catalog', icon: 'package' },
  { href: '/orders', label: '订单履约', eyebrow: 'Fulfillment', icon: 'orders' },
  { href: '/analytics', label: '经营分析', eyebrow: 'Intelligence', icon: 'chart' },
  { href: '/favorites', label: '收藏对比', eyebrow: 'Shortlist', icon: 'bookmark' },
  { href: '/settings', label: '系统设置', eyebrow: 'Workspace', icon: 'settings' },
] as const;

type NavIconName = (typeof NAV_ITEMS)[number]['icon'];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const current = NAV_ITEMS.find((item) => isActive(pathname, item.href)) ?? NAV_ITEMS[0];

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        跳到主要内容
      </a>

      <aside className="app-sidebar" aria-label="主要导航">
        <Brand />
        <div className="app-sidebar-label">Merchant workspace</div>
        <nav className="app-sidebar-nav">
          {NAV_ITEMS.map((item, index) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`app-nav-item ${active ? 'is-active' : ''}`}
              >
                <span className="app-nav-index">{String(index + 1).padStart(2, '0')}</span>
                <NavIcon name={item.icon} />
                <span className="min-w-0">
                  <span className="app-nav-title">{item.label}</span>
                  <span className="app-nav-eyebrow">{item.eyebrow}</span>
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="app-sidebar-footer">
          <div className="app-environment">
            <span className="app-environment-dot" />
            <span>
              <strong>{isDemoAuthMode ? 'Demo workspace' : 'Live workspace'}</strong>
              <small>{isDemoAuthMode ? '安全演示模式' : 'Supabase 已连接'}</small>
            </span>
          </div>
          <AuthStatus />
        </div>
      </aside>

      <div className="app-mobile-header">
        <Brand compact />
        <div className="flex items-center gap-3">
          <div className="app-mobile-context">
            <span>{current.eyebrow}</span>
            <strong>{current.label}</strong>
          </div>
          <AuthStatus compact />
        </div>
      </div>

      <nav className="app-mobile-nav" aria-label="移动端导航">
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`app-mobile-nav-item ${active ? 'is-active' : ''}`}
            >
              <NavIcon name={item.icon} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <section className="app-stage">
        <header className="app-context-bar">
          <div>
            <span className="app-context-code">SUP / {current.eyebrow.toUpperCase()}</span>
            <span className="app-context-title">{current.label}</span>
          </div>
          <div className="app-context-status">
            <span className="app-context-pulse" />
            {isDemoAuthMode ? '本地演示环境' : '内部测试环境'}
          </div>
        </header>
        <div id="main-content" className="app-content" tabIndex={-1}>
          {children}
        </div>
      </section>
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link
      href="/"
      className={`app-brand ${compact ? 'is-compact' : ''}`}
      aria-label="Supplier 首页"
    >
      <span className="app-brand-mark" aria-hidden="true">
        <svg viewBox="0 0 38 38" fill="none">
          <path
            d="M8 10.5 19 4l11 6.5v17L19 34 8 27.5v-17Z"
            stroke="currentColor"
            strokeWidth="2"
          />
          <path
            d="m13 14 6-3.5 6 3.5-6 3.5-6-3.5Zm0 0v7l6 3.5 6-3.5v-7"
            stroke="currentColor"
            strokeWidth="2"
          />
        </svg>
      </span>
      <span>
        <strong>Supplier</strong>
        {!compact ? <small>Merchant OS</small> : null}
      </span>
    </Link>
  );
}

function NavIcon({ name }: { name: NavIconName }) {
  const paths: Record<NavIconName, ReactNode> = {
    spark: (
      <path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Zm6 11 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14ZM5 14l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z" />
    ),
    package: <path d="m4 7 8-4 8 4v10l-8 4-8-4V7Zm0 0 8 4m8-4-8 4m0 10V11m-4-6 8 4" />,
    orders: <path d="M6 3h12v18H6V3Zm3 5h6M9 12h6M9 16h4" />,
    chart: <path d="M4 20V10m5 10V4m6 16v-7m5 7V7M2 20h20" />,
    bookmark: <path d="M6 4.5A2.5 2.5 0 0 1 8.5 2h7A2.5 2.5 0 0 1 18 4.5V22l-6-4-6 4V4.5Z" />,
    settings: (
      <path d="M12 8.5A3.5 3.5 0 1 0 12 15.5 3.5 3.5 0 0 0 12 8.5Zm8.1 3.5 1.4 2.2-2.2 3.8-2.6-.1a8.6 8.6 0 0 1-2 1.2L13.5 22h-4l-1.2-2.9a8.6 8.6 0 0 1-2-1.2l-2.6.1-2.2-3.8L2.9 12l-1.4-2.2L3.7 6l2.6.1a8.6 8.6 0 0 1 2-1.2L9.5 2h4l1.2 2.9a8.6 8.6 0 0 1 2 1.2l2.6-.1 2.2 3.8L20.1 12Z" />
    ),
  };

  return (
    <svg
      className="app-nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}
