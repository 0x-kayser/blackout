/**
 * RunService: owns live runs, the real-time driver, idempotent actions,
 * persistence and crash recovery. The engine is pure; this is the only place
 * that maps wall-clock time onto engine ticks.
 *
 * Clock policy (documented for the frontend):
 *  - A run advances 1 tick per real second ONLY while it is running.
 *  - New runs start paused ("no_clients") and start when the first SSE client connects.
 *  - If no SSE client is connected for 15 s the run auto-pauses ("no_clients");
 *    reconnecting resumes it. Explicit PAUSE/RESUME actions are also supported.
 *  - The driver never fast-forwards more than 5 s of missed time: after a process
 *    stall it re-anchors instead of silently simulating minutes nobody watched.
 */
import { randomUUID } from "node:crypto";
import {
  type ActionEnvelope,
  type AnyAction,
  type EconomyEvent,
  type ErrorCode,
  type GameStatePublic,
  type LabCondition,
  type LedgerEntry,
} from "@blackout/shared";
import { SimError, applyAction, campaignSummary, createInitialState, newCtx, replayId, runReplay, tickMut, toPublic, type SimState } from "@blackout/sim";
import type { ChainConfig } from "./chain.ts";
import { nowIso, tx, type Db } from "./db.ts";

export const AUTO_PAUSE_MS = 15_000;
export const MAX_CATCHUP_TICKS = 5;
export const CHECKPOINT_TICKS = 5;

export interface TickFrame {
  tick: number;
  day: number;
  phase: string;
  phaseTick: number;
  stateVersion: number;
  lastEventSeq: number;
  paused: boolean;
}

export type Listener = (msg: { kind: "event"; event: EconomyEvent } | { kind: "state"; state: GameStatePublic } | { kind: "tick"; frame: TickFrame }) => void;

export interface RunHandle {
  runId: string;
  ownerId: string;
  state: SimState;
  running: boolean;
  pauseReason: "none" | "no_clients" | "player" | "finished";
  anchorWallMs: number;
  anchorTick: number;
  listeners: Set<Listener>;
  lastClientAt: number;
  actionSeq: number;
  /** Wall-clock ms when the run last paused (for the "welcome back" summary). */
  pausedAtMs: number;
}

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface StoredActionResult {
  ok: boolean;
  stateVersion: number;
  events?: EconomyEvent[];
  result?: Record<string, unknown>;
  error?: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}

export type RunEventHook = (h: RunHandle, events: EconomyEvent[]) => void;

export class RunService {
  readonly runs = new Map<string, RunHandle>();
  /** Called after a run's events are persisted (ticks and actions), e.g. so the shared exchange can react. */
  readonly eventHooks: RunEventHook[] = [];
  private fireHooks(h: RunHandle, events: EconomyEvent[]): void {
    if (!events.length) return;
    for (const hook of this.eventHooks) {
      try {
        hook(h, events);
      } catch (e) {
        console.error("[runs] event hook failed", e);
      }
    }
  }
  private stmts;

