import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StartSessionResponseSchema } from "@blackout/shared";
import { buildServer } from "../../apps/api/src/server.ts";
import { loadChainConfig } from "../../apps/api/src/chain.ts";
import { StaticWorldInputs } from "../../apps/api/src/world.ts";

let built: Awaited<ReturnType<typeof buildServer>>;
beforeEach(async () => {
  built = await buildServer({ dbPath: ":memory:", chain: loadChainConfig({}), webDist: null, world: new StaticWorldInputs(), economy: { gateway: null } });
});
afterEach(async () => {
  await built.app.close();
  built.db.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function company() {
  const token = StartSessionResponseSchema.parse((await built.app.inject({ method: "POST", url: "/api/session/start", payload: {} })).json()).token;
  const userId = (await built.app.inject({ method: "GET", url: "/api/me", headers: auth(token) })).json().player.playerId as string;
  const h = built.rsvc.liveFor(userId);
  const purchased = await built.app.inject({
    method: "POST", url: "/api/town/trade", headers: auth(token),
    payload: { merchantId: "kettle", item: "fuel:diesel", side: "buy", quantity: 100, idempotencyKey: `diesel-buy-${userId}` },
  });
  expect(purchased.statusCode).toBe(200);
  return { token, userId, h };
}

describe("player resource exchange (local settlement)", () => {
  it("reserves an owned listing, exposes it to other players, and returns it on withdrawal", async () => {
    const seller = await company();
    const buyer = await company();
    const before = built.tsvc.held(seller.h, "fuel:diesel");
    const listed = await built.app.inject({
      method: "POST", url: "/api/resources/list", headers: auth(seller.token),
      payload: { item: "fuel:diesel", quantity: 25, unitPriceCc: 1_000, idempotencyKey: "diesel-sale-cancel-1" },
    });
    expect(listed.statusCode).toBe(200);
    const sale = listed.json().sale;
    expect(sale.status).toBe("listed");
    expect(built.tsvc.held(seller.h, "fuel:diesel")).toBe(before - 25);

    const market = await built.app.inject({ method: "GET", url: "/api/resources/market", headers: auth(buyer.token) });
    expect(market.json().sales.find((row: { saleId: string }) => row.saleId === sale.saleId)?.mine).toBe(false);

    const cancelled = await built.app.inject({ method: "POST", url: "/api/resources/cancel", headers: auth(seller.token), payload: { saleId: sale.saleId } });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().sale.status).toBe("cancelled");
    expect(built.tsvc.held(seller.h, "fuel:diesel")).toBe(before);
  });

  it("lets an NPC policy buy an acceptable offer once and refuses an offer above its bid", async () => {
    const seller = await company();
    const listed = await built.app.inject({
      method: "POST", url: "/api/resources/list", headers: auth(seller.token),
      payload: { item: "fuel:diesel", quantity: 10, unitPriceCc: 50, idempotencyKey: "diesel-sale-fill-1" },
    });
    expect(listed.statusCode).toBe(200);
    const sale = listed.json().sale;
    built.db.prepare("UPDATE resource_sales SET updated_at = ? WHERE sale_id = ?").run(new Date(Date.now() - 10_000).toISOString(), sale.saleId);

    await built.resourceMarket.tick();
    const filled = built.resourceMarket.view(seller.userId).find((row) => row.saleId === sale.saleId)!;
    expect(filled.status, filled.decision).toBe("sold");
    expect(filled.buyerName).toBeTruthy();
    expect(built.tsvc.state.trades.filter((trade) => trade.listingId === sale.saleId)).toHaveLength(1);
    const creditsAfterSale = seller.h.state.balances.cc.player;
    await built.resourceMarket.tick();
    expect(seller.h.state.balances.cc.player).toBe(creditsAfterSale);

    const highAsk = await built.app.inject({
      method: "POST", url: "/api/resources/list", headers: auth(seller.token),
      payload: { item: "fuel:diesel", quantity: 5, unitPriceCc: 100_000_000, idempotencyKey: "diesel-sale-high-1" },
    });
    expect(highAsk.statusCode).toBe(200);
    const expensive = highAsk.json().sale;
    built.db.prepare("UPDATE resource_sales SET updated_at = ? WHERE sale_id = ?").run(new Date(Date.now() - 10_000).toISOString(), expensive.saleId);
    await built.resourceMarket.tick();
    const waiting = built.resourceMarket.view(seller.userId).find((row) => row.saleId === expensive.saleId)!;
    expect(waiting.status).toBe("listed");
    expect(waiting.decision).toMatch(/current bid|ask/i);
    await built.app.inject({ method: "POST", url: "/api/resources/cancel", headers: auth(seller.token), payload: { saleId: expensive.saleId } });
  });
});
