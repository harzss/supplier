/** 归一化工具：把任意特征压到 0-100，便于打分器组合 */

export function clamp(x: number, min = 0, max = 100): number {
  if (Number.isNaN(x)) return min;
  return Math.max(min, Math.min(max, x));
}

/** 对数压缩 — 适合销量、热度这类长尾分布 */
export function logScore(value: number | undefined, scale: number): number {
  if (!value || value <= 0) return 0;
  // log10(value+1) / log10(scale+1) → 当 value=scale 时得 1
  const r = Math.log10(value + 1) / Math.log10(scale + 1);
  return clamp(r * 100);
}

/** 反向 log — 同款数越多分数越低 */
export function inverseLogScore(value: number | undefined, scale: number): number {
  if (value === undefined || value < 0) return 70; // 信号缺失给中性偏好分
  if (value === 0) return 100;
  return clamp(100 - logScore(value, scale));
}

/** 把利润率映射到分数：0 → 0，30% → 60，60% → 90，>=100% → 100 */
export function profitMarginScore(margin: number): number {
  if (!Number.isFinite(margin) || margin <= 0) return 0;
  // 对 0..1 范围线性，>1 之后用 tanh 压住
  if (margin <= 1) return clamp(margin * 90);
  return clamp(90 + Math.tanh(margin - 1) * 10);
}

/** tanh 压缩到 0..100，零值居中（50） */
export function tanhCenter(value: number | undefined): number {
  if (value === undefined) return 50;
  return clamp(50 + Math.tanh(value) * 50);
}
