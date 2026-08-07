'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowCounterClockwise, Plus, Trash, WarningCircle } from '@phosphor-icons/react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type {
  ProductBatchSkuDimension,
  ProductBatchSkuEditContext,
  ProductBatchSkuRowTarget,
  ProductBatchSkuTarget,
  ProductBatchSkuValueTarget,
} from '@/lib/api';
import {
  appendSkuDimension,
  createNewSkuRow,
  createSkuTarget,
  deriveSkuTargetDimensions,
  nextAvailableSkuDimension,
  skuCustomValueInputText,
  skuDimensionIdentity,
  skuPriceCentsToInput,
  skuPriceInputToCents,
  summarizeSkuChanges,
  updateSkuCustomValueInput,
  validateSkuTarget,
} from './sku-edit-draft';

const DEFAULT_SOURCE_OPTION = '__default__';

interface SkuMatrixEditorProps {
  open: boolean;
  productTitle: string;
  context: ProductBatchSkuEditContext | null;
  initialTarget?: ProductBatchSkuTarget;
  error?: string | null;
  saving?: boolean;
  retrying?: boolean;
  onOpenChange(open: boolean): void;
  onRetry?(): void;
  onSave(target: ProductBatchSkuTarget): void;
}

export function SkuMatrixEditor({
  open,
  productTitle,
  context,
  initialTarget,
  error = null,
  saving = false,
  retrying = false,
  onOpenChange,
  onRetry,
  onSave,
}: SkuMatrixEditorProps) {
  const [target, setTarget] = useState<ProductBatchSkuTarget | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const errorSummaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !context) return;
    setTarget(initialTarget ?? createSkuTarget(context));
    setShowErrors(false);
  }, [context, initialTarget, open]);

  const errors = useMemo(
    () => (context && target ? validateSkuTarget(context, target) : []),
    [context, target],
  );
  const summary = useMemo(
    () => (context && target ? summarizeSkuChanges(context, target) : null),
    [context, target],
  );
  const editorBlockers = useMemo(
    () => [
      ...new Set([...(context?.blockers ?? []), ...(context?.rules.unsupportedReasons ?? [])]),
    ],
    [context],
  );
  const deletedRows = useMemo(() => {
    if (!context || !target) return [];
    const active = new Set(target.rows.map((row) => row.rowId));
    return context.rows.filter((row) => !active.has(row.rowId));
  }, [context, target]);
  const usedSourceIds = useMemo(
    () => new Set(target?.rows.map((row) => row.sourceSpecId) ?? []),
    [target],
  );
  const nextSource = context?.sourceSkus.find((source) => !usedSourceIds.has(source.sourceSpecId));
  const availableDimension = context && target ? nextAvailableSkuDimension(context, target) : null;

  useEffect(() => {
    if (showErrors && errors.length > 0) errorSummaryRef.current?.focus();
  }, [errors, showErrors]);

  const save = () => {
    if (!context || !target) return;
    const normalized = deriveSkuTargetDimensions(target);
    const nextErrors = validateSkuTarget(context, normalized);
    if (nextErrors.length > 0) {
      setTarget(normalized);
      setShowErrors(true);
      return;
    }
    onSave(normalized);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex !w-[min(96vw,72rem)] !max-w-none flex-col gap-0 overflow-hidden p-0 sm:!max-w-none"
      >
        <SheetHeader className="border-b bg-background px-5 py-5 pr-16 sm:px-7">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <Badge variant="secondary" className="mb-2">
                SKU Matrix
              </Badge>
              <SheetTitle className="truncate text-xl">编辑 SKU 结构</SheetTitle>
              <SheetDescription className="mt-1 max-w-3xl text-pretty">
                {productTitle} · 平台 SKU ID 与稳定编码保持不变；提交前只生成预览，不直接写入平台。
              </SheetDescription>
            </div>
            {summary ? (
              <div className="flex flex-wrap gap-2 pr-3 text-xs tabular-nums">
                <Badge variant="secondary">新增 {summary.added}</Badge>
                <Badge variant="outline">修改 {summary.changed}</Badge>
                <Badge variant={summary.deleted > 0 ? 'destructive' : 'outline'}>
                  删除 {summary.deleted}
                </Badge>
              </div>
            ) : null}
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30 px-4 py-5 sm:px-7">
          {error ? (
            <Alert variant="destructive" className="mx-auto max-w-2xl">
              <WarningCircle weight="fill" aria-hidden="true" />
              <AlertTitle>SKU 配置读取失败</AlertTitle>
              <AlertDescription>
                <p>{error}</p>
                {onRetry ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-3 min-h-11"
                    disabled={retrying}
                    onClick={onRetry}
                  >
                    {retrying ? '正在重新读取…' : '重新读取'}
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : !context || !target ? (
            <div
              className="grid min-h-64 place-items-center text-sm text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              正在读取平台 SKU 与类目规则…
            </div>
          ) : (
            <div className="mx-auto grid w-full max-w-[68rem] gap-5">
              {editorBlockers.length > 0 || context.rules.allSkuPicturesRequired ? (
                <Alert variant="warning">
                  <WarningCircle weight="fill" aria-hidden="true" />
                  <AlertTitle>当前 SKU 结构需要人工处理</AlertTitle>
                  <AlertDescription>
                    <ul className="mt-2 list-disc space-y-1 pl-5">
                      {editorBlockers.map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                      {context.rules.allSkuPicturesRequired ? (
                        <li>
                          当前类目要求新增 SKU 提供规格图片，本编辑器仅支持修改或删除既有 SKU。
                        </li>
                      ) : null}
                    </ul>
                  </AlertDescription>
                </Alert>
              ) : null}

              <section className="rounded-xl border bg-background shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5">
                  <div>
                    <h3 className="text-sm font-semibold">规格维度</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      最多 {Math.min(3, context.rules.maxDimensions)} 个维度；官方必填维度不能删除。
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-11 sm:h-8"
                    disabled={
                      !availableDimension ||
                      target.dimensions.length >= Math.min(3, context.rules.maxDimensions)
                    }
                    onClick={() => {
                      if (!availableDimension) return;
                      setTarget(appendSkuDimension(target, availableDimension));
                    }}
                  >
                    <Plus aria-hidden="true" />
                    添加维度
                  </Button>
                </div>
                <Separator />
                <div className="grid gap-3 p-4 sm:p-5 lg:grid-cols-3">
                  {target.dimensions.length === 0 ? (
                    <p className="text-sm text-muted-foreground lg:col-span-3">
                      当前为单 SKU。可从平台类目规则中添加规格维度。
                    </p>
                  ) : null}
                  {target.dimensions.map((dimension, index) => {
                    const rule = findDimensionRule(context, dimension);
                    const mutable =
                      context.rules.supportsCustomDimensions || dimension.propertyId === '0';
                    return (
                      <div
                        key={`${dimension.propertyId}:${index}`}
                        className="rounded-lg border p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-medium text-muted-foreground">
                            维度 {index + 1}
                          </span>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="size-11 text-muted-foreground hover:text-destructive sm:size-9"
                            disabled={rule?.required === true}
                            aria-label={`删除规格维度 ${dimension.propertyName}`}
                            onClick={() => removeDimension(target, index, setTarget)}
                          >
                            <Trash aria-hidden="true" />
                          </Button>
                        </div>
                        <Input
                          className="mt-2 h-11 sm:h-9"
                          value={dimension.propertyName}
                          readOnly={!mutable}
                          aria-label={`规格维度 ${index + 1} 名称`}
                          onChange={(event) =>
                            updateDimensionName(target, index, event.target.value, setTarget)
                          }
                        />
                        <p className="mt-2 text-[11px] text-muted-foreground">
                          {mutable ? '可编辑自定义名称' : `官方属性 ID ${dimension.propertyId}`}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="overflow-hidden rounded-xl border bg-background shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5">
                  <div>
                    <h3 className="text-sm font-semibold">SKU 与 1688 路由</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      每个目标 SKU 必须一对一绑定当前货源规格；新增 SKU
                      的库存来自货源，只需填写售价。
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    className="h-11 sm:h-8"
                    disabled={
                      !nextSource ||
                      context.rules.allSkuPicturesRequired ||
                      target.rows.length >= Math.min(100, context.rules.maxCombinations)
                    }
                    onClick={() => {
                      if (!nextSource) return;
                      setTarget({
                        ...target,
                        rows: [...target.rows, createNewSkuRow(target, nextSource.sourceSpecId)],
                      });
                    }}
                  >
                    <Plus aria-hidden="true" />
                    新增 SKU
                  </Button>
                </div>
                <Separator />
                <div className="overflow-x-auto">
                  <table className="min-w-[58rem] w-full text-left text-xs">
                    <caption className="sr-only">平台 SKU、1688 规格、销售属性、售价与操作</caption>
                    <thead className="bg-muted/60 text-muted-foreground">
                      <tr>
                        <th scope="col" className="px-4 py-3 font-medium">
                          平台 SKU
                        </th>
                        <th scope="col" className="px-3 py-3 font-medium">
                          1688 规格
                        </th>
                        {target.dimensions.map((dimension, index) => (
                          <th
                            key={`${dimension.propertyId}:${index}`}
                            scope="col"
                            className="min-w-40 px-3 py-3 font-medium"
                          >
                            {dimension.propertyName || `维度 ${index + 1}`}
                          </th>
                        ))}
                        <th scope="col" className="min-w-32 px-3 py-3 font-medium">
                          售价 / 库存
                        </th>
                        <th scope="col" className="w-16 px-3 py-3 text-right font-medium">
                          操作
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {target.rows.map((row, rowIndex) => (
                        <SkuRow
                          key={row.rowId}
                          context={context}
                          target={target}
                          row={row}
                          rowIndex={rowIndex}
                          onChange={(nextRow) =>
                            setTarget({
                              ...target,
                              rows: target.rows.map((item) =>
                                item.rowId === row.rowId ? nextRow : item,
                              ),
                            })
                          }
                          onDelete={() =>
                            setTarget({
                              ...target,
                              rows: target.rows.filter((item) => item.rowId !== row.rowId),
                            })
                          }
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {deletedRows.length > 0 ? (
                <section className="rounded-xl border border-dashed bg-background p-4 sm:p-5">
                  <h3 className="text-sm font-semibold">待删除 SKU</h3>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {deletedRows.map((row) => (
                      <div
                        key={row.rowId}
                        className="flex items-center justify-between gap-3 rounded-lg bg-muted/60 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <strong className="block truncate text-xs font-medium">
                            {row.platformSkuKey}
                          </strong>
                          <span className="text-[11px] text-muted-foreground">
                            {row.properties.map((value) => value.valueName).join(' / ') ||
                              '默认规格'}
                          </span>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="min-h-11 sm:h-8 sm:min-h-0"
                          onClick={() => restoreRow(target, row, setTarget)}
                        >
                          <ArrowCounterClockwise aria-hidden="true" />
                          撤销
                        </Button>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {showErrors && errors.length > 0 ? (
                <Alert ref={errorSummaryRef} variant="destructive" tabIndex={-1}>
                  <WarningCircle weight="fill" aria-hidden="true" />
                  <AlertTitle>还不能保存 SKU 配置</AlertTitle>
                  <AlertDescription>
                    <ul className="mt-2 list-disc space-y-1 pl-5">
                      {errors.map((error) => (
                        <li key={error}>{error}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>
          )}
        </div>

        <SheetFooter className="gap-2 border-t bg-background px-5 py-4 sm:px-7">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:h-9 sm:min-h-0"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            className="min-h-11 sm:h-9 sm:min-h-0"
            disabled={
              !context ||
              !context.editable ||
              !target ||
              Boolean(error) ||
              saving ||
              editorBlockers.length > 0
            }
            onClick={save}
          >
            {saving ? '保存中…' : '保存到批量预览'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function SkuRow({
  context,
  target,
  row,
  rowIndex,
  onChange,
  onDelete,
}: {
  context: ProductBatchSkuEditContext;
  target: ProductBatchSkuTarget;
  row: ProductBatchSkuRowTarget;
  rowIndex: number;
  onChange(row: ProductBatchSkuRowTarget): void;
  onDelete(): void;
}) {
  const usedByOtherRows = new Set(
    target.rows.filter((item) => item.rowId !== row.rowId).map((item) => item.sourceSpecId),
  );
  const source = context.sourceSkus.find((item) => item.sourceSpecId === row.sourceSpecId);
  const hasDefaultSource = context.sourceSkus.some((item) => item.sourceSpecId === null);
  return (
    <tr className="align-top">
      <td className="px-4 py-4">
        <Badge variant={row.platformSkuId ? 'outline' : 'secondary'}>
          {row.platformSkuId ? '保留' : '新增'}
        </Badge>
        <strong className="mt-2 block max-w-40 truncate font-mono text-[11px] font-medium">
          {row.platformSkuKey ?? '提交后生成稳定编码'}
        </strong>
        <span className="mt-1 block text-[10px] text-muted-foreground">
          {row.platformSkuId ? `ID ${row.platformSkuId}` : `新行 ${rowIndex + 1}`}
        </span>
      </td>
      <td className="px-3 py-4">
        <select
          className="h-11 w-44 rounded-md border border-input bg-background px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9"
          aria-label={`SKU ${rowIndex + 1} 的 1688 规格`}
          value={
            row.sourceSpecId === null && !hasDefaultSource
              ? ''
              : sourceOptionValue(row.sourceSpecId)
          }
          onChange={(event) =>
            onChange({
              ...row,
              sourceSpecId:
                event.target.value === DEFAULT_SOURCE_OPTION ? null : event.target.value || null,
            })
          }
        >
          <option value="">选择货源规格</option>
          {context.sourceSkus.map((item) => (
            <option
              key={sourceOptionValue(item.sourceSpecId)}
              value={sourceOptionValue(item.sourceSpecId)}
              disabled={usedByOtherRows.has(item.sourceSpecId)}
            >
              {item.sourceSpecName || item.sourceSpecId || '默认规格'}
            </option>
          ))}
        </select>
        {source ? (
          <span className="mt-2 block text-[10px] text-muted-foreground tabular-nums">
            成本 ¥{source.costPrice.toFixed(2)} · 库存 {source.stock}
          </span>
        ) : null}
      </td>
      {target.dimensions.map((dimension, dimensionIndex) => {
        const value = row.properties[dimensionIndex] ?? emptyValue(dimension);
        const rule = findDimensionRule(context, dimension);
        const values = rule?.values ?? [];
        const custom =
          dimension.propertyId === '0' ||
          value.valueId === '0' ||
          (values.length === 0 && rule?.supportsCustomValues === true);
        return (
          <td key={`${dimension.propertyId}:${dimensionIndex}`} className="px-3 py-4">
            {custom ? (
              <Input
                className="h-11 sm:h-9"
                value={skuCustomValueInputText(value, rule?.supportsRemark === true)}
                maxLength={30}
                aria-label={`SKU ${rowIndex + 1} 的${dimension.propertyName}`}
                placeholder={rule?.supportsRemark ? '输入自定义规格值' : undefined}
                onChange={(event) =>
                  onChange(
                    updateRowValue(
                      row,
                      dimensionIndex,
                      updateSkuCustomValueInput(
                        { ...value, propertyName: dimension.propertyName },
                        event.target.value,
                        rule?.supportsRemark === true,
                      ),
                    ),
                  )
                }
              />
            ) : (
              <select
                className="h-11 w-full rounded-md border border-input bg-background px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9"
                value={value.valueId}
                aria-label={`SKU ${rowIndex + 1} 的${dimension.propertyName}`}
                onChange={(event) => {
                  if (event.target.value === '0') {
                    const customValueName =
                      values.find((item) => item.valueId === '0')?.valueName || value.valueName;
                    onChange(
                      updateRowValue(
                        row,
                        dimensionIndex,
                        updateSkuCustomValueInput(
                          {
                            ...value,
                            propertyName: dimension.propertyName,
                            valueId: '0',
                            valueName: customValueName,
                          },
                          '',
                          rule?.supportsRemark === true,
                        ),
                      ),
                    );
                    return;
                  }
                  const selected = values.find((item) => item.valueId === event.target.value);
                  onChange(
                    updateRowValue(row, dimensionIndex, {
                      ...value,
                      propertyName: dimension.propertyName,
                      valueId: selected?.valueId ?? '',
                      valueName: selected?.valueName ?? '',
                    }),
                  );
                }}
              >
                <option value="">选择规格值</option>
                {values
                  .filter((item) => item.valueId !== '0')
                  .map((item) => (
                    <option key={item.valueId} value={item.valueId}>
                      {item.valueName}
                    </option>
                  ))}
                {rule?.supportsCustomValues ? <option value="0">自定义规格值…</option> : null}
              </select>
            )}
          </td>
        );
      })}
      <td className="px-3 py-4">
        {row.platformSkuId ? (
          <>
            <strong className="font-mono text-xs tabular-nums">
              ¥
              {(
                (context.rows.find((item) => item.rowId === row.rowId)?.priceCents ?? 0) / 100
              ).toFixed(2)}
            </strong>
            <span className="mt-1 block text-[10px] text-muted-foreground tabular-nums">
              库存 {context.rows.find((item) => item.rowId === row.rowId)?.stock ?? 0}
            </span>
          </>
        ) : (
          <label className="block">
            <span className="sr-only">新增 SKU {rowIndex + 1} 售价</span>
            <div className="flex min-h-11 items-center rounded-md border border-input bg-background px-2 shadow-sm focus-within:ring-2 focus-within:ring-ring sm:min-h-9">
              <span className="mr-1 text-muted-foreground">¥</span>
              <input
                className="h-11 min-w-0 flex-1 bg-transparent font-mono outline-none tabular-nums sm:h-9"
                type="number"
                inputMode="decimal"
                min="0.01"
                max="1000000"
                step="0.01"
                placeholder="0.00"
                value={skuPriceCentsToInput(row.priceCents)}
                onChange={(event) =>
                  onChange({ ...row, priceCents: skuPriceInputToCents(event.target.value) })
                }
              />
            </div>
            <span className="mt-1 block text-[10px] text-muted-foreground tabular-nums">
              库存 {source?.stock ?? '—'}
            </span>
          </label>
        )}
      </td>
      <td className="px-3 py-4 text-right">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-11 text-muted-foreground hover:text-destructive sm:size-9"
          aria-label={`删除 SKU ${row.platformSkuKey ?? rowIndex + 1}`}
          onClick={onDelete}
        >
          <Trash aria-hidden="true" />
        </Button>
      </td>
    </tr>
  );
}

function removeDimension(
  target: ProductBatchSkuTarget,
  index: number,
  setTarget: (target: ProductBatchSkuTarget) => void,
) {
  setTarget({
    ...target,
    dimensions: target.dimensions.filter((_, itemIndex) => itemIndex !== index),
    rows: target.rows.map((row) => ({
      ...row,
      properties: row.properties.filter((_, itemIndex) => itemIndex !== index),
    })),
  });
}

function updateDimensionName(
  target: ProductBatchSkuTarget,
  index: number,
  name: string,
  setTarget: (target: ProductBatchSkuTarget) => void,
) {
  setTarget({
    ...target,
    dimensions: target.dimensions.map((dimension, itemIndex) =>
      itemIndex === index ? { ...dimension, propertyName: name } : dimension,
    ),
    rows: target.rows.map((row) => ({
      ...row,
      properties: row.properties.map((value, itemIndex) =>
        itemIndex === index ? { ...value, propertyName: name } : value,
      ),
    })),
  });
}

function updateRowValue(
  row: ProductBatchSkuRowTarget,
  index: number,
  value: ProductBatchSkuValueTarget,
): ProductBatchSkuRowTarget {
  return {
    ...row,
    properties: row.properties.map((item, itemIndex) => (itemIndex === index ? value : item)),
  };
}

function emptyValue(dimension: ProductBatchSkuDimension): ProductBatchSkuValueTarget {
  return {
    propertyId: dimension.propertyId,
    propertyName: dimension.propertyName,
    valueId: dimension.propertyId === '0' ? '0' : '',
    valueName: '',
  };
}

function restoreRow(
  target: ProductBatchSkuTarget,
  row: ProductBatchSkuEditContext['rows'][number],
  setTarget: (target: ProductBatchSkuTarget) => void,
) {
  setTarget({
    ...target,
    rows: [
      ...target.rows,
      {
        rowId: row.rowId,
        isNew: false,
        platformSkuId: row.platformSkuId,
        platformSkuKey: row.platformSkuKey,
        sourceSpecId: row.sourceSpecId,
        properties: row.properties.map((value) => ({
          propertyId: value.propertyId,
          propertyName: value.propertyName,
          valueId: value.valueId,
          valueName: value.valueName,
          ...(value.remark ? { remark: value.remark } : {}),
        })),
        priceCents: row.priceCents,
        skuPictureUrls: [...row.skuPictureUrls],
      },
    ],
  });
}

function findDimensionRule(
  context: ProductBatchSkuEditContext,
  dimension: ProductBatchSkuDimension,
) {
  return context.rules.dimensions.find(
    (rule) => skuDimensionIdentity(rule) === skuDimensionIdentity(dimension),
  );
}

function sourceOptionValue(sourceSpecId: string | null): string {
  return sourceSpecId ?? DEFAULT_SOURCE_OPTION;
}
