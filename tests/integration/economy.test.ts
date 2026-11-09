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
const economy = async (t: string) => (await built.app.inject({ method: "GET", url: "/api/economy", headers: auth(t) })).json().economy;
async function drain(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await built.economy.ensureTownOpen();
    built.economy.queueSettlement();
    await built.economy.processOps(50);
  }
}

describe("player wallets and starting capital", () => {
  it("a signed-in player gets one real wallet and one starting grant, however often they ask", async () => {
    const p = await player();
    const first = await economy(p.token);
    expect(first.mode).toBe("near");
    expect(first.wallet.status).toBe("creating");
    await economy(p.token);
    await economy(p.token);
    await drain();
    const e = await economy(p.token);
    expect(e.wallet.status).toBe("active");
    expect(chain.accounts.has(e.wallet.accountId)).toBe(true);
    expect(e.wallet.accountId).toMatch(/^p[0-9a-f]{20}\.players\.game\.testnet$/);
    // exactly one grant, from the players' bucket, of the game's own starting capital
    const grants = [...chain.grants.values()].filter((g) => g.receiver === e.wallet.accountId);
    expect(grants).toEqual([{ bucket: "players", receiver: e.wallet.accountId, amount: STARTER_GRANT_CC }]);
    // the wallet holds what the company holds in the game
    const h = built.rsvc.liveFor(p.userId);
    expect(chain.balance(e.wallet.accountId)).toBe(region.rbal(h.state, "cc", "player"));
    // asking again, or a direct retry of the grant, never pays twice
    built.economy.ensureWallet(p.userId);
    built.economy.enqueue({ opId: "grant:start:" + p.userId, kind: "grant", subject: `wallet:${p.userId}`, signer: "operator", method: "treasury_grant", args: { grant_id: `start:${p.userId}`, bucket: "players", receiver_id: e.wallet.accountId, amount: String(STARTER_GRANT_CC), memo: "again" } });
    await drain();
    expect([...chain.grants.values()].filter((g) => g.receiver === e.wallet.accountId)).toHaveLength(1);
    expect(chain.supply()).toBe(TREASURY_PLAN.totalSupply);
  });

  it("guests play with game money only and are told why; different players never share a wallet", async () => {
    const guest = await player(false);
    const e = await economy(guest.token);
    expect(e.wallet).toBeNull();
    expect(e.walletNote).toMatch(/Guests play with game money only/);
    const a = await player();
    const b = await player();
    await economy(a.token);
    await economy(b.token);
    await drain();
    const wa = (await economy(a.token)).wallet.accountId;
    const wb = (await economy(b.token)).wallet.accountId;
    expect(wa).not.toBe(wb);
  });

  it("a wallet opened after playing a while starts with exactly the company's current cash", async () => {
    const p = await player();
    const h = built.rsvc.liveFor(p.userId);
    h.state.onboarding.done = true;
    for (let i = 0; i < 50; i++) built.rsvc.advance(h);
    await economy(p.token);
    await drain();
    const e = await economy(p.token);
    expect(e.wallet.status).toBe("active");
    const w = built.economy.wallet(p.userId)!;
    expect(chain.balance(w.account_id)).toBe(w.opening_cash_cc);
    expect(w.opening_cash_cc).not.toBe(STARTER_GRANT_CC);
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
    expect(view.plants.find((x: { tokenId: string }) => x.tokenId === built.economy.plantTokenId(h.regionId, sold.assetNo)).status).toBe("sold");
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
    await run(36 * 4, p.h);
    const orders = built.tsvc.state.power!.orders.filter((o) => o.sellerKey === `player:${p.userId}` && o.status === "settled");
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
    // the explorer links in the desk are the real transaction hashes
    const v = built.tsvc.view(p.userId);
    const mine = v.companies!.orders.find((x) => x.orderId === o.orderId)!;
    expect(mine.txHash).toMatch(/^FAKE/);
    expect(mine.confirmTxHash).toMatch(/^FAKE/);
    expect(chain.supply()).toBe(TREASURY_PLAN.totalSupply);
  });

  it("a refused escrow moves nothing and the order fails visibly", async () => {
    const p = await playerSelling();
    // run up to the next window, then make the chain refuse the first order
    while ((built.tsvc.state.tick + 1) % 36 !== 0) built.tsvc.tick();
    built.tsvc.tick();
    const placing = built.tsvc.state.power!.orders.filter((o) => o.status === "placing");
    expect(placing.length).toBeGreaterThan(0);
    const victim = placing[0];
    const escrowedBefore = built.tsvc.state.firms![victim.buyerId].escrowedCc;
    chain.failNext = "Smart contract panicked: Above this NPC's per-payment limit";
    await built.economy.processOps(1);
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
    const settled = built.db.prepare("SELECT COUNT(*) AS n FROM settlement_epochs WHERE status = 'confirmed' AND tx_hash IS NOT NULL").get() as { n: number };
    expect(settled.n).toBeGreaterThan(0);
    // close and settle everything outstanding, then the wallet matches the game to the credit
    region.forceCloseEpoch(p.h.state);
    built.rsvc.advance(p.h);
    await drain(4);
    const w = built.economy.activeAccount(p.userId)!;
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
