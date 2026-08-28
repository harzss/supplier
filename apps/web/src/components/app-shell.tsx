'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowsCounterClockwise,
  BookmarkSimple,
  ChartLineUp,
  CirclesFour,
  GearSix,
  List,
  Package,
  Receipt,
  Sparkle,
  Stack,
  WarningOctagon,
  type Icon,
} from '@phosphor-icons/react';
import { ActivationGuide } from '@/components/activation-guide';
import { AuthStatus } from '@/components/auth-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { api } from '@/lib/api';
import { isDemoAuthMode, isLegalPagesEnabled } from '@/lib/environment';
import { cn } from '@/lib/utils';

const NAV_GROUPS = [
  {
    label: '选品与货源',
    items: [
      { href: '/', label: '今日选品', icon: Sparkle },
      { href: '/sources', label: '我的货源', icon: Stack },
      { href: '/favorites', label: '收藏对比', icon: BookmarkSimple },
    ],
  },
  {
    label: '商品与履约',
    items: [
      { href: '/published', label: '铺货中心', icon: Package },
      { href: '/orders', label: '订单履约', icon: Receipt },
      { href: '/after-sales', label: '售后工单', icon: ArrowsCounterClockwise },
    ],
  },
  {
    label: '经营管控',
    items: [
      { href: '/exceptions', label: '异常中心', icon: WarningOctagon },
      { href: '/analytics', label: '经营分析', icon: ChartLineUp },
    ],
  },
  {
    label: '工作区',
    items: [{ href: '/settings', label: '系统设置', icon: GearSix }],
  },
] as const satisfies ReadonlyArray<{
  label: string;
  items: ReadonlyArray<{ href: string; label: string; icon: Icon }>;
}>;

const NAV_ITEMS = NAV_GROUPS.flatMap((group) =>
  group.items.map((item) => ({ ...item, group: group.label })),
);
const DEFAULT_NAV_ITEM = {
  ...NAV_GROUPS[0].items[0],
  group: NAV_GROUPS[0].label,
};

type EnvironmentState = 'demo' | 'checking' | 'ready' | 'error';

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isPrototypeRoute = pathname.startsWith('/prototypes/');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const focusMainAfterCloseRef = useRef(false);
  const systemReadiness = useQuery({
    queryKey: ['system-readiness'],
    queryFn: () => api.readiness(),
    enabled: !isDemoAuthMode && !isPrototypeRoute,
    retry: false,
    refetchInterval: 60_000,
  });
  const current = NAV_ITEMS.find((item) => isActive(pathname, item.href)) ?? DEFAULT_NAV_ITEM;
  const environmentState: EnvironmentState = isDemoAuthMode
    ? 'demo'
    : systemReadiness.isPending
      ? 'checking'
      : systemReadiness.isSuccess
        ? 'ready'
        : 'error';
  const environmentDetail = isDemoAuthMode
    ? '本地安全数据'
    : systemReadiness.isPending
      ? '正在检查数据连接'
      : systemReadiness.isSuccess
        ? '数据连接正常'
        : '数据连接需检查';

  useEffect(() => {
    const desktopQuery = window.matchMedia('(min-width: 1280px)');
    const closeAtDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setMobileNavOpen(false);
    };
    desktopQuery.addEventListener('change', closeAtDesktop);
    return () => desktopQuery.removeEventListener('change', closeAtDesktop);
  }, []);

  if (isPrototypeRoute) return children;

  return (
    <div className="supplier-shell min-h-screen text-foreground">
      <a
        href="#main-content"
        className="fixed left-4 top-4 z-[70] -translate-y-24 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-transform focus:translate-y-0"
      >
        跳到主要内容
      </a>

      <aside className="supplier-sidebar fixed inset-y-0 left-0 z-40 hidden w-56 xl:flex xl:flex-col">
        <SidebarContent
          pathname={pathname}
          environmentState={environmentState}
          environmentDetail={environmentDetail}
        />
      </aside>

      <header className="supplier-mobile-header sticky top-0 z-40 flex h-16 items-center gap-3 px-4 xl:hidden">
        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" size="icon" className="size-11" aria-label="打开导航">
              <List weight="bold" aria-hidden="true" />
            </Button>
          </SheetTrigger>
          <SheetContent
            id="mobile-navigation"
            side="left"
            className="w-[20rem] max-w-[88vw] p-0"
            onCloseAutoFocus={(event) => {
              if (!focusMainAfterCloseRef.current) return;
              event.preventDefault();
              focusMainAfterCloseRef.current = false;
              requestAnimationFrame(() =>
                document.getElementById('main-content')?.focus({ preventScroll: true }),
              );
            }}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Supplier 导航</SheetTitle>
              <SheetDescription>选择业务模块</SheetDescription>
            </SheetHeader>
            <SidebarContent
              pathname={pathname}
              environmentState={environmentState}
              environmentDetail={environmentDetail}
              onNavigate={() => {
                focusMainAfterCloseRef.current = true;
                setMobileNavOpen(false);
              }}
            />
          </SheetContent>
        </Sheet>

        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-muted-foreground">{current.group}</p>
          <p className="truncate text-sm font-semibold">{current.label}</p>
        </div>
        <AuthStatus compact />
      </header>

      <div className="supplier-workspace min-w-0 xl:pl-56">
        <header className="supplier-utility-bar sticky top-0 z-30 hidden h-[3.25rem] items-center justify-between px-7 xl:flex">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{current.group}</span>
            <span className="text-muted-foreground/50">/</span>
            <span className="font-medium">{current.label}</span>
          </div>
          <EnvironmentBadge state={environmentState} label={environmentDetail} />
        </header>

        <div
          id="main-content"
          className="supplier-main min-h-[calc(100dvh-4rem)] scroll-mt-16 outline-none xl:scroll-mt-[3.25rem]"
          tabIndex={-1}
        >
          <ActivationGuide />
          {children}
        </div>
      </div>
    </div>
  );
}

