import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { compactMoney, labelStride, niceTicks } from "../chartMath.ts";
import { formatMoney } from "../format.ts";

/** Width of a container, kept up to date. Charts draw in real pixels so text stays crisp. */
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

const PAD = { top: 16, right: 16, bottom: 28, left: 56 };

export interface LinePoint {
  key: string;
  label: string;
  /** Tooltip heading, e.g. "Nov 2026". */
  title: string;
  value: number;
}

/**
 * One series over time: 2px line, 10% area wash, crosshair + tooltip that
 * snaps to the nearest point, keyboard arrows to step through points, and
 * the latest value labeled at the end.
 */
export function LineChart({ points, height = 220, label }: { points: readonly LinePoint[]; height?: number; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  if (points.length === 0) return <div ref={ref} className="chart empty-chart" />;

  const values = points.map((p) => p.value);
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const lo = ticks[0]!;
  const hi = ticks.at(-1)!;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${PAD.top + plotH} L${x(0).toFixed(1)},${PAD.top + plotH} Z`;
  const stride = labelStride(points.length, plotW);
  const last = points.length - 1;

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    setActive(best);
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === "ArrowLeft") setActive((a) => Math.max(0, (a ?? last) - 1));
    else if (e.key === "ArrowRight") setActive((a) => Math.min(last, (a ?? last) + 1));
    else return;
    e.preventDefault();
  };
  const shown = active === null ? null : points[active]!;

  return (
    <div ref={ref} className="chart" style={{ height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${label}. Latest ${points[last]!.title}: ${formatMoney(points[last]!.value, { cents: false })}.`}
          tabIndex={0}
          onPointerMove={onMove}
          onPointerLeave={() => setActive(null)}
          onFocus={() => setActive(last)}
          onBlur={() => setActive(null)}
          onKeyDown={onKey}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="tick" x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                {compactMoney(t)}
              </text>
            </g>
          ))}
          {lo < 0 && hi > 0 && <line className="baseline" x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} />}
          {points.map((p, i) =>
            i % stride === (last % stride) ? (
              <text key={p.key} className="tick" x={x(i)} y={height - 8} textAnchor="middle">
                {p.label}
              </text>
            ) : null,
          )}
          <path className="area s1" d={area} />
          <path className="line s1" d={line} />
          {shown && active !== null && <line className="crosshair" x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + plotH} />}
          <circle className="dot s1" cx={x(active ?? last)} cy={y(points[active ?? last]!.value)} r={4.5} />
        </svg>
      )}
      {width > 0 && active === null && (
        <span className="end-label" style={{ right: PAD.right, top: Math.max(0, y(points[last]!.value) - 28) }}>
          {formatMoney(points[last]!.value, { cents: false })}
        </span>
      )}
      {shown && active !== null && (
        <div className="tooltip" style={{ left: Math.min(Math.max(x(active) - 70, 0), Math.max(0, width - 150)), top: 0 }}>
          <strong>{formatMoney(shown.value, { cents: false })}</strong>
          <span>{shown.title}</span>
        </div>
      )}
    </div>
  );
}

export interface ColumnSeries {
  name: string;
  /** CSS class for the series color: "s1" or "s2". */
  className: string;
  values: readonly number[];
}

/**
 * Grouped columns per period (e.g. income vs spending by month). Columns are
 * at most 24px wide with a 2px gap, 4px rounded tops, square at the
 * baseline. Hovering or focusing a period shows every series' value.
 */
export function ColumnChart({
  categories,
  titles,
  series,
  height = 240,
  label,
}: {
  categories: readonly string[];
  titles: readonly string[];
  series: readonly ColumnSeries[];
  height?: number;
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const all = series.flatMap((s) => s.values);
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
  const lo = ticks[0]!;
  const hi = ticks.at(-1)!;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const band = categories.length ? plotW / categories.length : 0;
  const barW = Math.max(2, Math.min(24, (band * 0.7 - 2 * (series.length - 1)) / series.length));
  const groupW = barW * series.length + 2 * (series.length - 1);
  const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const stride = labelStride(categories.length, plotW);
  const last = categories.length - 1;

  /** A column with a rounded data end (top for positive values) and a square baseline end. */
  const columnPath = (x0: number, v: number) => {
    const base = y(0);
    const top = y(v);
    const h = Math.abs(base - top);
    if (h < 0.5) return "";
    const r = Math.min(4, h, barW / 2);
    if (v >= 0) {
      return `M${x0},${base} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + barW - r} Q${x0 + barW},${top} ${x0 + barW},${top + r} V${base} Z`;
    }
    return `M${x0},${base} V${top - r} Q${x0},${top} ${x0 + r},${top} H${x0 + barW - r} Q${x0 + barW},${top} ${x0 + barW},${top - r} V${base} Z`;
  };

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === "ArrowLeft") setActive((a) => Math.max(0, (a ?? last) - 1));
    else if (e.key === "ArrowRight") setActive((a) => Math.min(last, (a ?? last) + 1));
    else return;
    e.preventDefault();
  };

  return (
    <div className="chart-block">
      <div className="legend" aria-hidden>
        {series.map((s) => (
          <span key={s.name}>
            <i className={`swatch ${s.className}`} />
            {s.name}
          </span>
        ))}
      </div>
      <div ref={ref} className="chart" style={{ height }}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={label}
            tabIndex={0}
            onPointerLeave={() => setActive(null)}
            onBlur={() => setActive(null)}
            onFocus={() => setActive(last)}
            onKeyDown={onKey}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line className={t === 0 ? "baseline" : "grid"} x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
                <text className="tick" x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                  {compactMoney(t)}
                </text>
              </g>
            ))}
            {categories.map((c, i) => {
              const x0 = PAD.left + i * band + (band - groupW) / 2;
              return (
                <g key={c} className={active === i ? "group active" : "group"}>
                  {/* The whole band is the hit target, not just the painted columns. */}
                  <rect className="hit" x={PAD.left + i * band} y={PAD.top} width={band} height={plotH} onPointerEnter={() => setActive(i)} />
                  {series.map((s, j) => (
                    <path key={s.name} className={`column ${s.className}`} d={columnPath(x0 + j * (barW + 2), s.values[i] ?? 0)} />
                  ))}
                  {i % stride === last % stride && (
                    <text className="tick" x={PAD.left + i * band + band / 2} y={height - 8} textAnchor="middle">
                      {c}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
        {active !== null && width > 0 && (
          <div className="tooltip" style={{ left: Math.min(Math.max(PAD.left + active * band + band / 2 - 80, 0), Math.max(0, width - 170)), top: 0 }}>
            <span className="tooltip-title">{titles[active]}</span>
            {series.map((s) => (
              <span key={s.name} className="tooltip-row">
                <i className={`key ${s.className}`} />
                <strong>{formatMoney(s.values[active] ?? 0, { cents: false })}</strong> {s.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * How much of a budget is used. The fill is the accent until it passes 90%,
 * then warning, then critical once over budget; the state is also written
 * out next to it, never shown by color alone.
 */
export function Meter({ used, total, label }: { used: number; total: number; label: string }) {
  const ratio = total > 0 ? used / total : used > 0 ? 1.01 : 0;
  const state = ratio > 1 ? "over" : ratio > 0.9 ? "near" : "ok";
  return (
    <div
      className={`meter ${state}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.max(total, 0)}
      aria-valuenow={Math.max(0, used)}
    >
      <div className="meter-fill" style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }} />
    </div>
  );
}
