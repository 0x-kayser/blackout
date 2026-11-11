/**
 * RegionService: live regional power systems. Owns the clock (1 interval per real second while someone is watching),
 * idempotent actions, persistence (snapshot + action log, resumable after a restart), world inputs as recorded
 * system actions, settlement epochs and the weekly challenge leaderboard. The engine stays pure.
 */
import { randomInt } from "node:crypto";
import type { AnyRegionAction, RegionAction, RegionActionResult, RegionView, WorldSnapshot } from "@blackout/shared";
import { SimError, region } from "@blackout/sim";
import { challengeFor, isoWeek } from "./challenge.ts";
import { nowIso, tx, type Db } from "./db.ts";
import { ApiError } from "./services.ts";
import type { WorldInputProvider } from "./world.ts";
import type { TownService } from "./town.ts";

type RegionState = region.RegionState;

export const REGION_AUTO_PAUSE_MS = 15_000;
const CHECKPOINT_EVERY = 5;

export interface RegionHandle {
  regionId: string;
  ownerId: string;
  mode: "live" | "challenge";
  week: string | null;
  state: RegionState;
  listeners: Set<(v: RegionView) => void>;
  lastClientAt: number;
  playerPaused: boolean;
  actionSeq: number;
  ticksSinceCheckpoint: number;
  lastEpochNo: number;
  /** First minute: the clock waits for the player, then runs a few intervals so each tap visibly lands. */
  onboardingBudget: number;
}

/** Intervals the clock runs after each first-minute decision. */
export const ONBOARDING_TICKS_PER_ACTION = 4;

export interface SettlementSink {
  /** Whether epochs should be queued for on-chain settlement ('pending') or only kept locally ('local'). */
  enabled: boolean;
}

export class RegionService {
  readonly regions = new Map<string, RegionHandle>();
  /** The shared market; set by the server after both services exist. */
  town: TownService | null = null;

  /** The name other players see: the company name once chosen, never a personal name before that. */
  nameOf(userId: string): string {
    const r = this.db.prepare("SELECT display_name, company_named FROM players WHERE player_id = ?").get(userId) as { display_name: string; company_named: number } | undefined;
    return r?.company_named ? r.display_name : "An unnamed power company";
  }

  constructor(
    private readonly db: Db,
    readonly world: WorldInputProvider,
    private readonly settlement: SettlementSink = { enabled: false },
    private readonly now: () => number = Date.now,
  ) {}

  challengeInfo() {
    const week = isoWeek(new Date(this.now()));
    const challenge = challengeFor(week);
    const regional = region.REGION_CHALLENGES[challenge.condition];
    return { week, name: regional.name, description: regional.description };
  }

  /* ---------------------------------------------------------------- lookup & creation */

  liveFor(userId: string): RegionHandle {
    for (const h of this.regions.values()) if (h.ownerId === userId && h.mode === "live") return h;
    const row = this.db.prepare("SELECT region_id FROM regions WHERE owner_id = ? AND mode = 'live' ORDER BY created_at DESC LIMIT 1").get(userId) as { region_id: string } | undefined;
    if (row) return this.get(row.region_id);
    return this.create(userId, "live");
  }

  create(userId: string, mode: "live" | "challenge"): RegionHandle {
    const week = mode === "challenge" ? isoWeek(new Date(this.now())) : null;
    const challenge = mode === "challenge" ? challengeFor(week!) : null;
    const seed = challenge?.seed ?? randomInt(1, 2 ** 31 - 1);
    const regionId = `r_${randomInt(1, 2 ** 47).toString(36)}${randomInt(1, 2 ** 31).toString(36)}`;
    const snapshot = challenge ? region.regionChallengeSnapshot(challenge.condition) : this.world.current();
    const state = region.createRegion({ regionId, seed, mode, snapshot });
    const at = nowIso();
    this.db
      .prepare("INSERT INTO regions (region_id, owner_id, mode, week, seed, state_json, state_version, interval_no, ended, score, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)")
      .run(regionId, userId, mode, week, seed, JSON.stringify(state), state.stateVersion, state.interval, at, at);
    const h = this.handle(regionId, userId, mode, week, state, 0);
    return h;
  }

