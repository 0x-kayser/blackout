import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ActionResultSchema,
  CompareResponseSchema,
  GameStatePublicSchema,
  HealthResponseSchema,
  LedgerResponseSchema,
  MarketResponseSchema,
  PublicConfigSchema,
  ReplayResponseSchema,
  RunStateResponseSchema,
  StartSessionResponseSchema,
} from "@blackout/shared";
import { buildServer } from "../../apps/api/src/server.ts";
import { loadChainConfig } from "../../apps/api/src/chain.ts";

type Built = Awaited<ReturnType<typeof buildServer>>;
let built: Built;
let clock = 1_000_000;

async function session() {
  const r = await built.app.inject({ method: "POST", url: "/api/session/start", payload: {} });
  expect(r.statusCode).toBe(200);
  const body = StartSessionResponseSchema.parse(r.json());
  expect(r.headers["set-cookie"]).toContain("HttpOnly");
  return body.token;
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
let keyN = 0;
const key = () => `test-key-${++keyN}-${Date.now()}`;

async function newRun(token: string, seed = 424242) {
  const r = await built.app.inject({ method: "POST", url: "/api/runs", headers: auth(token), payload: { seed, mode: "guest_demo" } });
  expect(r.statusCode).toBe(200);
  return RunStateResponseSchema.parse(r.json()).state;
}
async function act(token: string, runId: string, action: object, k = key(), extra: object = {}) {
  const r = await built.app.inject({ method: "POST", url: `/api/runs/${runId}/actions`, headers: auth(token), payload: { action, idempotencyKey: k, ...extra } });
  return { status: r.statusCode, body: ActionResultSchema.parse(r.json()) };
}
function advance(runId: string, n: number) {
  const h = built.svc.get(runId);
  for (let i = 0; i < n; i++) built.svc.advanceOne(h);
}

beforeEach(async () => {
  built = await buildServer({ dbPath: ":memory:", chain: loadChainConfig({}), now: () => clock, allowedOrigins: ["http://localhost:5173"] });
});
afterEach(async () => {
  await built.app.close();
  built.db.close();
});

describe("session & runs", () => {
  it("requires a session and scopes runs to their owner", async () => {
    const noAuth = await built.app.inject({ method: "POST", url: "/api/runs", payload: {} });
    expect(noAuth.statusCode).toBe(401);
    expect(noAuth.json().error.code).toBe("UNAUTHORIZED");
    const a = await session();
    const b = await session();
    const st = await newRun(a);
    expect(() => GameStatePublicSchema.parse(st)).not.toThrow();
    const other = await built.app.inject({ method: "GET", url: `/api/runs/${st.run.runId}/state`, headers: auth(b) });
    expect(other.statusCode).toBe(403);
    const otherAct = await act(b, st.run.runId, { type: "READY" });
    expect(otherAct.status).toBe(403);
  });

  it("new runs start paused until a client connects; first outage arrives on the first tick", async () => {
    const t = await session();
    const st = await newRun(t);
    expect(st.clock.paused).toBe(true);
    expect(st.clock.pauseReason).toBe("no_clients");
    expect(st.clock.phase).toBe("operating");
    advance(st.run.runId, 1);
    const s2 = RunStateResponseSchema.parse((await built.app.inject({ method: "GET", url: `/api/runs/${st.run.runId}/state`, headers: auth(t) })).json()).state;
    const req = s2.requests[0];
    expect(req.businessId).toBe("cold_room");
    expect(req.requestedW).toBe(1500);
    expect(req.estimatedFuelMl).toBe(900);
    expect(req.estimatedCo2Mg).toBe(2_412_000);
    expect(req.expectedPaymentCc).toBe(2400);
  });
});

describe("Cold Room vertical slice over HTTP", () => {
  it("accept + assign -> service starts on the next tick -> exact accounting", async () => {
    const t = await session();
    const st = await newRun(t);
    const runId = st.run.runId;
    advance(runId, 1);
    const state = built.svc.publicState(built.svc.get(runId));
    const req = state.requests[0];
    const acc = await act(t, runId, { type: "ACCEPT_REQUEST", requestId: req.requestId });
    expect(acc.status).toBe(200);
    expect(acc.body.ok).toBe(true);
    if (!acc.body.ok) return;
    const contractId = acc.body.result.contractId as string;
    expect(acc.body.events.map((e) => e.type)).toContain("CONTRACT_ACCEPTED");
    const as = await act(t, runId, { type: "ASSIGN_CONTRACT", contractId, generatorId: "gen_1" });
    expect(as.body.ok).toBe(true);
    if (!as.body.ok) return;
    expect(as.body.events.map((e) => e.type)).toContain("LOAD_ASSIGNED");
    expect(as.body.events.map((e) => e.type)).not.toContain("SERVICE_STARTED");
    advance(runId, 1);
    const lit = built.svc.publicState(built.svc.get(runId));
    expect(lit.businesses.find((b) => b.businessId === "cold_room")!.powerSource).toBe("player");
    advance(runId, 19);
    const done = built.svc.publicState(built.svc.get(runId));
    const c = done.contracts.find((x) => x.contractId === contractId)!;
    expect(c.status).toBe("completed");
    expect(done.player.fuelMl).toBe(20_000 - 900);
    expect(done.player.creditsCc).toBe(100_000 + 2_400);
    // ledger + events are persisted and paginated
    const led = LedgerResponseSchema.parse((await built.app.inject({ method: "GET", url: `/api/runs/${runId}/ledger?asset=fuel_ml&limit=1000`, headers: auth(t) })).json());
    const burned = led.entries.filter((e) => e.to === "world:fuel_burned").reduce((a, e) => a + e.amount, 0);
    expect(burned).toBe(900);
    expect(led.events.some((e) => e.type === "SERVICE_STARTED")).toBe(true);
  });

  it("idempotency: the same key returns the original result and never applies twice", async () => {
    const t = await session();
    const st = await newRun(t);
    advance(st.run.runId, 1);
    const req = built.svc.publicState(built.svc.get(st.run.runId)).requests[0];
    const k = "same-key-123456";
    const a = await act(t, st.run.runId, { type: "ACCEPT_REQUEST", requestId: req.requestId }, k);
    const b = await act(t, st.run.runId, { type: "ACCEPT_REQUEST", requestId: req.requestId }, k);
    expect(a.body.ok && b.body.ok).toBe(true);
    if (!a.body.ok || !b.body.ok) return;
    expect(b.body.replayed).toBe(true);
    expect(b.body.result.contractId).toBe(a.body.result.contractId);
    const contracts = built.svc.publicState(built.svc.get(st.run.runId)).contracts;
    expect(contracts).toHaveLength(1);
    // a NEW key for the same request is a different intent -> ALREADY_PROCESSED from the sim
    const c = await act(t, st.run.runId, { type: "ACCEPT_REQUEST", requestId: req.requestId });
    expect(c.status).toBe(409);
    expect(!c.body.ok && c.body.error.code).toBe("ALREADY_PROCESSED");
  });

  it("stale expectedStateVersion is rejected with STALE_STATE", async () => {
    const t = await session();
    const st = await newRun(t);
    const r = await act(t, st.run.runId, { type: "SET_TARIFF", districtId: "market_quarter", rateCcPerKwh: 900 }, key(), { expectedStateVersion: st.run.stateVersion + 5 });
    expect(r.status).toBe(409);
    expect(!r.body.ok && r.body.error.code).toBe("STALE_STATE");
  });

  it("rejects oversize/invalid payloads and client-supplied prices", async () => {
    const t = await session();
    const st = await newRun(t);
    const big = await built.app.inject({ method: "POST", url: `/api/runs/${st.run.runId}/actions`, headers: auth(t), payload: { action: { type: "BUY", quoteId: "q", quantity: 10_000_000 }, idempotencyKey: key() } });
    expect(big.statusCode).toBe(400);
    expect(big.json().error.code).toBe("VALIDATION_FAILED");
    const unknown = await built.app.inject({ method: "POST", url: `/api/runs/${st.run.runId}/actions`, headers: auth(t), payload: { action: { type: "SETTLE_TRADE", tradeId: "t", outcome: "confirmed", txHash: "x", error: null }, idempotencyKey: key() } });
    expect(unknown.statusCode).toBe(400); // system actions are not accepted from clients
    const badOrigin = await built.app.inject({ method: "POST", url: `/api/runs/${st.run.runId}/actions`, headers: { ...auth(t), origin: "https://evil.example" }, payload: { action: { type: "READY" }, idempotencyKey: key() } });
    expect(badOrigin.statusCode).toBe(403);
  });
});

describe("market over HTTP", () => {
  it("quote -> buy -> merchant stock down, quote up, reasons exposed; expired quote fails", async () => {
    const t = await session();
    const st = await newRun(t);
    const runId = st.run.runId;
    advance(runId, 255); // to day 2 morning
    const m0 = MarketResponseSchema.parse((await built.app.inject({ method: "GET", url: `/api/runs/${runId}/market`, headers: auth(t) })).json());
    expect(m0.marketOpen).toBe(true);
    const lantern0 = m0.merchants.find((m) => m.merchantId === "lantern")!;
    expect(lantern0.reasons.explanation).toContain("Import cost");
    const q = await built.app.inject({ method: "POST", url: `/api/runs/${runId}/quote`, headers: auth(t), payload: { sellerId: "merchant:lantern", item: "diesel", quantity: 20_000, idempotencyKey: key() } });
    const qb = ActionResultSchema.parse(q.json());
    if (!qb.ok) throw new Error("quote failed");
    const quote = qb.result.quote as { quoteId: string; unitPriceCc: number };
    expect(quote.unitPriceCc).toBe(lantern0.quoteCcPerL);
    const buy = await act(t, runId, { type: "BUY", quoteId: quote.quoteId, quantity: 20_000 });
    expect(buy.body.ok).toBe(true);
    const bought = buy.body;
    if (!bought.ok) return;
    const trade = bought.state.trades.find((x) => x.tradeId === bought.result.tradeId)!;
    expect(trade).not.toHaveProperty("chainStatus");
    expect(trade).not.toHaveProperty("txHash");
    const lantern1 = bought.state.merchants.find((m) => m.merchantId === "lantern")!;
    expect(lantern1.stockMl).toBe(lantern0.stockMl - 20_000);
    expect(lantern1.quoteCcPerL).toBeGreaterThan(lantern0.quoteCcPerL);
    // quote expiry is server-controlled
    const q2 = ActionResultSchema.parse((await built.app.inject({ method: "POST", url: `/api/runs/${runId}/quote`, headers: auth(t), payload: { sellerId: "merchant:ember", item: "diesel", quantity: 1_000, idempotencyKey: key() } })).json());
    if (!q2.ok) throw new Error("quote failed");
    advance(runId, 16);
    const q2id = (q2.result.quote as { quoteId: string }).quoteId;
    const late = await act(t, runId, { type: "BUY", quoteId: q2id, quantity: 1_000 });
    expect(late.body.ok).toBe(false);
    expect(!late.body.ok && ["QUOTE_EXPIRED", "INVALID_PHASE"]).toContain(!late.body.ok && late.body.error.code);
  });
});

describe("restart recovery", () => {
  it("a restored run reproduces the same state and does not double-apply actions", async () => {
    const t = await session();
    const st = await newRun(t, 777);
    const runId = st.run.runId;
    advance(runId, 1);
    const req = built.svc.publicState(built.svc.get(runId)).requests[0];
    await act(t, runId, { type: "ACCEPT_REQUEST", requestId: req.requestId, generatorId: "gen_1" });
    advance(runId, 12);
    const live = built.svc.get(runId).state;
    // simulate a crash: drop the in-memory run and reload from snapshot + action log
    built.svc.runs.delete(runId);
    const restored = built.svc.get(runId).state;
    // restored state is at the last snapshot (action time), behind live; replay forward to compare
    while (restored.tick < live.tick) built.svc.advanceOne(built.svc.get(runId));
    expect(JSON.stringify(built.svc.get(runId).state)).toBe(JSON.stringify(live));
    const evCount = built.db.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = ?").get(runId) as { n: number };
    expect(evCount.n).toBe(live.eventSeq); // no duplicated events after re-execution
  });
});

describe("observatory", () => {
  it("replays are deterministic, labelled simulation-only, and comparable", async () => {
    const r1 = ReplayResponseSchema.parse((await built.app.inject({ method: "POST", url: "/api/replays", payload: { seed: 424242, policyId: "diesel", days: 7 } })).json());
    expect(r1.replay.label).toBe("SIMULATED FUTURE SCENARIO — no blockchain settlement");
    expect(r1.replay.daily).toHaveLength(7);
    const cmp = CompareResponseSchema.parse((await built.app.inject({ method: "POST", url: "/api/replays/compare", payload: { seed: 424242, policies: ["diesel", "diversified"], days: 7 } })).json());
    expect(cmp.a.traceHash).toBe(r1.replay.traceHash);
    expect(cmp.differences.length).toBeGreaterThan(0);
    const trace = (await built.app.inject({ method: "GET", url: `/api/replays/${r1.replay.replayId}/events?format=json` })).json();
    expect(trace.events.every((e: { source: string }) => e.source === "replay_simulation")).toBe(true);
    expect(trace.events.some((e: { txHash: string | null }) => e.txHash)).toBe(false);
  });
});

describe("operator chain evidence, health, config", () => {
  it("keeps chain status and transaction evidence behind operator access", async () => {
    const cs = await built.app.inject({ method: "GET", url: "/api/chain/status" });
    expect(cs.statusCode).toBe(403);
    const tr = await built.app.inject({ method: "GET", url: "/api/chain/transfers/4ZbV4k1Tcv1oWy1hoxUo4o9b2cUqGgYyU6wF7pK2ZWwz" });
    expect(tr.statusCode).toBe(403);
    const h = HealthResponseSchema.parse((await built.app.inject({ method: "GET", url: "/api/health" })).json());
    expect(h.db).toBe("ok");
    expect(h).not.toHaveProperty("chain");
    const c = PublicConfigSchema.parse((await built.app.inject({ method: "GET", url: "/api/config/public" })).json());
    expect(c.timing.operatingTicks).toBe(240);
    expect(c.auth).not.toHaveProperty("x");
    expect(c.auth.supabaseUrl).toBeNull();
    expect(JSON.stringify(c)).not.toMatch(/PRIVATE|secret|ed25519:/i);
  });
});
