/**
 * Asset classes and what each fund holds. A security has a "mix": the share
 * of its value in each class (a total-market fund is 100% US stock; a global
 * fund is split). Common funds are recognized by ticker; others are guessed
 * from their name and marked as guesses so the user can confirm them.
 */
export const ASSET_CLASSES = ["us_stock", "intl_stock", "bonds", "cash", "real_estate", "other"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  us_stock: "US stocks",
  intl_stock: "International stocks",
  bonds: "Bonds",
  cash: "Cash",
  real_estate: "Real estate",
  other: "Other",
};

/** Fractions per class, adding up to 1. */
export type AssetMix = Partial<Record<AssetClass, number>>;

const one = (c: AssetClass): AssetMix => ({ [c]: 1 });

// Broad index funds and money markets whose asset class is unambiguous.
const KNOWN: Record<string, AssetMix> = {};
const add = (mix: AssetMix, tickers: string) => {
  for (const t of tickers.split(/\s+/)) KNOWN[t] = mix;
};
add(one("us_stock"), "VTI VOO IVV SPY ITOT SCHB SCHX VV VTSAX VFIAX FXAIX FSKAX SWPPX SWTSX FZROX VTV VUG VB VO SCHD QQQ VIG IWM VXF VEXAX FSMDX VIGAX VTCLX");
add(one("intl_stock"), "VXUS VEA VWO IXUS IEFA IEMG SCHF SCHE VTIAX FTIHX FZILX SWISX VTMGX VFWAX VEMAX FSPSX");
add(one("bonds"), "BND AGG SCHZ VBTLX FXNAX SWAGX BNDX VGIT VGSH TLT IEF SHY VTIP SCHP TIP BIV BSV VCIT MUB FBNDX VBMFX VTABX");
add(one("cash"), "SPAXX FDRXX VMFXX SWVXX FZFXX VUSXX SGOV BIL CORE");
add(one("real_estate"), "VNQ VNQI SCHH FREL VGSLX USRT");
// Global stock funds: roughly 60% US / 40% international (the split drifts; edit if needed).
add({ us_stock: 0.6, intl_stock: 0.4 }, "VT VTWAX ACWI");

export interface MixGuess {
  mix: AssetMix;
  source: "known" | "guessed";
}

/** The mix for a ticker or fund name, if it can be recognized. */
export function defaultMix(ticker: string | null, name: string): MixGuess | undefined {
  if (ticker && KNOWN[ticker.toUpperCase()]) return { mix: KNOWN[ticker.toUpperCase()]!, source: "known" };
  const n = name.toLowerCase();
  if (/money market|cash|sweep|core position|government cash|treasury money/.test(n)) return { mix: one("cash"), source: "guessed" };
  if (/target|retirement 20\d\d|lifecycle|balanced|allocation|wellington|lifestrategy/.test(n)) return undefined; // blended: ask
  // Stable value funds (common in 401(k)s) behave like short-term bonds.
  if (/stable value|guaranteed|fixed account/.test(n)) return { mix: one("bonds"), source: "guessed" };
  if (/reit|real estate/.test(n)) return { mix: one("real_estate"), source: "guessed" };
  if (/bond|treasury|income|fixed|aggregate|tips|municipal/.test(n)) return { mix: one("bonds"), source: "guessed" };
  if (/international|intl|developed|emerging|ex[- ]us|world ex|foreign|europe|pacific/.test(n)) return { mix: one("intl_stock"), source: "guessed" };
  if (/total world|global|all[- ]world/.test(n)) return { mix: { us_stock: 0.6, intl_stock: 0.4 }, source: "guessed" };
  if (/s&p|500|total (stock )?market|large cap|mid cap|small cap|growth|value|dividend|index|nasdaq|russell|stock/.test(n)) {
    return { mix: one("us_stock"), source: "guessed" };
  }
  return undefined;
}

/** Check a mix: known classes, no negatives, adds up to 1 (±0.001). */
export function validateMix(mix: AssetMix): string | undefined {
  let total = 0;
  for (const [k, v] of Object.entries(mix)) {
    if (!(ASSET_CLASSES as readonly string[]).includes(k)) return `Unknown asset class "${k}".`;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return "Shares must be zero or more.";
    total += v;
  }
  if (Math.abs(total - 1) > 0.001) return `The mix adds up to ${Math.round(total * 1000) / 10}%, not 100%.`;
  return undefined;
}

/** The class a security mostly is (≥ 90%), if any. */
export function dominantClass(mix: AssetMix | null): AssetClass | null {
  if (!mix) return null;
  for (const c of ASSET_CLASSES) if ((mix[c] ?? 0) >= 0.9) return c;
  return null;
}