  get(regionId: string): RegionHandle {
    const live = this.regions.get(regionId);
    if (live) return live;
    const row = this.db.prepare("SELECT owner_id, mode, week, state_json FROM regions WHERE region_id = ?").get(regionId) as { owner_id: string; mode: "live" | "challenge"; week: string | null; state_json: string } | undefined;
    if (!row) throw new ApiError("NOT_FOUND", "No such region.");
    const seq = (this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM region_actions WHERE region_id = ?").get(regionId) as { n: number }).n;
    return this.handle(regionId, row.owner_id, row.mode, row.week, region.ensureRegion(JSON.parse(row.state_json) as RegionState), seq);
  }

  requireOwner(regionId: string, userId: string): RegionHandle {
    const h = this.get(regionId);
    if (h.ownerId !== userId) throw new ApiError("FORBIDDEN", "That region belongs to someone else.");
    return h;
  }

  private handle(regionId: string, ownerId: string, mode: "live" | "challenge", week: string | null, state: RegionState, actionSeq: number): RegionHandle {
    const h: RegionHandle = { regionId, ownerId, mode, week, state, listeners: new Set(), lastClientAt: 0, playerPaused: false, actionSeq, ticksSinceCheckpoint: 0, lastEpochNo: state.epochs.at(-1)?.epochNo ?? 0, onboardingBudget: 0 };
    this.regions.set(regionId, h);
    return h;
  }

  /* ---------------------------------------------------------------- views */

  isRunning(h: RegionHandle): boolean {
    if (!h.state.onboarding.done && h.state.mode === "live" && h.onboardingBudget <= 0) return false;
    return !h.playerPaused && !h.state.ended && (h.listeners.size > 0 || this.now() - h.lastClientAt < REGION_AUTO_PAUSE_MS);
  }

  view(h: RegionHandle): RegionView {
    const view = region.toRegionView(h.state, { paused: !this.isRunning(h) });
    // Settlement evidence belongs to the operator audit endpoint, not the player session payload.
    view.settlement.epochs = [];
    return view;
  }

  subscribe(h: RegionHandle, fn: (v: RegionView) => void): () => void {
    h.listeners.add(fn);
    h.lastClientAt = this.now();
    return () => {
      h.listeners.delete(fn);
      h.lastClientAt = this.now();
    };
  }

  /* ---------------------------------------------------------------- clock */

  /** One driver beat: every watched, unpaused region advances one interval. */
  driverStep(): number {
    let n = 0;
    for (const h of this.regions.values()) {
      if (h.listeners.size > 0) h.lastClientAt = this.now();
      if (!this.isRunning(h)) continue;
      this.advance(h);
      n++;
    }
    return n;
  }

  advance(h: RegionHandle): void {
    const ctx = region.newRCtx(20);
    region.regionTick(h.state, ctx);
    if (h.onboardingBudget > 0) h.onboardingBudget -= 1;
    if (this.town && h.mode === "live") {
      this.town.serviceRegion({ userId: h.ownerId, name: this.nameOf(h.ownerId) }, h, this);
      // the steel mills in players' regions feed Pavel's yard: their average output is the market's steel supply
      if (h.state.interval % 36 === 0) {
        const live = [...this.regions.values()].filter((x) => x.mode === "live");
        this.town.setSteelSupply(live.reduce((a, x) => a + x.state.actors.steel.productionBps, 0) / Math.max(1, live.length));
      }
    }
    h.ticksSinceCheckpoint += 1;
    this.persistEpochs(h);
    if (h.ticksSinceCheckpoint >= CHECKPOINT_EVERY || h.state.ended) this.checkpoint(h);
    this.broadcast(h);
  }

  broadcast(h: RegionHandle): void {
    if (!h.listeners.size) return;
    const v = this.view(h);
    for (const fn of h.listeners) fn(v);
  }

  checkpoint(h: RegionHandle): void {
    // Wallet and custody boundaries may force-close an epoch between simulation ticks; persist it before the state
    // snapshot so a paused region cannot strand a settlement only in memory.
    this.persistEpochs(h);
    const score = h.state.ended ? region.regionScore(h.state).score : null;
    this.db
      .prepare("UPDATE regions SET state_json = ?, state_version = ?, interval_no = ?, ended = ?, score = COALESCE(?, score), updated_at = ? WHERE region_id = ?")
      .run(JSON.stringify(h.state), h.state.stateVersion, h.state.interval, h.state.ended ? 1 : 0, score, nowIso(), h.regionId);
    h.ticksSinceCheckpoint = 0;
  }

  private persistEpochs(h: RegionHandle): void {
    const fresh = h.state.epochs.filter((e) => e.epochNo > h.lastEpochNo);
    if (!fresh.length) return;
    const at = nowIso();
    const ins = this.db.prepare("INSERT OR IGNORE INTO settlement_epochs (epoch_id, region_id, epoch_no, from_interval, to_interval, hash, body_json, status, tx_hash, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)");
    for (const e of fresh) ins.run(e.epochId, h.regionId, e.epochNo, e.fromInterval, e.toInterval, e.hash, JSON.stringify(e), this.settlement.enabled ? "pending" : "local", at, at);
    h.lastEpochNo = fresh[fresh.length - 1].epochNo;
  }

  /* ---------------------------------------------------------------- actions */

  act(h: RegionHandle, action: RegionAction | AnyRegionAction, idempotencyKey: string, source: "player" | "system" = "player", expectedVersion?: number): RegionActionResult {
    const prior = this.db.prepare("SELECT result_json FROM region_actions WHERE region_id = ? AND idempotency_key = ?").get(h.regionId, idempotencyKey) as { result_json: string } | undefined;
    if (prior) return { ...(JSON.parse(prior.result_json) as RegionActionResult), replayed: true, view: this.view(h) };
    if (expectedVersion !== undefined && expectedVersion < h.state.stateVersion - 600) throw new ApiError("STALE_STATE", "Your view is out of date; refresh.");
    let result: RegionActionResult;
    if (action.type === "PAUSE" || action.type === "RESUME") {
      h.playerPaused = action.type === "PAUSE";
      if (!h.playerPaused) h.lastClientAt = this.now();
      result = { ok: true, version: h.state.stateVersion, message: h.playerPaused ? "Paused." : "Running." };
    } else {
      const ctx = region.newRCtx(20);
      // buy what the decision needs (steel to build, kits to repair) from Vesper Market first
      let prepError: SimError | null = null;
      if (source === "player" && this.town && h.mode === "live") {
        try {
          this.town.prepare({ userId: h.ownerId, name: this.nameOf(h.ownerId) }, h, this, action as RegionAction);
        } catch (e) {
          if (e instanceof SimError) prepError = e;
          else throw e;
        }
      }
      const before = JSON.stringify(h.state);
      try {
        if (prepError) throw prepError;
        const r = region.regionAct(h.state, ctx, action);
        result = { ok: true, version: h.state.stateVersion, message: r.message };
      } catch (e) {
        // a refused action leaves no trace in the state
        h.state = JSON.parse(before) as RegionState;
        if (e instanceof SimError) result = { ok: false, version: h.state.stateVersion, error: { code: e.code, message: e.message } };
        else throw e;
      }
    }
    tx(this.db, () => {
      h.actionSeq += 1;
      this.db
        .prepare("INSERT INTO region_actions (region_id, seq, interval_no, idempotency_key, source, action_json, ok, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(h.regionId, h.actionSeq, h.state.interval, idempotencyKey, source, JSON.stringify(action), result.ok ? 1 : 0, JSON.stringify(result), nowIso());
    });
    if (result.ok && source === "player" && !h.state.onboarding.done) h.onboardingBudget = ONBOARDING_TICKS_PER_ACTION;
    if (result.ok) this.checkpoint(h);
    this.broadcast(h);
    return { ...result, view: this.view(h) };
  }

  /** New real-world inputs reach every live region as a recorded system action (replays stay exact). */
  applyWorld(snap: WorldSnapshot): number {
    let n = 0;
    for (const h of this.regions.values()) {
      if (h.mode !== "live" || h.state.ended) continue;
      if (h.state.input.capturedAt === snap.capturedAt && h.state.input.source === snap.source) continue;
      this.act(h, { type: "WORLD_INPUT", snapshot: snap }, `world:${snap.capturedAt}:${snap.source}`, "system");
      n++;
    }
    return n;
  }

  /* ---------------------------------------------------------------- challenge & settlement */

  leaderboard(week = isoWeek(new Date(this.now())), limit = 20) {
    const rows = this.db
      .prepare("SELECT r.region_id, r.owner_id, r.score, r.state_json, CASE WHEN p.company_named = 1 THEN p.display_name ELSE 'An unnamed power company' END AS name FROM regions r LEFT JOIN players p ON p.player_id = r.owner_id WHERE r.mode = 'challenge' AND r.week = ? AND r.ended = 1 ORDER BY r.score DESC LIMIT ?")
      .all(week, limit) as { region_id: string; owner_id: string; score: number; state_json: string; name: string }[];
    return rows.map((r, i) => {
      const s = JSON.parse(r.state_json) as RegionState;
      const sc = region.regionScore(s);
      return { rank: i + 1, regionId: r.region_id, playerId: r.owner_id, name: r.name, score: r.score, profitCc: sc.profitCc, unservedMWh: sc.unservedMWh, emissionsT: sc.emissionsT, regionOutputBps: sc.regionOutputBps };
    });
  }

  epochs(regionId: string, limit = 24) {
    const rows = this.db.prepare("SELECT body_json, status, tx_hash, attempts, last_error FROM settlement_epochs WHERE region_id = ? ORDER BY epoch_no DESC LIMIT ?").all(regionId, limit) as { body_json: string; status: string; tx_hash: string | null; attempts: number; last_error: string | null }[];
    return rows.map((r) => {
      const e = JSON.parse(r.body_json) as region.REpoch;
      return { ...e, status: r.status, txHash: r.tx_hash, attempts: r.attempts, lastError: r.last_error, verified: region.verifyEpoch(e) };
    });
  }

  shutdown(): void {
    for (const h of this.regions.values()) this.checkpoint(h);
  }
}

export function startRegionDriver(rsvc: RegionService, intervalMs = 1_000): () => void {
  const t = setInterval(() => {
    try {
      rsvc.driverStep();
    } catch (e) {
      console.error("region driver", e);
    }
  }, intervalMs);
  let worldTimer: NodeJS.Timeout | null = null;
  const pullWorld = async () => {
    try {
      const snap = await rsvc.world.getSnapshot();
      rsvc.applyWorld(snap);
      rsvc.town?.applyWorld(snap);
    } catch {
      /* the provider already falls back */
    }
  };
  void pullWorld();
  worldTimer = setInterval(pullWorld, 5 * 60_000);
  return () => {
    clearInterval(t);
    if (worldTimer) clearInterval(worldTimer);
  };
}
