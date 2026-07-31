/** 综合分徽章，按分数高低着色 */
export function ScoreBadge({ value }: { value: number }) {
  const tier =
    value >= 80
      ? { bg: 'bg-[#dcece7]', text: 'text-[#185145]', border: 'border-[#7cb4a6]', label: '强推' }
      : value >= 70
        ? { bg: 'bg-[#f7e9ca]', text: 'text-[#754913]', border: 'border-[#d7b56c]', label: '可选' }
        : { bg: 'bg-[#ece8de]', text: 'text-[#5e655f]', border: 'border-[#b9b4aa]', label: '观望' };
  return (
    <span
      className={`inline-flex items-center gap-1 border px-2 py-1 font-mono text-xs font-bold ${tier.bg} ${tier.text} ${tier.border}`}
    >
      {value.toFixed(1)}
      <span className="text-[9px] font-medium opacity-80">{tier.label}</span>
    </span>
  );
}
