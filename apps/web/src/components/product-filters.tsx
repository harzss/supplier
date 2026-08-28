'use client';

import { useId, useState, type FormEvent } from 'react';
import { FunnelSimple, X } from '@phosphor-icons/react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
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
  { label: '¥10 至 30', priceMin: 10, priceMax: 30 },
  { label: '¥30 至 50', priceMin: 30, priceMax: 50 },
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
  const priceErrorId = useId();
  const priceError = customError ?? rangeError;
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
    <Card aria-label="商品筛选">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0 border-b p-4 sm:p-5">
        <div>
          <div className="flex items-center gap-2">
            <FunnelSimple
              className="size-4 text-muted-foreground"
              weight="bold"
              aria-hidden="true"
            />
            <CardTitle className="text-sm">筛选条件</CardTitle>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {facets?.priceRange
              ? `当前货源采购价 ¥${formatPrice(facets.priceRange.min)} 至 ¥${formatPrice(facets.priceRange.max)}`
              : isLoading
                ? '正在读取类目与价格分布'
                : '暂无可用价格分布'}
          </p>
        </div>
        {hasFilters ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={() => {
              setCustomError(undefined);
              onChange({});
            }}
          >
            <X aria-hidden="true" />
            清空
          </Button>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-5 p-4 sm:p-5">
        <fieldset disabled={isPending} className="min-w-0 space-y-2">
          <legend className="text-xs font-medium text-muted-foreground">类目</legend>
          <div className="flex gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible">
            <FilterButton
              active={!filters.categoryL1}
              onClick={() => onChange({ ...filters, categoryL1: undefined })}
            >
              全部
            </FilterButton>
            {categoryOptions.map((item) => (
              <FilterButton
                key={item.name}
                active={filters.categoryL1 === item.name}
                onClick={() =>
                  onChange({
                    ...filters,
                    categoryL1: filters.categoryL1 === item.name ? undefined : item.name,
                  })
                }
              >
                {item.name}
                {item.count ? (
                  <Badge variant="secondary" className="ml-1 border-0 px-1.5 py-0 font-normal">
                    {item.count}
                  </Badge>
                ) : null}
              </FilterButton>
            ))}
            {isLoading && !categoryOptions.length ? (
              <span className="inline-flex h-11 items-center text-xs text-muted-foreground sm:h-9">
                正在读取类目…
              </span>
            ) : null}
          </div>
        </fieldset>

        <fieldset disabled={isPending} className="min-w-0 space-y-3">
          <legend className="text-xs font-medium text-muted-foreground">采购价</legend>
          <div className="flex gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible">
            {PRICE_BANDS.map((band) => (
              <FilterButton
                key={band.label}
                active={filters.priceMin === band.priceMin && filters.priceMax === band.priceMax}
                onClick={() => {
                  setCustomError(undefined);
                  onChange({ ...filters, priceMin: band.priceMin, priceMax: band.priceMax });
                }}
              >
                {band.label}
              </FilterButton>
            ))}
          </div>

          <form
            key={`${filters.priceMin ?? ''}-${filters.priceMax ?? ''}`}
            className="flex flex-wrap items-end gap-2"
            onSubmit={applyCustomPrice}
            aria-describedby={priceError ? priceErrorId : undefined}
          >
            <PriceInput
              name="priceMin"
              label="最低价"
              defaultValue={filters.priceMin}
              disabled={isPending}
              invalid={Boolean(priceError)}
              errorId={priceErrorId}
            />
            <span className="pb-3 text-xs text-muted-foreground">至</span>
            <PriceInput
              name="priceMax"
              label="最高价"
              defaultValue={filters.priceMax}
              disabled={isPending}
              invalid={Boolean(priceError)}
              errorId={priceErrorId}
            />
            <Button type="submit" variant="secondary" className="h-11 sm:h-9" disabled={isPending}>
              应用价格
            </Button>
          </form>

          {priceError ? (
            <p id={priceErrorId} className="text-xs font-medium text-destructive" role="alert">
              {priceError}
            </p>
          ) : null}
        </fieldset>

        {facets?.degraded ? (
          <Alert variant="warning" role="status">
            <AlertDescription>类目与价格分布暂时不可用，商品列表仍可继续浏览。</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={active ? 'default' : 'outline'}
      size="sm"
      aria-pressed={active}
      onClick={onClick}
      className="h-11 shrink-0 sm:h-9"
    >
      {children}
    </Button>
  );
}

function PriceInput({
  name,
  label,
  defaultValue,
  disabled,
  invalid,
  errorId,
}: {
  name: string;
  label: string;
  defaultValue?: number;
  disabled: boolean;
  invalid: boolean;
  errorId: string;
}) {
  return (
    <label className="grid min-w-0 flex-1 gap-1 text-xs font-medium text-muted-foreground sm:max-w-36">
      {label}
      <span className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted-foreground">
          ¥
        </span>
        <Input
          name={name}
          type="number"
          inputMode="decimal"
          min="0"
          max="1000000"
          step="0.01"
          defaultValue={defaultValue}
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined}
          className="h-11 pl-7 tabular-nums sm:h-9"
        />
      </span>
    </label>
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
