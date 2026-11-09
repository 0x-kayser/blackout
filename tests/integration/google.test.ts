/**
 * Direct Google sign-in. Google's ID tokens are simulated with a locally generated RS256 key and a local JWKS, so this
 * verifies OUR verification and player mapping, not Google itself.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { StartSessionResponseSchema } from "@blackout/shared";
import { buildServer } from "../../apps/api/src/server.ts";
import { loadChainConfig } from "../../apps/api/src/chain.ts";
import { loadSupabaseConfig } from "../../apps/api/src/auth.ts";
import { StaticWorldInputs } from "../../apps/api/src/world.ts";

const CLIENT = "1234567890-abcdefg.apps.googleusercontent.com";
type Key = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let priv: Key;
let built: Awaited<ReturnType<typeof buildServer>>;

async function idToken(sub: string, o: { aud?: string; iss?: string; verified?: boolean; exp?: string; key?: Key } = {}) {
  return new SignJWT({ email: "ada@gmail.com", email_verified: o.verified ?? true, given_name: "Ada", name: "Ada Lovelace" })
    .setProtectedHeader({ alg: "RS256", kid: "g1" })
    .setSubject(sub)
    .setIssuer(o.iss ?? "https://accounts.google.com")
    .setAudience(o.aud ?? CLIENT)
    .setIssuedAt()
    .setExpirationTime(o.exp ?? "1h")
    .sign(o.key ?? priv);
}

beforeEach(async () => {
  const kp = await generateKeyPair("RS256", { extractable: true });
  priv = kp.privateKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: "g1", alg: "RS256" };
  built = await buildServer({ dbPath: ":memory:", chain: loadChainConfig({}), webDist: null, world: new StaticWorldInputs(), supabase: loadSupabaseConfig({ GOOGLE_CLIENT_ID: CLIENT }), googleJwks: createLocalJWKSet({ keys: [jwk] }), economy: { gateway: null } });
});
afterEach(async () => {
  await built.app.close();
  built.db.close();
});

const google = (credential: string, cookie?: string) => built.app.inject({ method: "POST", url: "/api/auth/google", payload: { credential }, headers: cookie ? { cookie } : {} });
const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers["set-cookie"] ?? "").split(";")[0];

describe("Google sign-in", () => {
  it("advertises the client id, signs a new player in, and the same Google account comes back to the same player", async () => {
    const cfg = (await built.app.inject({ method: "GET", url: "/api/config/public" })).json();
    expect(cfg.auth.google).toBe(true);
    expect(cfg.auth.googleClientId).toBe(CLIENT);
    const a = await google(await idToken("g-1"));
    expect(a.statusCode).toBe(200);
    expect(a.json().player.kind).toBe("registered");
    const me = (await built.app.inject({ method: "GET", url: "/api/me", headers: { cookie: cookieOf(a) } })).json();
    expect(me.player.playerId).toBe(a.json().player.playerId);
    const b = await google(await idToken("g-1"));
    expect(b.json().player.playerId).toBe(a.json().player.playerId);
    // we never store the email address
    const rows = JSON.stringify(built.db.prepare("SELECT * FROM auth_identities").all()) + JSON.stringify(built.db.prepare("SELECT * FROM players").all());
    expect(rows).not.toContain("ada@gmail.com");
    expect(rows).not.toContain("g-1");
  });

  it("a guest who signs in with Google keeps their company", async () => {
    const s = await built.app.inject({ method: "POST", url: "/api/session/start", payload: {} });
    const token = StartSessionResponseSchema.parse(s.json()).token;
    const guestId = (await built.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } })).json().player.playerId;
    const r = await built.app.inject({ method: "POST", url: "/api/auth/google", payload: { credential: await idToken("g-2") }, headers: { authorization: `Bearer ${token}` } });
    expect(r.json().upgradedGuest).toBe(true);
    expect(r.json().player.playerId).toBe(guestId);
    expect(r.json().player.kind).toBe("registered");
  });

  it("refuses tokens for another app, from another issuer, expired, badly signed, or for an unverified email", async () => {
    const other = (await generateKeyPair("RS256")).privateKey;
    for (const t of [await idToken("x", { aud: "someone-else.apps.googleusercontent.com" }), await idToken("x", { iss: "https://evil.example" }), await idToken("x", { exp: "-1m" }), await idToken("x", { key: other })]) {
      expect((await google(t)).statusCode).toBe(401);
    }
    expect((await google(await idToken("x", { verified: false }))).statusCode).toBe(400);
    expect(built.db.prepare("SELECT COUNT(*) AS n FROM auth_identities WHERE provider = 'google'").get()).toEqual({ n: 0 });
  });

  it("is off, and says so, when no client id is configured", async () => {
    const off = await buildServer({ dbPath: ":memory:", chain: loadChainConfig({}), webDist: null, world: new StaticWorldInputs(), supabase: loadSupabaseConfig({}), economy: { gateway: null } });
    const r = await off.app.inject({ method: "POST", url: "/api/auth/google", payload: { credential: "x".repeat(200) } });
    expect(r.json().error.code).toBe("AUTH_PROVIDER_UNAVAILABLE");
    await off.app.close();
    off.db.close();
  });
});
