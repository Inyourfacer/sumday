/**
 * Alerts (DESIGN §9): rule checks run against the current data. Each alert
 * has a stable key, so dismissing it hides it until the situation changes
 * (a new month, a new bill amount, a new transaction).
 */
import type { FastifyInstance } from "fastify";
import { monthOf } from "../engine/budget/budget.ts";
import { addDays, daysBetween } from "../engine/dates.ts";
import { allocation, drift } from "../engine/invest/portfolio.ts";
import type { AlertKind, AlertSettings, AlertView, AlertsResponse } from "../shared/api.ts";
import { alertDismissSchema, alertSettingsSchema } from "../shared/schemas.ts";
import { listAccounts } from "./accounts.ts";
import { budgetFor, recurring, today } from "./budget.ts";
import { getSetting, setSetting, type Db } from "./db.ts";
import { getTarget, loadHoldings, toPositions, PORTFOLIO_TYPES } from "./holdings.ts";
import { parse } from "./http.ts";
import { goalsWithPlan } from "./plan.ts";

export const ALERT_DEFAULTS: AlertSettings = {
  flexPacePct: 15,
  billChangePct: 10,
  largeAmount: 50_000,
  largeMultiple: 3,
  lowCash: 50_000,
  promoDays: 90,
  staleDays: 14,
  disabled: [],
  desktop: false,
};

export function getAlertSettings(db: Db): AlertSettings {
  return { ...ALERT_DEFAULTS, ...getSetting<Partial<AlertSettings>>(db, "alerts") };
}

