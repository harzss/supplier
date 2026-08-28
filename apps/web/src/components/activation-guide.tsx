'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Check, WarningCircle } from '@phosphor-icons/react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
      <div className="activation-runway-wrap">
        <Alert variant="warning" className="flex items-center gap-4 pr-3">
          <WarningCircle weight="fill" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <AlertTitle>首次铺货进度暂时无法读取</AlertTitle>
            <AlertDescription>现有业务数据不会被重置，可重新读取进度。</AlertDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void activation.refetch()}
          >
            重新读取
          </Button>
        </Alert>
      </div>
    );
  }

  const data = activation.data;
  if (!data || data.currentStep === null || data.completedSteps >= data.totalSteps) return null;

  const current = data.steps.find((step) => step.key === data.currentStep);
  const copy = STEP_COPY[data.currentStep];
  const progress = Math.max(0, Math.min(100, (data.completedSteps / data.totalSteps) * 100));

  return (
    <div className="activation-runway-wrap">
      <section className="activation-runway" aria-labelledby="activation-guide-title">
        <header className="activation-runway-header">
          <div className="activation-runway-count" aria-hidden="true">
            {data.completedSteps}/{data.totalSteps}
          </div>
          <div className="activation-runway-copy">
            <div className="activation-runway-meta">
              <span>首次铺货</span>
              <small>进度由业务数据自动恢复</small>
            </div>
            <p id="activation-guide-title" className="activation-runway-title">
              {copy.title}
            </p>
            <p className="activation-runway-description">{copy.description}</p>
          </div>
          <Button asChild size="sm" className="activation-runway-action shrink-0">
            <Link href={data.nextHref}>
              {copy.action}
              <ArrowRight weight="bold" aria-hidden="true" />
            </Link>
          </Button>
        </header>

        <div className="activation-runway-track" aria-hidden="true">
          <div style={{ transform: `scaleX(${progress / 100})` }} />
        </div>

        <ol className="activation-runway-steps" aria-label="首次铺货进度">
          {data.steps.map((step, index) => {
            const active = step.key === data.currentStep;
            return (
              <li
                key={step.key}
                className={cn(
                  'activation-runway-step',
                  active && 'is-active',
                  step.readyNow && 'is-complete',
                )}
                aria-current={active ? 'step' : undefined}
              >
                <span
                  className={cn(
                    'activation-runway-step-index',
                    step.readyNow && 'is-complete',
                    active && !step.readyNow && 'is-active',
                  )}
                  aria-hidden="true"
                >
                  {step.readyNow ? <Check weight="bold" /> : index + 1}
                </span>
                <span className="min-w-0">
                  <strong>{step.title}</strong>
                  <small>
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
          <Alert variant="warning" className="activation-runway-warning" role="status">
            <AlertDescription>
              这一项曾经完成，但当前授权或业务状态已失效；恢复后会继续保留后续历史进度。
            </AlertDescription>
          </Alert>
        ) : null}
      </section>
    </div>
  );
}
