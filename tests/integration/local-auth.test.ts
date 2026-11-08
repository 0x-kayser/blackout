import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../../apps/api/src/server.ts";
import { loadChainConfig } from "../../apps/api/src/chain.ts";
import { loadSupabaseConfig } from "../../apps/api/src/auth.ts";

type Built = Awaited<ReturnType<typeof buildServer>>;
let built: Built | null = null;
afterEach(async () => {
  if (built) {
    await built.app.close();
    built.db.close();
    built = null;
  }
});

const local = (showCode: boolean) => loadSupabaseConfig({ AUTH_LOCAL_EMAIL: "true", AUTH_LOCAL_EMAIL_SHOW_CODE: showCode ? "true" : "false" } as NodeJS.ProcessEnv);
const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers["set-cookie"] ?? "").split(";")[0];

describe("local email-code sign-in (no Supabase)", () => {
  it("signs a guest in with a code, keeps their city, and lets them back in on another device", async () => {
    built = await buildServer({ dbPath: ":memory:", chain: loadChainConfig({}), allowedOrigins: [], webDist: null, supabase: local(true) });
    const cfg = (await built.app.inject({ method: "GET", url: "/api/config/public" })).json();
    expect(cfg.auth).toMatchObject({ email: true, local: true, localShowsCode: true, google: false });

    const s = await built.app.inject({ method: "POST", url: "/api/session/start", payload: {} });
    const guest = cookieOf(s);
    const g = await built.app.inject({ method: "POST", url: "/api/game/start", headers: { cookie: guest }, payload: { scenarioId: "starter" } });
    const runId = g.json().state.run.runId;

    const start = await built.app.inject({ method: "POST", url: "/api/auth/email/start", headers: { cookie: guest }, payload: { email: "Ada@Example.com" } });
    expect(start.json()).toMatchObject({ ok: true, sent: true, devCode: expect.stringMatching(/^\d{6}$/) });
    const wrong = await built.app.inject({ method: "POST", url: "/api/auth/email/verify", headers: { cookie: guest }, payload: { email: "ada@example.com", code: start.json().devCode === "000000" ? "111111" : "000000" } });
    expect(wrong.json().error.message).toMatch(/doesn't match/);
    const ok = await built.app.inject({ method: "POST", url: "/api/auth/email/verify", headers: { cookie: guest }, payload: { email: "ada@example.com", code: start.json().devCode } });
    expect(ok.json()).toMatchObject({ ok: true, upgradedGuest: true, player: { kind: "registered", displayName: "ada", activeRunId: runId } });
    const me = (await built.app.inject({ method: "GET", url: "/api/me", headers: { cookie: guest } })).json().player;
    expect(me).toMatchObject({ kind: "registered", loginMethod: "email", activeRunId: runId });
    // the email itself is never stored, only hashes
    expect(JSON.stringify(built.db.prepare("SELECT * FROM auth_identities").all())).not.toMatch(/ada@example/i);

    // a different device (no cookie) signs in to the same account and city
    const c2 = await built.app.inject({ method: "POST", url: "/api/auth/email/start", payload: { email: "ada@example.com" } });
    const v2 = await built.app.inject({ method: "POST", url: "/api/auth/email/verify", payload: { email: "ada@example.com", code: c2.json().devCode } });
    expect(v2.json()).toMatchObject({ upgradedGuest: false, player: { activeRunId: runId } });
    const me2 = (await built.app.inject({ method: "GET", url: "/api/me", headers: { cookie: cookieOf(v2) } })).json().player;
    expect(me2.activeRunId).toBe(runId);
    // codes are single-use
    const again = await built.app.inject({ method: "POST", url: "/api/auth/email/verify", payload: { email: "ada@example.com", code: c2.json().devCode } });
    expect(again.json().error.message).toMatch(/expired/);
  });

  it("never returns the code to the page unless local test mode is on, and is off when Supabase is configured", async () => {
    built = await buildServer({ dbPath: ":memory:", chain: loadChainConfig({}), allowedOrigins: [], webDist: null, supabase: local(false) });
    const r = await built.app.inject({ method: "POST", url: "/api/auth/email/start", payload: { email: "bo@example.com" } });
    expect(r.json()).toEqual({ ok: true, sent: true });
    const supa = loadSupabaseConfig({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon", AUTH_LOCAL_EMAIL: "true", AUTH_LOCAL_EMAIL_SHOW_CODE: "true" } as NodeJS.ProcessEnv);
    expect(supa.local).toEqual({ enabled: false, showCode: false });
    const prod = loadSupabaseConfig({ AUTH_LOCAL_EMAIL: "true", AUTH_LOCAL_EMAIL_SHOW_CODE: "true", NODE_ENV: "production" } as NodeJS.ProcessEnv);
    expect(prod.local.showCode).toBe(false);
  });
});
