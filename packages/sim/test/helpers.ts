import type { AnyAction } from "@blackout/shared";
import { applyActionMut, createInitialState, tickMut } from "../src/engine.ts";
import { newCtx, type SimState } from "../src/state.ts";
import type { EconomyEvent, LedgerEntry } from "@blackout/shared";

export function newRun(seed = 424242, extra: Partial<Parameters<typeof createInitialState>[0]> = {}) {
  const { state, events, ledger } = createInitialState({ runId: "test-run", ownerId: "tester", seed, ...extra });
  return { s: state, events: [...events], ledger: [...ledger] };
}

export function ticks(s: SimState, n: number, log?: { events: EconomyEvent[]; ledger: LedgerEntry[] }): EconomyEvent[] {
  const out: EconomyEvent[] = [];
  for (let i = 0; i < n; i++) {
    const ctx = newCtx(s);
    tickMut(s, ctx);
    out.push(...ctx.events);
    log?.events.push(...ctx.events);
    log?.ledger.push(...ctx.ledger);
  }
  return out;
}

export function act(s: SimState, action: AnyAction, key = `k-${s.tick}-${Math.random()}`, chainLeg = false) {
  const ctx = newCtx(s);
  const result = applyActionMut(s, ctx, action, { idempotencyKey: key, chainLeg, tokenId: "DIESEL_100ML" });
  return { result, events: ctx.events, ledger: ctx.ledger };
}

/** Advance until predicate or limit. */
export function until(s: SimState, pred: (s: SimState) => boolean, limit = 5000): void {
  let i = 0;
  while (!pred(s) && i++ < limit) ticks(s, 1);
  if (!pred(s)) throw new Error("until(): condition not reached");
}

export const openRequests = (s: SimState) => Object.values(s.requests).filter((r) => r.status === "open" || r.status === "customer_countered");
