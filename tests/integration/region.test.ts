import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StartSessionResponseSchema, type RegionView } from "@blackout/shared";
import { region } from "@blackout/sim";
import { buildServer } from "../../apps/api/src/server.ts";
import { loadChainConfig } from "../../apps/api/src/chain.ts";
import { LiveWorldInputs, StaticWorldInputs } from "../../apps/api/src/world.ts";
import { openDb } from "../../apps/api/src/db.ts";

type Built = Awaited<ReturnType<typeof buildServer>>;
let built: Built;
let clock = 5_000_000;

beforeEach(async () => {
  built = await buildServer({ dbPath: ":memory:", chain: loadChainConfig({}), now: () => clock, webDist: null, world: new StaticWorldInputs() });
});
afterEach(async () => {
  await built.app.close();
  built.db.close();
});

async function session() {
  const r = await built.app.inject({ method: "POST", url: "/api/session/start", payload: {} });
  return StartSessionResponseSchema.parse(r.json()).token;
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
let n = 0;
const key = () => `region-key-${++n}-x`;

async function live(t: string): Promise<RegionView> {
  const r = await built.app.inject({ method: "GET", url: "/api/region", headers: auth(t) });
  expect(r.statusCode).toBe(200);
  return r.json().view;
}
async function act(t: string, regionId: string, action: object, k = key()) {
  const r = await built.app.inject({ method: "POST", url: `/api/region/${regionId}/actions`, headers: auth(t), payload: { action, idempotencyKey: k } });
  return { status: r.statusCode, body: r.json() };
}

describe("region API", () => {
  it("gives each player one persistent live region and resumes it", async () => {
    const t = await session();
    const v = await live(t);
    expect(v.nodes).toHaveLength(7);
    expect(v.pulse.cashCc).toBe(region.regionConfig.STARTER_GRANT_CC);
    const again = await live(t);
    expect(again.regionId).toBe(v.regionId);
    // a restart loads the same region from the database
    const h = built.rsvc.get(v.regionId);
    for (let i = 0; i < 7; i++) built.rsvc.advance(h);
    built.rsvc.checkpoint(h);
    built.rsvc.regions.clear();
    const resumed = await live(t);
    expect(resumed.regionId).toBe(v.regionId);
    expect(resumed.interval).toBe(8);
  });

  it("applies decisions idempotently and refuses other players", async () => {
    const t = await session();
    const v = await live(t);
    const k = key();
    const a = await act(t, v.regionId, { type: "SET_PLANT_ONLINE", plantId: "kestrel", online: true }, k);
    expect(a.status).toBe(200);
    expect(a.body.ok).toBe(true);
    const b = await act(t, v.regionId, { type: "SET_PLANT_ONLINE", plantId: "kestrel", online: true }, k);
    expect(b.body.replayed).toBe(true);
    const rows = built.db.prepare("SELECT COUNT(*) AS n FROM region_actions WHERE region_id = ?").get(v.regionId) as { n: number };
    expect(rows.n).toBe(1);
    const bad = await act(t, v.regionId, { type: "SET_PLANT_ONLINE", plantId: "harbor_ccgt", online: false });
    expect(bad.status).toBe(403);
    expect(bad.body.error.message).toMatch(/isn't yours/);
    const other = await session();
    const steal = await act(other, v.regionId, { type: "SET_BATTERY_MODE", plantId: "eastside", mode: "discharge" });
    expect(steal.status).toBe(403);
    const invalid = await act(t, v.regionId, { type: "BUILD_PLANT", tech: "fusion", nodeId: "port", size: 0 });
    expect(invalid.status).toBe(400);
  });

  it("quotes market orders with exact current totals and no reservation", async () => {
    const t = await session();
    const v = await live(t);
    const townBefore = JSON.stringify(built.tsvc.state);
    const cashBefore = region.rbal(built.rsvc.get(v.regionId).state, "cc", region.RACC.player);
    const q = await built.app.inject({
      method: "POST",
      url: "/api/town/quote",
      headers: auth(t),
      payload: { merchantId: "pavel", item: "material:steel", side: "buy", quantity: 10 },
    });
    expect(q.statusCode).toBe(200);
    expect(q.json().quote.canTrade).toBe(true);
    expect(q.json().quote.feeCc).toBe(0);
    expect(q.json().quote.totalCc).toBe(q.json().quote.unitCc * 10);
    expect(q.json().quote.cashAfterCc).toBe(q.json().quote.cashCc - q.json().quote.totalCc);
    expect(JSON.stringify(built.tsvc.state)).toBe(townBefore);
    expect(region.rbal(built.rsvc.get(v.regionId).state, "cc", region.RACC.player)).toBe(cashBefore);
  });

  it("previews a shop investment without reserving cash and reports the settled share", async () => {
    const t = await session();
    const v = await live(t);
    const amountCc = 500_000;
    const stateBefore = JSON.stringify(built.tsvc.state);
    const cashBefore = v.player.cashCc;
    const q = await built.app.inject({
      method: "POST",
      url: "/api/town/invest-quote",
      headers: auth(t),
      payload: { merchantId: "lena", amountCc },
    });
    expect(q.statusCode).toBe(200);
    expect(q.json().quote).toMatchObject({ canInvest: true, amountCc, cashCc: cashBefore, cashAfterCc: cashBefore - amountCc });
    expect(q.json().quote.shareBps).toBeGreaterThan(0);
    expect(JSON.stringify(built.tsvc.state)).toBe(stateBefore);
    expect(region.rbal(built.rsvc.get(v.regionId).state, "cc", region.RACC.player)).toBe(cashBefore);

    const result = await built.app.inject({
      method: "POST",
      url: "/api/town/invest",
      headers: auth(t),
      payload: { merchantId: "lena", amountCc, idempotencyKey: "invest-quote-check-1" },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().shareBps).toBe(q.json().quote.shareBps);
  });

  it("requires a player session to quote a personal order", async () => {
    const q = await built.app.inject({
      method: "POST",
      url: "/api/town/quote",
      payload: { merchantId: "pavel", item: "material:steel", side: "buy", quantity: 10 },
    });
    expect(q.statusCode).toBe(401);
  });

  it("stores each settlement epoch once with a verifiable hash", async () => {
    const t = await session();
    const v = await live(t);
    const h = built.rsvc.get(v.regionId);
    for (let i = 0; i < 80; i++) built.rsvc.advance(h);
    const r = await built.app.inject({ method: "GET", url: `/api/region/${v.regionId}/epochs`, headers: auth(t) });
    expect(r.statusCode).toBe(403); // settlement hashes are for operators, not the player interface
    const epochs = built.rsvc.epochs(v.regionId) as { epochId: string; verified: boolean; status: string; transfers: { deltaCc: number }[] }[];
    expect(epochs.length).toBe(2);
    for (const e of epochs) {
      expect(e.verified).toBe(true);
      expect(e.status).toBe("local");
      expect(e.transfers.reduce((a, x) => a + x.deltaCc, 0)).toBe(0);
    }
    // re-persisting is a no-op: the epoch id is unique
    h.lastEpochNo = 0;
    built.rsvc.advance(h);
    const count = built.db.prepare("SELECT COUNT(*) AS n FROM settlement_epochs WHERE region_id = ?").get(v.regionId) as { n: number };
    expect(count.n).toBe(2);
  });

  it("pauses when nobody watches and runs while the stream is open", async () => {
    const t = await session();
    const v = await live(t);
    const h = built.rsvc.get(v.regionId);
    h.state.onboarding.done = true;
    expect(built.rsvc.driverStep()).toBe(0);
    const off = built.rsvc.subscribe(h, () => undefined);
    expect(built.rsvc.driverStep()).toBe(1);
    off();
    clock += 20_000;
    expect(built.rsvc.driverStep()).toBe(0);
  });

  it("in the first minute the clock waits for the player, then runs a few intervals after each tap", async () => {
    const t = await session();
    const v = await live(t);
    const h = built.rsvc.get(v.regionId);
    built.rsvc.subscribe(h, () => undefined);
    expect(built.rsvc.driverStep()).toBe(0);
    await act(t, v.regionId, { type: "SET_BATTERY_MODE", plantId: "eastside", mode: "auto" });
    let ran = 0;
    for (let i = 0; i < 10; i++) ran += built.rsvc.driverStep();
    expect(ran).toBe(4);
    expect(h.state.onboarding.step).toBe(1);
  });

  it("records world inputs as system actions for live regions only", async () => {
    const t = await session();
    const v = await live(t);
    const snap = { ...region.regionConfig.DEFAULT_SNAPSHOT, source: "live" as const, capturedAt: "2026-11-09T10:00:00Z", gasUsdPerMMBtu: 9.5 };
    expect(built.rsvc.applyWorld(snap)).toBe(1);
    expect(built.rsvc.applyWorld(snap)).toBe(0);
    expect(built.rsvc.get(v.regionId).state.input.gasUsdPerMMBtu).toBe(9.5);
    const sys = built.db.prepare("SELECT source FROM region_actions WHERE region_id = ?").all(v.regionId) as { source: string }[];
    expect(sys.map((x) => x.source)).toEqual(["system"]);
  });

  it("weekly challenge: same seed for everyone, scored on the leaderboard", async () => {
    const a = await session();
    const b = await session();
    const ra = (await built.app.inject({ method: "POST", url: "/api/region/new", headers: auth(a), payload: { mode: "challenge" } })).json().view as RegionView;
    const rb = (await built.app.inject({ method: "POST", url: "/api/region/new", headers: auth(b), payload: { mode: "challenge" } })).json().view as RegionView;
    expect(built.rsvc.get(ra.regionId).state.seed).toBe(built.rsvc.get(rb.regionId).state.seed);
    const h = built.rsvc.get(ra.regionId);
    while (!h.state.ended) built.rsvc.advance(h);
    const lb = (await built.app.inject({ method: "GET", url: "/api/region/leaderboard" })).json().entries;
    expect(lb).toHaveLength(1);
    expect(lb[0].regionId).toBe(ra.regionId);
  }, 20_000);

  it("Economy Lab compares gas-heavy and solar+storage", async () => {
    const r = await built.app.inject({ method: "GET", url: "/api/region/lab?seed=3&days=1" });
    const lab = r.json().lab;
    expect(lab.gasHeavy.frames).toHaveLength(60);
    expect(lab.solarStorage.emissionsT).toBeLessThan(lab.gasHeavy.emissionsT);
  });
});

describe("world inputs", () => {
  it("normalises Open-Meteo, persists it, and falls back to the last good snapshot", async () => {
    const db = openDb(":memory:");
    const ok = (async (url: string) =>
      new Response(JSON.stringify(String(url).includes("open-meteo") ? { current: { temperature_2m: 33.4, cloud_cover: 12, wind_speed_10m: 9, time: "2026-11-09T12:00" } } : {}), { status: 200 })) as unknown as typeof fetch;
    const p = new LiveWorldInputs(db, ok, { enabled: true, refreshMs: 0 });
    const s = await p.getSnapshot();
    expect(s.source).toBe("live");
    expect(s.tempC).toBe(33.4);
    expect(s.sources.find((x) => x.field === "weather")!.provider).toMatch(/Open-Meteo/);
    expect(s.sources.find((x) => x.field === "gas")!.provider).toMatch(/reference value/);
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const p2 = new LiveWorldInputs(db, down, { enabled: true, refreshMs: 0 });
    expect(p2.current().source).toBe("fallback");
    expect(p2.current().tempC).toBe(33.4);
    const s2 = await p2.getSnapshot();
    expect(s2.source).toBe("fallback");
    db.close();
  });
});

describe("Vesper Market through the API", () => {
  async function trade(t: string, body: object) {
    const r = await built.app.inject({ method: "POST", url: "/api/town/trade", headers: auth(t), payload: body });
    return { status: r.statusCode, body: r.json() };
  }

  it("a trade moves the merchant's stock and the player's inventory together, once", async () => {
    const t = await session();
    const v = await live(t);
    const before = built.tsvc.view(null).merchants.find((m) => m.merchantId === "kettle")!.items[0].stock;
    const r = await trade(t, { merchantId: "kettle", item: "fuel:diesel", side: "buy", quantity: 5_000, idempotencyKey: "trade-key-0001" });
    expect(r.status).toBe(200);
    expect(r.body.view.player.diesel).toBe(v.player.diesel + 5_000);
    expect(r.body.view.player.cashCc).toBe(v.player.cashCc - r.body.trade.totalCc);
    expect(r.body.town.merchants.find((m: { merchantId: string }) => m.merchantId === "kettle").items[0].stock).toBe(before - 5_000);
    const again = await trade(t, { merchantId: "kettle", item: "fuel:diesel", side: "buy", quantity: 5_000, idempotencyKey: "trade-key-0001" });
    expect(again.body.replayed).toBe(true);
    expect(built.tsvc.view(null).merchants.find((m) => m.merchantId === "kettle")!.items[0].stock).toBe(before - 5_000);
    // selling back what you hold works; selling what you don't, doesn't
    expect((await trade(t, { merchantId: "kettle", item: "fuel:diesel", side: "sell", quantity: 1_000, idempotencyKey: "trade-key-0002" })).status).toBe(200);
    const bad = await trade(t, { merchantId: "lena", item: "certificate:renewable", side: "sell", quantity: 10, idempotencyKey: "trade-key-0003" });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toMatch(/You have only 0/);
  });

  it("one player's buying raises the price another player sees", async () => {
    const a = await session();
    const b = await session();
    await live(a);
    await live(b);
    const p0 = (await built.app.inject({ method: "GET", url: "/api/town", headers: auth(b) })).json().town.merchants.find((m: { merchantId: string }) => m.merchantId === "ingrid").items[0].askCc;
    await trade(a, { merchantId: "ingrid", item: "fuel:natural-gas", side: "buy", quantity: 20_000, idempotencyKey: "trade-key-0100" });
    const p1 = (await built.app.inject({ method: "GET", url: "/api/town", headers: auth(b) })).json().town.merchants.find((m: { merchantId: string }) => m.merchantId === "ingrid").items[0].askCc;
    expect(p1).toBeGreaterThan(p0);
  });

  it("building buys the steel it needs from the market automatically", async () => {
    const t = await session();
    const v = await live(t);
    const steel0 = built.tsvc.view(null).merchants.find((m) => m.merchantId === "pavel")!.items[0].stock;
    const r = await act(t, v.regionId, { type: "BUILD_PLANT", tech: "diesel", nodeId: "residential_east", size: 1 });
    expect(r.status).toBe(200);
    expect(r.body.view.plants.some((p: { status: string; mine: boolean }) => p.mine && p.status === "building")).toBe(true);
    expect(built.tsvc.view(null).merchants.find((m) => m.merchantId === "pavel")!.items[0].stock).toBeLessThan(steel0);
    expect(built.tsvc.state.trades.at(-1)!.item).toBe("material:steel");
  });

  it("investing in a closed shop reopens it and costs the investor", async () => {
    const t = await session();
    const v = await live(t);
    built.tsvc.state.merchants.lena.open = false;
    built.tsvc.state.merchants.lena.closedSince = built.tsvc.state.tick;
    const need = built.tsvc.view(null).merchants.find((m) => m.merchantId === "lena")!.reopenCc;
    const r = await built.app.inject({ method: "POST", url: "/api/town/invest", headers: auth(t), payload: { merchantId: "lena", amountCc: need, idempotencyKey: "invest-key-01" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().reopened).toBe(true);
    expect(r.json().view.player.cashCc).toBe(v.player.cashCc - need);
    expect(r.json().town.merchants.find((m: { merchantId: string }) => m.merchantId === "lena").investors[0].mine).toBe(true);
  });

  it("serves a watchable week", async () => {
    const r = await built.app.inject({ method: "GET", url: "/api/town/fastforward?seed=7" });
    expect(r.json().week.frames).toHaveLength(60);
    // a simulated week is CPU-heavy; under a full parallel test run it can take a while
  }, 90_000);
});

describe("company names", () => {
  it("nobody sees a personal name until you name your company; renaming updates the market", async () => {
    const t = await session();
    const v = await live(t);
    const me = (await built.app.inject({ method: "GET", url: "/api/me", headers: auth(t) })).json().player;
    expect(me.companyNamed).toBe(false);
    await built.app.inject({ method: "POST", url: "/api/town/trade", headers: auth(t), payload: { merchantId: "kettle", item: "fuel:diesel", side: "buy", quantity: 1_000, idempotencyKey: "name-key-001" } });
    expect(built.tsvc.state.trades.at(-1)!.label).toBe("An unnamed power company");
    const r = await built.app.inject({ method: "PATCH", url: "/api/me", headers: auth(t), payload: { displayName: "Vesper Light & Power" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().player).toMatchObject({ displayName: "Vesper Light & Power", companyNamed: true });
    // past trades and future ones carry the new name
    expect(built.tsvc.state.trades.at(-1)!.label).toBe("Vesper Light & Power");
    await built.app.inject({ method: "POST", url: "/api/town/trade", headers: auth(t), payload: { merchantId: "kettle", item: "fuel:diesel", side: "buy", quantity: 1_000, idempotencyKey: "name-key-002" } });
    expect(built.tsvc.state.trades.at(-1)!.label).toBe("Vesper Light & Power");
    expect(v.regionId).toBeTruthy();
    const bad = await built.app.inject({ method: "PATCH", url: "/api/me", headers: auth(t), payload: { displayName: "<script>" } });
    expect(bad.statusCode).toBe(400);
  });
});
