import { useCallback, useEffect, useState } from "react";
import type { ApiError, TransactionUpdateResult, TransactionView } from "../shared/api.ts";

export class RequestError extends Error {
  readonly status: number;
  readonly issues: ApiError["issues"];
  constructor(status: number, body: ApiError) {
    super(body.error);
    this.status = status;
    this.issues = body.issues;
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) throw new RequestError(res.status, (data as ApiError) ?? { error: `Request failed (${res.status})` });
  return data as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof RequestError && err.issues && err.issues.length > 1) {
    return err.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join(" · ");
  }
  return err instanceof Error ? err.message : String(err);
}

export interface Loaded<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => Promise<void>;
}

interface Fetched<T> {
  /** The path these results are for. */
  path: string | null;
  data: T | undefined;
  error: string | undefined;
}

/**
 * GET a path and keep the result; `reload` refetches. A null path skips
 * loading. While a new path loads, the previous data stays visible.
 */
export function useApi<T>(path: string | null): Loaded<T> {
  const [state, setState] = useState<Fetched<T>>({ path: null, data: undefined, error: undefined });

  const load = useCallback(
    async (isCurrent: () => boolean = () => true) => {
      if (path === null) return;
      try {
        const data = await api<T>("GET", path);
        if (isCurrent()) setState({ path, data, error: undefined });
      } catch (err) {
        if (isCurrent()) setState((prev) => ({ path, data: prev.data, error: errorMessage(err) }));
      }
    },
    [path],
  );

  useEffect(() => {
    let current = true;
    // State is only set after the request resolves, not synchronously.
    // oxlint-disable-next-line react/set-state-in-effect
    void load(() => current);
    return () => {
      current = false;
    };
  }, [load]);

  const reload = useCallback(() => load(), [load]);
  return { data: state.data, error: state.error, loading: path !== null && state.path !== path, reload };
}

/** App-wide "something changed" signal, so the sidebar badges refresh. */
const listeners = new Set<() => void>();
export function notifyDataChanged(): void {
  for (const fn of listeners) fn();
}
export function useDataChanged(fn: () => void): void {
  useEffect(() => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, [fn]);
}

/** Change a transaction's category, returning any rule suggestion from the server. */
export async function changeCategory(txn: TransactionView, categoryId: number | null): Promise<TransactionUpdateResult> {
  const result = await api<TransactionUpdateResult>("PATCH", `/api/transactions/${txn.id}`, { categoryId });
  notifyDataChanged();
  return result;
}
