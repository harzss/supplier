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
import { isDemoAuthMode } from '@/lib/environment';
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
    const desktopQuery = window.matchMedia('(min-width: 1024px)');
    const closeAtDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setMobileNavOpen(false);
    };
    desktopQuery.addEventListener('change', closeAtDesktop);
    return () => desktopQuery.removeEventListener('change', closeAtDesktop);
  }, []);

  if (isPrototypeRoute) return children;

  return (
    <div className="min-h-screen bg-muted/30 text-foreground">
      <a
        href="#main-content"
        className="fixed left-4 top-4 z-[70] -translate-y-24 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-transform focus:translate-y-0"
      >
        跳到主要内容
      </a>

      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r bg-background lg:flex lg:flex-col">
        <SidebarContent
          pathname={pathname}
          environmentState={environmentState}
          environmentDetail={environmentDetail}
        />
      </aside>

      <header className="sticky top-0 z-40 flex h-16 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:hidden">
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
              requestAnimationFrame(() => document.getElementById('main-content')?.focus());
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

      <div className="min-w-0 lg:pl-64">
        <header className="sticky top-0 z-30 hidden h-14 items-center justify-between border-b bg-background/95 px-8 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:flex">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{current.group}</span>
            <span className="text-muted-foreground/50">/</span>
            <span className="font-medium">{current.label}</span>
          </div>
          <EnvironmentBadge state={environmentState} label={environmentDetail} />
        </header>

        <div
          id="main-content"
          className="app-content min-h-[calc(100dvh-4rem)] outline-none"
          tabIndex={-1}
        >
          <div className="mx-auto w-full max-w-[100rem] px-4 pt-4 sm:px-6 lg:px-8">
            <ActivationGuide />
          </div>
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
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-16 shrink-0 items-center px-4">
        <Brand onNavigate={onNavigate} />
      </div>
      <Separator />

      <nav className="min-h-0 flex-1 space-y-6 overflow-y-auto px-3 py-5" aria-label="主要导航">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <p className="mb-2 px-2 text-xs font-medium text-muted-foreground">{group.label}</p>
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
                      'flex h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors lg:h-9',
                      active
                        ? 'bg-primary text-primary-foreground shadow-sm'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
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

      <div className="shrink-0 p-3">
        <Separator className="mb-3" />
        <div className="space-y-3 rounded-lg bg-muted/60 p-3">
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
        </div>
      </div>
    </div>
  );
}

function Brand({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link
      href="/"
      className="flex min-h-11 items-center gap-3"
      aria-label="Supplier 首页"
      onClick={onNavigate}
    >
      <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
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
    <Badge variant="outline" className="gap-2 bg-background font-normal text-muted-foreground">
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
