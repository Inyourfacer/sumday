import { useEffect, useState } from "react";

/** A tiny History-API router: Sumday has a handful of pages, no need for a library. */

export const NAVIGATE_EVENT = "sumday:navigate";

export function navigate(to: string, { replace = false } = {}): void {
  if (replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
  window.scrollTo(0, 0);
}

export interface Location {
  path: string;
  search: string;
  query: URLSearchParams;
}

function readLocation(): Location {
  return { path: window.location.pathname, search: window.location.search, query: new URLSearchParams(window.location.search) };
}

export function useLocation(): Location {
  const [location, setLocation] = useState(readLocation);
  useEffect(() => {
    const update = () => setLocation(readLocation());
    window.addEventListener("popstate", update);
    window.addEventListener(NAVIGATE_EVENT, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(NAVIGATE_EVENT, update);
    };
  }, []);
  return location;
}

/** Match "/accounts/:id" against a path; returns params or null. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const part = p[i]!;
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(s[i]!);
    else if (part !== s[i]) return null;
  }
  return params;
}
