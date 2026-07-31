'use client';

import { useState, type FormEvent } from 'react';
import type { ProductFacets } from '@/lib/api';

export interface AppliedProductFilters {
  categoryL1?: string;
  priceMin?: number;
  priceMax?: number;
}

interface ProductFiltersProps {
  facets?: ProductFacets;
  filters: AppliedProductFilters;
  isLoading: boolean;
  isPending: boolean;
  rangeError?: string;
  onChange: (filters: AppliedProductFilters) => void;
}

const PRICE_BANDS = [
  { label: '不限价格' },
  { label: '¥10 以下', priceMax: 10 },
  { label: '¥10–30', priceMin: 10, priceMax: 30 },
  { label: '¥30–50', priceMin: 30, priceMax: 50 },
  { label: '¥50 以上', priceMin: 50 },
] satisfies Array<{ label: string; priceMin?: number; priceMax?: number }>;

export function ProductFilters({
  facets,
  filters,
  isLoading,
  isPending,
  rangeError,
  onChange,
}: ProductFiltersProps) {
  const [customError, setCustomError] = useState<string>();
  const hasFilters =
    Boolean(filters.categoryL1) || filters.priceMin !== undefined || filters.priceMax !== undefined;
  const categories = facets?.categories ?? [];
  const categoryOptions =
    filters.categoryL1 && !categories.some((item) => item.name === filters.categoryL1)
      ? [{ name: filters.categoryL1, count: 0 }, ...categories]
      : categories;

  const applyCustomPrice = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const priceMin = parsePrice(form.get('priceMin'));
    const priceMax = parsePrice(form.get('priceMax'));
    if (priceMin !== undefined && priceMax !== undefined && priceMin > priceMax) {
      setCustomError('最低价不能高于最高价');
      return;
    }
    setCustomError(undefined);
    onChange({ ...filters, priceMin, priceMax });
  };

  return (
    <section className="ledger-panel mb-6 overflow-hidden text-[var(--ink)]">
      <div className="flex flex-col gap-2 border-b border-[var(--line)] px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div>
          <h2 className="text-sm font-semibold">筛选商品</h2>
          <p className="mt-0.5 text-xs text-[var(--muted)]">按类目和采购价缩小候选范围</p>
        </div>
        <p className="text-xs text-[var(--muted)] tabular-nums">
          {facets?.priceRange
            ? `当前采购价 ¥${formatPrice(facets.priceRange.min)}–¥${formatPrice(facets.priceRange.max)}`
            : isLoading
              ? '正在读取货源分布…'
              : '暂无价格分布'}
        </p>
      </div>

      <div className="grid min-w-0 lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
        <div className="min-w-0 border-b border-[var(--line)] p-4 lg:border-b-0 lg:border-r">
          <div className="mb-3 flex items-center justify-between gap-4">
            <h3 className="text-xs font-semibold text-[var(--ink-soft)]">类目</h3>
            <span className="text-xs text-[var(--muted)]">来自已打分货源</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <FilterButton
              active={!filters.categoryL1}
              disabled={isPending}
              onClick={() => onChange({ ...filters, categoryL1: undefined })}
            >
              全部
            </FilterButton>
            {categoryOptions.map((item) => (
              <FilterButton
                key={item.name}
                active={filters.categoryL1 === item.name}
                disabled={isPending}
                onClick={() =>
                  onChange({
                    ...filters,
                    categoryL1: filters.categoryL1 === item.name ? undefined : item.name,
                  })
                }
              >
                {item.name}
                {item.count ? <span className="ml-1 opacity-60">{item.count}</span> : null}
              </FilterButton>
            ))}
            {isLoading && !categoryOptions.length ? (
              <span className="text-sm text-[var(--muted)]">读取类目中…</span>
            ) : null}
          </div>
        </div>

        <div className="min-w-0 p-4">
          <h3 className="mb-3 text-xs font-semibold text-[var(--ink-soft)]">1688 采购价</h3>
          <div className="flex flex-wrap gap-2">
            {PRICE_BANDS.map((band) => (
              <FilterButton
                key={band.label}
                active={filters.priceMin === band.priceMin && filters.priceMax === band.priceMax}
                disabled={isPending}
                onClick={() => {
                  setCustomError(undefined);
                  onChange({
                    ...filters,
                    priceMin: band.priceMin,
                    priceMax: band.priceMax,
                  });
                }}
              >
                {band.label}
              </FilterButton>
            ))}
          </div>

          <form
            key={`${filters.priceMin ?? ''}-${filters.priceMax ?? ''}`}
            className="mt-4 flex flex-wrap items-end gap-2"
            onSubmit={applyCustomPrice}
          >
            <PriceInput name="priceMin" label="最低价" defaultValue={filters.priceMin} />
            <span className="pb-3 text-[var(--muted-light)]">—</span>
            <PriceInput name="priceMax" label="最高价" defaultValue={filters.priceMax} />
            <button
              type="submit"
              disabled={isPending}
              className="primary-button h-11 min-h-11 py-0"
            >
              应用
            </button>
          </form>
          {customError || rangeError ? (
            <p className="mt-2 text-xs text-red-600">{customError ?? rangeError}</p>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-12 flex-wrap items-center gap-2 border-t border-[var(--line)] bg-[var(--surface-strong)] px-4 py-2 text-xs sm:px-5">
        <span className="font-medium text-[var(--muted)]">已应用</span>
        {!hasFilters ? <span className="text-[var(--ink-soft)]">全部货源</span> : null}
        {filters.categoryL1 ? <ActiveTag>类目：{filters.categoryL1}</ActiveTag> : null}
        {filters.priceMin !== undefined || filters.priceMax !== undefined ? (
          <ActiveTag>
            采购价：{filters.priceMin !== undefined ? `¥${formatPrice(filters.priceMin)}` : '不限'}
            {' – '}
            {filters.priceMax !== undefined ? `¥${formatPrice(filters.priceMax)}` : '不限'}
          </ActiveTag>
        ) : null}
        {hasFilters ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              setCustomError(undefined);
              onChange({});
            }}
            className="quiet-button ml-auto min-h-10 text-xs disabled:opacity-50"
          >
            清空筛选
          </button>
        ) : null}
      </div>

      {facets?.degraded ? (
        <p className="border-t border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-700 sm:px-5">
          类目与价格分布暂时不可用，商品列表仍可继续浏览。
        </p>
      ) : null}
    </section>
  );
}

function FilterButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`filter-chip min-h-10 rounded-full border px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? 'border-brand-200 bg-brand-50 text-brand-700'
          : 'border-[var(--line)] bg-[var(--surface)] text-[var(--ink-soft)]'
      }`}
    >
      {children}
    </button>
  );
}

function PriceInput({
  name,
  label,
  defaultValue,
}: {
  name: string;
  label: string;
  defaultValue?: number;
}) {
  return (
    <label className="grid gap-1 text-[11px] font-medium text-[var(--muted)]">
      {label}
      <span className="flex h-11 items-center rounded-lg border border-[var(--line-strong)] bg-[var(--surface)] px-2 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-100">
        <span className="mr-1 text-[var(--muted)]">¥</span>
        <input
          name={name}
          type="number"
          inputMode="decimal"
          min="0"
          max="1000000"
          step="0.01"
          defaultValue={defaultValue}
          className="w-20 bg-transparent font-sans text-sm text-[var(--ink)] outline-none"
        />
      </span>
    </label>
  );
}

function ActiveTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-[var(--line)] bg-[var(--surface)] px-2.5 py-1">
      {children}
    </span>
  );
}

function parsePrice(value: FormDataEntryValue | null): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function formatPrice(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
