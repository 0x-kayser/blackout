/**
 * ExchangeService: owns the one shared Vesper Fuel Exchange.
 *
 *  - Every change goes through `mutate`: the engine runs on a copy, the invariants are
 *    checked, and the new state, its events, ledger rows, chain jobs and city effects
 *    commit in ONE SQLite transaction. A rejected change leaves nothing behind.
 *  - Sandbox mode (no Testnet exchange configured): chain operations settle at once
 *    with no transaction hash, because none exists. Testnet mode: they become
 *    `exchange_jobs` for the worker, and settle only from a verified outcome.
 *  - City effects (paid, delivered, refunded, fees) are applied to the player's city
 *    as idempotent system actions, so each one lands exactly once even across restarts.
 */
import { createHash } from "node:crypto";
import { type ExchangeCityEffect } from "@blackout/shared";
import { BRENT_DATASET, SimError, brentToIndexCenti, exchange as X } from "@blackout/sim";
import { playerChainId, type ChainConfig } from "./chain.ts";
import { nowIso, tx, type Db } from "./db.ts";
import { ApiError, type RunService } from "./services.ts";

export const EXCHANGE_TICK_MS = 5_000;

/** Like the cities, each exchange day follows one observed 2026 Brent week (repeating). */
export function exchangeOilForDay(day: number): number {
  const w = BRENT_DATASET.weekly2026;
  return brentToIndexCenti(w[(day - 1) % w.length].usdPerBarrel);
}

export type ExchangeListener = (events: X.ExchangeEvent[]) => void;

export class ExchangeService {
  state: X.ExchangeState;
  readonly sandbox: boolean;
  /** Set when the saved exchange belongs to a different settlement mode than this server is configured for. */
  readonly modeConflict: string | null = null;
  /** Latest result of the read-only contract reconciliation (Testnet only). */
  lastReconcile: import("./reconciler.ts").ReconcileReport | null = null;
  private readonly listeners = new Set<ExchangeListener>();
  private stmts;

