'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Check, WarningCircle } from '@phosphor-icons/react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { api, type ActivationProgress, type ActivationStepKey } from '@/lib/api';
import { cn } from '@/lib/utils';

const STEP_COPY: Record<ActivationStepKey, { title: string; description: string; action: string }> =
  {
    connect_shop: {
      title: '先连接一个销售店铺',
      description: '通过官方授权接入抖店，后续发布、订单和物流状态会自动回到同一个工作台。',
      action: '连接店铺',
    },
    select_product: {
      title: '选一款准备测试的 1688 商品',
      description: '先看采购价、销量、利润和合规评分，再进入商品配置。',
      action: '开始选品',
    },
    preview_pricing: {
      title: '先算清利润，再决定是否上架',
      description: '确认售价、保本价、预计利润与关键假设，策略变化后系统会要求重新试算。',
      action: '继续试算',
    },
    publish_product: {
      title: '提交铺货并确认真实结果',
      description: '任务进入持久化队列后可离开页面；返回时仍会挂回原任务，不重复创建。',
      action: '继续铺货',
    },
  };

export function ActivationGuide() {
  const activation = useQuery<ActivationProgress>({
    queryKey: ['activation'],
    queryFn: () => api.activation(),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });

  if (activation.isLoading) return null;

  if (activation.isError) {
    return (
      <Alert variant="warning" className="mb-4 flex items-center gap-4 pr-3">
        <WarningCircle weight="fill" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <AlertTitle>首次铺货进度暂时无法读取</AlertTitle>
          <AlertDescription>现有业务数据不会被重置，可重新读取进度。</AlertDescription>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void activation.refetch()}>
          重新读取
        </Button>
      </Alert>
    );
  }

  const data = activation.data;
  if (!data || data.currentStep === null || data.completedSteps >= data.totalSteps) return null;

  const current = data.steps.find((step) => step.key === data.currentStep);
  const copy = STEP_COPY[data.currentStep];
  const progress = Math.max(0, Math.min(100, (data.completedSteps / data.totalSteps) * 100));

  return (
    <Card className="mb-4 overflow-hidden" aria-labelledby="activation-guide-title">
      <CardHeader className="gap-4 border-b p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div className="flex min-w-0 items-start gap-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-primary/10 text-sm font-semibold text-primary tabular-nums">
            {data.completedSteps}/{data.totalSteps}
          </div>
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <Badge variant="secondary">首次铺货</Badge>
              <span className="text-xs text-muted-foreground">进度由业务数据自动恢复</span>
            </div>
            <h2 id="activation-guide-title" className="text-sm font-semibold sm:text-base">
              {copy.title}
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{copy.description}</p>
          </div>
        </div>
        <Button asChild size="sm" className="shrink-0">
          <Link href={data.nextHref}>
            {copy.action}
            <ArrowRight weight="bold" aria-hidden="true" />
          </Link>
        </Button>
      </CardHeader>

      <CardContent className="p-0">
        <div className="h-1 bg-muted" aria-hidden="true">
          <div className="h-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
        </div>
        <ol className="grid sm:grid-cols-2 xl:grid-cols-4" aria-label="首次铺货进度">
          {data.steps.map((step, index) => {
            const active = step.key === data.currentStep;
            return (
              <li
                key={step.key}
                className={cn(
                  'flex min-w-0 items-center gap-3 border-b p-4 last:border-b-0 sm:[&:nth-last-child(-n+2)]:border-b-0 xl:border-b-0 xl:border-r xl:last:border-r-0',
                  active && 'bg-primary/5',
                )}
                aria-current={active ? 'step' : undefined}
              >
                <span
                  className={cn(
                    'grid size-7 shrink-0 place-items-center rounded-md border bg-background text-xs font-medium text-muted-foreground',
                    step.readyNow && 'border-emerald-200 bg-emerald-50 text-emerald-700',
                    active && !step.readyNow && 'border-primary bg-primary text-primary-foreground',
                  )}
                  aria-hidden="true"
                >
                  {step.readyNow ? <Check weight="bold" /> : index + 1}
                </span>
                <span className="min-w-0">
                  <strong className="block truncate text-sm font-medium">{step.title}</strong>
                  <small className="mt-0.5 block text-xs text-muted-foreground">
                    {step.readyNow
                      ? '已完成'
                      : active && step.completedAt
                        ? '需要恢复当前状态'
                        : active
                          ? '当前步骤'
                          : '稍后进行'}
                  </small>
                </span>
              </li>
            );
          })}
        </ol>

        {current?.completedAt && !current.readyNow ? (
          <Alert variant="warning" className="m-4" role="status">
            <AlertDescription>
              这一项曾经完成，但当前授权或业务状态已失效；恢复后会继续保留后续历史进度。
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
