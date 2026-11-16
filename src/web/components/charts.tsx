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

export interface FanPoint {
  year: number;
  label: string;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

/**
 * The range of simulated outcomes over time: a light band from the 10th to
 * the 90th percentile, a stronger band for the middle half, and the median
 * as a line. One hue (it's one quantity); a marker shows when retirement
 * starts. Hover or arrow keys show a year's numbers.
 */
export function FanChart({
  points,
  markerYear,
  height = 280,
  label,
  axisLabel,
}: {
  points: readonly FanPoint[];
  markerYear?: number;
  height?: number;
  label: string;
  axisLabel?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  if (points.length === 0) return <div ref={ref} className="chart" />;
  // Scale to the middle of the outcomes: the luckiest 10% can run far off the top and would
  // flatten everything else. The outer band is clipped at the edge (the tooltip has its numbers).
  const p75max = Math.max(...points.map((p) => p.p75), 1);
  const p90max = Math.max(...points.map((p) => p.p90), 1);
  const hiValue = Math.min(p90max, p75max * 1.6);
  const trimmed = p90max > hiValue;
  const ticks = niceTicks(0, hiValue);
  const hi = ticks.at(-1)!;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / hi) * plotH;
  const area = (lo: keyof FanPoint, up: keyof FanPoint) =>
    points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[up] as number).toFixed(1)}`).join(" ") +
    " " +
    [...points]
      .map((p, i) => ({ p, i }))
      .reverse()
      .map(({ p, i }) => `L${x(i).toFixed(1)},${y(p[lo] as number).toFixed(1)}`)
      .join(" ") +
    " Z";
  const median = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.p50).toFixed(1)}`).join(" ");
  const stride = labelStride(points.length, plotW, 40);
  const markerIndex = markerYear === undefined ? -1 : points.findIndex((p) => p.year === markerYear);
  const last = points.length - 1;

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const i = Math.round(((px - PAD.left) / Math.max(1, plotW)) * last);
    setActive(Math.min(last, Math.max(0, i)));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === "ArrowLeft") setActive((a) => Math.max(0, (a ?? last) - 1));
    else if (e.key === "ArrowRight") setActive((a) => Math.min(last, (a ?? 0) + 1));
    else return;
    e.preventDefault();
  };
  const shown = active === null ? null : points[active]!;

  return (
    <div className="chart-block">
      <div className="legend" aria-hidden>
        <span>
          <i className="key s1" />
          Median
        </span>
        <span>
          <i className="swatch band-mid" />
          Middle half of outcomes
        </span>
        <span>
          <i className="swatch band-wide" />
          8 in 10 outcomes{trimmed ? " (top trimmed)" : ""}
        </span>
        {axisLabel && <span className="legend-axis">Across: {axisLabel}</span>}
      </div>
      <div ref={ref} className="chart" style={{ height }}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={label}
            tabIndex={0}
            onPointerMove={onMove}
            onPointerLeave={() => setActive(null)}
            onBlur={() => setActive(null)}
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
            {points.map((p, i) =>
              i % stride === 0 ? (
                <text key={p.year} className="tick" x={x(i)} y={height - 8} textAnchor="middle">
                  {p.label}
                </text>
              ) : null,
            )}
            <defs>
              <clipPath id="fan-plot">
                <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} />
              </clipPath>
            </defs>
            <g clipPath="url(#fan-plot)">
              <path className="band-wide-fill" d={area("p10", "p90")} />
              <path className="band-mid-fill" d={area("p25", "p75")} />
              <path className="line s1" d={median} />
            </g>

            {markerIndex >= 0 && (
              <g>
                <line className="marker" x1={x(markerIndex)} x2={x(markerIndex)} y1={PAD.top} y2={PAD.top + plotH} />
                <text className="tick marker-label" x={x(markerIndex) + 4} y={PAD.top + 10}>
                  Retire
                </text>
              </g>
            )}
            {shown && active !== null && (
              <>
                <line className="crosshair" x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + plotH} />
                <circle className="dot s1" cx={x(active)} cy={y(shown.p50)} r={4.5} />
              </>
            )}
          </svg>
        )}
        {shown && active !== null && (
          <div className="tooltip" style={{ left: Math.min(Math.max(x(active) - 80, 0), Math.max(0, width - 180)), top: 0 }}>
            <span className="tooltip-title">
              {shown.year}
              {axisLabel ? ` · ${axisLabel} ${shown.label}` : ` · ${shown.label}`}
            </span>
            <span className="tooltip-row">
              <strong>{compactMoney(shown.p50)}</strong> median
            </span>
            <span className="tooltip-row">
              {compactMoney(shown.p25)}–{compactMoney(shown.p75)} middle half
            </span>
            <span className="tooltip-row">
              {compactMoney(shown.p10)}–{compactMoney(shown.p90)} 8 in 10
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export interface MultiSeries {
  name: string;
  /** One value per x position (null = no value there). */
  values: (number | null)[];
}

/**
 * Up to four series on one axis (categorical slots 1–4, in order). Legend
 * above, the latest value labeled at each line's end, and a crosshair tooltip
 * listing every series at the hovered x.
 */
export function MultiLineChart({ xLabels, series, height = 260, label }: { xLabels: readonly string[]; series: readonly MultiSeries[]; height?: number; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const shownSeries = series.slice(0, 4);
  const all = shownSeries.flatMap((s) => s.values.filter((v): v is number => v !== null));
  if (xLabels.length === 0 || all.length === 0) return <div ref={ref} className="chart empty-chart" />;

  const ticks = niceTicks(Math.min(0, ...all), Math.max(...all));
  const lo = ticks[0]!;
  const hi = ticks.at(-1)!;
  const pad = { ...PAD, right: 72 };
  const plotW = Math.max(0, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const n = xLabels.length;
  const last = n - 1;
  const x = (i: number) => pad.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => pad.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const path = (values: readonly (number | null)[]) => {
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };
  const stride = labelStride(n, plotW);
  const lastValue = (s: MultiSeries) => {
    for (let i = s.values.length - 1; i >= 0; i--) if (s.values[i] !== null) return { i, v: s.values[i]! };
    return null;
  };
  // End labels: nudge apart so they don't overlap.
  const ends = shownSeries
    .map((s, k) => ({ k, end: lastValue(s) }))
    .filter((e): e is { k: number; end: { i: number; v: number } } => e.end !== null)
    .map((e) => ({ ...e, top: y(e.end.v) }))
    .sort((a, b) => a.top - b.top);
  for (let j = 1; j < ends.length; j++) ends[j]!.top = Math.max(ends[j]!.top, ends[j - 1]!.top + 16);
  // Keep them inside the plot: if the stack runs off the bottom, push it back up.
  const floor = pad.top + plotH;
  for (let j = ends.length - 1; j >= 0; j--) ends[j]!.top = Math.min(ends[j]!.top, j === ends.length - 1 ? floor : ends[j + 1]!.top - 16);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    setActive(Math.min(last, Math.max(0, Math.round(((px - pad.left) / (plotW || 1)) * last))));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === "ArrowLeft") setActive((a) => Math.max(0, (a ?? last) - 1));
    else if (e.key === "ArrowRight") setActive((a) => Math.min(last, (a ?? last) + 1));
    else return;
    e.preventDefault();
  };

  return (
    <>
      <div className="legend" aria-hidden>
        {shownSeries.map((s, k) => (
          <span key={s.name}>
            <i className={`key s${k + 1}`} /> {s.name}
          </span>
        ))}
      </div>
      <div ref={ref} className="chart" style={{ height }}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`${label}. ${shownSeries.map((s) => `${s.name}: ${lastValue(s) ? formatMoney(lastValue(s)!.v, { cents: false }) : "none"} at ${xLabels[lastValue(s)?.i ?? last]}`).join("; ")}.`}
            tabIndex={0}
            onPointerMove={onMove}
            onPointerLeave={() => setActive(null)}
            onFocus={() => setActive(last)}
            onBlur={() => setActive(null)}
            onKeyDown={onKey}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line className="grid" x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} />
                <text className="tick" x={pad.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                  {compactMoney(t)}
                </text>
              </g>
            ))}
            <line className="baseline" x1={pad.left} x2={width - pad.right} y1={y(Math.max(lo, 0))} y2={y(Math.max(lo, 0))} />
            {xLabels.map((l, i) =>
              i % stride === last % stride ? (
                <text key={l} className="tick" x={x(i)} y={height - 8} textAnchor={i === last ? "end" : "middle"}>
                  {l}
                </text>
              ) : null,
            )}
            {shownSeries.map((s, k) => (
              <path key={s.name} className={`line s${k + 1}`} d={path(s.values)} />
            ))}
            {active !== null && <line className="crosshair" x1={x(active)} x2={x(active)} y1={pad.top} y2={pad.top + plotH} />}
            {active !== null &&
              shownSeries.map((s, k) =>
                s.values[active] != null ? <circle key={s.name} className={`dot s${k + 1}`} cx={x(active)} cy={y(s.values[active]!)} r={4.5} /> : null,
              )}
          </svg>
        )}
        {width > 0 &&
          active === null &&
          ends.map((e) => (
            <span key={e.k} className="end-label multi" style={{ left: x(e.end.i) + 8, top: e.top - 9 }}>
              <i className={`key s${e.k + 1}`} />
              {compactMoney(e.end.v)}
            </span>
          ))}
        {active !== null && (
          <div className="tooltip" style={{ left: Math.min(Math.max(x(active) - 90, 0), Math.max(0, width - 200)), top: 0 }}>
            <span className="tooltip-title">{xLabels[active]}</span>
            {shownSeries.map((s, k) => (
              <span key={s.name} className="tooltip-row">
                <i className={`key s${k + 1}`} />
                {s.name}: <strong>{s.values[active] == null ? "–" : formatMoney(s.values[active]!, { cents: false })}</strong>
              </span>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
