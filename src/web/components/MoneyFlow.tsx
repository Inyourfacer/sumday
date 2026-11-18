import { formatMoney } from "../format.ts";

export interface FlowSegment {
  label: string;
  amount: number;
  /** bills = fixed and non-monthly; flex = everyday spending; step = a plan step; left = unallocated. */
  tone: "bills" | "flex" | "step" | "left";
}

/**
 * One bar showing where a month's income goes: bills, everyday spending, each
 * plan step, and what's left. The legend repeats every amount in text, so the
 * colours never carry the meaning alone.
 */
export function MoneyFlow({ income, segments }: { income: number; segments: readonly FlowSegment[] }) {
  const parts = segments.filter((s) => s.amount > 0);
  const spent = parts.filter((s) => s.tone !== "left").reduce((sum, s) => sum + s.amount, 0);
  const total = Math.max(income, spent);
  const over = spent - income;
  const summary = parts.map((s) => `${s.label} ${formatMoney(s.amount, { cents: false })}`).join(", ");
  // Plan steps take turns through three shades so neighbours differ.
  const shaded = parts.map((s, i) => ({ ...s, shade: s.tone === "step" ? parts.slice(0, i).filter((x) => x.tone === "step").length % 3 : 0 }));
  return (
    <figure className="flow">
      <div className="flow-bar" role="img" aria-label={`Where ${formatMoney(income, { cents: false })} a month goes: ${summary}`}>
        {shaded.map((s) => (
          <span
            key={s.label}
            className={`flow-seg ${s.tone} shade-${s.shade}`}
            style={{ width: `${(s.amount / total) * 100}%` }}
            title={`${s.label}: ${formatMoney(s.amount, { cents: false })}`}
          />
        ))}
      </div>
      <ul className="flow-legend">
        {shaded.map((s) => (
          <li key={s.label}>
            <span className={`flow-swatch ${s.tone} shade-${s.shade}`} aria-hidden />
            <span>{s.label}</span>
            <strong>{formatMoney(s.amount, { cents: false })}</strong>
          </li>
        ))}
      </ul>
      {over > 0 && (
        <p className="small flow-over" role="status">
          Spending and bills already come to {formatMoney(over, { cents: false })} more than expected income, so nothing is left to invest.
        </p>
      )}
    </figure>
  );
}
