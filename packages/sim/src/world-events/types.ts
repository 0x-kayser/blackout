/**
 * World Events: types, bounds and the validator for any external/bundled event payload.
 * Events never touch balances. They only change a small set of bounded economic INPUTS
 * that the existing NPC policies already read (see modifiers.ts).
 */
import { z } from "zod";

export const WORLD_CATEGORIES = [
  "shipping",
  "production",
  "refinery",
  "inventory",
  "weather",
  "demand",
  "policy",
  "renewables",
  "recovery",
] as const;
export type WorldCategory = (typeof WORLD_CATEGORIES)[number];

/** Modes: real Brent prices + sourced annotations; real prices + fictional local events; fully fictional; none. */
export const WORLD_MODES = ["historical", "living", "scenario", "calm"] as const;
export type WorldMode = (typeof WORLD_MODES)[number];

export interface WorldModifiers {
  /** Change to merchants' upstream import capacity (bps). Fewer/more litres can be ordered. */
  importCapacityBps: number;
  /** Extra restock delivery delay (game days). */
  leadTimeDays: number;
  /** Shipping/refinery premium on the import cost (bps). Forced to 0 when oil prices are historical (no double shock). */
  logisticsCostBps: number;
  /** Outside shopper demand in the city (bps): businesses earn more or less per powered hour. */
  demandBps: number;
  /** Solar panel and battery prices (bps). */
  solarCostBps: number;
  /** Daily carbon-permit supply from Vesper City's regulator (bps). */
  permitSupplyBps: number;
  /** Merchant caution: how much extra stock merchants want to hold (bps of target). */
  cautionBps: number;
  /** Extra outage hours per request during grid stress (0 or 1). */
  gridStressHours: number;
}

export const ZERO_MODIFIERS: WorldModifiers = {
  importCapacityBps: 0,
  leadTimeDays: 0,
  logisticsCostBps: 0,
  demandBps: 0,
  solarCostBps: 0,
  permitSupplyBps: 0,
  cautionBps: 0,
  gridStressHours: 0,
};

/** Hard bounds on the COMBINED effect of all active events (tunable, documented in ECONOMY_RULES). */
export const MODIFIER_BOUNDS: { [K in keyof WorldModifiers]: [number, number] } = {
  importCapacityBps: [-7_000, 5_000],
  leadTimeDays: [0, 2],
  logisticsCostBps: [-2_000, 2_500],
  demandBps: [-2_500, 2_500],
  solarCostBps: [-3_000, 5_000],
  permitSupplyBps: [-5_000, 3_000],
  cautionBps: [-3_000, 5_000],
  gridStressHours: [0, 1],
};

const effectsSchema = z
  .object({
    importCapacityBps: z.number().int(),
    leadTimeDays: z.number().int(),
    logisticsCostBps: z.number().int(),
    demandBps: z.number().int(),
    solarCostBps: z.number().int(),
    permitSupplyBps: z.number().int(),
    cautionBps: z.number().int(),
    gridStressHours: z.number().int(),
  })
  .partial()
  .strict();

/**
 * Schema for any event that originates OUTSIDE the engine (bundled historical data, a future
 * vetted feed). Text is display-only, length-limited and never interpreted; categories are an
 * enum; effects are numeric and clamped; unknown keys are rejected.
 */
export const ExternalEventSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{3,64}$/),
    category: z.enum(WORLD_CATEGORIES),
    headline: z.string().min(5).max(140),
    explanation: z.string().min(10).max(600),
    assumption: z.string().min(10).max(300),
    region: z.string().min(2).max(60),
    sourceTitle: z.string().min(3).max(160),
    sourceUrl: z.string().url().refine((u) => ALLOWED_SOURCE_HOSTS.some((h) => new URL(u).hostname === h || new URL(u).hostname.endsWith(`.${h}`)), "source host not allow-listed"),
    publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    durationDays: z.number().int().min(1).max(10),
    effects: effectsSchema,
  })
  .strict();
export type ExternalEvent = z.infer<typeof ExternalEventSchema>;

/** Only official/primary energy-statistics publishers may back a "sourced" event. */
export const ALLOWED_SOURCE_HOSTS = ["eia.gov", "iea.org", "fred.stlouisfed.org"];

export interface WorldEventState {
  eventId: string;
  templateId: string;
  category: WorldCategory;
  headline: string;
  explanation: string;
  /** What the game model assumes this means locally (always shown). */
  assumption: string;
  sourceType: "fictional_scenario" | "historical_source";
  verification: "fictional" | "sourced";
  sourceTitle: string | null;
  sourceUrl: string | null;
  publishedAt: string | null;
  region: string;
  effects: Partial<WorldModifiers>;
  startTick: number;
  endTick: number;
  startDay: number;
  phase: "building" | "peak" | "easing" | "resolved";
}

export interface WorldState {
  mode: WorldMode;
  /** Fixed schedule for Economy Lab conditions / weekly challenges (null = seeded random for living/scenario). */
  preset: string | null;
  rng: [number, number, number, number];
  active: WorldEventState[];
  history: WorldEventState[];
  /** Historical annotations already started in this loop of the dataset. */
  startedHistorical: string[];
  seq: number;
}

/** Validates + clamps an external payload. Returns null (and the reason) for anything malformed. */
export function ingestExternalEvent(raw: unknown): { ok: true; event: ExternalEvent } | { ok: false; reason: string } {
  const r = ExternalEventSchema.safeParse(raw);
  if (!r.success) return { ok: false, reason: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const e = r.data;
  const effects: Partial<WorldModifiers> = {};
  for (const [k, v] of Object.entries(e.effects) as [keyof WorldModifiers, number][]) {
    const [lo, hi] = MODIFIER_BOUNDS[k];
    effects[k] = Math.max(lo, Math.min(hi, v));
  }
  return { ok: true, event: { ...e, effects } };
}
