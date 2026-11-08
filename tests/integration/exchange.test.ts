import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../apps/api/src/server.ts";
import { exchangeCall, loadChainConfig, type ChainConfig, type SubmitResult } from "../../apps/api/src/chain.ts";
import { processExchangeJobs, type ExchangeDeps } from "../../apps/api/src/workers.ts";
import { reconcileExchange } from "../../apps/api/src/reconciler.ts";
import { EXCHANGE_TRADER_IDS, playerChainId } from "../../apps/api/src/chain.ts";

type Built = Awaited<ReturnType<typeof buildServer>>;
let built: Built | null = null;
afterEach(async () => {
  if (built) {
    await built.app.close();
    built.db.close();
    built = null;
  }
});

const H = (t: string) => ({ authorization: `Bearer ${t}` });
let n = 0;
const key = () => `xkey-${++n}-${Date.now()}`;

async function sandbox(allowGuests = true) {
  built = await buildServer({ dbPath: ":memory:", chain: loadChainConfig({}), allowedOrigins: [], webDist: null, exchangeAllowGuests: allowGuests });
  return built;
}

async function player(b: Built) {
  const token = (await b.app.inject({ method: "POST", url: "/api/session/start", payload: {} })).json().token as string;
  const g = await b.app.inject({ method: "POST", url: "/api/game/start", headers: H(token), payload: { scenarioId: "starter" } });
  expect(g.statusCode).toBe(200);
  const runId = g.json().state.run.runId as string;
  return { token, runId, h: () => b.svc.get(runId) };
}

async function buyDiesel(b: Built, token: string, quantityMl: number) {
  const q = await b.app.inject({ method: "POST", url: "/api/game/actions", headers: H(token), payload: { action: { type: "REQUEST_QUOTE", sellerId: "merchant:ember", item: "diesel", quantity: quantityMl }, idempotencyKey: key() } });
  expect(q.statusCode).toBe(200);
  const r = await b.app.inject({ method: "POST", url: "/api/game/actions", headers: H(token), payload: { action: { type: "BUY", quoteId: q.json().result.quoteId, quantity: quantityMl }, idempotencyKey: key() } });
  expect(r.statusCode).toBe(200);
  return r.json();
}

const post = (b: Built, token: string, url: string, payload: object) => b.app.inject({ method: "POST", url, headers: H(token), payload });
const credits = (b: Built, runId: string) => b.svc.get(runId).state.balances.credits_cc.player;
const fuel = (b: Built, runId: string) => b.svc.get(runId).state.balances.fuel_ml.player;
/** Today's "Sell fuel on the Exchange" goal (if rotated in) also pays the seller once. */
const sellGoalReward = (b: Built, runId: string) => b.svc.publicState(b.svc.get(runId)).goals.items.find((g) => g.kind === "exchange_sell" && !g.done)?.rewardCc ?? 0;

