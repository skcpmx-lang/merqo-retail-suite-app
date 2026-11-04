import { useMemo, useRef, useState } from 'react';
import { money, dateLong } from './format.js';

export interface Series {
  key: string;
  label: string;
  color: string;
  values: number[];
}

/**
 * Dependency-free SVG line/area chart. Renders only real database values —
 * there is no synthetic or placeholder data anywhere in this component.
 */
export function LineChart({
  labels,
  series,
  height = 210,
  formatValue = (v: number) => money(v),
  showArea = true,
}: {
  labels: string[];
  series: Series[];
  height?: number;
  formatValue?: (v: number) => string;
  showArea?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const W = 760;
  const H = height;
  const padL = 8;
  const padR = 8;
  const padT = 14;
  const padB = 26;

  const max = useMemo(() => {
    const all = series.flatMap((s) => s.values);
    const m = all.length ? Math.max(...all) : 0;
    return m <= 0 ? 1 : m * 1.12;
  }, [series]);

  const n = Math.max(1, labels.length);
  const x = (i: number) => padL + (i * (W - padL - padR)) / Math.max(1, n - 1);
  const y = (v: number) => padT + (1 - v / max) * (H - padT - padB);

  const pathFor = (values: number[]) =>
    values
      .map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      .join(' ');

  const areaFor = (values: number[]) =>
    `${pathFor(values)} L${x(values.length - 1).toFixed(1)},${(H - padB).toFixed(1)} L${x(0).toFixed(1)},${(
      H - padB
    ).toFixed(1)} Z`;

  const gridLines = 4;
  const tickIdx = useMemo(() => {
    if (n <= 7) return labels.map((_, i) => i);
    const step = Math.ceil(n / 6);
    const out: number[] = [];
    for (let i = 0; i < n; i += step) out.push(i);
    if (out[out.length - 1] !== n - 1) out.push(n - 1);
    return out;
  }, [n, labels]);

  if (!labels.length) {
    return <div className="empty-state" style={{ padding: 28 }}>এই সময়ের জন্য কোনো তথ্য নেই।</div>;
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const rel = ((e.clientX - rect.left) / rect.width) * W;
          const idx = Math.round(((rel - padL) / (W - padL - padR)) * (n - 1));
          setHover(Math.min(n - 1, Math.max(0, idx)));
        }}
      >
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.26" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0.01" />
            </linearGradient>
          ))}
        </defs>
        {Array.from({ length: gridLines + 1 }).map((_, i) => {
          const gy = padT + ((H - padT - padB) * i) / gridLines;
          return <line key={i} x1={padL} x2={W - padR} y1={gy} y2={gy} stroke="#eef1f4" strokeWidth="1" />;
        })}
        {series.map((s) =>
          showArea ? <path key={`a-${s.key}`} d={areaFor(s.values)} fill={`url(#grad-${s.key})`} /> : null,
        )}
        {series.map((s) => (
          <path
            key={`l-${s.key}`}
            d={pathFor(s.values)}
            fill="none"
            stroke={s.color}
            strokeWidth="2.1"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {hover !== null ? (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB} stroke="#c8d0d8" strokeDasharray="3 3" />
            {series.map((s) => (
              <circle key={s.key} cx={x(hover)} cy={y(s.values[hover] ?? 0)} r="3.6" fill="#fff" stroke={s.color} strokeWidth="2" />
            ))}
          </g>
        ) : null}
        {tickIdx.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={H - 7}
            textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
            fontSize="10"
            fill="#98a2b3"
            fontFamily="var(--font-num)"
          >
            {labels[i]}
          </text>
        ))}
      </svg>
      {hover !== null ? (
        <div
          className="chart-tip"
          style={{
            left: `${(x(hover) / W) * 100}%`,
            top: 6,
          }}
        >
          <div style={{ marginBottom: 2 }}>{dateLong(labels[hover])}</div>
          {series.map((s) => (
            <div key={s.key} style={{ color: s.color }}>
              {s.label}: {formatValue(s.values[hover] ?? 0)}
            </div>
          ))}
        </div>
      ) : null}
      <div className="chart-legend" style={{ marginTop: 4 }}>
        {series.map((s) => (
          <span key={s.key}>
            <i style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function BarList({
  items,
  formatValue = (v: number) => money(v),
  max: maxOverride,
}: {
  items: { label: string; value: number; sub?: string }[];
  formatValue?: (v: number) => string;
  max?: number;
}) {
  const max = maxOverride ?? Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <div className="empty-state" style={{ padding: 24 }}>কোনো তথ্য নেই।</div>;
  return (
    <div className="col" style={{ gap: 10 }}>
      {items.map((item, idx) => (
        <div key={`${item.label}-${idx}`}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 3 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.label}
            </span>
            <span className="num small bold" style={{ flex: 'none' }}>
              {formatValue(item.value)}
            </span>
          </div>
          <div className="progress">
            <i style={{ width: `${Math.max(2, (item.value / max) * 100)}%` }} />
          </div>
          {item.sub ? <div className="tiny muted" style={{ marginTop: 2 }}>{item.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}

export function DonutChart({
  items,
  size = 168,
}: {
  items: { label: string; value: number; color: string }[];
  size?: number;
}) {
  const total = items.reduce((s, i) => s + i.value, 0);
  const radius = size / 2 - 12;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="row" style={{ gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#eef1f4" strokeWidth="16" />
        {total > 0
          ? items.map((item) => {
              const length = (item.value / total) * circumference;
              const dash = `${length} ${circumference - length}`;
              const el = (
                <circle
                  key={item.label}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  stroke={item.color}
                  strokeWidth="16"
                  strokeDasharray={dash}
                  strokeDashoffset={-offset}
                  transform={`rotate(-90 ${size / 2} ${size / 2})`}
                  strokeLinecap="butt"
                />
              );
              offset += length;
              return el;
            })
          : null}
      </svg>
      <div className="col" style={{ gap: 6 }}>
        {items.map((i) => (
          <div key={i.label} className="row small" style={{ gap: 7 }}>
            <i style={{ width: 9, height: 9, borderRadius: 3, background: i.color, display: 'inline-block' }} />
            <span style={{ minWidth: 90 }}>{i.label}</span>
            <span className="num bold">{money(i.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export const CHART_COLORS = ['#12907e', '#e9a23b', '#2563eb', '#dc2626', '#7c3aed', '#0891b2', '#65a30d', '#f97316'];
