/** With guest play off (the default outside development), everyone signs in before they can play. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../apps/api/src/server.ts";
import { loadChainConfig } from "../../apps/api/src/chain.ts";
import { loadSupabaseConfig } from "../../apps/api/src/auth.ts";
import { StaticWorldInputs } from "../../apps/api/src/world.ts";

let built: Awaited<ReturnType<typeof buildServer>>;
beforeEach(async () => {
  built = await buildServer({ dbPath: ":memory:", chain: loadChainConfig({}), webDist: null, world: new StaticWorldInputs(), economy: { gateway: null }, guestPlay: false, supabase: loadSupabaseConfig({ AUTH_LOCAL_EMAIL: "true", AUTH_LOCAL_EMAIL_SHOW_CODE: "true" }) });
});
afterEach(async () => {
  await built.app.close();
  built.db.close();
});

describe("sign in first", () => {
  it("offers no guest play, refuses guest sessions, and lets a signed-in player in", async () => {
    const cfg = (await built.app.inject({ method: "GET", url: "/api/config/public" })).json();
    expect(cfg.auth.guestPlay).toBe(false);
    expect((await built.app.inject({ method: "POST", url: "/api/session/start", payload: {} })).statusCode).toBe(403);
    // a guest session from before can see who it is (to be upgraded) but can't play
    const g = built.auth.createGuestSession();
    const H = { authorization: `Bearer ${g.token}` };
    expect((await built.app.inject({ method: "GET", url: "/api/me", headers: H })).json().player.kind).toBe("guest");
    expect((await built.app.inject({ method: "GET", url: "/api/region", headers: H })).statusCode).toBe(401);
    // signing in with an email code upgrades that same player and opens the game
    const start = (await built.app.inject({ method: "POST", url: "/api/auth/email/start", payload: { email: "ada@example.com" } })).json();
    const v = await built.app.inject({ method: "POST", url: "/api/auth/email/verify", headers: H, payload: { email: "ada@example.com", code: start.devCode } });
    expect(v.json().upgradedGuest).toBe(true);
    expect(v.json().player.playerId).toBe(g.userId);
    expect((await built.app.inject({ method: "GET", url: "/api/region", headers: H })).statusCode).toBe(200);
  });
});
