import { useCallback, useEffect, type ReactNode } from "react";
import type { HealthResponse, SummaryResponse } from "../shared/api.ts";
import { useApi, useDataChanged } from "./api.ts";
import { AccountDetailPage, AccountsPage } from "./pages/Accounts.tsx";
import { BudgetPage } from "./pages/Budget.tsx";
import { DebtPage } from "./pages/Debt.tsx";
import { GoalsPage } from "./pages/Goals.tsx";
import { HoldingsImportPage } from "./pages/HoldingsImport.tsx";
import { InvestmentsPage } from "./pages/Investments.tsx";
import { RetirementPage } from "./pages/Retirement.tsx";
import { ScenariosPage } from "./pages/Scenarios.tsx";
import { ReportPage, ReportsPage } from "./pages/Reports.tsx";
import { SettingsAlertsPage } from "./pages/SettingsAlerts.tsx";
import { SettingsDataPage } from "./pages/SettingsData.tsx";
import { useDesktopAlerts } from "./desktopAlerts.ts";
import { PlanPage } from "./pages/Plan.tsx";
import { CashFlowPage } from "./pages/CashFlow.tsx";
import { RecurringPage } from "./pages/Recurring.tsx";
import { CategoriesPage } from "./pages/Categories.tsx";
import { DashboardPage } from "./pages/Dashboard.tsx";
import { ImportPage } from "./pages/Import.tsx";
import { ImportReviewPage } from "./pages/ImportReview.tsx";
import { RulesPage } from "./pages/Rules.tsx";
import { SettingsHouseholdPage } from "./pages/SettingsHousehold.tsx";
import { SetupPage } from "./pages/Setup.tsx";
import { TransactionsPage } from "./pages/Transactions.tsx";
import { Link } from "./router.tsx";
import { matchPath, navigate, useLocation } from "./navigation.ts";

interface NavItem {
  to: string;
  label: string;
  phase?: number;
  badge?: number;
}

function NavLink({ item, path }: { item: NavItem; path: string }) {
  if (item.phase !== undefined) {
    return (
      <span className="soon" title={`Coming in Phase ${item.phase}`}>
        {item.label}
        <small>P{item.phase}</small>
      </span>
    );
  }
  const active = item.to === "/" ? path === "/" : path === item.to || path.startsWith(`${item.to}/`);
  return (
    <Link to={item.to} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>
      {item.label}
      {item.badge ? <span className="count">{item.badge}</span> : null}
    </Link>
  );
}

function route(path: string, summary: SummaryResponse | undefined): ReactNode {
  let m: Record<string, string> | null;
  if (path === "/") return <DashboardPage summary={summary} />;
  if (path === "/setup") return <SetupPage />;
  if (path === "/accounts") return <AccountsPage />;
  if ((m = matchPath("/accounts/:id", path))) return <AccountDetailPage key={m.id} id={Number(m.id)} />;
  if (path === "/transactions") return <TransactionsPage />;
  if (path === "/budget") return <BudgetPage />;
  if (path === "/plan") return <PlanPage />;
  if (path === "/goals") return <GoalsPage />;
  if (path === "/debt") return <DebtPage />;
  if (path === "/investments") return <InvestmentsPage />;
  if (path === "/retirement") return <RetirementPage />;
  if (path === "/investments/import") return <HoldingsImportPage />;
  if (path === "/scenarios") return <ScenariosPage />;
  if (path === "/reports") return <ReportsPage />;
  if ((m = matchPath("/reports/:month", path))) return <ReportPage key={m.month} month={m.month!} />;
  if (path === "/settings/alerts") return <SettingsAlertsPage />;
  if (path === "/settings/data") return <SettingsDataPage />;
  if (path === "/cashflow") return <CashFlowPage />;
  if (path === "/recurring") return <RecurringPage />;
  if (path === "/import") return <ImportPage />;
  if ((m = matchPath("/import/:id", path))) return <ImportReviewPage key={m.id} id={Number(m.id)} />;
  if (path === "/settings/household") return <SettingsHouseholdPage />;
  if (path === "/settings/categories") return <CategoriesPage />;
  if (path === "/settings/rules") return <RulesPage />;
  return (
    <div className="empty">
      <h1>Page not found</h1>
      <Link to="/">Back to the dashboard</Link>
    </div>
  );
}

export function App() {
  const { path } = useLocation();
  const health = useApi<HealthResponse>("/api/health");
  const summary = useApi<SummaryResponse>("/api/summary");
  const { reload: refetchSummary } = summary;
  const reloadSummary = useCallback(() => void refetchSummary(), [refetchSummary]);
  useDataChanged(reloadSummary);
  useDesktopAlerts();

  // First run: send people to the setup wizard (they can skip it).
  useEffect(() => {
    if (path === "/" && summary.data && !summary.data.setupComplete && summary.data.accountCount === 0) {
      navigate("/setup", { replace: true });
    }
  }, [path, summary.data]);

  const s = summary.data;
  const main: NavItem[] = [
    { to: "/", label: "Dashboard" },
    { to: "/plan", label: "Next best moves" },
    { to: "/accounts", label: "Accounts" },
    { to: "/transactions", label: "Transactions", badge: s?.uncategorizedCount },
    { to: "/import", label: "Import", badge: s?.stagedImportCount },
    { to: "/budget", label: "Budget" },
    { to: "/cashflow", label: "Cash flow" },
    { to: "/recurring", label: "Recurring" },
    { to: "/goals", label: "Goals" },
    { to: "/debt", label: "Debt" },
    { to: "/investments", label: "Investments" },
    { to: "/retirement", label: "Retirement" },
    { to: "/scenarios", label: "Scenarios" },
    { to: "/reports", label: "Reports" },
  ];
  const settings: NavItem[] = [
    { to: "/settings/household", label: "Household" },
    { to: "/settings/categories", label: "Categories" },
    { to: "/settings/rules", label: "Rules" },
    { to: "/settings/alerts", label: "Alerts" },
    { to: "/settings/data", label: "Backups & export" },
  ];

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link to="/" className="brand">
          Sum<span>day</span>
        </Link>
        <nav aria-label="Sections">
          {main.map((item) => (
            <NavLink key={item.to} item={item} path={path} />
          ))}
          <span className="nav-heading">Settings</span>
          {settings.map((item) => (
            <NavLink key={item.to} item={item} path={path} />
          ))}
        </nav>
        <footer className="status" role="status">
          {health.data && (
            <>
              <span className="dot ok" aria-hidden /> v{health.data.version} · schema v{health.data.schemaVersion}
            </>
          )}
          {health.error && (
            <>
              <span className="dot err" aria-hidden /> Server not reachable. Is <code>npm start</code> running?
            </>
          )}
        </footer>
      </aside>
      <main>{route(path, s)}</main>
    </div>
  );
}