const usd = (c: number) => `$${Math.round(Math.abs(c) / 100).toLocaleString("en-US")}`;

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/** Every alert that applies right now, dismissed or not. */
export function computeAlerts(db: Db, settings = getAlertSettings(db)): AlertView[] {
  const now = today(db);
  const month = monthOf(now);
  const out: AlertView[] = [];
  const accounts = listAccounts(db).filter((a) => !a.isClosed);
  const transferCategory = (db.prepare("SELECT id FROM categories WHERE budget_type = 'transfer' LIMIT 1").get() as { id: number } | undefined)?.id ?? -1;

  // Over budget, or spending Flex money faster than the month allows.
  const { flex, daysLeft } = budgetFor(db, month).budget;
  if (flex.budget !== null && flex.actual > flex.budget) {
    out.push({
      key: `over_budget:${month}`,
      kind: "over_budget",
      severity: "warning",
      title: "Flex spending is over budget",
      message: `You've spent ${usd(flex.actual)} of the ${usd(flex.budget)} Flex budget this month.`,
      facts: [
        { label: "Spent", value: flex.actual, kind: "money" },
        { label: "Budget", value: flex.budget, kind: "money" },
      ],
      link: "/budget",
    });
  } else if (flex.budget !== null && flex.pace && flex.pace.expectedByNow > 0 && flex.actual > flex.pace.expectedByNow * (1 + settings.flexPacePct / 100)) {
    out.push({
      key: `flex_pace:${month}`,
      kind: "over_budget",
      severity: "info",
      title: "Flex spending is running ahead",
      message: `${usd(flex.actual)} spent so far against about ${usd(flex.pace.expectedByNow)} expected by today. ${usd(Math.max(0, flex.pace.perDayLeft))} a day keeps you on budget${daysLeft ? ` for the last ${daysLeft} days` : ""}.`,
      facts: [
        { label: "Spent", value: flex.actual, kind: "money" },
        { label: "Expected by now", value: flex.pace.expectedByNow, kind: "money" },
      ],
      link: "/budget",
    });
  }

  // Bills that changed, and new recurring charges.
  const rec = recurring(db);
  const amountOf = db.prepare("SELECT amount FROM transactions WHERE id = ?");
  for (const s of rec.series) {
    if (s.ignored || s.isTransfer || !s.active || s.direction !== "out") continue;
    const amounts = s.transactionIds.map((id) => (amountOf.get(id) as { amount: number } | undefined)?.amount ?? 0);
    const recent = daysBetween(s.lastDate, now) <= 45;
    if (recent && amounts.length >= 3) {
      const last = amounts.at(-1)!;
      const before = amounts.slice(0, -1);
      const usual = median(before);
      // Bills that always swing (utilities) aren't flagged; a steady bill that jumps is.
      const steady = before.every((a) => Math.abs(a - usual) <= Math.abs(usual) * 0.1);
      if (steady && usual !== 0 && Math.abs(last - usual) / Math.abs(usual) > settings.billChangePct / 100) {
        const up = Math.abs(last) > Math.abs(usual);
        out.push({
          key: `bill_changed:${s.key}:${s.lastDate}`,
          kind: "bill_changed",
          severity: up ? "warning" : "info",
          title: `${s.payee} ${up ? "went up" : "went down"}`,
          message: `The ${s.lastDate} charge was ${usd(last)}, against a usual ${usd(usual)}.`,
          facts: [
            { label: "Latest", value: Math.abs(last), kind: "money" },
            { label: "Usual", value: Math.abs(usual), kind: "money" },
          ],
          link: "/recurring",
        });
      }
    }
    const fresh = s.frequency === "yearly" ? s.occurrences <= 2 : ["monthly", "quarterly"].includes(s.frequency) && s.occurrences <= 3;
    if (fresh && recent) {
      out.push({
        key: `new_recurring:${s.key}`,
        kind: "new_subscription",
        severity: "info",
        title: `New ${s.frequency} charge: ${s.payee}`,
        message: `${usd(s.amount)} from ${s.accountName}, next expected ${s.nextDate}. Ignore it on Recurring if it isn't a subscription.`,
        facts: [{ label: "Amount", value: Math.abs(s.amount), kind: "money" }],
        link: "/recurring",
      });
    }
  }

  // Large transactions in the last 30 days.
  const recentTx = db
    .prepare(
      `SELECT t.id, t.date, t.amount, t.payee, t.category_id AS categoryId, a.name AS accountName
       FROM transactions t JOIN accounts a ON a.id = t.account_id
       WHERE t.status = 'posted' AND t.amount < 0 AND t.date >= ? AND t.transfer_id IS NULL
         AND (t.category_id IS NULL OR t.category_id != ?)
       ORDER BY t.amount`,
    )
    .all(addDays(now, -30), transferCategory) as { id: number; date: string; amount: number; payee: string; categoryId: number | null; accountName: string }[];
  const typical = new Map<number, number | null>();
  const history = db.prepare("SELECT -amount AS a FROM transactions WHERE status = 'posted' AND category_id = ? AND amount < 0 AND date >= ? AND date < ?");
  const typicalFor = (categoryId: number): number | null => {
    if (!typical.has(categoryId)) {
      const values = (history.all(categoryId, addDays(now, -365), addDays(now, -30)) as { a: number }[]).map((r) => r.a);
      typical.set(categoryId, values.length >= 5 ? median(values) : null);
    }
    return typical.get(categoryId)!;
  };
  // Regular bills (rent, a car payment) are expected, however large.
  const regular = new Set(rec.series.filter((x) => x.active && !x.ignored).flatMap((x) => x.transactionIds));
  let large = 0;
  for (const t of recentTx) {
    if (regular.has(t.id)) continue;
    const amount = -t.amount;
    const usual = t.categoryId === null ? null : typicalFor(t.categoryId);
    const byMultiple = usual !== null && amount >= 10_000 && amount > usual * settings.largeMultiple;
    if (amount < settings.largeAmount && !byMultiple) continue;
    if (++large > 5) break;
    out.push({
      key: `large:${t.id}`,
      kind: "large_transaction",
      severity: "info",
      title: `Large charge: ${t.payee} ${usd(amount)}`,
      message: `On ${t.date} from ${t.accountName}.${byMultiple ? ` That's ${Math.round((amount / usual!) * 10) / 10}× the usual ${usd(usual!)} for this category.` : ""}`,
      facts: [{ label: "Amount", value: amount, kind: "money" }],
      link: "/transactions",
    });
  }

  // Checking projected below the floor before the next paycheck.
  const checking = accounts.filter((a) => a.type === "checking");
  if (checking.length > 0) {
    const ids = new Set(checking.map((a) => a.id));
    const items = rec.upcoming.filter((u) => ids.has(u.accountId)).sort((a, b) => (a.date < b.date ? -1 : 1));
    const payday = items.find((u) => u.amount > 0)?.date ?? addDays(now, 30);
    let balance = checking.reduce((s, a) => s + a.balance, 0);
    let low = balance;
    let lowDate = now;
    for (const u of items) {
      if (u.date >= payday) break;
      balance += u.amount;
      if (balance < low) [low, lowDate] = [balance, u.date];
    }
    if (low < settings.lowCash) {
      out.push({
        key: `low_cash:${payday}`,
        kind: "low_cash",
        severity: "warning",
        title: "Checking may run low before payday",
        message: `Expected bills take checking to about ${low < 0 ? "-" : ""}${usd(low)} by ${lowDate}, before the next deposit on ${payday}.`,
        facts: [
          { label: "Lowest point", value: low, kind: "money" },
          { label: "Your floor", value: settings.lowCash, kind: "money" },
        ],
        link: "/recurring",
      });
    }
  }

  // Allocation drift.
  const positions = toPositions(loadHoldings(db).filter((h) => accounts.some((a) => a.id === h.account_id && PORTFOLIO_TYPES.includes(a.type))));
  if (positions.length > 0) {
    const d = drift(allocation(positions), getTarget(db).target);
    if (d.outOfBand) {
      const off = d.rows.filter((r) => r.status !== "in");
      out.push({
        key: `drift:${month}:${off.map((r) => r.assetClass).join(",")}`,
        kind: "drift",
        severity: "info",
        title: "Investments have drifted from your target mix",
        message: off.map((r) => `${r.assetClass.replace("_", " ")} ${Math.round(r.current * 100)}% (target ${Math.round(r.target * 100)}%)`).join("; ") + ".",
        facts: off.map((r) => ({ label: r.assetClass, value: Math.round(r.drift * 1000) / 10, kind: "percent" as const })),
        link: "/investments",
      });
    }
  }

  // Intro rates ending.
  for (const a of accounts.filter((x) => x.promoEnds && x.promoEnds >= now && x.promoEnds <= addDays(now, settings.promoDays) && x.balance < 0)) {
    out.push({
      key: `promo:${a.id}:${a.promoEnds}`,
      kind: "promo_ending",
      severity: "warning",
      title: `${a.name}'s intro rate ends ${a.promoEnds}`,
      message: `${usd(a.balance)} goes from ${a.promoRatePct ?? 0}% to ${a.interestRatePct ?? "the standard"}${a.interestRatePct !== null ? "%" : " rate"} in ${daysBetween(now, a.promoEnds!)} days.`,
      facts: [{ label: "Balance", value: -a.balance, kind: "money" }],
      link: "/debt",
    });
  }

  // Goals that won't make their date at the planned pace.
  for (const g of goalsWithPlan(db)) {
    const p = g.progress;
    const behind = p.status === "overdue" || (p.status === "in_progress" && p.requiredMonthly !== null && p.requiredMonthly > g.plannedMonthly * 1.05 + 100);
    if (!behind) continue;
    out.push({
      key: `goal_behind:${g.id}:${month}`,
      kind: "goal_behind",
      severity: "info",
      title: p.status === "overdue" ? `${g.name} is past its date` : `${g.name} is behind`,
      message:
        p.status === "overdue"
          ? `${usd(p.remaining)} still to go after ${g.targetDate}. Pick a new date or a bigger monthly amount.`
          : `Reaching ${usd(p.target)} by ${g.targetDate} takes ${usd(p.requiredMonthly!)} a month; the plan puts ${usd(g.plannedMonthly)} toward it.`,
      facts: [
        { label: "Remaining", value: p.remaining, kind: "money" },
        ...(p.requiredMonthly !== null ? [{ label: "Needed per month", value: p.requiredMonthly, kind: "money" as const }] : []),
      ],
      link: "/goals",
    });
  }

  // Stale data: accounts that haven't been updated in a while.
  const lastUpdate = db.prepare(
    `SELECT MAX(d) AS d FROM (
       SELECT substr(committed_at, 1, 10) AS d FROM import_batches WHERE account_id = ? AND status = 'committed'
       UNION ALL SELECT MAX(date) FROM balance_snapshots WHERE account_id = ?
       UNION ALL SELECT MAX(substr(created_at, 1, 10)) FROM transactions WHERE account_id = ? AND import_batch_id IS NULL)`,
  );
  for (const a of accounts) {
    const last = (lastUpdate.get(a.id, a.id, a.id) as { d: string | null }).d;
    if (last === null) continue;
    const age = daysBetween(last, now);
    if (age < settings.staleDays) continue;
    out.push({
      key: `stale:${a.id}:${last}`,
      kind: "stale_data",
      severity: "info",
      title: `${a.name} hasn't been updated in ${age} days`,
      message: `Last update ${last}. Import a new statement or enter the balance so plans use current numbers.`,
      facts: [{ label: "Days", value: String(age), kind: "text" }],
      link: "/import",
    });
  }

  const off = new Set<AlertKind>(settings.disabled);
  return out.filter((a) => !off.has(a.kind));
}

