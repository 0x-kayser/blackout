/**
 * Oil reference data for display (World Events panel). The GAME always uses the bundled, cached
 * dataset so replays stay deterministic; this endpoint only shows the latest observation.
 *
 * Live source (optional): U.S. EIA Open Data API v2, Brent spot (series RBRTE), daily, USD/bbl.
 * Requires a free key (EIA_API_KEY). EIA asks clients to throttle; we cache for 6 hours.
 * Fallback: the cached dataset (EIA via FRED, DCOILBRENTEU) with a freshness label. Never invents a quote.
 */
import { BRENT_DATASET } from "@blackout/sim";

export const EIA_BRENT_URL = "https://api.eia.gov/v2/petroleum/pri/spt/data/";
const CACHE_MS = 6 * 3_600_000;
let cache: { at: number; value: OilSnapshot } | null = null;

export interface OilSnapshot {
  source: "eia_live" | "cached_dataset";
  asOf: string;
  latest: { date: string; usdPerBarrel: number };
  freshness: string;
  attribution: string;
  sourceUrl: string;
}

/** Parses an EIA v2 response. Defensive: only accepts rows with an ISO date and a positive number. */
export function parseEiaBrent(json: unknown): { date: string; usdPerBarrel: number } | null {
  const rows = (json as { response?: { data?: Record<string, unknown>[] } })?.response?.data;
  if (!Array.isArray(rows)) return null;
  for (const r of rows) {
    const date = typeof r.period === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.period) ? r.period : null;
    const raw = r.value ?? r.price;
    const v = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (date && Number.isFinite(v) && v > 0 && v < 1_000) return { date, usdPerBarrel: v };
  }
  return null;
}

export function cachedSnapshot(now = new Date()): OilSnapshot {
  const daily = (BRENT_DATASET as unknown as { daily: { date: string; usdPerBarrel: number }[] }).daily;
  const last = daily[daily.length - 1];
  const ageDays = Math.floor((now.getTime() - Date.parse(last.date)) / 86_400_000);
  return {
    source: "cached_dataset",
    asOf: BRENT_DATASET.retrieved,
    latest: last,
    freshness: `Cached data: last observation ${last.date} (${ageDays} days old). Live refresh ${process.env.EIA_API_KEY ? "temporarily unavailable" : "not configured"}.`,
    attribution: BRENT_DATASET.source,
    sourceUrl: BRENT_DATASET.sourceUrl,
  };
}

export async function oilSnapshot(fetchImpl: typeof fetch = fetch, key = process.env.EIA_API_KEY, now = Date.now()): Promise<OilSnapshot> {
  if (!key) return cachedSnapshot(new Date(now));
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  try {
    const qs = new URLSearchParams({ api_key: key, frequency: "daily", "data[0]": "value", "facets[series][]": "RBRTE", "sort[0][column]": "period", "sort[0][direction]": "desc", length: "5" });
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8_000);
    const res = await fetchImpl(`${EIA_BRENT_URL}?${qs}`, { signal: ctl.signal });
    clearTimeout(t);
    const latest = res.ok ? parseEiaBrent(await res.json()) : null;
    if (!latest) return cachedSnapshot(new Date(now));
    const value: OilSnapshot = {
      source: "eia_live",
      asOf: new Date(now).toISOString(),
      latest,
      freshness: `EIA daily Brent spot; latest published observation ${latest.date} (EIA publishes with a lag of a few days).`,
      attribution: "U.S. Energy Information Administration (EIA), Open Data API v2",
      sourceUrl: "https://www.eia.gov/dnav/pet/hist/RBRTED.htm",
    };
    cache = { at: now, value };
    return value;
  } catch {
    return cachedSnapshot(new Date(now));
  }
}

export const _resetOilCache = () => {
  cache = null;
};
