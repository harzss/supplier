/** 综合分徽章，按分数高低着色 */
export function ScoreBadge({ value }: { value: number }) {
  const tier =
    value >= 80
      ? { bg: 'bg-emerald-100', text: 'text-emerald-700', label: '强推' }
      : value >= 70
        ? { bg: 'bg-amber-100', text: 'text-amber-700', label: '可选' }
        : { bg: 'bg-zinc-100', text: 'text-zinc-500', label: '观望' };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-sm font-semibold ${tier.bg} ${tier.text}`}
    >
      {value.toFixed(1)}
      <span className="text-xs font-normal opacity-80">{tier.label}</span>
    </span>
  );
}