export function alertsView(db: Db): AlertsResponse {
  const all = computeAlerts(db);
  const dismissed = new Set((db.prepare("SELECT key FROM alert_dismissals").all() as { key: string }[]).map((r) => r.key));
  return {
    alerts: all.filter((a) => !dismissed.has(a.key)),
    dismissedCount: all.filter((a) => dismissed.has(a.key)).length,
    settings: getAlertSettings(db),
  };
}

export function registerAlertRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/alerts", async () => alertsView(db));

  app.post("/api/alerts/dismiss", async (request) => {
    const { key } = parse(alertDismissSchema, request.body);
    db.prepare("INSERT OR REPLACE INTO alert_dismissals (key) VALUES (?)").run(key);
    // Old dismissals point at alerts that can't come back.
    db.prepare("DELETE FROM alert_dismissals WHERE dismissed_at < ?").run(addDays(today(db), -400));
    return alertsView(db);
  });

  app.post("/api/alerts/restore", async () => {
    db.prepare("DELETE FROM alert_dismissals").run();
    return alertsView(db);
  });

  app.put("/api/alerts/settings", async (request) => {
    const patch = parse(alertSettingsSchema, request.body);
    setSetting(db, "alerts", { ...getAlertSettings(db), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
    return alertsView(db);
  });
}

