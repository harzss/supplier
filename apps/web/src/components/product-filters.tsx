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
    <section className="mb-8 border border-[#20211e] bg-[#f4f1ea] text-[#20211e] shadow-[4px_4px_0_#20211e]">
      <div className="flex flex-col gap-2 border-b border-[#20211e] px-4 py-4 sm:flex-row sm:items-end sm:justify-between sm:px-5">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-brand-600">
            S-06 · Source filter
          </p>
          <h2 className="mt-1 font-serif text-2xl font-semibold">把货源池切到你的价格带</h2>
        </div>
        <p className="font-mono text-[11px] text-[#686a63]">
          {facets?.priceRange
            ? `当前采购价 ¥${formatPrice(facets.priceRange.min)}–¥${formatPrice(facets.priceRange.max)}`
            : isLoading
              ? '正在读取货源分布…'
              : '暂无价格分布'}
        </p>
      </div>

      <div className="grid min-w-0 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <div className="min-w-0 border-b border-[#b8b2a8] p-4 sm:p-5 lg:border-b-0 lg:border-r">
          <div className="mb-3 flex items-center justify-between gap-4">
            <h3 className="font-mono text-xs font-semibold uppercase tracking-[0.12em]">类目</h3>
            <span className="text-xs text-[#777970]">来自已打分货源</span>
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
              <span className="text-sm text-[#777970]">读取类目中…</span>
            ) : null}
          </div>
        </div>

        <div className="min-w-0 p-4 sm:p-5">
          <h3 className="mb-3 font-mono text-xs font-semibold uppercase tracking-[0.12em]">
            1688 采购价
          </h3>
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
            <span className="pb-2 text-[#777970]">—</span>
            <PriceInput name="priceMax" label="最高价" defaultValue={filters.priceMax} />
            <button
              type="submit"
              disabled={isPending}
              className="h-9 border border-[#20211e] bg-[#20211e] px-4 text-xs font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
            >
              应用
            </button>
          </form>
          {customError || rangeError ? (
            <p className="mt-2 text-xs text-red-600">{customError ?? rangeError}</p>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-11 flex-wrap items-center gap-2 border-t border-[#b8b2a8] px-4 py-2 text-xs sm:px-5">
        <span className="font-mono uppercase tracking-[0.12em] text-[#777970]">已应用</span>
        {!hasFilters ? <span className="text-[#686a63]">全部货源</span> : null}
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
            className="ml-auto border-b border-[#20211e] text-xs font-medium disabled:opacity-50"
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
      className={`border px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
        active
          ? 'border-[#20211e] bg-[#20211e] text-white'
          : 'border-[#b8b2a8] bg-[#faf8f2] text-[#555750] hover:border-brand-500 hover:text-brand-600'
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
    <label className="grid gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[#686a63]">
      {label}
      <span className="flex h-9 items-center border border-[#b8b2a8] bg-[#faf8f2] px-2 focus-within:border-[#20211e]">
        <span className="mr-1 text-[#777970]">¥</span>
        <input
          name={name}
          type="number"
          inputMode="decimal"
          min="0"
          max="1000000"
          step="0.01"
          defaultValue={defaultValue}
          className="w-20 bg-transparent font-sans text-xs text-[#20211e] outline-none"
        />
      </span>
    </label>
  );
}

function ActiveTag({ children }: { children: React.ReactNode }) {
  return <span className="border border-[#b8b2a8] bg-[#faf8f2] px-2 py-1">{children}</span>;
}

function parsePrice(value: FormDataEntryValue | null): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function formatPrice(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