describe("shared exchange (sandbox: no Testnet exchange configured)", () => {
  it("player A moves bought fuel to the exchange and lists it; player B buys it and takes it home", async () => {
    const b = await sandbox();
    const alice = await player(b);
    const bob = await player(b);
    await buyDiesel(b, alice.token, 10_000);

    const view = (await b.app.inject({ method: "GET", url: "/api/exchange", headers: H(alice.token) })).json();
    expect(view).toMatchObject({ ok: true, mode: "sandbox", canTrade: true, depositableFuelMl: 10_000 });
    expect(view.note).toMatch(/no transaction hashes/);

    // starter fuel cannot leave the city; bought fuel can, once per idempotency key
    const fuel0 = fuel(b, alice.runId);
    const k = key();
    const dep = await post(b, alice.token, "/api/exchange/deposit", { quantityMl: 10_000, idempotencyKey: k });
    expect(dep.statusCode).toBe(200);
    expect(dep.json()).toMatchObject({ replayed: false, exchange: { me: { warehouseMl: 10_000, pendingDepositMl: 0 } }, state: { player: { exchangeDepositableFuelMl: 0 } } });
    expect(fuel(b, alice.runId)).toBe(fuel0 - 10_000);
    const again = await post(b, alice.token, "/api/exchange/deposit", { quantityMl: 10_000, idempotencyKey: k });
    expect(again.json().replayed).toBe(true);
    expect(fuel(b, alice.runId)).toBe(fuel0 - 10_000);
    const starter = await post(b, alice.token, "/api/exchange/deposit", { quantityMl: 1_000, idempotencyKey: key() });
    expect(starter.statusCode).toBe(422);
    expect(starter.json().error).toMatchObject({ code: "INSUFFICIENT_FUEL" });
    expect(starter.json().error.message).toMatch(/Starter fuel stays in the city/);

    // a price no trader would pay, so only a player can take it
    const ask = await post(b, alice.token, "/api/exchange/asks", { quantityMl: 8_000, unitPriceCcPerL: 1_500, idempotencyKey: key() });
    expect(ask.statusCode).toBe(200);
    const orderId = ask.json().orderId as string;
    expect(ask.json().exchange.me.orders[0]).toMatchObject({ orderId, status: "open", quantityMl: 8_000 });
    // band check comes from the engine and reaches the player as a clear error
    const silly = await post(b, alice.token, "/api/exchange/asks", { quantityMl: 1_000, unitPriceCcPerL: 100, idempotencyKey: key() });
    expect(silly.json().error.message).toMatch(/between 5.00 and 30.00/);

    const quote = (await post(b, bob.token, "/api/exchange/quote", { quantityMl: 8_000 })).json().quote;
    expect(quote).toMatchObject({ quantityMl: 8_000, totalCc: 12_000 });
    const aliceCredits0 = credits(b, alice.runId);
    const aliceGoal = sellGoalReward(b, alice.runId);
    const bobCredits0 = credits(b, bob.runId);
    const buyKey = key();
    const buy = await post(b, bob.token, "/api/exchange/buy", { quantityMl: 8_000, idempotencyKey: buyKey });
    expect(buy.statusCode).toBe(200);
    expect(buy.json()).toMatchObject({ totalCc: 12_000, replayed: false, exchange: { me: { warehouseMl: 8_000 } }, state: { player: { exchangeReservedCc: 0 } } });
    expect(credits(b, bob.runId)).toBe(bobCredits0 - 12_000);
    // the seller's city is paid even though the seller did nothing
    expect(credits(b, alice.runId)).toBe(aliceCredits0 + 12_000 + aliceGoal);
    if (aliceGoal) expect(b.svc.publicState(b.svc.get(alice.runId)).goals.items.find((g) => g.kind === "exchange_sell")!.done).toBe(true);
    expect((await post(b, bob.token, "/api/exchange/buy", { quantityMl: 8_000, idempotencyKey: buyKey })).json().replayed).toBe(true);
    expect(credits(b, bob.runId)).toBe(bobCredits0 - 12_000);

    const bobFuel0 = fuel(b, bob.runId);
    const red = await post(b, bob.token, "/api/exchange/redeem", { quantityMl: 8_000, idempotencyKey: key() });
    expect(red.statusCode).toBe(200);
    expect(fuel(b, bob.runId)).toBe(bobFuel0 + 8_000);
    // fuel that came through the market may go back to it
    expect(red.json().state.player.exchangeDepositableFuelMl).toBeGreaterThanOrEqual(8_000);
    // tank room is checked first, then what the warehouse actually holds
    const noRoom = await post(b, bob.token, "/api/exchange/redeem", { quantityMl: 60_000, idempotencyKey: key() });
    expect(noRoom.json().error.code).toBe("TANK_FULL");
    const empty = await post(b, bob.token, "/api/exchange/redeem", { quantityMl: 1_000, idempotencyKey: key() });
    expect(empty.json().error.code).toBe("INSUFFICIENT_FUEL");

    // Alice sees what happened while she was away
    const mine = (await b.app.inject({ method: "GET", url: "/api/exchange", headers: H(alice.token) })).json().me;
    expect(mine.recent.map((e: { type: string }) => e.type)).toContain("FILL_SETTLED");
    expect(mine.orders.find((o: { orderId: string }) => o.orderId === orderId).filledMl).toBe(8_000);
    // every city change is a recorded, replayable system action
    const actions = b.db.prepare("SELECT action_json FROM actions WHERE run_id = ? AND source = 'chain_worker'").all(alice.runId) as { action_json: string }[];
    expect(actions.map((a) => JSON.parse(a.action_json).type)).toEqual(expect.arrayContaining(["EXCHANGE_DEPOSIT", "EXCHANGE_EFFECT"]));
    expect(b.db.prepare("SELECT COUNT(*) AS c FROM exchange_city_effects WHERE status != 'applied'").get()).toEqual({ c: 0 });
    expect(b.db.prepare("SELECT COUNT(*) AS c FROM exchange_jobs").get()).toEqual({ c: 0 });
  });

  it("a trader finds a cheap player ask on its own and pays the seller's city", async () => {
    const b = await sandbox();
    const alice = await player(b);
    await buyDiesel(b, alice.token, 10_000);
    await post(b, alice.token, "/api/exchange/deposit", { quantityMl: 10_000, idempotencyKey: key() });
    await post(b, alice.token, "/api/exchange/asks", { quantityMl: 10_000, unitPriceCcPerL: 900, idempotencyKey: key() });
    const before = credits(b, alice.runId);
    const goal = sellGoalReward(b, alice.runId);
    const events = b.xsvc.tick();
    expect(events.some((e) => e.type === "FILL_SETTLED" && e.actors.includes(`player:${b.svc.get(alice.runId).ownerId}`))).toBe(true);
    expect(credits(b, alice.runId)).toBe(before + 9_000 + goal);
    const book = (await b.app.inject({ method: "GET", url: "/api/exchange", headers: H(alice.token) })).json().book;
    expect(book.traders.length).toBe(EXCHANGE_TRADER_IDS.length);
    expect(book.traders[0].explanation).toMatch(/Import cost/);
    expect(book.asks.length).toBeGreaterThan(0);
  });

  it("links every town to the trader wallets: restocks draw on traders and each new day records their price premium", async () => {
    const b = await sandbox();
    const alice = await player(b);
    const h = alice.h();
    const traderStock = () => Object.keys(b.xsvc.state.traders).reduce((a, id) => a + (b.xsvc.state.balances.fuel_ml[`trader:${id}`] ?? 0), 0);
    b.xsvc.tick();
    const before = traderStock();
    for (let i = 0; i < 260 && h.state.day < 2; i++) b.svc.advanceOne(h);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.state.day).toBe(2);
    const supplied = b.db.prepare("SELECT COUNT(*) AS c FROM exchange_events WHERE type = 'CITY_SUPPLIED'").get() as { c: number };
    const restocked = b.db.prepare("SELECT COUNT(*) AS c FROM events WHERE run_id = ? AND type = 'MERCHANT_RESTOCK_ORDERED'").get(alice.runId) as { c: number };
    if (restocked.c > 0) {
      expect(supplied.c).toBeGreaterThan(0);
      expect(traderStock()).toBeLessThan(before);
    }
    const signal = b.db.prepare("SELECT action_json FROM actions WHERE run_id = ? AND source = 'chain_worker'").all(alice.runId) as { action_json: string }[];
    expect(signal.map((r) => JSON.parse(r.action_json).type)).toContain("EXCHANGE_PRICE_SIGNAL");
  });

  it("stops acting for a player who took self-custody of their warehouse", async () => {
    const b = await sandbox();
    const alice = await player(b);
    await buyDiesel(b, alice.token, 5_000);
    const ownerId = b.svc.get(alice.runId).ownerId;
    b.db.prepare("INSERT INTO player_chain_ids (player_id, chain_id, created_at, self_custody) VALUES (?, ?, ?, 1)").run(ownerId, "pabc.vault.testnet", new Date().toISOString());
    const r = await post(b, alice.token, "/api/exchange/deposit", { quantityMl: 1_000, idempotencyKey: key() });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toMatch(/your own NEAR account/);
  });

  it("rejects a purchase that cannot be filled without touching the buyer's credits", async () => {
    const b = await sandbox();
    const bob = await player(b);
    const c0 = credits(b, bob.runId);
    const r = await post(b, bob.token, "/api/exchange/buy", { quantityMl: 5_000, idempotencyKey: key() });
    expect(r.json().error.code).toBe("OUT_OF_STOCK");
    expect(credits(b, bob.runId)).toBe(c0);
  });

  it("lets guests browse but not trade unless the server allows it", async () => {
    const b = await sandbox(false);
    const g = await player(b);
    const view = (await b.app.inject({ method: "GET", url: "/api/exchange", headers: H(g.token) })).json();
    expect(view).toMatchObject({ canTrade: false, blockedReason: expect.stringMatching(/Sign in with Google or email/) });
    expect(view.book).toBeTruthy();
    const r = await post(b, g.token, "/api/exchange/deposit", { quantityMl: 1_000, idempotencyKey: key() });
    expect(r.statusCode).toBe(403);
  });

  it("survives a restart: the exchange and its effects reload from SQLite", async () => {
    const path = join(tmpdir(), `bo-exchange-${process.pid}-${Date.now()}.sqlite`);
    built = await buildServer({ dbPath: path, chain: loadChainConfig({}), allowedOrigins: [], webDist: null, exchangeAllowGuests: true });
    const alice = await player(built);
    await buyDiesel(built, alice.token, 10_000);
    await post(built, alice.token, "/api/exchange/deposit", { quantityMl: 10_000, idempotencyKey: key() });
    built.xsvc.tick();
    const tick = built.xsvc.state.tick;
    built.svc.shutdown();
    await built.app.close();
    built.db.close();
    built = await buildServer({ dbPath: path, chain: loadChainConfig({}), allowedOrigins: [], webDist: null, exchangeAllowGuests: true });
    expect(built.xsvc.state.tick).toBe(tick);
    const me = (await built.app.inject({ method: "GET", url: "/api/exchange", headers: H(alice.token) })).json().me;
    expect(me.warehouseMl).toBe(10_000);
    await built.app.close();
    built.db.close();
    built = null;
    for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
  });
});

