/**
 * Real-world inputs (§10). One adapter, one normalised snapshot:
 *   weather  — Open-Meteo current conditions (free, no key) at WORLD_LAT/WORLD_LON (default: Houston, a gas-and-heat grid)
 *   Brent    — U.S. EIA (EIA_API_KEY) via oil.ts, else the bundled EIA/FRED dataset
 *   gas      — U.S. EIA Henry Hub spot (EIA_API_KEY), else a labelled reference value
 *   carbon   — a labelled reference value (no free live carbon API); set WORLD_CARBON_USD to override
 * Every successful live snapshot is persisted; on failure the last persisted one is used (source "fallback"), and
 * before any success the bundled default (source "fixture"). Inputs never invent a quote: each field says where it came from.
 */
import { region } from "@blackout/sim";
import type { WorldSnapshot } from "@blackout/shared";
import { WorldSnapshotSchema } from "@blackout/shared";
import type { Db } from "./db.ts";
import { nowIso } from "./db.ts";
import { oilSnapshot } from "./oil.ts";

export interface WorldInputProvider {
  getSnapshot(): Promise<WorldSnapshot>;
  /** Last snapshot without fetching. */
  current(): WorldSnapshot;
}

const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
const EIA_GAS = "https://api.eia.gov/v2/natural-gas/pri/fut/data/";
const REFERENCE_GAS_USD = 3.6;
const REFERENCE_CARBON_USD = 32;

export class LiveWorldInputs implements WorldInputProvider {
  private last: WorldSnapshot;
  private lastFetch = 0;
  constructor(
    private readonly db: Db,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly opts: { enabled: boolean; refreshMs?: number; lat?: number; lon?: number; eiaKey?: string } = { enabled: true },
  ) {
    const row = db.prepare("SELECT snapshot_json FROM world_snapshots ORDER BY id DESC LIMIT 1").get() as { snapshot_json: string } | undefined;
    const parsed = row ? WorldSnapshotSchema.safeParse(JSON.parse(row.snapshot_json)) : null;
    this.last = parsed?.success ? { ...(parsed.data as WorldSnapshot), source: "fallback" } : region.regionConfig.DEFAULT_SNAPSHOT;
  }

  current(): WorldSnapshot {
    return this.last;
  }

  async getSnapshot(): Promise<WorldSnapshot> {
    const refresh = this.opts.refreshMs ?? 30 * 60_000;
    if (!this.opts.enabled || Date.now() - this.lastFetch < refresh) return this.last;
    this.lastFetch = Date.now();
    const lat = this.opts.lat ?? Number(process.env.WORLD_LAT ?? 29.76);
    const lon = this.opts.lon ?? Number(process.env.WORLD_LON ?? -95.37);
    const sources: WorldSnapshot["sources"] = [];
    const at = nowIso();
    let weather: { tempC: number; cloudPct: number; windKph: number } | null = null;
    try {
      const url = `${OPEN_METEO}?latitude=${lat}&longitude=${lon}&current=temperature_2m,cloud_cover,wind_speed_10m`;
      const res = await this.timed(url);
      const j = (await res.json()) as { current?: { temperature_2m?: number; cloud_cover?: number; wind_speed_10m?: number; time?: string } };
      const c = j.current;
      if (res.ok && c && Number.isFinite(c.temperature_2m) && Number.isFinite(c.cloud_cover)) {
        weather = { tempC: c.temperature_2m!, cloudPct: c.cloud_cover!, windKph: c.wind_speed_10m ?? 10 };
        sources.push({ field: "weather", provider: `Open-Meteo (${lat.toFixed(2)}, ${lon.toFixed(2)})`, url: "https://open-meteo.com/", observedAt: c.time ?? at });
      }
    } catch {
      /* fall through to the last snapshot's weather */
    }
    let brent = this.last.brentUsdPerBbl;
    try {
      const o = await oilSnapshot(this.fetchImpl);
      brent = o.latest.usdPerBarrel;
      sources.push({ field: "brent", provider: o.source === "eia_live" ? "U.S. EIA (live)" : "EIA via FRED (bundled dataset)", url: o.sourceUrl, observedAt: o.latest.date });
    } catch {
      /* keep last */
    }
    let gas = REFERENCE_GAS_USD;
    const key = this.opts.eiaKey ?? process.env.EIA_API_KEY;
    if (key) {
      try {
        const qs = new URLSearchParams({ api_key: key, frequency: "daily", "data[0]": "value", "facets[series][]": "RNGWHHD", "sort[0][column]": "period", "sort[0][direction]": "desc", length: "3" });
        const res = await this.timed(`${EIA_GAS}?${qs}`);
        const rows = ((await res.json()) as { response?: { data?: { period?: string; value?: unknown }[] } }).response?.data ?? [];
        const r = rows.find((x) => Number(x.value) > 0);
        if (res.ok && r) {
          gas = Number(r.value);
          sources.push({ field: "gas", provider: "U.S. EIA Henry Hub spot (live)", url: "https://www.eia.gov/dnav/ng/hist/rngwhhdD.htm", observedAt: r.period ?? at });
        }
      } catch {
        /* reference value */
      }
    }
    if (!sources.some((s) => s.field === "gas")) sources.push({ field: "gas", provider: "reference value (set EIA_API_KEY for live Henry Hub)", url: "https://www.eia.gov/dnav/ng/hist/rngwhhdD.htm", observedAt: "2026-06" });
    const carbon = Number(process.env.WORLD_CARBON_USD ?? REFERENCE_CARBON_USD);
    sources.push({ field: "carbon", provider: process.env.WORLD_CARBON_USD ? "operator-set (WORLD_CARBON_USD)" : "reference value (no free live carbon feed)", url: "", observedAt: "2026-06" });
    if (!weather) {
      // nothing live came back: keep the last snapshot, marked as the fallback
      this.last = { ...this.last, source: this.last.source === "fixture" ? "fixture" : "fallback" };
      return this.last;
    }
    const snap: WorldSnapshot = { source: "live", capturedAt: at, gasUsdPerMMBtu: gas, brentUsdPerBbl: brent, carbonUsdPerT: carbon, ...weather, sources };
    const ok = WorldSnapshotSchema.safeParse(snap);
    if (!ok.success) return this.last;
    this.db.prepare("INSERT INTO world_snapshots (captured_at, source, snapshot_json) VALUES (?, ?, ?)").run(at, "live", JSON.stringify(snap));
    this.db.prepare("DELETE FROM world_snapshots WHERE id NOT IN (SELECT id FROM world_snapshots ORDER BY id DESC LIMIT 50)").run();
    this.last = snap;
    return snap;
  }

  private async timed(url: string): Promise<Response> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8_000);
    try {
      return await this.fetchImpl(url, { signal: ctl.signal });
    } finally {
      clearTimeout(t);
    }
  }
}

/** Fixed inputs (tests, offline demos). */
export class StaticWorldInputs implements WorldInputProvider {
  constructor(private readonly snap: WorldSnapshot = region.regionConfig.DEFAULT_SNAPSHOT) {}
  async getSnapshot() {
    return this.snap;
  }
  current() {
    return this.snap;
  }
}
