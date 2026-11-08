/**
 * World Events lifecycle. Runs inside the deterministic engine:
 *  - its own seeded PRNG stream (seed-derived), so scheduling never perturbs other draws;
 *  - events are checked at 06:00 and 18:00 game time (decision intervals), never per quote;
 *  - each event builds up, peaks and eases, then resolves; markets recover when it ends;
 *  - effects are summed and clamped to MODIFIER_BOUNDS, and only feed NPC policy inputs.
 */
import { seedRng, rngInt, rngRange } from "../prng.ts";
import { emit, type Ctx, type SimState } from "../state.ts";
import { FICTIONAL_TEMPLATES, HISTORICAL_ANNOTATIONS, PRESETS, type FictionalTemplate } from "./catalog.ts";
import { MODIFIER_BOUNDS, ZERO_MODIFIERS, type WorldEventState, type WorldMode, type WorldModifiers, type WorldState } from "./types.ts";

const DAY_TICKS = 240;
const RAMP_SHARE_BPS = 2_000; // first/last 20% of an event run at half strength

export function initWorld(seed: number, mode: WorldMode, preset: string | null): WorldState {
  return { mode, preset, rng: seedRng((seed ^ 0x5eedc0de) >>> 0), active: [], history: [], startedHistorical: [], seq: 0 };
}

/** Old saves created before world events existed get a calm world (no behaviour change). */
export function ensureWorld(s: SimState): WorldState {
  if (!s.worldEvents) s.worldEvents = initWorld(s.seed, "calm", null);
  return s.worldEvents;
}

const historicalPrices = (s: SimState) => s.scenarioId === "oil_shock_2026";

export function intensityBps(e: WorldEventState, tick: number): number {
  if (e.phase === "resolved") return 0;
  const len = Math.max(1, e.endTick - e.startTick);
  const ramp = Math.floor((len * RAMP_SHARE_BPS) / 10_000);
  if (tick < e.startTick + ramp || tick >= e.endTick - ramp) return 5_000;
  return 10_000;
}

/** Combined, clamped modifiers from all active events at the current tick. */
export function worldModifiers(s: SimState): WorldModifiers {
  const w = s.worldEvents;
  if (!w || !w.active.length) return { ...ZERO_MODIFIERS };
  const out: WorldModifiers = { ...ZERO_MODIFIERS };
  for (const e of w.active) {
    const k = intensityBps(e, s.tick);
    for (const [key, v] of Object.entries(e.effects) as [keyof WorldModifiers, number][]) {
      // whole-unit effects (days/hours) apply at any strength; bps effects scale with intensity
      out[key] += key === "leadTimeDays" || key === "gridStressHours" ? v : Math.trunc((v * k) / 10_000);
    }
  }
  for (const key of Object.keys(out) as (keyof WorldModifiers)[]) {
    const [lo, hi] = MODIFIER_BOUNDS[key];
    out[key] = Math.max(lo, Math.min(hi, out[key]));
  }
  // No double shock: when oil prices are observed history, the price move is already in the data.
  if (historicalPrices(s)) out.logisticsCostBps = 0;
  return out;
}

function describe(e: Partial<WorldModifiers>, historical: boolean): string[] {
  const p = (bps: number) => `${bps > 0 ? "+" : ""}${(bps / 100).toFixed(0)}%`;
  const out: string[] = [];
  if (e.importCapacityBps) out.push(`fuel import capacity ${p(e.importCapacityBps)}`);
  if (e.leadTimeDays) out.push(`deliveries +${e.leadTimeDays} day`);
  if (e.logisticsCostBps) out.push(historical ? "no extra price shock (already in observed Brent)" : `import cost ${p(e.logisticsCostBps)}`);
  if (e.cautionBps) out.push(`merchants' safety stock ${p(e.cautionBps)}`);
  if (e.demandBps) out.push(`shopper demand ${p(e.demandBps)}`);
  if (e.solarCostBps) out.push(`solar & battery prices ${p(e.solarCostBps)}`);
  if (e.permitSupplyBps) out.push(`permit supply ${p(e.permitSupplyBps)}`);
  if (e.gridStressHours) out.push(`outages +${e.gridStressHours} h`);
  return out;
}

function start(s: SimState, ctx: Ctx, ev: Omit<WorldEventState, "eventId" | "startTick" | "endTick" | "startDay" | "phase">, days: number, onStarted: (e: WorldEventState) => void): void {
  const w = ensureWorld(s);
  w.seq += 1;
  const e: WorldEventState = { ...ev, eventId: `wev_${w.seq}`, startTick: s.tick, endTick: s.tick + days * DAY_TICKS, startDay: s.day, phase: "building" };
  w.active.push(e);
  const effects = describe(e.effects, historicalPrices(s));
  emit(s, ctx, "WORLD_EVENT_STARTED", ["world"], `${e.headline}. In Vesper City: ${effects.join(", ")}. ${e.verification === "sourced" ? `Source: ${e.sourceTitle}.` : "Fictional game scenario."}`, {
    worldEventId: e.eventId,
    category: e.category,
    verification: e.verification,
    sourceUrl: e.sourceUrl,
    effects: e.effects,
    endTick: e.endTick,
  });
  onStarted(e);
}

