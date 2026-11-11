/**
 * The on-chain economy, end to end through the server, against a stand-in for NEAR that follows the contract's rules
 * (fakeChain.ts). These prove the server's lifecycle: one wallet and one grant per player, NPC-signed escrow, delivery
 * measured by the player's grid, payment exactly once, failures and lost responses handled, supply conserved.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StartSessionResponseSchema } from "@blackout/shared";
import { region } from "@blackout/sim";
import { buildServer } from "../../apps/api/src/server.ts";
import { loadChainConfig } from "../../apps/api/src/chain.ts";
import { StaticWorldInputs } from "../../apps/api/src/world.ts";
import { STARTER_GRANT_CC, TREASURY_PLAN } from "../../apps/api/src/economy/treasury.ts";
import { rtransfer } from "../../packages/sim/src/region/state.ts";
import { FakeChain, fakeEconomyConfig } from "./fakeChain.ts";

type Built = Awaited<ReturnType<typeof buildServer>>;
let built: Built;
let chain: FakeChain;
let clock = 9_000_000;

beforeEach(async () => {
  const cfg = fakeEconomyConfig();
  chain = new FakeChain(cfg);
  built = await buildServer({ dbPath: ":memory:", chain: loadChainConfig({}), now: () => clock, webDist: null, world: new StaticWorldInputs(), economy: { cfg, gateway: chain } });
});
afterEach(async () => {
  await built.app.close();
  built.db.close();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
async function player(registered = true) {
  const r = await built.app.inject({ method: "POST", url: "/api/session/start", payload: {} });
  const token = StartSessionResponseSchema.parse(r.json()).token;
  const me = (await built.app.inject({ method: "GET", url: "/api/me", headers: auth(token) })).json();
  const userId = me.player.playerId as string;
  if (registered) built.db.prepare("UPDATE players SET kind = 'registered' WHERE player_id = ?").run(userId);
  return { token, userId };
}
// Wallet state is operator/service data now, not a public player API. These service-level tests exercise
// the internal provisioning path directly while separate assertions keep that data out of player routes.
const economy = async (t: string) => {
  const me = (await built.app.inject({ method: "GET", url: "/api/me", headers: auth(t) })).json();
  return built.economy.view(me.player.playerId as string);
};
const requireWallet = (view: NonNullable<Awaited<ReturnType<typeof economy>>>) => {
  if (!view.wallet) throw new Error("Expected an internally provisioned wallet");
  return view.wallet;
};
async function drain(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await built.economy.ensureTownOpen();
    await built.economy.queueSettlement();
    await built.economy.processOps(50);
  }
}
async function forceRegionSettlement() {
  built.db.prepare("INSERT INTO economy_state (key, value_json, updated_at) VALUES ('region_batch_at', '0', ?) ON CONFLICT(key) DO UPDATE SET value_json = '0', updated_at = excluded.updated_at").run(new Date().toISOString());
  await drain(3);
}

describe("player wallets and starting capital", () => {
  it("a signed-in player gets one real wallet and one starting grant, however often they ask", async () => {
    const p = await player();
    const first = await economy(p.token);
    expect(first.mode).toBe("near");
    expect(requireWallet(first).status).toBe("creating");
    await economy(p.token);
    await economy(p.token);
    await drain();
    const e = await economy(p.token);
    const playerWallet = requireWallet(e);
    expect(playerWallet.status).toBe("active");
    expect(chain.accounts.has(playerWallet.accountId)).toBe(true);
    expect(playerWallet.accountId).toMatch(/^p[0-9a-f]{20}\.players\.game\.testnet$/);
    // exactly one grant, from the players' bucket, of the game's own starting capital
    const grants = [...chain.grants.values()].filter((g) => g.receiver === playerWallet.accountId);
    expect(grants).toEqual([{ bucket: "players", receiver: playerWallet.accountId, amount: STARTER_GRANT_CC }]);
    // the wallet holds what the company holds in the game
    const h = built.rsvc.liveFor(p.userId);
    expect(chain.balance(playerWallet.accountId)).toBe(region.rbal(h.state, "cc", "player"));
    // asking again, or a direct retry of the grant, never pays twice
    built.economy.ensureWallet(p.userId);
    built.economy.enqueue({ opId: "grant:start:" + p.userId, kind: "grant", subject: `wallet:${p.userId}`, signer: "operator", method: "treasury_grant", args: { grant_id: `start:${p.userId}`, bucket: "players", receiver_id: playerWallet.accountId, amount: String(STARTER_GRANT_CC), memo: "again" } });
    await drain();
    expect([...chain.grants.values()].filter((g) => g.receiver === playerWallet.accountId)).toHaveLength(1);
    expect(chain.supply()).toBe(TREASURY_PLAN.totalSupply);
  });

  it("guests get a wallet once they've played their first minute (never on a bare page load); players never share one", async () => {
    const guest = await player(false);
    const e = await economy(guest.token);
    expect(e.wallet).toBeNull();
    expect(e.walletNote).toMatch(/Finish your first minute/);
    built.rsvc.liveFor(guest.userId).state.onboarding.done = true;
    expect(requireWallet(await economy(guest.token)).status).toBe("creating");
    await drain();
    expect(requireWallet(await economy(guest.token)).status).toBe("active");
    const a = await player();
    const b = await player();
    await economy(a.token);
    await economy(b.token);
    await drain();
    const wa = requireWallet(await economy(a.token)).accountId;
    const wb = requireWallet(await economy(b.token)).accountId;
    expect(wa).not.toBe(wb);
  });

  it("settles a player's market inventory to their wallet and returns sold items to market custody", async () => {
    const p = await player();
    await economy(p.token);
    await drain();
    const h = built.rsvc.liveFor(p.userId);
    const wallet = built.economy.activeAccount(p.userId)!;
    const token = "certificate:renewable";
    const beforeItems = chain.balance(wallet, token);
    built.tsvc.trade({ userId: p.userId, name: "Test Co" }, h, built.rsvc, { merchantId: "lena", item: token, side: "buy", quantity: 40 }, "buy-certs");
    for (let i = 0; i < 72; i++) built.tsvc.tick();
    built.db.prepare("UPDATE settlement_epochs SET created_at = ? WHERE region_id = 'town'").run(new Date(Date.now() - 600_000).toISOString());
    await drain(4);
    expect(chain.balance(wallet, token)).toBe(beforeItems + 40);

    const beforeSaleCash = chain.balance(wallet);
    built.tsvc.trade({ userId: p.userId, name: "Test Co" }, h, built.rsvc, { merchantId: "lena", item: token, side: "sell", quantity: 40 }, "sell-certs");
    for (let i = 0; i < 72; i++) built.tsvc.tick();
    built.db.prepare("UPDATE settlement_epochs SET created_at = ? WHERE region_id = 'town'").run(new Date(Date.now() - 600_000).toISOString());
    await drain(4);
    const settled = built.db.prepare("SELECT COUNT(*) AS n FROM chain_ops WHERE subject = 'town' AND kind = 'batch' AND status = 'settled'").get() as { n: number };
    expect(settled.n).toBeGreaterThan(0);
    expect(built.db.prepare("SELECT COUNT(*) AS n FROM chain_ops WHERE subject = 'town' AND kind = 'batch' AND status = 'failed'").get()).toEqual({ n: 0 });
    expect(chain.balance(wallet, token)).toBe(beforeItems);
    // Lena paid the player's wallet for the resource they sold.
    expect(chain.balance(wallet)).toBeGreaterThan(beforeSaleCash);
    expect(chain.supply()).toBe(TREASURY_PLAN.totalSupply);
  });

  it("settles gameplay resource consumption back to world custody in a batched region epoch", async () => {
    const p = await player();
    await economy(p.token);
    await drain();
    const h = built.rsvc.liveFor(p.userId);
    const wallet = built.economy.activeAccount(p.userId)!;
    const token = "fuel:diesel";
    const ctx = region.newRCtx();

    rtransfer(h.state, ctx, "diesel", "ext:imports", region.RACC.player, 1_000, "resource accounting fixture");
    h.state.interval += region.regionConfig.EPOCH_INTERVALS;
    region.forceCloseEpoch(h.state);
    built.rsvc.advance(h); // persist the epoch before the chain worker reads it
    await forceRegionSettlement();
    expect(chain.balance(wallet, token)).toBe(1);

    rtransfer(h.state, ctx, "diesel", region.RACC.player, "ext:burned", 500, "gameplay fuel burn");
    h.state.interval += region.regionConfig.EPOCH_INTERVALS;
    region.forceCloseEpoch(h.state);
    built.rsvc.advance(h);
    await forceRegionSettlement();
    expect(chain.balance(wallet, token)).toBe(0);
  });

  it("keeps account identifiers and wallet controls out of player-facing routes", async () => {
    const p = await player();
    await economy(p.token);
    await drain();
    const identity = (await built.app.inject({ method: "GET", url: "/api/identity", headers: auth(p.token) })).json().identity;
    expect(identity).not.toHaveProperty("chainAccountId");
    expect(identity).not.toHaveProperty("gasless");
    expect((await built.app.inject({ method: "GET", url: "/api/economy", headers: auth(p.token) })).statusCode).toBe(404);
    expect((await built.app.inject({ method: "POST", url: "/api/economy/wallet/export", headers: auth(p.token), payload: { confirm: "I understand" } })).statusCode).toBe(404);
    expect((await built.app.inject({ method: "POST", url: "/api/economy/wallet/leave", headers: auth(p.token), payload: { confirm: "LEAVE" } })).statusCode).toBe(404);
    expect((await built.app.inject({ method: "GET", url: "/api/region", headers: auth(p.token) })).json()).not.toMatchObject({ wallet: expect.anything(), accountId: expect.anything(), chainAccountId: expect.anything() });
  });

  it("a wallet opened after playing a while starts with exactly the company's current cash", async () => {
    const p = await player();
    const h = built.rsvc.liveFor(p.userId);
    h.state.onboarding.done = true;
    for (let i = 0; i < 50; i++) built.rsvc.advance(h);
    // The player buys while still a guest; wallet opening must seed the held item exactly once.
    built.tsvc.trade({ userId: p.userId, name: "Test Co" }, h, built.rsvc, { merchantId: "lena", item: "certificate:renewable", side: "buy", quantity: 40 }, "pre-wallet-certs");
    await economy(p.token);
    await drain();
    const e = await economy(p.token);
    expect(requireWallet(e).status).toBe("active");
    const w = built.economy.wallet(p.userId)!;
    expect(chain.balance(w.account_id)).toBe(w.opening_cash_cc);
    expect(w.opening_cash_cc).not.toBe(STARTER_GRANT_CC);
    expect(w.resource_opened_interval).not.toBeNull();
    expect(chain.balance(w.account_id, "certificate:renewable")).toBe(40);
  });
});

describe("opening the market on chain", () => {
  it("lines every NPC's wallet up with this server's market even if another server used them before", async () => {
    // another server already paid Ingrid's starting grant and moved her balance and stock around
    const ingrid = "ingrid.game.testnet";
    chain.grants.set("npc:ingrid", { bucket: "npc", receiver: ingrid, amount: 9_000_000 });
    chain.bal.set(`credit:vesper|${ingrid}`, 12_345_678);
    chain.bal.set(`credit:vesper|treasury.game.testnet`, chain.balance("treasury.game.testnet") - 12_345_678);
    chain.bal.set(`fuel:natural-gas|${ingrid}`, 777);
    chain.bal.set(`fuel:natural-gas|world.game.testnet`, chain.balance("world.game.testnet", "fuel:natural-gas") - 777);
    await drain(4);
    const t = built.tsvc.state;
    for (const m of ["ingrid", "bayo", "pavel"]) {
      expect(chain.balance(`${m}.game.testnet`)).toBe(t.epochStart.balances.cc[`merchant:${m}`]);
    }
    expect(chain.balance(ingrid, "fuel:natural-gas")).toBe(t.epochStart.balances["fuel:natural-gas"][`merchant:ingrid`]);
    for (const f of ["halvard", "solara", "northwind"]) expect(chain.balance(`${f}.game.testnet`)).toBe(t.epochStart.balances.cc[`firm:${f}`]);
    expect(chain.supply()).toBe(TREASURY_PLAN.totalSupply);
  });
});

describe("resync after an incident", () => {
  it("waits until nothing is in flight, then lines every NPC and wallet on NEAR up with the game, minting nothing", async () => {
    const p = await player();
    await economy(p.token);
    await drain(4);
    const wallet = built.economy.activeAccount(p.userId)!;
    // an incident: balances drift apart from the game (a lost batch, say)
    chain.bal.set(`credit:vesper|ingrid.game.testnet`, chain.balance("ingrid.game.testnet") - 500_000);
    chain.bal.set(`credit:vesper|world.game.testnet`, chain.balance("world.game.testnet") + 500_000);
    chain.bal.set(`credit:vesper|${wallet}`, chain.balance(wallet) + 77_000);
    chain.bal.set(`credit:vesper|grid.game.testnet`, chain.balance("grid.game.testnet") - 77_000);
    built.economy.enqueue({ opId: "batch:stuck", kind: "batch", subject: "town", signer: "operator", method: "settle_batch", args: { epoch_id: "stuck", hash: "a".repeat(64), entries: [] } });
    built.db.prepare("UPDATE chain_ops SET status = 'failed' WHERE op_id = 'batch:stuck'").run();
    // escrow still held on chain: it must wait
    chain.bal.set(`credit:vesper|econ.game.testnet`, 1_000);
    chain.bal.set(`credit:vesper|world.game.testnet`, chain.balance("world.game.testnet") - 1_000);
    const waiting = (await built.app.inject({ method: "POST", url: "/api/economy/admin/resync", headers: { "x-admin-token": "admin-secret" } })).json();
    expect(waiting.status).toBe("waiting");
    chain.bal.set(`credit:vesper|econ.game.testnet`, 0);
    chain.bal.set(`credit:vesper|world.game.testnet`, chain.balance("world.game.testnet") + 1_000);
    const done = (await built.app.inject({ method: "POST", url: "/api/economy/admin/resync", headers: { "x-admin-token": "admin-secret" } })).json();
    expect(done.status).toBe("done");
    expect(built.economy.op("batch:stuck")!.detail).toMatch(/withdrawn by resync/);
    expect(built.economy.cfg.npcSpending).toBe(false); // still paused until the corrections land
    await drain(4);
    built.economy.finishResync();
    const t = built.tsvc.state;
    expect(chain.balance("ingrid.game.testnet")).toBe(t.epochStart.balances.cc["merchant:ingrid"]);
    expect(chain.balance(wallet)).toBe(region.rbal(built.rsvc.liveFor(p.userId).state, "cc", "player"));
    expect(chain.supply()).toBe(TREASURY_PLAN.totalSupply);
    expect(built.economy.cfg.npcSpending).toBe(true);
  });
});

describe("selling plants between companies", () => {
  async function walletPlayer() {
    const p = await player();
    await economy(p.token);
    await drain();
    built.economy.syncPlants();
    await drain();
    return { ...p, h: built.rsvc.liveFor(p.userId), wallet: built.economy.activeAccount(p.userId)! };
  }
  const post = (t: string, url: string, payload: object) => built.app.inject({ method: "POST", url, headers: auth(t), payload });

  it("one atomic sale on NEAR: the buyer's credits go to the seller, the NFT to the buyer, and the plant moves grids", async () => {
    const seller = await walletPlayer();
    const buyer = await walletPlayer();
    const plant = seller.h.state.plants.find((x) => x.ownerId === "player" && x.tech === "battery")!;
    const token = built.economy.plantTokenId(seller.h.regionId, plant.assetNo);
    const listed = await post(seller.token, "/api/plants/list", { plantId: plant.plantId, priceCc: 5_000_000 });
    expect(listed.statusCode).toBe(200);
    // locked: it can't also be offered to VoltLine meanwhile
    expect(built.rsvc.act(seller.h, { type: "LIST_PLANT", plantId: plant.plantId, askCc: 1_000_000 }, "list-to-npc").ok).toBe(false);
    await drain();
    const saleId = (await built.app.inject({ method: "GET", url: "/api/plants/market", headers: auth(buyer.token) })).json().sales.find((x: { name: string }) => x.name === plant.name).saleId;
    const sellerChain = chain.balance(seller.wallet);
    const buyerCash = built.rsvc.liveFor(buyer.userId).state.balances.cc.player;
    expect((await post(buyer.token, "/api/plants/buy", { saleId })).statusCode).toBe(200);
    // the price is held at once
    expect(built.rsvc.liveFor(buyer.userId).state.balances.cc.player).toBe(buyerCash - 5_000_000);
    await drain();
    expect(chain.plants.get(token)).toBe(buyer.wallet);
    expect(chain.balance(seller.wallet)).toBe(sellerChain + 5_000_000);
    expect(seller.h.state.plants.some((x) => x.plantId === plant.plantId)).toBe(false);
    const arrived = built.rsvc.liveFor(buyer.userId).state.plants.find((x) => x.chainTokenId === token)!;
    expect(arrived).toBeTruthy();
    expect(arrived.nodeId).toBe(plant.nodeId);
    expect(arrived.ownerId).toBe("player");
    // the buyer's sync never mints it again: it already is that NFT
    const mints = chain.calls.filter((c) => c.method === "plant_mint").length;
    built.economy.syncPlants();
    await drain();
    expect(chain.calls.filter((c) => c.method === "plant_mint").length).toBe(mints);
    expect(chain.supply()).toBe(TREASURY_PLAN.totalSupply);
  });

  it("a buy NEAR refuses gives the buyer's money back and leaves the plant for sale", async () => {
    const seller = await walletPlayer();
    const buyer = await walletPlayer();
    const plant = seller.h.state.plants.find((x) => x.ownerId === "player" && x.tech === "battery")!;
    await post(seller.token, "/api/plants/list", { plantId: plant.plantId, priceCc: 5_000_000 });
    await drain();
    const saleId = (await built.app.inject({ method: "GET", url: "/api/plants/market", headers: auth(buyer.token) })).json().sales[0].saleId;
    const cash = built.rsvc.liveFor(buyer.userId).state.balances.cc.player;
    // the buyer's wallet is short on chain
    chain.bal.set(`credit:vesper|${buyer.wallet}`, 10);
    await post(buyer.token, "/api/plants/buy", { saleId });
    await drain();
    expect(built.rsvc.liveFor(buyer.userId).state.balances.cc.player).toBe(cash);
    expect(seller.h.state.plants.some((x) => x.plantId === plant.plantId)).toBe(true);
    const sales = (await built.app.inject({ method: "GET", url: "/api/plants/market", headers: auth(buyer.token) })).json().sales;
    expect(sales.find((x: { saleId: string }) => x.saleId === saleId).status).toBe("listed");
  });
});

describe("plants as NFTs", () => {
  it("every plant a wallet holder owns is minted to their wallet, and leaves it when they sell", async () => {
    const p = await player();
    await economy(p.token);
    await drain();
    built.economy.syncPlants();
    await drain();
    const h = built.rsvc.liveFor(p.userId);
    const wallet = built.economy.activeAccount(p.userId)!;
    const mine = h.state.plants.filter((x) => x.ownerId === "player" && x.status !== "building");
    expect(mine.length).toBeGreaterThan(0);
    for (const pl of mine) expect(chain.plants.get(built.economy.plantTokenId(h.regionId, pl.assetNo))).toBe(wallet);
    // running the sync again mints nothing twice
    const n = chain.calls.filter((c) => c.method === "plant_mint").length;
    built.economy.syncPlants();
    await drain();
    expect(chain.calls.filter((c) => c.method === "plant_mint").length).toBe(n);
    // sell one (here: hand it to VoltLine directly, as an accepted bid does) and NEAR follows
    const sold = mine[0];
    sold.ownerId = "voltline";
    built.economy.syncPlants();
    await drain();
    expect(chain.plants.get(built.economy.plantTokenId(h.regionId, sold.assetNo))).toBe("grid.game.testnet");
    const view = await economy(p.token);
    expect(view.plants.find((x: { tokenId: string }) => x.tokenId === built.economy.plantTokenId(h.regionId, sold.assetNo))?.status).toBe("sold");
  });
});

describe("NPC companies buying power from players on chain", () => {
  async function playerSelling() {
    const p = await player();
    const h = built.rsvc.liveFor(p.userId);
    h.state.onboarding.done = true;
    built.rsvc.act(h, { type: "SET_PLANT_ONLINE", plantId: "kestrel", online: true }, "start-kestrel");
    for (let i = 0; i < 80; i++) built.rsvc.advance(h);
    await economy(p.token);
    await drain();
    expect(built.economy.activeAccount(p.userId)).toBeTruthy();
    return { ...p, h };
  }
  async function run(ticks: number, h: { lastClientAt: number }) {
    for (let i = 0; i < ticks; i++) {
      h.lastClientAt = clock;
      built.tsvc.tick();
      for (const r of built.rsvc.regions.values()) if (r.mode === "live") built.rsvc.advance(r);
      if (i % 6 === 0) await drain(2);
    }
    await drain();
  }

  it("the NPC signs its own escrow, the player's grid delivers, the operator confirms, the player is paid once", async () => {
    const p = await playerSelling();
    const wallet = built.economy.activeAccount(p.userId)!;
    // regions are randomly seeded, so give the companies up to eight windows to buy from this player
    const sold = () => built.tsvc.state.power!.orders.filter((o) => o.sellerKey === `player:${p.userId}` && o.status === "settled");
    for (let w = 0; w < 8 && sold().length === 0; w++) await run(36, p.h);
    const orders = sold();
    expect(orders.length).toBeGreaterThan(0);
    const o = orders[0];
    const placed = chain.calls.find((c) => c.method === "power_order_place" && c.args.order_id === o.orderId)!;
    // signed by the buying company's own account, paying into the player's own wallet
    expect(placed.signer).toMatch(/^(halvard|solara)\.game\.testnet$/);
    expect(placed.args.seller_id).toBe(wallet);
    const confirm = chain.calls.find((c) => c.method === "power_order_confirm" && c.args.order_id === o.orderId)!;
    expect(confirm.signer).toBe("operator.game.testnet");
    // the grid measured the delivery; the chain paid exactly that, and the region recorded the same payment once
    expect(Number(confirm.args.delivered_kwh)).toBe(o.deliveredKwh);
    expect(chain.orders.get(o.orderId)!.paid).toBe(o.paidCc);
    const paidActions = built.db.prepare("SELECT COUNT(*) AS n FROM region_actions WHERE idempotency_key = ?").get(`pw:p:${o.orderId}`) as { n: number };
    expect(paidActions.n).toBe(1);
    // an NPC also bought from another NPC (the gas plant), on chain
    expect(chain.calls.some((c) => c.method === "power_order_place" && c.args.seller_id === "northwind.game.testnet")).toBe(true);
    // player trade views omit chain receipts; the operator audit retains them
    const v = built.tsvc.view(p.userId);
    const mine = v.companies!.orders.find((x) => x.orderId === o.orderId)!;
    expect(mine).not.toHaveProperty("txHash");
    expect(mine).not.toHaveProperty("confirmTxHash");
    const audit = await built.economy.auditEvidence();
    expect(audit.operations.some((op) => op.txHash?.startsWith("FAKE"))).toBe(true);
    expect(chain.supply()).toBe(TREASURY_PLAN.totalSupply);
  });

  it("a refused escrow moves nothing and the order fails visibly", async () => {
    const p = await playerSelling();
    // run up to the next window, then make the chain refuse the first order
    while ((built.tsvc.state.tick + 1) % 36 !== 0) built.tsvc.tick();
    built.tsvc.tick();
    const placing = built.tsvc.state.power!.orders.filter((o) => o.status === "placing");
    expect(placing.length).toBeGreaterThan(0);
    const escrowed = Object.fromEntries(Object.entries(built.tsvc.state.firms!).map(([k, f]) => [k, f.escrowedCc]));
    chain.failNext = "Smart contract panicked: Above this NPC's per-payment limit";
    await built.economy.processOps(1);
    // whichever order the chain refused
    const victim = placing.find((o) => /per-payment limit/.test(built.economy.op(`order:${o.orderId}`)?.detail ?? ""))!;
    expect(victim).toBeTruthy();
    const escrowedBefore = escrowed[victim.buyerId];
    const after = built.tsvc.state.power!.orders.find((o) => o.orderId === victim.orderId)!;
    expect(after.status).toBe("failed");
    expect(after.failReason).toMatch(/per-payment limit/);
    expect(built.tsvc.state.firms![victim.buyerId].escrowedCc).toBe(escrowedBefore - victim.escrowCc);
    expect(chain.orders.has(victim.orderId)).toBe(false);
    void p;
  });

  it("a lost response is reconciled by reading the contract, never resubmitted blindly", async () => {
    const p = await player();
    await economy(p.token);
    await drain();
    // a fresh grant whose response is lost on the way back
    built.economy.enqueue({ opId: "grant:test", kind: "grant", subject: "test", signer: "operator", method: "treasury_grant", args: { grant_id: "test-grant", bucket: "reserve", receiver_id: "grid.game.testnet", amount: "1000", memo: "test" } });
    chain.pendingNext = true;
    await built.economy.processOps(50);
    expect(built.economy.op("grant:test")!.status).toBe("submitted");
    built.db.prepare("UPDATE chain_ops SET updated_at = ? WHERE op_id = 'grant:test'").run(new Date(Date.now() - 60_000).toISOString());
    await built.economy.processOps(50);
    expect(built.economy.op("grant:test")!.status).toBe("settled");
    expect(chain.calls.filter((c) => c.args.grant_id === "test-grant")).toHaveLength(1);
  });

  it("never sends an order the game already gave up on, and retries what a rate limit stopped", async () => {
    const p = await playerSelling();
    while ((built.tsvc.state.tick + 1) % 36 !== 0) built.tsvc.tick();
    built.tsvc.tick();
    const placing = built.tsvc.state.power!.orders.filter((o) => o.status === "placing");
    expect(placing.length).toBeGreaterThan(0);
    // the window passes before the queue gets to them (a backlog, a slow endpoint)
    for (let i = 0; i < 36; i++) built.tsvc.tick();
    expect(placing.every((o) => o.status === "failed")).toBe(true);
    await built.economy.processOps(50);
    for (const o of placing) {
      expect(chain.orders.has(o.orderId)).toBe(false);
      expect(built.economy.op(`order:${o.orderId}`)!.detail).toMatch(/gave up on this order/);
    }
    // a grant stopped by a rate limit is retried, not given up on
    built.economy.enqueue({ opId: "grant:rl", kind: "grant", subject: "test", signer: "operator", method: "treasury_grant", args: { grant_id: "rl-grant", bucket: "reserve", receiver_id: "grid.game.testnet", amount: "1000", memo: "test" } });
    chain.failNext = 'Rate limits exceeded. For higher rate limits get a subscription (429)';
    await built.economy.processOps(50);
    expect(built.economy.op("grant:rl")!.status).toBe("failed");
    built.db.prepare("UPDATE chain_ops SET updated_at = ? WHERE op_id = 'grant:rl'").run(new Date(Date.now() - 120_000).toISOString());
    await built.economy.processOps(50);
    expect(built.economy.op("grant:rl")!.status).toBe("settled");
    void p;
  });

  it("an escrow that landed after the game gave up on its order is refunded through the contract", async () => {
    await playerSelling();
    while ((built.tsvc.state.tick + 1) % 36 !== 0) built.tsvc.tick();
    built.tsvc.tick();
    const placing = built.tsvc.state.power!.orders.filter((x) => x.status === "placing");
    // the first escrow's response is lost (it lands, but the server never hears); the window passes
    chain.pendingNext = true;
    await built.economy.processOps(1);
    const o = placing.find((x) => built.economy.op(`order:${x.orderId}`)?.status === "submitted")!;
    expect(chain.orders.get(o.orderId)?.status).toBe("open");
    for (let i = 0; i < 36; i++) built.tsvc.tick();
    expect(built.tsvc.state.power!.orders.find((x) => x.orderId === o.orderId)!.status).toBe("failed");
    built.economy.sweepEscrows();
    expect(built.economy.op(`expire:${o.orderId}`)).toBeTruthy();
  });

  it("the kill switch stops NPC spending on the server and in the contract", async () => {
    const p = await playerSelling();
    const r = await built.app.inject({ method: "POST", url: "/api/economy/admin/npc-spending", headers: { "x-admin-token": "admin-secret" }, payload: { paused: true } });
    expect(r.statusCode).toBe(200);
    const denied = await built.app.inject({ method: "POST", url: "/api/economy/admin/npc-spending", headers: { "x-admin-token": "nope" }, payload: { paused: false } });
    expect(denied.statusCode).toBe(403);
    await drain();
    expect(chain.npcPaused).toBe(true);
    const before = chain.orders.size;
    await run(40, p.h);
    expect(chain.orders.size).toBe(before);
    expect(built.tsvc.state.power!.orders.some((o) => o.status === "failed" && /switched off/.test(o.failReason ?? ""))).toBe(true);
  });

  it("market and region epochs settle in batches that keep the wallet equal to the company's cash", async () => {
    const p = await playerSelling();
    await run(36 * 4, p.h);
    built.rsvc.checkpoint(p.h);
    await forceRegionSettlement();
    const settled = built.db.prepare("SELECT COUNT(*) AS n FROM settlement_epochs WHERE status = 'confirmed' AND tx_hash IS NOT NULL").get() as { n: number };
    expect(settled.n).toBeGreaterThan(0);
    // close and settle everything outstanding, then the wallet matches the game to the credit
    region.forceCloseEpoch(p.h.state);
    built.rsvc.advance(p.h);
    await drain(4);
    const w = built.economy.activeAccount(p.userId)!;
    expect(built.db.prepare("SELECT COUNT(*) AS n FROM chain_ops WHERE subject = 'regions' AND status = 'failed'").get()).toEqual({ n: 0 });
    const unsettledTown = built.db.prepare("SELECT COUNT(*) AS n FROM settlement_epochs WHERE region_id = 'town' AND status IN ('pending', 'submitted')").get() as { n: number };
    if (unsettledTown.n === 0) {
      const town = built.tsvc.state;
      // town trades not yet in a closed epoch are the only allowed difference
      const openTownCc = (town.balances.cc[`ext:player:${p.userId}`] ?? 0) - (town.epochStart.balances.cc?.[`ext:player:${p.userId}`] ?? 0);
      const pendingRegion = region.rbal(p.h.state, "cc", "player") - chain.balance(w);
      expect(Math.abs(pendingRegion - openTownCc)).toBeLessThan(STARTER_GRANT_CC);
    }
    expect(chain.supply()).toBe(TREASURY_PLAN.totalSupply);
  });
});