// ---------------------------------------------------------------- Testnet mode against a fake RPC

const fakeEnv = {
  NEAR_CHAIN_ENABLED: "true",
  NEAR_RPC_URL: "http://127.0.0.1:1/fake",
  NEAR_RESOURCE_CONTRACT_ID: "resources.blackout-test.testnet",
  NEAR_VAULT_ACCOUNT_ID: "vault.blackout-test.testnet",
  NEAR_VAULT_OPERATOR_PRIVATE_KEY: "ed25519:fake-vault-operator",
  NEAR_MERCHANT_EMBER_ACCOUNT_ID: "ember.blackout-test.testnet",
  NEAR_MERCHANT_EMBER_PRIVATE_KEY: "ed25519:fake",
  NEAR_MERCHANT_LANTERN_ACCOUNT_ID: "lantern.blackout-test.testnet",
  NEAR_MERCHANT_LANTERN_PRIVATE_KEY: "ed25519:fake",
  NEAR_MERCHANT_HARBOR_ACCOUNT_ID: "harbor.blackout-test.testnet",
  NEAR_MERCHANT_HARBOR_PRIVATE_KEY: "ed25519:fake",
  // every exchange trader gets its own (fake) Testnet account and key
  ...Object.fromEntries(EXCHANGE_TRADER_IDS.flatMap((id) => [[`NEAR_TRADER_${id.toUpperCase()}_ACCOUNT_ID`, `${id.replace(/_/g, "-")}.blackout-test.testnet`], [`NEAR_TRADER_${id.toUpperCase()}_PRIVATE_KEY`, "ed25519:fake-trader"]])),
};
const HASH = "4ZbV4k1Tcv1oWy1hoxUo4o9b2cUqGgYyU6wF7pK2ZWwz";

