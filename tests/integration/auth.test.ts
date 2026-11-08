/**
 * Auth -> player mapping, guest persistence and upgrade, save/restore, offline policy.
 * Supabase tokens are simulated with a locally generated ES256 key pair and a local JWKS:
 * this verifies OUR verification and mapping code, not Supabase itself.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { GameStateResponseSchema, MeResponseSchema } from "@blackout/shared";
import { buildServer } from "../../apps/api/src/server.ts";
import { loadChainConfig } from "../../apps/api/src/chain.ts";
import type { SupabaseConfig } from "../../apps/api/src/auth.ts";

const SUPA = "https://demo-project.supabase.co";
const supabase: SupabaseConfig = { enabled: true, url: SUPA, anonKey: "public-anon", issuer: `${SUPA}/auth/v1`, audience: "authenticated", providers: { google: true, email: true }, local: { enabled: false, showCode: false } };

type Built = Awaited<ReturnType<typeof buildServer>>;
let built: Built;
let clock = 5_000_000;
type Key = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let priv: Key;
let wrongPriv: Key;

async function token(sub: string, opts: { iss?: string; aud?: string; exp?: string; key?: Key; provider?: string } = {}) {
  return new SignJWT({ role: "authenticated", app_metadata: { provider: opts.provider ?? "google" }, user_metadata: { full_name: "Ada Operator" } })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setSubject(sub)
    .setIssuer(opts.iss ?? `${SUPA}/auth/v1`)
    .setAudience(opts.aud ?? "authenticated")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h")
    .sign(opts.key ?? priv);
}
const H = (t: string) => ({ authorization: `Bearer ${t}` });

beforeEach(async () => {
  const kp = await generateKeyPair("ES256", { extractable: true });
  priv = kp.privateKey;
  wrongPriv = (await generateKeyPair("ES256")).privateKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "ES256" };
  built = await buildServer({ dbPath: ":memory:", chain: loadChainConfig({}), now: () => clock, allowedOrigins: [], supabase, jwks: createLocalJWKSet({ keys: [jwk] }), webDist: null });
});
afterEach(async () => {
  await built.app.close();
  built.db.close();
});

describe("provider login -> player mapping", () => {
  it("first login creates one player; later logins reuse it", async () => {
    const t = await token("user-1");
    const a = MeResponseSchema.parse((await built.app.inject({ method: "GET", url: "/api/me", headers: H(t) })).json());
    expect(a.player.kind).toBe("registered");
    expect(a.player.loginMethod).toBe("google");
    expect(a.player.displayName).toBe("Ada Operator");
    const b = MeResponseSchema.parse((await built.app.inject({ method: "GET", url: "/api/me", headers: H(await token("user-1", { provider: "email" })) })).json());
    expect(b.player.playerId).toBe(a.player.playerId);
    const n = built.db.prepare("SELECT COUNT(*) AS n FROM players").get() as { n: number };
    expect(n.n).toBe(1);
  });

  it("rejects tokens with wrong issuer, audience, signature or expiry", async () => {
    for (const bad of [
      await token("u", { iss: "https://evil.supabase.co/auth/v1" }),
      await token("u", { aud: "anon" }),
      await token("u", { key: wrongPriv }),
      await token("u", { exp: "-10m" }),
      "not.a.jwt",
    ]) {
      const r = await built.app.inject({ method: "GET", url: "/api/me", headers: H(bad) });
      expect(r.statusCode).toBe(401);
    }
  });

  it("the client cannot choose its player id", async () => {
    const t = await token("user-2");
    const r = await built.app.inject({ method: "POST", url: "/api/game/start", headers: { ...H(t), "x-player-id": "player_other" }, payload: { playerId: "player_other" } });
    expect(r.statusCode).toBe(200);
    const me = MeResponseSchema.parse((await built.app.inject({ method: "GET", url: "/api/me", headers: H(t) })).json());
    expect(me.player.playerId).not.toBe("player_other");
  });
});

describe("save and restore", () => {
  it("game/start creates one save; returning resumes it with progress intact", async () => {
    const t = await token("user-3");
    const g1 = GameStateResponseSchema.parse((await built.app.inject({ method: "POST", url: "/api/game/start", headers: H(t), payload: {} })).json());
    expect(g1.resumed).toBe(false);
    const runId = g1.state.run.runId;
    const h = built.svc.get(runId);
    built.svc.advanceOne(h);
    const req = built.svc.publicState(h).requests[0];
    await built.app.inject({ method: "POST", url: "/api/game/actions", headers: H(t), payload: { action: { type: "ACCEPT_REQUEST", requestId: req.requestId, generatorId: "gen_1" }, idempotencyKey: "acc-0000001" } });
    for (let i = 0; i < 20; i++) built.svc.advanceOne(h);
    const credits = built.svc.publicState(h).player.creditsCc;
    // "leave": drop from memory (as after a restart) and come back later with a fresh token
    built.svc.runs.delete(runId);
    clock += 3_600_000;
    const g2 = GameStateResponseSchema.parse((await built.app.inject({ method: "POST", url: "/api/game/start", headers: H(await token("user-3")), payload: {} })).json());
    expect(g2.resumed).toBe(true);
    expect(g2.state.run.runId).toBe(runId);
    expect(g2.state.player.creditsCc).toBe(credits);
    expect(g2.state.contracts.some((c) => c.status === "completed")).toBe(true);
  });

  it("offline policy: with no client connected the city pauses — no fuel burns, no bills", async () => {
    const t = await token("user-4");
    const g = GameStateResponseSchema.parse((await built.app.inject({ method: "POST", url: "/api/game/start", headers: H(t), payload: {} })).json());
    const h = built.svc.get(g.state.run.runId);
    built.svc.advanceOne(h);
    const req = built.svc.publicState(h).requests[0];
    await built.app.inject({ method: "POST", url: "/api/game/actions", headers: H(t), payload: { action: { type: "ACCEPT_REQUEST", requestId: req.requestId, generatorId: "gen_1" }, idempotencyKey: "acc-0000002" } });
    // a client connects then leaves
    const off = built.svc.subscribe(h, () => {});
    expect(h.running).toBe(true);
    off();
    clock += 20_000;
    built.svc.driverStep(); // auto-pause after 15 s without clients
    expect(h.running).toBe(false);
    const fuel = h.state.balances.fuel_ml.player;
    clock += 6 * 3_600_000;
    built.svc.driverStep();
    expect(h.state.balances.fuel_ml.player).toBe(fuel);
    const st = GameStateResponseSchema.parse((await built.app.inject({ method: "GET", url: "/api/game/state", headers: H(t) })).json());
    expect(st.awayMs).toBeGreaterThanOrEqual(6 * 3_600_000);
    expect(st.state.contracts.find((c) => c.status === "active")).toBeTruthy(); // resumes mid-delivery
  });
});

describe("guest upgrade", () => {
  async function guestWithCity() {
    const s = await built.app.inject({ method: "POST", url: "/api/session/start", payload: {} });
    const gt = s.json().token as string;
    const g = GameStateResponseSchema.parse((await built.app.inject({ method: "POST", url: "/api/game/start", headers: H(gt), payload: {} })).json());
    return { gt, runId: g.state.run.runId };
  }

  it("a guest city moves to the new account on first sign-in", async () => {
    const { gt, runId } = await guestWithCity();
    const t = await token("user-5");
    const r = await built.app.inject({ method: "POST", url: "/api/auth/link-guest", headers: H(t), payload: { guestToken: gt } });
    expect(r.statusCode).toBe(200);
    const me = MeResponseSchema.parse(r.json());
    expect(me.player.kind).toBe("registered");
    expect(me.player.activeRunId).toBe(runId);
    const again = MeResponseSchema.parse((await built.app.inject({ method: "GET", url: "/api/me", headers: H(await token("user-5")) })).json());
    expect(again.player.activeRunId).toBe(runId);
    // the old guest token no longer works
    expect((await built.app.inject({ method: "GET", url: "/api/me", headers: H(gt) })).statusCode).toBe(401);
  });

  it("never overwrites an account that already has a city", async () => {
    const t = await token("user-6");
    const mine = GameStateResponseSchema.parse((await built.app.inject({ method: "POST", url: "/api/game/start", headers: H(t), payload: {} })).json());
    const { gt, runId } = await guestWithCity();
    const r = await built.app.inject({ method: "POST", url: "/api/auth/link-guest", headers: H(t), payload: { guestToken: gt } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("ACCOUNT_EXISTS");
    const me = MeResponseSchema.parse((await built.app.inject({ method: "GET", url: "/api/me", headers: H(t) })).json());
    expect(me.player.activeRunId).toBe(mine.state.run.runId);
    expect((await built.app.inject({ method: "GET", url: "/api/game/state", headers: H(gt) })).json().state.run.runId).toBe(runId);
  });

  it("logout revokes a guest session", async () => {
    const { gt } = await guestWithCity();
    await built.app.inject({ method: "POST", url: "/api/auth/logout", headers: H(gt), payload: {} });
    expect((await built.app.inject({ method: "GET", url: "/api/me", headers: H(gt) })).statusCode).toBe(401);
  });
});