function fromTemplate(t: FictionalTemplate): Omit<WorldEventState, "eventId" | "startTick" | "endTick" | "startDay" | "phase"> {
  return {
    templateId: t.templateId,
    category: t.category,
    headline: t.headline,
    explanation: t.explanation,
    assumption: t.assumption,
    sourceType: "fictional_scenario",
    verification: "fictional",
    sourceTitle: null,
    sourceUrl: null,
    publishedAt: null,
    region: t.region,
    effects: { ...t.effects },
  };
}

/**
 * Called once per tick by the engine. `onChange` lets the engine re-run NPC policies
 * (merchant repricing, delayed deliveries) when the world changes.
 */
export function worldTick(s: SimState, ctx: Ctx, onChange: (kind: "started" | "ended", e: WorldEventState) => void): void {
  const w = ensureWorld(s);
  // phase updates and expiry
  for (const e of [...w.active]) {
    if (s.tick >= e.endTick) {
      e.phase = "resolved";
      w.active = w.active.filter((x) => x !== e);
      w.history.push(e);
      if (w.history.length > 20) w.history.shift();
      emit(s, ctx, "WORLD_EVENT_ENDED", ["world"], `Resolved: ${e.headline}. Its effects on Vesper City (${describe(e.effects, historicalPrices(s)).join(", ")}) have ended.`, { worldEventId: e.eventId });
      onChange("ended", e);
      continue;
    }
    const k = intensityBps(e, s.tick);
    const phase = k < 10_000 ? (s.tick < (e.startTick + e.endTick) / 2 ? "building" : "easing") : "peak";
    if (phase !== e.phase) {
      e.phase = phase;
      emit(s, ctx, "WORLD_EVENT_UPDATED", ["world"], `${e.headline}: ${phase === "peak" ? "now at full strength" : "easing"}.`, { worldEventId: e.eventId, phase });
    }
  }
  if (w.mode === "calm") return;
  const dayTick = s.phaseTick;
  if (dayTick !== 0 && dayTick !== 120) return; // decision intervals: 06:00 and 18:00

  if (w.preset) {
    const p = PRESETS[w.preset];
    for (const item of p?.schedule ?? []) {
      const key = `${item.templateId}@${item.day}`;
      if (dayTick === 0 && s.day === item.day && !w.startedHistorical.includes(key)) {
        w.startedHistorical.push(key);
        const t = FICTIONAL_TEMPLATES.find((x) => x.templateId === item.templateId)!;
        start(s, ctx, fromTemplate(t), item.days, (e) => onChange("started", e));
      }
    }
    return;
  }

  if (w.mode === "historical") {
    if (dayTick !== 0) return;
    for (const a of HISTORICAL_ANNOTATIONS) {
      const day = historicalDayFor(a.publishedAt);
      const seriesDay = s.day + (s.world.oilDayOffset ?? 0);
      const loop = Math.floor((seriesDay - 1) / 45);
      const key = `${a.id}#${loop}`;
      if (day !== null && ((seriesDay - 1) % 45) + 1 === day && !w.startedHistorical.includes(key)) {
        w.startedHistorical.push(key);
        start(
          s,
          ctx,
          {
            templateId: a.id,
            category: a.category,
            headline: a.headline,
            explanation: a.explanation,
            assumption: a.assumption,
            sourceType: "historical_source",
            verification: "sourced",
            sourceTitle: a.sourceTitle,
            sourceUrl: a.sourceUrl,
            publishedAt: a.publishedAt,
            region: a.region,
            effects: { ...a.effects },
          },
          a.durationDays,
          (e) => onChange("started", e),
        );
      }
    }
    return;
  }

  // living / scenario: seeded random events once the tutorial is over
  if (s.wavesTotal <= 4 || w.active.length >= 2) return;
  // the first event after the tutorial is guaranteed (pacing); later ones are a seeded 45% roll
  const first = w.history.length === 0 && w.active.length === 0;
  if (!first && rngInt(w.rng, 100) >= 45) return;
  const activeCats = new Set(w.active.map((e) => e.category));
  const pool = FICTIONAL_TEMPLATES.filter((t) => !activeCats.has(t.category) && !w.active.some((a) => a.templateId === t.templateId));
  if (!pool.length) return;
  const total = pool.reduce((a, t) => a + t.weight, 0);
  let r = rngInt(w.rng, total);
  const t = pool.find((x) => (r -= x.weight) < 0)!;
  start(s, ctx, fromTemplate(t), rngRange(w.rng, t.minDays, t.maxDays), (e) => onChange("started", e));
}

/** Game day on which a dated observation appears in the weekly Brent replay (1-based), or null. */
import { BRENT_DATASET } from "../config.ts";
export function historicalDayFor(date: string): number | null {
  const weeks = BRENT_DATASET.weekly2026;
  for (let i = weeks.length - 1; i >= 0; i--) if (weeks[i].weekStart <= date) return i + 1;
  return null;
}

export { describe as describeEffects };