describe("shared exchange on Testnet (fake RPC)", () => {
  let cfg: ChainConfig;

  async function chainCity() {
    cfg = loadChainConfig(fakeEnv as NodeJS.ProcessEnv);
    expect(cfg.exchangeEnabled).toBe(true);
    built = await buildServer({ dbPath: ":memory:", chain: cfg, allowedOrigins: [], webDist: null, exchangeAllowGuests: true });
    const p = await player(built);
    // city merchants are local simulation by default; only the shared exchange settles on Testnet
    expect(p.h().state.chainMode).toBe("disabled");
    await buyDiesel(built, p.token, 10_000);
    return p;
  }

  const confirmed = (signer: string): SubmitResult => ({ txHash: HASH, signerId: signer, outcome: { status: "confirmed", txHash: HASH, signerId: signer, receiverId: "resources.blackout-test.testnet", detail: "FINAL" } });

  it("maps every operation to the right contract call and signer", () => {
    cfg = loadChainConfig(fakeEnv as NodeJS.ProcessEnv);
    const dep = exchangeCall(cfg, { kind: "chain", op: "deposit", opId: "dep_1", playerId: "player_abc", amountMl: 10_000 });
    expect(dep).toMatchObject({ signerId: "vault.blackout-test.testnet", method: "exchange_deposit", args: { token_id: "DIESEL_100ML", amount: "100", deposit_id: "dep_1" } });
    expect(dep.args.player_id).toMatch(/^p[0-9a-f]{24}\.vault\.blackout-test\.testnet$/);
    const traderAsk = exchangeCall(cfg, { kind: "chain", op: "ask", opId: "kettle:ask:3", owner: { kind: "trader", id: "kettle" }, amountMl: 30_000, unitPriceCcPerL: 1_235 });
    expect(traderAsk).toMatchObject({ signerId: "kettle.blackout-test.testnet", method: "exchange_ask", args: { owner_id: "kettle.blackout-test.testnet", amount: "300", unit_price_cc: "124" } });
    const traderFill = exchangeCall(cfg, { kind: "chain", op: "fill", opId: "kettle:fill:9", orderId: "ask_x", buyer: { kind: "trader", id: "kettle" }, amountMl: 5_000 });
    expect(traderFill).toMatchObject({ signerId: "kettle.blackout-test.testnet", args: { buyer_id: "kettle.blackout-test.testnet", fill_id: "kettle:fill:9" } });
    expect(exchangeCall(cfg, { kind: "chain", op: "import", opId: "northline:import:4", traderId: "northline", amountMl: 50_000 })).toMatchObject({ signerId: "northline.blackout-test.testnet", method: "npc_import", args: { amount: "500" } });
  });

  it("keeps a deposit pending until the chain confirms it, then settles exactly once with the real hash", async () => {
    const p = await chainCity();
    const fuel0 = fuel(built!, p.runId);
    const dep = await post(built!, p.token, "/api/exchange/deposit", { quantityMl: 10_000, idempotencyKey: key() });
    expect(dep.statusCode).toBe(200);
    expect(dep.json().exchange).toMatchObject({ mode: "testnet", me: { warehouseMl: 0, pendingDepositMl: 10_000, chainId: expect.stringMatching(/\.vault\.blackout-test\.testnet$/) } });
    expect(fuel(built!, p.runId)).toBe(fuel0 - 10_000);
    const job = built!.db.prepare("SELECT op, status, payload_json FROM exchange_jobs").get() as { op: string; status: string; payload_json: string };
    expect(job).toMatchObject({ op: "deposit", status: "pending" });

    const deps: ExchangeDeps = {
      submit: vi.fn(async (_c, e, onSigned) => {
        onSigned!(HASH, "vault.blackout-test.testnet");
        expect(e.op).toBe("deposit");
        return confirmed("vault.blackout-test.testnet");
      }),
      lookup: vi.fn(),
      onChain: vi.fn(),
    };
    expect(await processExchangeJobs(built!.db, built!.xsvc, cfg, deps)).toBe(1);
    expect(built!.xsvc.view(built!.svc.get(p.runId).ownerId).me!.warehouseMl).toBe(10_000);
    const events = built!.db.prepare("SELECT event_json FROM exchange_events WHERE type = 'DEPOSITED'").all() as { event_json: string }[];
    expect(JSON.parse(events[0].event_json).data.txHash).toBe(HASH);
    expect(await processExchangeJobs(built!.db, built!.xsvc, cfg, deps)).toBe(0);
    expect(deps.submit).toHaveBeenCalledTimes(1);
  });

  it("never settles an outcome it cannot see, reconciles from the contract's records, and refunds a definite failure", async () => {
    const p = await chainCity();
    const fuel0 = fuel(built!, p.runId);
    await post(built!, p.token, "/api/exchange/deposit", { quantityMl: 5_000, idempotencyKey: key() });
    await post(built!, p.token, "/api/exchange/deposit", { quantityMl: 5_000, idempotencyKey: key() });
    const ids = (built!.db.prepare("SELECT op_id FROM exchange_jobs ORDER BY created_at, rowid").all() as { op_id: string }[]).map((r) => r.op_id);

    // broadcast response lost: hash persisted, outcome unknown
    const lost: ExchangeDeps = {
      submit: vi.fn(async (_c, _e, onSigned) => {
        onSigned!(HASH, "vault.blackout-test.testnet");
        return { txHash: HASH, signerId: "vault.blackout-test.testnet", outcome: { status: "pending" as const, txHash: HASH, detail: "broadcast error: socket hang up" } } satisfies SubmitResult;
      }),
      lookup: vi.fn(async () => ({ status: "unknown" as const, txHash: HASH, detail: "UNKNOWN_TRANSACTION" })),
      onChain: vi.fn(async () => ({ done: false, detail: "contract has no deposit" })),
    };
    expect(await processExchangeJobs(built!.db, built!.xsvc, cfg, lost)).toBe(0);
    expect(await processExchangeJobs(built!.db, built!.xsvc, cfg, lost)).toBe(0);
    expect(lost.submit).toHaveBeenCalledTimes(2); // once per job, never re-broadcast
    expect(built!.xsvc.view(built!.svc.get(p.runId).ownerId).me).toMatchObject({ warehouseMl: 0, pendingDepositMl: 10_000 });

    // the contract shows the first deposit happened; the second definitively failed
    const resolve: ExchangeDeps = {
      submit: vi.fn(),
      lookup: vi.fn(async (_c, _h) => ({ status: "unknown" as const, txHash: HASH, detail: "still unknown" })),
      onChain: vi.fn(async (_c, e) => ({ done: e.opId === ids[0], detail: "view" })),
    };
    expect(await processExchangeJobs(built!.db, built!.xsvc, cfg, resolve)).toBe(1);
    const fail: ExchangeDeps = { submit: vi.fn(), lookup: vi.fn(async () => ({ status: "failed" as const, txHash: HASH, signerId: "vault.blackout-test.testnet", receiverId: "resources.blackout-test.testnet", detail: "Operation already processed" })), onChain: vi.fn() };
    expect(await processExchangeJobs(built!.db, built!.xsvc, cfg, fail)).toBe(1);
    expect(resolve.submit).not.toHaveBeenCalled();
    const me = built!.xsvc.view(built!.svc.get(p.runId).ownerId).me!;
    expect(me).toMatchObject({ warehouseMl: 5_000, pendingDepositMl: 0 });
    // the failed 5 L came back to the tank through a recorded city effect
    expect(fuel(built!, p.runId)).toBe(fuel0 - 5_000);
    const jobs = built!.db.prepare("SELECT status FROM exchange_jobs ORDER BY created_at, rowid").all() as { status: string }[];
    expect(jobs.map((j) => j.status)).toEqual(["confirmed", "failed"]);
  });

  it("reconciles exchange balances against the contract, skipping while operations settle", async () => {
    const p = await chainCity();
    await post(built!, p.token, "/api/exchange/deposit", { quantityMl: 10_000, idempotencyKey: key() });
    const ownerId = built!.svc.get(p.runId).ownerId;
    const pid = playerChainId(cfg, ownerId);
    const onChain: Record<string, number> = {};
    for (const t of Object.values(built!.xsvc.state.traders)) onChain[cfg.traders[t.traderId].accountId!] = t.params.startStockMl;
    const balance = vi.fn(async (_c: ChainConfig, id: string) => onChain[id] ?? 0);
    const settling = await reconcileExchange(built!.db, built!.xsvc, cfg, balance);
    expect(settling).toMatchObject({ inBalance: null, note: expect.stringMatching(/1 exchange operation is still settling/) });
    expect(balance).not.toHaveBeenCalled();
    const deps: ExchangeDeps = { submit: vi.fn(async (_c, _e, onSigned) => { onSigned!(HASH, "vault.blackout-test.testnet"); return confirmed("vault.blackout-test.testnet"); }), lookup: vi.fn(), onChain: vi.fn() };
    await processExchangeJobs(built!.db, built!.xsvc, cfg, deps);
    // the contract shows the deposit: everything matches
    onChain[pid] = 10_000;
    expect(await reconcileExchange(built!.db, built!.xsvc, cfg, balance)).toMatchObject({ inBalance: true, accountsChecked: EXCHANGE_TRADER_IDS.length + 2, mismatches: [] });
    // a contract balance that drifts is reported, never silently "fixed"
    onChain[pid] = 9_000;
    const bad = await reconcileExchange(built!.db, built!.xsvc, cfg, balance);
    expect(bad.inBalance).toBe(false);
    expect(bad.mismatches).toEqual([{ label: "player warehouse", accountId: pid, expectedMl: 10_000, onChainMl: 9_000 }]);
    const status = (await built!.app.inject({ method: "GET", url: "/api/chain/status" })).json();
    expect(status.exchange).toMatchObject({ mode: "testnet", traderAccounts: expect.arrayContaining([expect.objectContaining({ name: "Kettle & Sons", accountId: "kettle.blackout-test.testnet" })]) });
  });

  it("never lets a sandbox exchange continue as a Testnet one", async () => {
    const path = join(tmpdir(), `bo-xmode-${process.pid}-${Date.now()}.sqlite`);
    built = await buildServer({ dbPath: path, chain: loadChainConfig({}), allowedOrigins: [], webDist: null });
    expect(built.xsvc.sandbox).toBe(true);
    await built.app.close();
    built.db.close();
    built = await buildServer({ dbPath: path, chain: loadChainConfig(fakeEnv as NodeJS.ProcessEnv), allowedOrigins: [], webDist: null });
    expect(built.xsvc.sandbox).toBe(true);
    expect(built.xsvc.modeConflict).toMatch(/created in sandbox mode but this server is configured for testnet/);
    const status = (await built.app.inject({ method: "GET", url: "/api/chain/status" })).json();
    expect(status.exchange.mode).toBe("sandbox");
    await built.app.close();
    built.db.close();
    built = null;
    for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
  });
});

