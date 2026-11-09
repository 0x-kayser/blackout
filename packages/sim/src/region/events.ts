/**
 * Endogenous events (§9): the engine notices conditions as they start and end, links each new event to the open
 * conditions that caused it, and lets the person affected say what it means, with the simulation's own numbers (§50).
 */
import type { NodeId, RegionEvent } from "@blackout/shared";
import { ACTORS, SUPPLIERS } from "./config.ts";
import type { RCtx, RegionState } from "./state.ts";

const MAX_EVENTS = 80;

export function emit(
  s: RegionState,
  ctx: RCtx,
  ev: { type: string; severity: RegionEvent["severity"]; title: string; detail: string; nodeId?: NodeId | null; actorId?: string | null; causeKeys?: string[]; quote?: RegionEvent["quote"] },
  key?: string,
): RegionEvent {
  s.eventSeq += 1;
  const causes = [...new Set((ev.causeKeys ?? []).map((k) => s.causes[k]).filter((x): x is number => typeof x === "number"))].sort((a, b) => a - b);
  const e: RegionEvent = {
    seq: s.eventSeq,
    interval: s.interval,
    type: ev.type,
    severity: ev.severity,
    title: ev.title,
    detail: ev.detail,
    nodeId: ev.nodeId ?? null,
    actorId: ev.actorId ?? null,
    causes,
    quote: ev.quote ?? null,
  };
  s.events.push(e);
  if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
  ctx.events.push(e);
  if (key) s.causes[key] = e.seq;
  return e;
}

/** True (and starts the cooldown) if `key` hasn't fired in the last `intervals`. */
export function cooled(s: RegionState, key: string, intervals: number): boolean {
  const last = s.cooldowns[key];
  if (last !== undefined && s.interval - last < intervals) return false;
  s.cooldowns[key] = s.interval;
  return true;
}

export const open = (s: RegionState, key: string) => typeof s.causes[key] === "number";
export const close = (s: RegionState, key: string) => {
  delete s.causes[key];
};
/** Every open condition whose key starts with one of the prefixes. */
export const openKeys = (s: RegionState, ...prefixes: string[]) => Object.keys(s.causes).filter((k) => prefixes.some((p) => k === p || k.startsWith(p)));

export const cr = (cc: number) => `₡${Math.round(cc / 100).toLocaleString("en-US")}`;
export const mw = (kw: number) => `${Math.round(kw / 1000).toLocaleString("en-US")} MW`;

const actorCfg = (id: string) => ACTORS.find((a) => a.actorId === id)!;

/** A line from a person, built from the numbers that moved them. */
export function actorQuote(actorId: string, situation: "curtail" | "shed" | "strained" | "distressed" | "layoffs" | "closed" | "reopened" | "recovered" | "steel", n: { priceCc?: number; productionBps?: number; employees?: number; lost?: number; shedKw?: number; lossCc?: number }): RegionEvent["quote"] {
  const a = actorCfg(actorId);
  const p = n.priceCc !== undefined ? cr(n.priceCc) : "";
  const prod = n.productionBps !== undefined ? `${Math.round(n.productionBps / 100)}%` : "";
  let text = "";
  switch (situation) {
    case "curtail":
      text =
        a.kind === "industry"
          ? `At ${p} a megawatt-hour my lines lose money on every tonne. We're down to ${prod} and the night shift is going home.`
          : a.kind === "households"
            ? `At ${p} people are switching off air-conditioning and laundry. We're using ${prod} of what we normally would.`
            : `At ${p} we're cutting everything that isn't essential: running at ${prod}.`;
      break;
    case "shed":
      text =
        a.kind === "hospital"
          ? `We're on backup diesel. Theatres are closed until the grid holds.`
          : a.kind === "households"
            ? `${mw(n.shedKw ?? 0)} of homes went dark. Fridges warming, lifts stuck, kids doing homework by phone light.`
            : a.kind === "datacenter"
              ? `Our clients have contracts. Every dark interval costs us ${cr(n.lossCc ?? 0)} and some of them won't renew.`
              : `The power cut stopped everything. That's ${cr(n.lossCc ?? 0)} gone this interval and the stock is spoiling.`;
      break;
    case "strained":
      text = `Margins are thin. We've frozen hiring until power gets cheaper.`;
      break;
    case "distressed":
      text = `The bank wants a plan by Friday. ${(n.employees ?? 0).toLocaleString("en-US")} jobs are riding on what power costs this week.`;
      break;
    case "layoffs":
      text = `We let ${(n.lost ?? 0).toLocaleString("en-US")} people go today. I knew most of them by name.`;
      break;
    case "closed":
      text = `We've shut the gates. ${(n.lost ?? 0).toLocaleString("en-US")} people out of work.`;
      break;
    case "reopened":
      text = `New money, same people. We're back with ${(n.employees ?? 0).toLocaleString("en-US")} staff.`;
      break;
    case "recovered":
      text = `Power's affordable again. We're hiring back.`;
      break;
    case "steel":
      text = `Our furnaces are cold, so every builder in the region is paying more for steel.`;
      break;
  }
  return { person: a.person, face: a.face, text };
}

export function supplierQuote(supplierId: string, situation: "ration" | "disrupted" | "recovered", n: { fillPct?: number; priceCc?: number }): RegionEvent["quote"] {
  const c = SUPPLIERS.find((x) => x.supplierId === supplierId)!;
  const unit = c.fuel === "gas" ? "MMBtu" : "litre";
  const text =
    situation === "ration"
      ? `My tanks are at ${n.fillPct}%. Everyone gets a share, nobody gets all they want, and it's ${cr(n.priceCc ?? 0)} a ${unit} now.`
      : situation === "disrupted"
        ? `Imports are cut. Buy what you need now, because next week it costs more.`
        : `Supply's flowing again. Prices will settle.`;
  return { person: c.person, face: c.face, text };
}
