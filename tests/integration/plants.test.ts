/** Player-to-player plant sales on a server with no chain: the same steps, at once, on the game server. */
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
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
async function company() {
  const token = StartSessionResponseSchema.parse((await built.app.inject({ method: "POST", url: "/api/session/start", payload: {} })).json()).token;
  const userId = (await built.app.inject({ method: "GET", url: "/api/me", headers: auth(token) })).json().player.playerId as string;
  return { token, userId, h: built.rsvc.liveFor(userId) };
}

describe("plants between companies (no chain)", () => {
  it("lists, sells and moves a plant with its money, and refuses the impossible", async () => {
    const a = await company();
    const b = await company();
    const plant = a.h.state.plants.find((x) => x.ownerId === "player" && x.tech === "battery")!;
    const post = (t: string, url: string, payload: object) => built.app.inject({ method: "POST", url, headers: auth(t), payload });
    expect((await post(a.token, "/api/plants/list", { plantId: plant.plantId, priceCc: 8_000_000 })).statusCode).toBe(200);
    expect((await post(a.token, "/api/plants/list", { plantId: plant.plantId, priceCc: 8_000_000 })).statusCode).toBe(409);
    const sales = (await built.app.inject({ method: "GET", url: "/api/plants/market", headers: auth(b.token) })).json().sales;
    expect(sales).toHaveLength(1);
    expect(sales[0].mine).toBe(false);
    // the seller can't buy their own plant
    expect((await post(a.token, "/api/plants/buy", { saleId: sales[0].saleId })).statusCode).toBe(409);
    const aCash = a.h.state.balances.cc.player;
    const bCash = b.h.state.balances.cc.player;
    expect((await post(b.token, "/api/plants/buy", { saleId: sales[0].saleId })).statusCode).toBe(200);
    expect(a.h.state.plants.some((x) => x.plantId === plant.plantId)).toBe(false);
    expect(a.h.state.balances.cc.player).toBe(aCash + 8_000_000);
    expect(b.h.state.balances.cc.player).toBe(bCash - 8_000_000);
    const got = b.h.state.plants.filter((x) => x.ownerId === "player" && x.tech === "battery");
    expect(got.length).toBe(2);
    // sold: it can't be bought again
    expect((await post(b.token, "/api/plants/buy", { saleId: sales[0].saleId })).statusCode).toBe(409);
  });

  it("a withdrawn listing unlocks the plant", async () => {
    const a = await company();
    const plant = a.h.state.plants.find((x) => x.ownerId === "player" && x.tech === "battery")!;
    const r = (await built.app.inject({ method: "POST", url: "/api/plants/list", headers: auth(a.token), payload: { plantId: plant.plantId, priceCc: 1_000_000 } })).json();
    await built.app.inject({ method: "POST", url: "/api/plants/cancel", headers: auth(a.token), payload: { saleId: r.sales[0].saleId } });
    expect(plant.saleLocked).toBeFalsy();
  });
});
