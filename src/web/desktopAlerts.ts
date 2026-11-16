import { useEffect } from "react";
import type { AlertsResponse } from "../shared/api.ts";
import { api } from "./api.ts";

const NOTIFIED = "sumday.notifiedAlerts";
const EVERY = 15 * 60 * 1000;

function notified(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(NOTIFIED) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/**
 * While Sumday is open, show new alerts as desktop notifications (if turned on
 * in Settings → Alerts and the browser allows it). Each alert notifies once.
 */
export function useDesktopAlerts(): void {
  useEffect(() => {
    if (typeof Notification === "undefined") return;
    let stopped = false;
    const check = async () => {
      if (Notification.permission !== "granted") return;
      try {
        const r = await api<AlertsResponse>("GET", "/api/alerts");
        if (stopped || !r.settings.desktop) return;
        const seen = notified();
        for (const a of r.alerts.filter((x) => !seen.has(x.key)).slice(0, 3)) {
          const n = new Notification(`Sumday: ${a.title}`, { body: a.message, tag: a.key });
          n.onclick = () => {
            window.focus();
            if (a.link) window.location.assign(a.link);
          };
        }
        const keep = [...new Set([...r.alerts.map((a) => a.key), ...seen])].slice(0, 500);
        try {
          localStorage.setItem(NOTIFIED, JSON.stringify(keep));
        } catch {
          // Private windows: notifications may repeat, which is fine.
        }
      } catch {
        // Server not reachable; try again later.
      }
    };
    const first = setTimeout(() => void check(), 3_000);
    const timer = setInterval(() => void check(), EVERY);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);
}