  constructor(
    private readonly db: Db,
    private readonly chain: ChainConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.stmts = {
      insEvent: db.prepare("INSERT OR IGNORE INTO events (run_id, seq, type, day, tick, event_json, server_time) VALUES (?, ?, ?, ?, ?, ?, ?)"),
      insLedger: db.prepare("INSERT OR IGNORE INTO ledger (run_id, seq, entry_json) VALUES (?, ?, ?)"),
      upSnap: db.prepare(
        "INSERT INTO snapshots (run_id, kind, tick, state_version, action_seq, state_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, kind, tick) DO UPDATE SET state_version=excluded.state_version, action_seq=excluded.action_seq, state_json=excluded.state_json, created_at=excluded.created_at",
      ),
      delLatest: db.prepare("DELETE FROM snapshots WHERE run_id = ? AND kind = 'latest'"),
      insAction: db.prepare("INSERT INTO actions (run_id, seq, tick, idempotency_key, source, action_json, ok, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
      getAction: db.prepare("SELECT ok, result_json FROM actions WHERE run_id = ? AND idempotency_key = ?"),
      insRun: db.prepare("INSERT INTO runs (run_id, owner_id, seed, scenario_id, scenario_version, mode, chain_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
      getRun: db.prepare("SELECT * FROM runs WHERE run_id = ?"),
      finishRun: db.prepare("UPDATE runs SET finished = 1, score = ? WHERE run_id = ?"),
      insBoard: db.prepare("INSERT OR REPLACE INTO leaderboard (run_id, owner_id, seed, scenario_id, score, net_worth_cc, reliability_bps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
      insJob: db.prepare("INSERT OR IGNORE INTO chain_jobs (trade_key, run_id, trade_id, merchant_id, token_id, amount, status, attempts, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)"),
      insMarketplaceJob: db.prepare("INSERT OR IGNORE INTO marketplace_jobs (job_id, run_id, listing_id, kind, seller_id, merchant_id, token_id, amount, unit_price_cc, status, attempts, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'DIESEL_100ML', ?, ?, 'pending', 0, ?)"),
    };
  }

  // ---------------------------------------------------------------- lifecycle

  createRun(
    ownerId: string,
    req: { scenarioId: "starter" | "fuel_squeeze" | "oil_shock_2026"; seed?: number; mode: "play" | "guest_demo" | "challenge"; worldMode?: "living" | "historical" | "calm" | "scenario"; worldPreset?: string | null; campaignDays?: number; challengeWeek?: string | null },
  ): RunHandle {
    const runId = `run_${randomUUID().slice(0, 12)}`;
    const seed = req.seed ?? Math.floor(Math.random() * 2_000_000_000); // seed choice is not game logic; it is recorded
    const chainMode = req.mode === "play" && this.chain.enabled && this.chain.cityPurchasesOnChain ? "testnet" : "disabled";
    const merchantAccounts = Object.fromEntries(Object.entries(this.chain.merchants).map(([k, v]) => [k, chainMode === "testnet" ? v.accountId : null]));
    const { state, events, ledger } = createInitialState({
      runId,
      ownerId,
      seed,
      scenarioId: req.scenarioId,
      mode: req.mode,
      chainMode,
      merchantAccounts,
      rivalAccountId: chainMode === "testnet" ? this.chain.rivalAccountId : null,
      worldMode: req.worldMode ?? (req.mode === "play" ? "living" : "calm"),
      worldPreset: req.worldPreset ?? null,
      campaignDays: req.campaignDays,
      challengeWeek: req.challengeWeek ?? null,
    });
    const h: RunHandle = {
      runId,
      ownerId,
      state,
      running: false,
      pauseReason: "no_clients",
      anchorWallMs: this.now(),
      anchorTick: state.tick,
      listeners: new Set(),
      lastClientAt: this.now(),
      actionSeq: 0,
      pausedAtMs: this.now(),
    };
    tx(this.db, () => {
      this.stmts.insRun.run(runId, ownerId, seed, state.scenarioId, state.scenarioVersion, req.mode, chainMode, nowIso());
      this.persist(h, events, ledger);
      this.snapshot(h, "latest");
    });
    this.runs.set(runId, h);
    return h;
  }

  /** Loads a run into memory (restoring from snapshot + action log after a restart). */
  get(runId: string): RunHandle {
    const live = this.runs.get(runId);
    if (live) return live;
    const row = this.stmts.getRun.get(runId) as { run_id: string; owner_id: string } | undefined;
    if (!row) throw new ApiError("NOT_FOUND", "Run not found.");
    const h = this.restore(runId, row.owner_id);
    this.runs.set(runId, h);
    return h;
  }

  requireOwner(runId: string, userId: string): RunHandle {
    const h = this.get(runId);
    if (h.ownerId !== userId) throw new ApiError("FORBIDDEN", "This run belongs to another player.");
    return h;
  }

  private restore(runId: string, ownerId: string): RunHandle {
    const snap = this.db.prepare("SELECT state_json, action_seq FROM snapshots WHERE run_id = ? AND kind = 'latest'").get(runId) as { state_json: string; action_seq: number } | undefined;
    if (!snap) throw new ApiError("INTERNAL", "Run has no snapshot.");
    const state = JSON.parse(snap.state_json) as SimState;
    const h: RunHandle = { runId, ownerId, state, running: false, pauseReason: "no_clients", anchorWallMs: this.now(), anchorTick: state.tick, listeners: new Set(), lastClientAt: this.now(), actionSeq: snap.action_seq, pausedAtMs: this.now() };
    // re-apply any actions recorded after the snapshot at their original ticks
    const rows = this.db.prepare("SELECT seq, tick, idempotency_key, action_json, ok FROM actions WHERE run_id = ? AND seq > ? ORDER BY seq").all(runId, snap.action_seq) as {
      seq: number;
      tick: number;
      idempotency_key: string;
      action_json: string;
      ok: number;
    }[];
    for (const r of rows) {
      while (h.state.tick < r.tick && h.state.phase !== "finished") {
        const ctx = newCtx(h.state);
        tickMut(h.state, ctx);
        this.persist(h, ctx.events, ctx.ledger);
      }
      if (r.ok) {
        const out = applyAction(h.state, JSON.parse(r.action_json), this.metaFor(h, r.idempotency_key));
        h.state = out.state;
        this.persist(h, out.events, out.ledger);
      }
      h.actionSeq = r.seq;
    }
    // Ticks that ran after the last checkpoint already emitted (persisted) events. The engine is
    // deterministic, so replaying forward to the last persisted event reproduces exactly what the
    // player saw; INSERT OR IGNORE keeps the event log free of duplicates.
    const last = this.db.prepare("SELECT MAX(tick) AS t FROM events WHERE run_id = ?").get(runId) as { t: number | null };
    while (last.t !== null && h.state.tick <= last.t && h.state.phase !== "finished") {
      const ctx = newCtx(h.state);
      tickMut(h.state, ctx);
      this.persist(h, ctx.events, ctx.ledger);
    }
    if (h.state.phase === "finished") h.pauseReason = "finished";
    this.snapshot(h, "latest");
    return h;
  }

  // ---------------------------------------------------------------- persistence

  private persist(h: RunHandle, events: EconomyEvent[], ledger: LedgerEntry[]): void {
    const t = nowIso();
    for (const e of events) {
      e.serverTime = t;
      this.stmts.insEvent.run(h.runId, e.seq, e.type, e.day, e.tick, JSON.stringify(e), t);
    }
    for (const l of ledger) this.stmts.insLedger.run(h.runId, l.seq, JSON.stringify(l));
  }

  snapshot(h: RunHandle, kind: "latest" | "day" | "wave"): void {
    if (kind === "latest") this.stmts.delLatest.run(h.runId);
    this.stmts.upSnap.run(h.runId, kind, kind === "latest" ? 0 : h.state.tick, h.state.stateVersion, h.actionSeq, JSON.stringify(h.state), nowIso());
  }

  // ---------------------------------------------------------------- views

  chainInfo(h: RunHandle): GameStatePublic["chain"] {
    if (h.state.chainMode !== "testnet") {
      return {
        mode: "disabled",
        network: null,
        resourceContractId: null,
        vaultAccountId: null,
        note:
          h.state.mode === "guest_demo"
            ? "This guest city uses the game ledger and is not connected to NEAR."
            : "NEAR mode is not configured on this server. Trades settle in the game ledger.",
      };
    }
    return {
      mode: "testnet",
      network: "testnet",
      resourceContractId: this.chain.resourceContractId,
      vaultAccountId: this.chain.vaultAccountId,
      note: "The server simulates electricity. Confirmed diesel purchases enter the game's shared custodial vault; player listings escrow those resources in the NEP-245 contract and NPC purchases transfer them to the merchant account. Credits remain in the game ledger.",
    };
  }

  publicState(h: RunHandle): GameStatePublic {
    return toPublic(h.state, {
      paused: !h.running,
      pauseReason: h.state.phase === "finished" ? "finished" : h.running ? "none" : h.pauseReason,
      chain: this.chainInfo(h),
      explorerTxBase: this.chain.explorerTxBase,
    });
  }

  private frame(h: RunHandle): TickFrame {
    return { tick: h.state.tick, day: h.state.day, phase: h.state.phase, phaseTick: h.state.phaseTick, stateVersion: h.state.stateVersion, lastEventSeq: h.state.eventSeq, paused: !h.running };
  }

  private broadcast(h: RunHandle, events: EconomyEvent[], withState: boolean): void {
    if (h.listeners.size === 0) return;
    for (const l of h.listeners) for (const e of events) l({ kind: "event", event: e });
    if (withState) {
      const st = this.publicState(h);
      for (const l of h.listeners) l({ kind: "state", state: st });
    } else {
      const f = this.frame(h);
      for (const l of h.listeners) l({ kind: "tick", frame: f });
    }
  }

  // ---------------------------------------------------------------- clients & clock

  subscribe(h: RunHandle, fn: Listener): () => void {
    h.listeners.add(fn);
    h.lastClientAt = this.now();
    if (!h.running && h.pauseReason === "no_clients" && h.state.phase !== "finished") this.resume(h);
    return () => {
      h.listeners.delete(fn);
      h.lastClientAt = this.now();
    };
  }

  private resume(h: RunHandle): void {
    h.running = true;
    h.pauseReason = "none";
    h.anchorWallMs = this.now();
    h.anchorTick = h.state.tick;
  }

  awayMs(h: RunHandle): number {
    return h.running ? 0 : Math.max(0, this.now() - h.pausedAtMs);
  }

  private pause(h: RunHandle, reason: RunHandle["pauseReason"]): void {
    h.pausedAtMs = this.now();
    if (!h.running) {
      h.pauseReason = reason;
      return;
    }
    h.running = false;
    h.pauseReason = reason;
    this.snapshot(h, "latest");
    this.broadcast(h, [], true);
  }

  /** Called by the driver every ~100 ms. Returns the number of ticks applied. */
  driverStep(): number {
    let applied = 0;
    const now = this.now();
    for (const h of this.runs.values()) {
      if (!h.running) continue;
      if (h.listeners.size === 0 && now - h.lastClientAt > AUTO_PAUSE_MS) {
        this.pause(h, "no_clients");
        continue;
      }
      let due = h.anchorTick + Math.floor((now - h.anchorWallMs) / 1000);
      if (due - h.state.tick > MAX_CATCHUP_TICKS) {
        // process stalled: re-anchor rather than silently fast-forwarding
        h.anchorTick = h.state.tick;
        h.anchorWallMs = now;
        due = h.state.tick;
      }
      while (h.state.tick < due && h.state.phase !== "finished") {
        applied += 1;
        this.advanceOne(h);
      }
    }
    return applied;
  }

  /** Advance exactly one tick (also used by tests with a virtual clock). */
  advanceOne(h: RunHandle): EconomyEvent[] {
    const before = { phase: h.state.phase, wave: h.state.waveIndex, day: h.state.day };
    const ctx = newCtx(h.state);
    tickMut(h.state, ctx);
    const phaseChanged = before.phase !== h.state.phase || before.day !== h.state.day;
    tx(this.db, () => {
      this.persist(h, ctx.events, ctx.ledger);
      // periodic checkpoint (every 5 s of game time) + on every wave/day change
      if (phaseChanged || before.wave !== h.state.waveIndex || h.state.tick % CHECKPOINT_TICKS === 0) this.snapshot(h, "latest");
      if (before.day !== h.state.day) this.snapshot(h, "day");
    });
    if (h.state.phase === "finished") this.onFinished(h);
    this.broadcast(h, ctx.events, true);
    this.fireHooks(h, ctx.events);
    return ctx.events;
  }

  private onFinished(h: RunHandle): void {
    h.running = false;
    h.pauseReason = "finished";
    const sum = campaignSummary(h.state);
    this.stmts.finishRun.run(sum.score, h.runId);
    this.stmts.insBoard.run(h.runId, h.ownerId, h.state.seed, h.state.scenarioId, sum.score, sum.netWorthCc, sum.reliabilityBps, nowIso());
    this.snapshot(h, "latest");
  }

  // ---------------------------------------------------------------- actions

  private metaFor(h: RunHandle, idempotencyKey: string) {
    return { idempotencyKey, chainLeg: h.state.chainMode === "testnet", tokenId: "DIESEL_100ML" };
  }

  /**
   * Applies a player (or chain-worker) action exactly once per idempotency key.
   * Failed actions are recorded too, so a retry returns the same error instead of
   * possibly succeeding against a different state.
   */
  act(h: RunHandle, env: ActionEnvelope | { action: AnyAction; idempotencyKey: string; expectedStateVersion?: number }, source: "player" | "chain_worker" = "player"): StoredActionResult & { replayed: boolean } {
    const prior = this.stmts.getAction.get(h.runId, env.idempotencyKey) as { ok: number; result_json: string } | undefined;
    if (prior) return { ...(JSON.parse(prior.result_json) as StoredActionResult), replayed: true };

    const action = env.action;
    if (action.type === "PAUSE" || action.type === "RESUME") {
      if (action.type === "PAUSE") this.pause(h, "player");
      else if (h.state.phase !== "finished") this.resume(h);
      return { ok: true, stateVersion: h.state.stateVersion, events: [], result: { running: h.running }, replayed: false };
    }
    if (env.expectedStateVersion !== undefined && env.expectedStateVersion !== h.state.stateVersion) {
      return {
        ok: false,
        stateVersion: h.state.stateVersion,
        error: { code: "STALE_STATE", message: `State moved from version ${env.expectedStateVersion} to ${h.state.stateVersion}; refetch and retry with a new key.` },
        replayed: false,
      };
    }
    const tickAt = h.state.tick;
    let stored: StoredActionResult;
    let events: EconomyEvent[] = [];
    try {
      const out = applyAction(h.state, action, this.metaFor(h, env.idempotencyKey));
      events = out.events;
      h.actionSeq += 1;
      stored = { ok: true, stateVersion: out.state.stateVersion, events: out.events, result: out.result };
      tx(this.db, () => {
        this.persist(h, out.events, out.ledger);
        this.stmts.insAction.run(h.runId, h.actionSeq, tickAt, env.idempotencyKey, source, JSON.stringify(action), 1, JSON.stringify(stored), nowIso());
        h.state = out.state;
        // queue chain legs for pending trades created by this action
        const tradeId = out.result.tradeId as string | undefined;
        if (tradeId) {
          const t = h.state.trades[tradeId];
          if (t && t.chainStatus === "pending" && t.item === "diesel") {
            this.stmts.insJob.run(`${h.runId}:${tradeId}`, h.runId, tradeId, t.sellerId.replace("merchant:", ""), t.tokenId ?? "DIESEL_100ML", t.tokenAmount ?? "0", nowIso());
          }
        }
        const marketJob = out.result.marketJob as { jobId: string; listingId: string; kind: "list" | "cancel" | "fill"; sellerId: string; merchantId: string | null; amount: string; unitPriceCc: string } | undefined;
        if (marketJob) {
          this.stmts.insMarketplaceJob.run(marketJob.jobId, h.runId, marketJob.listingId, marketJob.kind, marketJob.sellerId, marketJob.merchantId, marketJob.amount, marketJob.unitPriceCc, nowIso());
        }
        this.snapshot(h, "latest");
      });
    } catch (e) {
      if (!(e instanceof SimError)) throw e;
      h.actionSeq += 1;
      stored = { ok: false, stateVersion: h.state.stateVersion, error: { code: e.code, message: e.message, details: e.details } };
      this.stmts.insAction.run(h.runId, h.actionSeq, tickAt, env.idempotencyKey, source, JSON.stringify(action), 0, JSON.stringify(stored), nowIso());
    }
    if (h.state.phase === "finished" && h.pauseReason !== "finished") this.onFinished(h);
    this.broadcast(h, events, true);
    this.fireHooks(h, events);
    return { ...stored, replayed: false };
  }

  // ---------------------------------------------------------------- replays

  createReplay(input: { seed: number; scenarioId: "starter" | "fuel_squeeze" | "oil_shock_2026"; policyId: "diesel" | "diversified" | "gouger"; days: number; condition?: LabCondition }) {
    const id = replayId(input);
    const row = this.db.prepare("SELECT summary_json FROM replays WHERE replay_id = ?").get(id) as { summary_json: string } | undefined;
    if (row) return JSON.parse(row.summary_json);
    const trace = runReplay(input);
    this.db
      .prepare("INSERT OR REPLACE INTO replays (replay_id, summary_json, events_json, created_at) VALUES (?, ?, ?, ?)")
      .run(trace.summary.replayId, JSON.stringify(trace.summary), JSON.stringify(trace.events), nowIso());
    return trace.summary;
  }

  getReplay(id: string): { summary: any; events: EconomyEvent[] } {
    const row = this.db.prepare("SELECT summary_json, events_json FROM replays WHERE replay_id = ?").get(id) as { summary_json: string; events_json: string } | undefined;
    if (!row) throw new ApiError("NOT_FOUND", "Replay not found.");
    return { summary: JSON.parse(row.summary_json), events: JSON.parse(row.events_json) };
  }

  shutdown(): void {
    for (const h of this.runs.values()) this.snapshot(h, "latest");
  }
}
