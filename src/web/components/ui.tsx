import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { parseMoney } from "../../engine/money.ts";
import type { CategoryView } from "../../shared/api.ts";
import { BUDGET_TYPES, BUDGET_TYPE_LABELS } from "../../shared/schemas.ts";
import { formatMoney } from "../format.ts";

export function Amount({ cents, signed = false }: { cents: number; signed?: boolean }) {
  return <span className={`amount ${cents < 0 ? "neg" : cents > 0 ? "pos" : ""}`}>{formatMoney(cents, { signed })}</span>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="lede">{subtitle}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export function ErrorNote({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <div className="note error" role="alert">
      {message}
    </div>
  );
}

export function Field({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`field${wide ? " wide" : ""}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/**
 * Text box for money that stores cents. Accepts "$1,234.56", "-12", "(5.00)".
 * Shows an inline problem instead of silently dropping bad input.
 */
export function MoneyInput({
  value,
  onChange,
  allowNegative = false,
  placeholder = "$0.00",
  ariaLabel,
}: {
  value: number | null;
  onChange: (cents: number | null) => void;
  allowNegative?: boolean;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const toText = (v: number | null) => (v === null ? "" : formatMoney(v).replace("$", ""));
  const [text, setText] = useState(toText(value));
  const [problem, setProblem] = useState<string>();
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(toText(value));
  }, [value]);

  const handle = (next: string) => {
    setText(next);
    if (next.trim() === "") {
      setProblem(undefined);
      onChange(null);
      return;
    }
    try {
      const cents = parseMoney(next);
      if (!allowNegative && cents < 0) {
        setProblem("Can't be negative");
        return;
      }
      setProblem(undefined);
      onChange(cents);
    } catch {
      setProblem("Not an amount");
    }
  };

  return (
    <span className="money-input">
      <input
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={problem !== undefined}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          if (problem === undefined) setText(toText(value));
        }}
        onChange={(e) => handle(e.target.value)}
      />
      {problem && <span className="field-problem">{problem}</span>}
    </span>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  ariaLabel,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  ariaLabel?: string;
}) {
  return (
    <span className="number-input">
      <input
        type="number"
        value={value ?? ""}
        min={min}
        max={max}
        step={step}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
      {suffix && <span className="suffix">{suffix}</span>}
    </span>
  );
}

export function CategorySelect({
  categories,
  value,
  onChange,
  noneLabel = "Uncategorized",
  ariaLabel = "Category",
  disabled,
}: {
  categories: readonly CategoryView[];
  value: number | null;
  onChange: (id: number | null) => void;
  noneLabel?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <select
      className={`category-select${value === null ? " is-unset" : ""}`}
      aria-label={ariaLabel}
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
    >
      <option value="">{noneLabel}</option>
      {BUDGET_TYPES.map((type) => {
        const inType = categories.filter((c) => c.budgetType === type);
        if (inType.length === 0) return null;
        return (
          <optgroup key={type} label={BUDGET_TYPE_LABELS[type]}>
            {inType.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading() {
  return <p className="muted">Loading…</p>;
}