  constructor(
    private readonly db: Db,
    private readonly svc: RunService,
    private readonly chain: ChainConfig,
  ) {
    const wanted = chain.exchangeEnabled ? "testnet" : "sandbox";
    const saved = db.prepare("SELECT mode FROM exchange_state WHERE id = 1").get() as { mode: string } | undefined;
    if (saved && saved.mode !== wanted) {
      // Never let sandbox balances pose as on-chain ones (or the reverse). Stay in the saved mode until an operator resets.
      this.modeConflict = `The saved exchange was created in ${saved.mode} mode but this server is configured for ${wanted}. It keeps running in ${saved.mode} mode. To switch, back up the database and delete the exchange_state row (and exchange_* tables) so a fresh ${wanted} exchange starts.`;
      console.error(`[exchange] ${this.modeConflict}`);
    }
    this.sandbox = (saved?.mode ?? wanted) === "sandbox";
    this.stmts = {
      saveState: db.prepare("INSERT INTO exchange_state (id, state_json, updated_at, mode) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at"),
      insEvent: db.prepare("INSERT OR IGNORE INTO exchange_events (seq, tick, type, actors, event_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
      insLedger: db.prepare("INSERT OR IGNORE INTO exchange_ledger (seq, entry_json) VALUES (?, ?)"),
      insJob: db.prepare("INSERT OR IGNORE INTO exchange_jobs (op, op_id, payload_json, status, attempts, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, ?, ?)"),
      insEffect: db.prepare("INSERT OR IGNORE INTO exchange_city_effects (effect_id, player_id, payload_json, status, attempts, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, ?, ?)"),
      pendingEffects: db.prepare("SELECT effect_id, player_id, payload_json, attempts FROM exchange_city_effects WHERE status = 'pending' ORDER BY created_at, effect_id LIMIT ?"),
      markEffect: db.prepare("UPDATE exchange_city_effects SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ? WHERE effect_id = ?"),
      activeRun: db.prepare("SELECT active_run_id FROM players WHERE player_id = ?"),
      getRequest: db.prepare("SELECT result_json FROM exchange_requests WHERE request_id = ?"),
      insRequest: db.prepare("INSERT OR IGNORE INTO exchange_requests (request_id, player_id, kind, result_json, created_at) VALUES (?, ?, ?, ?, ?)"),
      insChainId: db.prepare("INSERT OR IGNORE INTO player_chain_ids (player_id, chain_id, created_at) VALUES (?, ?, ?)"),
      recent: db.prepare("SELECT event_json FROM exchange_events WHERE actors LIKE ? ORDER BY seq DESC LIMIT ?"),
      selfCustody: db.prepare("SELECT self_custody FROM player_chain_ids WHERE player_id = ?"),
    };
    svc.eventHooks.push((h, events) => this.onCityEvents(h, events));
    const row = db.prepare("SELECT state_json FROM exchange_state WHERE id = 1").get() as { state_json: string } | undefined;
    if (row) {
      this.state = JSON.parse(row.state_json) as X.ExchangeState;
      // traders added to the game since this exchange was saved join with their starting wallets (sandbox only:
      // on Testnet their stock must be minted by the bootstrap first)
      if (this.sandbox && X.ensureTraders(this.state) > 0) this.stmts.saveState.run(JSON.stringify(this.state), nowIso(), "sandbox");
      else if (!this.sandbox) for (const t of Object.values(this.state.traders)) t.params = X.EXCHANGE_TRADERS.find((p) => p.traderId === t.traderId) ?? t.params;
    } else {
      this.state = X.createExchange({ oilIndexCenti: exchangeOilForDay(1) });
      this.stmts.saveState.run(JSON.stringify(this.state), nowIso(), this.sandbox ? "sandbox" : "testnet");
    }
  }

  // ---------------------------------------------------------------- the exchange and every city, linked
  private deferred: (() => void)[] = [];
  private flushing = false;

  /** Runs after the city's own action/tick has fully committed, never inside it. */
  private defer(fn: () => void): void {
    this.deferred.push(fn);
    if (this.flushing) return;
    this.flushing = true;
    queueMicrotask(() => {
      this.flushing = false;
      for (const f of this.deferred.splice(0)) {
        try {
          f();
        } catch (e) {
          console.error("[exchange] city link failed", e);
        }
      }
    });
  }

  /**
   * Players' town merchants restock from the exchange traders, and every new day each town hears the traders'
   * current price premium as a recorded action, so its replay stays exact.
   */
  private onCityEvents(h: import("./services.ts").RunHandle, events: import("@blackout/shared").EconomyEvent[]): void {
    if (h.state.mode !== "play") return;
    for (const e of events) {
      const qty = typeof e.data.quantityMl === "number" ? e.data.quantityMl : 0;
      if (e.type === "MERCHANT_RESTOCK_ORDERED" && qty > 0) {
        this.defer(() => this.mutate((s, ctx) => X.supplyCities(s, ctx, { quantityMl: qty, refId: `${h.runId}:${e.seq}` })));
      } else if (e.type === "DAY_STARTED" || e.type === "WAVE_STARTED") {
        this.defer(() => this.sendPriceSignal(h, `${h.runId}:${e.seq}`));
      }
    }
  }

  sendPriceSignal(h: import("./services.ts").RunHandle, key: string): void {
    const premiumBps = X.cityPricePremiumBps(this.state);
    const bestAskCcPerL = X.exchangeBook(this.state).bestAskCcPerL;
    this.svc.act(h, { action: { type: "EXCHANGE_PRICE_SIGNAL", premiumBps, bestAskCcPerL }, idempotencyKey: `xps:${key}` }, "chain_worker");
  }

  subscribe(fn: ExchangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Applies `fn` to a copy of the exchange and commits it atomically, or throws and changes nothing. */
  mutate<T>(fn: (s: X.ExchangeState, ctx: X.ExchangeCtx) => T): { result: T; ctx: X.ExchangeCtx } {
    const draft = structuredClone(this.state);
    const ctx = X.newExchangeCtx();
    let result: T;
    try {
      result = fn(draft, ctx);
      if (this.sandbox) X.settleAllPending(draft, ctx, "confirmed");
    } catch (e) {
      if (e instanceof SimError) throw new ApiError(e.code, e.message, e.details);
      throw e;
    }
    const bad = X.exchangeInvariants(draft);
    if (bad.length) throw new ApiError("INTERNAL", `Exchange invariant violated: ${bad[0]}`);
    const now = nowIso();
    tx(this.db, () => {
      this.stmts.saveState.run(JSON.stringify(draft), now, this.sandbox ? "sandbox" : "testnet");
      for (const e of ctx.events) this.stmts.insEvent.run(e.seq, e.tick, e.type, JSON.stringify(e.actors), JSON.stringify(e), now);
      for (const l of ctx.ledger) this.stmts.insLedger.run(l.seq, JSON.stringify(l));
      for (const e of ctx.effects) {
        if (e.kind === "chain") {
          if (!this.sandbox) this.stmts.insJob.run(e.op, e.opId, JSON.stringify(e), now, now);
        } else {
          this.stmts.insEffect.run(e.effectId, e.playerId, JSON.stringify(e), now, now);
        }
      }
    });
    this.state = draft;
    for (const l of this.listeners) l(ctx.events);
    this.applyCityEffects();
    return { result, ctx };
  }

  /** One exchange tick: today's oil index, deliveries, expiries, every trader, the daily close. */
  tick(): X.ExchangeEvent[] {
    return this.mutate((s, ctx) => {
      X.setOilIndex(s, ctx, exchangeOilForDay(s.day));
      X.exchangeTick(s, ctx);
      if (s.tick % s.config.ticksPerDay === 0) X.pruneExchange(s);
    }).ctx.events;
  }

  /** Settles a chain job from a verified outcome. Returns false if it was already settled. */
  settleChain(e: Pick<X.ChainEffect, "op" | "opId">, outcome: "confirmed" | "failed", txHash: string | null, error: string | null): boolean {
    try {
      this.mutate((s, ctx) => X.settleChainOp(s, ctx, e, outcome, txHash, error));
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === "ALREADY_PROCESSED") return false;
      throw err;
    }
  }

  /** Delivers settled outcomes to players' cities, each exactly once (idempotent by effect id). */
  applyCityEffects(limit = 100): number {
    const rows = this.stmts.pendingEffects.all(limit) as { effect_id: string; player_id: string; payload_json: string; attempts: number }[];
    let applied = 0;
    for (const r of rows) {
      const runId = (this.stmts.activeRun.get(r.player_id) as { active_run_id: string | null } | undefined)?.active_run_id;
      if (!runId) {
        this.stmts.markEffect.run("pending", "player has no city yet", nowIso(), r.effect_id);
        continue;
      }
      const { kind: _kind, playerId: _player, ...effect } = JSON.parse(r.payload_json) as X.CityEffect;
      try {
        const h = this.svc.get(runId);
        const out = this.svc.act(h, { action: { type: "EXCHANGE_EFFECT", effect: effect as ExchangeCityEffect }, idempotencyKey: `xfx:${r.effect_id}` }, "chain_worker");
        if (out.ok) {
          this.stmts.markEffect.run("applied", null, nowIso(), r.effect_id);
          applied += 1;
        } else {
          this.stmts.markEffect.run("failed", `${out.error?.code}: ${out.error?.message}`.slice(0, 300), nowIso(), r.effect_id);
          console.error("[exchange] city effect rejected", r.effect_id, out.error);
        }
      } catch (e) {
        this.stmts.markEffect.run("pending", (e as Error).message.slice(0, 300), nowIso(), r.effect_id);
      }
    }
    return applied;
  }

  // ---------------------------------------------------------------- request helpers

  requestId(playerId: string, kind: string, key: string): string {
    return `${kind}_${createHash("sha256").update(`${playerId}|${kind}|${key}`).digest("hex").slice(0, 24)}`;
  }

  priorRequest<T>(requestId: string): T | null {
    const r = this.stmts.getRequest.get(requestId) as { result_json: string } | undefined;
    return r ? (JSON.parse(r.result_json) as T) : null;
  }

  saveRequest(requestId: string, playerId: string, kind: string, result: unknown): void {
    this.stmts.insRequest.run(requestId, playerId, kind, JSON.stringify(result), nowIso());
  }

  /** True once the player took their warehouse into their own NEAR account (phase 6). */
  isSelfCustodied(playerId: string): boolean {
    return ((this.stmts.selfCustody.get(playerId) as { self_custody: number } | undefined)?.self_custody ?? 0) === 1;
  }

  /** Records the player's namespaced contract id the first time they use the Testnet exchange. */
  chainIdFor(playerId: string): string | null {
    if (this.sandbox) return null;
    const id = playerChainId(this.chain, playerId);
    this.stmts.insChainId.run(playerId, id, nowIso());
    return id;
  }

  // ---------------------------------------------------------------- views

  view(playerId: string | null) {
    const book = X.exchangeBook(this.state);
    const player = playerId ? X.playerExchangeView(this.state, playerId) : null;
    const me = player ? { ...player, fills: player.fills.map(({ txHash: _txHash, ...fill }) => fill) } : null;
    return {
      book,
      me,
    };
  }

  recentFor(playerId: string, limit = 20): X.ExchangeEvent[] {
    return (this.stmts.recent.all(`%"player:${playerId}"%`, limit) as { event_json: string }[]).map((r) => JSON.parse(r.event_json) as X.ExchangeEvent);
  }
}

export function startExchangeDriver(xsvc: ExchangeService, intervalMs = EXCHANGE_TICK_MS): () => void {
  const t = setInterval(() => {
    try {
      xsvc.tick();
    } catch (e) {
      console.error("[exchange] tick failed", e);
    }
  }, intervalMs);
  return () => clearInterval(t);
}
