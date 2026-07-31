import type { ProductScore } from '@/lib/api';

const DIMENSIONS: Array<{ key: keyof ProductScore; label: string }> = [
  { key: 'demand', label: '需求' },
  { key: 'competition', label: '竞争' },
  { key: 'profit', label: '利润' },
  { key: 'compliance', label: '合规' },
  { key: 'trend', label: '趋势' },
];

/** 纯 SVG 五维雷达图，无第三方依赖 */
export function ScoreRadar({ score, size = 220 }: { score: ProductScore; size?: number }) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 36;
  const n = DIMENSIONS.length;

  const pointAt = (i: number, value: number) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    const radius = (value / 100) * r;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)] as const;
  };

  const gridLevels = [0.25, 0.5, 0.75, 1];
  const dataPoints = DIMENSIONS.map((d, i) => pointAt(i, score[d.key] as number));
  const dataPath = dataPoints.map((p) => p.join(',')).join(' ');

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="select-none"
      role="img"
      aria-label={`AI 选品评分：需求 ${Math.round(score.demand)}，竞争 ${Math.round(score.competition)}，利润 ${Math.round(score.profit)}，合规 ${Math.round(score.compliance)}，趋势 ${Math.round(score.trend)}`}
    >
      {/* 网格 */}
      {gridLevels.map((lvl) => {
        const pts = DIMENSIONS.map((_, i) => pointAt(i, lvl * 100).join(',')).join(' ');
        return <polygon key={lvl} points={pts} fill="none" stroke="#e7e9ee" strokeWidth={1} />;
      })}
      {/* 轴线 + 标签 */}
      {DIMENSIONS.map((d, i) => {
        const [x, y] = pointAt(i, 100);
        const [lx, ly] = pointAt(i, 122);
        return (
          <g key={d.key}>
            <line x1={cx} y1={cy} x2={x} y2={y} stroke="#e7e9ee" strokeWidth={1} />
            <text
              x={lx}
              y={ly}
              fontSize={12}
              textAnchor="middle"
              dominantBaseline="middle"
              fill="#4f5663"
            >
              {d.label}
            </text>
            <text
              x={lx}
              y={ly + 14}
              fontSize={10}
              textAnchor="middle"
              dominantBaseline="middle"
              fill="#929baa"
            >
              {Math.round(score[d.key] as number)}
            </text>
          </g>
        );
      })}
      {/* 数据多边形 */}
      <polygon points={dataPath} fill="rgba(91,91,214,0.14)" stroke="#5b5bd6" strokeWidth={2} />
      {dataPoints.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r={3} fill="#5b5bd6" />
      ))}
    </svg>
  );
}
