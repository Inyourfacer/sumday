import type { Fact } from "../shared/api.ts";
import { formatDate, formatMoney } from "./format.ts";

/** Show one of the numbers behind a recommendation. */
export function formatFact(f: Fact): string {
  switch (f.kind) {
    case "money":
      return formatMoney(Number(f.value), { cents: false });
    case "percent":
      return `${Math.round(Number(f.value) * 100) / 100}%`;
    case "months":
      return `${f.value} ${f.value === 1 ? "month" : "months"}`;
    case "date":
      return formatDate(String(f.value));
    default:
      return String(f.value);
  }
}
