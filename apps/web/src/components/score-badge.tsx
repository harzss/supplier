/** 综合分徽章，按分数高低着色 */
export function ScoreBadge({ value }: { value: number }) {
  const tier =
    value >= 80
      ? {
          bg: 'bg-emerald-50/95',
          text: 'text-emerald-800',
          border: 'border-emerald-200',
          label: '强推',
        }
      : value >= 70
        ? {
            bg: 'bg-brand-50/95',
            text: 'text-brand-800',
            border: 'border-brand-200',
            label: '可选',
          }
        : { bg: 'bg-white/95', text: 'text-zinc-700', border: 'border-zinc-200', label: '观望' };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold shadow-sm backdrop-blur ${tier.bg} ${tier.text} ${tier.border}`}
    >
      <span className="tabular-nums">{value.toFixed(1)}</span>
      <span className="text-[9px] font-medium opacity-80">{tier.label}</span>
    </span>
  );
}
