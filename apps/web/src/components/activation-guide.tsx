'use client';

import Link from 'next/link';
import type { CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type ActivationProgress, type ActivationStepKey } from '@/lib/api';

const STEP_COPY: Record<
  ActivationStepKey,
  { eyebrow: string; title: string; description: string; action: string }
> = {
  connect_shop: {
    eyebrow: '连接渠道',
    title: '先连接一个销售店铺',
    description: '通过官方授权接入抖店，后续发布、订单和物流状态会自动回到同一个工作台。',
    action: '连接店铺',
  },
  select_product: {
    eyebrow: '选择货源',
    title: '选一款准备测试的 1688 商品',
    description: '先看采购价、销量、利润和合规评分，再进入商品配置。',
    action: '开始选品',
  },
  preview_pricing: {
    eyebrow: '利润试算',
    title: '先算清利润，再决定是否上架',
    description: '确认售价、保本价、预计利润与关键假设，策略变化后系统会要求重新试算。',
    action: '继续试算',
  },
  publish_product: {
    eyebrow: '首次铺货',
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
      <section className="activation-guide is-error" role="status">
        <div>
          <p className="activation-guide-kicker">首次铺货</p>
          <p className="activation-guide-error-copy">进度暂时无法读取，现有业务数据不会被重置。</p>
        </div>
        <button
          type="button"
          className="secondary-button shrink-0"
          onClick={() => void activation.refetch()}
        >
          重新读取
        </button>
      </section>
    );
  }

  const data = activation.data;
  if (!data || data.currentStep === null || data.completedSteps >= data.totalSteps) return null;

  const current = data.steps.find((step) => step.key === data.currentStep);
  const copy = STEP_COPY[data.currentStep];
  const progress = Math.max(0, Math.min(100, (data.completedSteps / data.totalSteps) * 100));

  return (
    <section className="activation-guide" aria-labelledby="activation-guide-title">
      <div className="activation-guide-summary">
        <div
          className="activation-guide-progress"
          style={{ '--activation-progress': `${progress}%` } as CSSProperties}
          aria-label={`首次铺货已完成 ${data.completedSteps} / ${data.totalSteps} 步`}
        >
          <span>{data.completedSteps}</span>
          <small>/{data.totalSteps}</small>
        </div>

        <div className="min-w-0 flex-1">
          <div className="activation-guide-meta">
            <span className="activation-guide-kicker">FIRST RUN · {copy.eyebrow}</span>
            <span className="activation-guide-save-state">进度由业务数据自动恢复</span>
          </div>
          <h2 id="activation-guide-title" className="activation-guide-title">
            {copy.title}
          </h2>
          <p className="activation-guide-description">{copy.description}</p>
        </div>

        <Link href={data.nextHref} className="primary-button activation-guide-action">
          {copy.action}
          <span aria-hidden="true">→</span>
        </Link>
      </div>

      <nav aria-label="首次铺货进度" className="activation-guide-steps">
        <ol>
          {data.steps.map((step, index) => {
            const active = step.key === data.currentStep;
            return (
              <li
                key={step.key}
                className={step.readyNow ? 'is-complete' : active ? 'is-current' : ''}
                aria-current={active ? 'step' : undefined}
              >
                <span className="activation-guide-step-index" aria-hidden="true">
                  {step.readyNow ? '✓' : index + 1}
                </span>
                <span className="activation-guide-step-copy">
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
      </nav>

      {current?.completedAt && !current.readyNow ? (
        <p className="activation-guide-recovery" role="status">
          这一项曾经完成，但当前授权或业务状态已失效；恢复后会继续保留后续历史进度。
        </p>
      ) : null}
    </section>
  );
}