function SidebarContent({
  pathname,
  environmentState,
  environmentDetail,
  onNavigate,
}: {
  pathname: string;
  environmentState: EnvironmentState;
  environmentDetail: string;
  onNavigate?: () => void;
}) {
  return (
    <div className="supplier-sidebar-content flex h-full min-h-0 flex-col">
      <div className="flex h-[3.75rem] shrink-0 items-center px-4">
        <Brand onNavigate={onNavigate} />
      </div>
      <Separator />

      <nav
        className="supplier-nav min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-4"
        aria-label="主要导航"
      >
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <p className="supplier-nav-label mb-2 px-2">{group.label}</p>
            <div className="space-y-1">
              {group.items.map((item) => {
                const active = isActive(pathname, item.href);
                const IconComponent = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    onClick={onNavigate}
                    className={cn(
                      'supplier-nav-link flex h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors xl:h-9',
                      active
                        ? 'is-active bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-black/[0.035] hover:text-foreground',
                    )}
                  >
                    <IconComponent weight={active ? 'fill' : 'regular'} aria-hidden="true" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="supplier-sidebar-footer shrink-0 p-3">
        <Separator className="mb-3" />
        <div className="space-y-3 px-2 pb-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium">
                {isDemoAuthMode ? '演示工作区' : '内部测试环境'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{environmentDetail}</p>
            </div>
            <EnvironmentDot state={environmentState} />
          </div>
          <AuthStatus />
          {isLegalPagesEnabled ? (
            <nav className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs" aria-label="帮助与法律">
              <Link href="/help" className="text-muted-foreground hover:text-foreground">
                帮助中心
              </Link>
              <Link href="/privacy" className="text-muted-foreground hover:text-foreground">
                隐私政策
              </Link>
              <Link href="/terms" className="text-muted-foreground hover:text-foreground">
                用户协议
              </Link>
              <Link
                href="/account-deletion"
                className="text-muted-foreground hover:text-foreground"
              >
                账号注销
              </Link>
            </nav>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Brand({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link
      href="/"
      className="supplier-brand flex min-h-11 items-center gap-3"
      aria-label="Supplier 首页"
      onClick={onNavigate}
    >
      <span className="supplier-brand-mark grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
        <CirclesFour className="size-5" weight="fill" aria-hidden="true" />
      </span>
      <span>
        <strong className="block text-sm font-semibold tracking-tight">Supplier</strong>
        <small className="block text-xs text-muted-foreground">分销经营台</small>
      </span>
    </Link>
  );
}

function EnvironmentBadge({ state, label }: { state: EnvironmentState; label: string }) {
  return (
    <Badge
      variant="outline"
      className="supplier-environment-badge gap-2 border-0 bg-transparent p-0 font-normal text-muted-foreground"
    >
      <EnvironmentDot state={state} />
      {label}
    </Badge>
  );
}

function EnvironmentDot({ state }: { state: EnvironmentState }) {
  return (
    <span
      className={cn(
        'mt-0.5 size-2 shrink-0 rounded-full',
        state === 'ready' && 'bg-emerald-500',
        state === 'demo' && 'bg-sky-500',
        state === 'checking' && 'animate-pulse bg-amber-500',
        state === 'error' && 'bg-destructive',
      )}
      aria-hidden="true"
    />
  );
}

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}
