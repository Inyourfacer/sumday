/**
 * Price providers. Sumday only needs one closing price per security per day.
 * The default is Tiingo (free API key in TIINGO_API_KEY); others can be added
 * behind the same interface.
 */
import type { IsoDate } from "../engine/dates.ts";

export interface Close {
  date: IsoDate;
  close: number;
}

export class PriceError extends Error {}

export interface PriceProvider {
  name: string;
  /** False when there's no API key: refreshes are skipped and manual prices still work. */
  configured: boolean;
  fetchCloses(ticker: string, from: IsoDate, to: IsoDate): Promise<Close[]>;
}

export function tiingoProvider(apiKey: string | undefined, fetchFn: typeof fetch = fetch): PriceProvider {
  return {
    name: "Tiingo",
    configured: Boolean(apiKey),
    async fetchCloses(ticker, from, to) {
      if (!apiKey) throw new PriceError("No Tiingo API key. Add TIINGO_API_KEY to your .env file.");
      // Tiingo writes share classes with a dash: BRK.B → BRK-B.
      const symbol = encodeURIComponent(ticker.replace(".", "-").toLowerCase());
      const url = `https://api.tiingo.com/tiingo/daily/${symbol}/prices?startDate=${from}&endDate=${to}`;
      let res: Response;
      try {
        res = await fetchFn(url, { headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" } });
      } catch (err) {
        throw new PriceError(`Couldn't reach Tiingo: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (res.status === 404) throw new PriceError(`Tiingo doesn't have prices for ${ticker}.`);
      if (res.status === 401 || res.status === 403) throw new PriceError("Tiingo rejected the API key. Check TIINGO_API_KEY.");
      if (res.status === 429) throw new PriceError("Tiingo's free-tier limit was reached. Prices will update on the next run.");
      if (!res.ok) throw new PriceError(`Tiingo returned an error (${res.status}).`);
      const body = (await res.json()) as { date: string; close: number }[] | { detail?: string };
      if (!Array.isArray(body)) throw new PriceError(body.detail ?? `Unexpected reply from Tiingo for ${ticker}.`);
      return body
        .filter((r) => typeof r.close === "number" && typeof r.date === "string")
        .map((r) => ({ date: r.date.slice(0, 10), close: r.close }));
    },
  };
}
