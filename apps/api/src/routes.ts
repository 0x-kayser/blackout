/**
 * HTTP routes. Business rules live in packages/sim and services.ts; handlers only
 * authenticate, validate (shared Zod schemas), authorize and translate errors.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ActionEnvelopeSchema,
  CompareRequestSchema,
  CreateRunRequestSchema,
  GameStartRequestSchema,
  QuoteRequestSchema,
  ReplayRequestSchema,
  StartSessionRequestSchema,
  type ErrorCode,
  type PlayerProfile,
  type ReplaySummary,
} from "@blackout/shared";
import { BRENT_DATASET, SCENARIOS, TIMING } from "@blackout/sim";
import { z } from "zod";
import { clearSessionCookie, setSessionCookie, type AuthService, type AuthedUser } from "./auth.ts";
import { chainStatus, lookupTx, MERCHANT_IDS, TOKEN_IDS, type ChainConfig } from "./chain.ts";
import type { Db } from "./db.ts";
import { lastEventId, openSse } from "./events.ts";
import type { RegionService } from "./region.ts";
import { registerRegionRoutes } from "./regionRoutes.ts";
import type { Relayer } from "./relayer.ts";
import { gameIdentity } from "./identity.ts";
import { oilSnapshot } from "./oil.ts";
import { isoWeek, challengeFor } from "./challenge.ts";
import { ApiError, AUTO_PAUSE_MS, type RunHandle, type RunService } from "./services.ts";
import type { ExchangeService } from "./exchange.ts";
import { registerExchangeRoutes } from "./exchangeRoutes.ts";

export const API_VERSION = "2.0.0";

const STATUS: Partial<Record<ErrorCode, number>> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  RATE_LIMITED: 429,
  STALE_STATE: 409,
  INVALID_PHASE: 409,
  INVALID_STATE: 409,
  ALREADY_PROCESSED: 409,
  RUN_FINISHED: 409,
  ACCOUNT_EXISTS: 409,
  AUTH_PROVIDER_UNAVAILABLE: 503,
  CHAIN_UNAVAILABLE: 503,
  TX_FAILED: 502,
  INTERNAL: 500,
};
export const httpStatus = (code: ErrorCode) => STATUS[code] ?? 422;

function fail(reply: FastifyReply, code: ErrorCode, message: string, details?: Record<string, unknown>) {
  return reply.status(httpStatus(code)).send({ ok: false, error: { code, message, ...(details ? { details } : {}) } });
}

/** Token bucket per session for write routes. */
class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly perSec: number,
    private readonly burst: number,
  ) {}
  take(key: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.perSec);
    b.at = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 50_000) this.buckets.clear();
    return ok;
  }
}

export interface RouteDeps {
  db: Db;
  svc: RunService;
  auth: AuthService;
  chain: ChainConfig;
  allowedOrigins: string[];
  secureCookies: boolean;
  /** The shared fuel exchange; omitted only by tools that don't need it. */
  xsvc?: ExchangeService;
  /** Local demos only: let guest players trade on the exchange. */
  exchangeAllowGuests?: boolean;
  /** The regional power game. */
  rsvc?: RegionService;
  relayer?: Relayer;
  economy?: import("./economy/service.ts").EconomyService;
}


export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db, svc, chain, auth } = deps;
  const writeLimiter = new RateLimiter(20, 40);
  const sessionLimiter = new RateLimiter(0.5, 10); // guest creation per IP
  let lastChainHealth: "disabled" | "ok" | "degraded" = chain.enabled ? "degraded" : "disabled";

  const originFor = (req: FastifyRequest) => {
    const o = req.headers.origin;
    return o && deps.allowedOrigins.includes(o) ? o : null;
  };
  const requireUser = async (req: FastifyRequest): Promise<AuthedUser> => {
    const u = await auth.authenticate(req);
    if (!u) throw new ApiError("UNAUTHORIZED", "Sign in or start a guest session first.");
    return u;
  };
  /** Same-origin or allow-listed origin only (CSRF defence for cookie sessions) + rate limit. */
  const writeGuard = (req: FastifyRequest, key: string) => {
    if (!writeLimiter.take(key)) throw new ApiError("RATE_LIMITED", "Too many requests; slow down.");
    const o = req.headers.origin;
    if (o && !deps.allowedOrigins.includes(o) && o !== `${req.protocol}://${req.headers.host}`) throw new ApiError("FORBIDDEN", `Origin ${o} is not allowed.`);
  };
  const parse = <T>(schema: { safeParse: (x: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown[] } } }, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw new ApiError("VALIDATION_FAILED", "Request body failed validation.", { issues: r.error.issues });
    return r.data;
  };

  app.setErrorHandler((err: Error, req, reply) => {
    if (err instanceof ApiError) return fail(reply, err.code, err.message, err.details);
    if ((err as { validation?: unknown }).validation || (err as { statusCode?: number }).statusCode === 400) return fail(reply, "VALIDATION_FAILED", err.message);
    req.log.error({ err: { message: err.message, stack: err.stack } }, "unhandled error");
    return fail(reply, "INTERNAL", `Internal error (request ${req.id}).`);
  });

  const profile = (u: AuthedUser): PlayerProfile => {
    const p = auth.player(u.userId);
    if (!p) throw new ApiError("NOT_FOUND", "Player not found.");
    const vault = chain.enabled ? chain.vaultAccountId : null;
    return {
      playerId: p.player_id,
      displayName: p.display_name,
      companyNamed: auth.companyNamed(p.player_id),
      kind: p.kind as "guest" | "registered",
      loginMethod: u.loginMethod,
      identities: auth.identities(p.player_id).map((i) => ({ provider: i.provider, loginMethod: i.login_method, lastLoginAt: i.last_login_at })),
      activeRunId: p.active_run_id,
      near: vault
        ? {
            mode: "custodial_vault",
            accountId: vault,
            provisioning: "shared_custodial_vault",
            explanation:
              "Your purchased resources are held by the game's custodial vault account on NEAR testnet and tracked per player in the game database. You have no private key; the server signs. Withdrawal is not available in this build.",
          }
        : {
            mode: "none",
            accountId: null,
            provisioning: "not_configured",
            explanation: "NEAR testnet is not configured on this server. Your resources are tracked only in the game ledger.",
          },
      createdAt: p.created_at,
    };
  };

  // ------------------------------------------------------------ auth & profile
  app.post("/api/session/start", async (req, reply) => {
    if (!sessionLimiter.take(`ip:${req.ip}`)) throw new ApiError("RATE_LIMITED", "Too many new guest sessions from this address.");
    parse(StartSessionRequestSchema, req.body);
    const s = auth.createGuestSession();
    setSessionCookie(reply, s.token, deps.secureCookies);
    return {
      ok: true,
      sessionId: s.sessionId,
      token: s.token,
      user: { userId: s.userId, kind: "guest" },
      authMode: "guest_local",
      note: "Guest city started. Sign in with Google or email later to keep it on another device.",
    };
  });

  app.get("/api/me", async (req) => ({ ok: true, player: profile(await requireUser(req)) }));

  // ------------------------------------------------------------ local email-code sign-in (no Supabase)
  const codeLimiter = new RateLimiter(1 / 20, 3); // ~3 codes per minute per address, then one every 20 s
  const Email = z.string().trim().toLowerCase().email().max(254);
  app.post("/api/auth/email/start", async (req) => {
    if (!auth.supabase.local.enabled) throw new ApiError("AUTH_PROVIDER_UNAVAILABLE", "Email sign-in is handled by the account provider on this server.");
    const body = parse(z.object({ email: Email }), req.body);
    if (!codeLimiter.take(`ip:${req.ip}`) || !codeLimiter.take(`email:${body.email}`)) throw new ApiError("RATE_LIMITED", "Too many codes requested. Wait a minute and try again.");
    const code = auth.startEmailCode(body.email);
    // No mail server in local mode: the code goes to the server log (and, in local test mode, to the page).
    req.log.info({ emailDomain: body.email.split("@")[1] }, "local sign-in code issued");
    console.log(`[auth] local sign-in code for ${body.email}: ${code} (valid 10 min)`);
    return { ok: true, sent: true, ...(auth.supabase.local.showCode ? { devCode: code } : {}) };
  });
  app.post("/api/auth/email/verify", async (req, reply) => {
    if (!auth.supabase.local.enabled) throw new ApiError("AUTH_PROVIDER_UNAVAILABLE", "Email sign-in is handled by the account provider on this server.");
    const body = parse(z.object({ email: Email, code: z.string().regex(/^\d{6}$/) }), req.body);
    const current = await auth.authenticate(req);
    let out;
    try {
      out = auth.verifyEmailCode(body.email, body.code, current);
    } catch (e) {
      const m = (e as Error).message;
      if (m === "CODE_WRONG") throw new ApiError("VALIDATION_FAILED", "That code doesn't match. Check the latest email and try again.");
      if (m === "CODE_LOCKED") throw new ApiError("RATE_LIMITED", "Too many wrong codes. Request a new one.");
      if (m === "CODE_EXPIRED") throw new ApiError("VALIDATION_FAILED", "That code has expired. Request a new one.");
      throw e;
    }
    if (out.token) setSessionCookie(reply, out.token, deps.secureCookies);
    const p = auth.player(out.playerId)!;
    return { ok: true, upgradedGuest: out.upgradedGuest, player: { playerId: p.player_id, displayName: p.display_name, kind: p.kind, activeRunId: p.active_run_id } };
  });

  app.patch("/api/me", async (req) => {
    const u = await requireUser(req);
    writeGuard(req, u.sessionId);
    const body = parse(z.object({ displayName: z.string().trim().min(2).max(32).regex(/^[\p{L}\p{N} ._'&-]+$/u) }), req.body);
    auth.setDisplayName(u.userId, body.displayName);
    // the market shows the new name everywhere: the feed, investor lists, future trades
    deps.rsvc?.town?.renamePlayer(u.userId, body.displayName);
    return { ok: true, player: profile(u) };
  });

  /** Guest -> registered upgrade. Caller authenticates with the Supabase JWT; body carries the guest token. */
  app.post("/api/auth/link-guest", async (req, reply) => {
    const u = await requireUser(req);
    writeGuard(req, u.sessionId);
    if (u.provider !== "supabase") throw new ApiError("UNAUTHORIZED", "Sign in with Google or email first, then link the guest city.");
    const body = parse(z.object({ guestToken: z.string().min(20).max(200).optional() }), req.body);
    // The browser still holds the guest's HTTP-only session cookie after a Google/email redirect, so the
    // city can be linked without the page ever having stored the guest token.
    const cookieToken = (req.headers.cookie ?? "").split(";").map((c) => c.trim()).find((c) => c.startsWith("bo_session="))?.slice("bo_session=".length);
    const guestToken = body.guestToken ?? (cookieToken ? decodeURIComponent(cookieToken) : null);
    if (!guestToken) throw new ApiError("NOT_FOUND", "No guest city to link on this device.");
    const guest = auth.guestFromToken(guestToken);
    if (!guest || guest.kind !== "guest") throw new ApiError("NOT_FOUND", "Guest session not found or already linked.");
    const p = auth.player(u.userId);
    const ids = auth.identities(u.userId);
    // u was resolved (and possibly auto-created) from the JWT; if that new player has no save yet we can
    // move the identity onto the guest player instead. Never overwrite a player that already has progress.
    if (p?.active_run_id) throw new ApiError("ACCOUNT_EXISTS", "This account already has a city. Your guest city was left untouched.", { existingRunId: p.active_run_id });
    const sub = ids.find((i) => i.provider === "supabase");
    if (!sub) throw new ApiError("INVALID_STATE", "No provider identity to link.");
    const row = db.prepare("SELECT subject FROM auth_identities WHERE provider='supabase' AND player_id = ?").get(u.userId) as { subject: string };
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM auth_identities WHERE provider='supabase' AND subject = ?").run(row.subject);
      db.prepare("DELETE FROM players WHERE player_id = ? AND active_run_id IS NULL").run(u.userId);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    const r = auth.linkGuest(guest, "supabase", row.subject, sub.login_method ?? "unknown", p?.display_name ?? "Operator");
    if (!r.ok) throw new ApiError("ACCOUNT_EXISTS", "This account already has a city.");
    auth.revokeGuestSession(guestToken);
    clearSessionCookie(reply, deps.secureCookies);
    return { ok: true, player: profile({ ...u, userId: r.playerId, kind: "registered" }) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const u = await auth.authenticate(req);
    const h = req.headers.authorization;
    const cookieToken = (req.headers.cookie ?? "").split(";").map((c) => c.trim()).find((c) => c.startsWith("bo_session="))?.slice("bo_session=".length);
    const token = h?.startsWith("Bearer ") ? h.slice(7) : cookieToken ? decodeURIComponent(cookieToken) : null;
    if (u?.provider === "guest" && token) auth.revokeGuestSession(token);
    clearSessionCookie(reply, deps.secureCookies);
    return { ok: true };
  });

  // ------------------------------------------------------------ the player's game (continuous save)
  const activeRun = (u: AuthedUser): RunHandle => {
    const p = auth.player(u.userId);
    if (!p?.active_run_id) throw new ApiError("NOT_FOUND", "No saved city yet: POST /api/game/start.");
    return svc.requireOwner(p.active_run_id, u.userId);
  };

  app.post("/api/game/start", async (req) => {
    const u = await requireUser(req);
    writeGuard(req, u.sessionId);
    const body = parse(GameStartRequestSchema, req.body);
    const p = auth.player(u.userId);
    if (p?.active_run_id && !body.fresh) {
      const h = svc.requireOwner(p.active_run_id, u.userId);
      return { ok: true, state: svc.publicState(h), resumed: true, awayMs: svc.awayMs(h) };
    }
    const h = svc.createRun(u.userId, { scenarioId: body.scenarioId, mode: "play", worldMode: body.worldMode });
    auth.setActiveRun(u.userId, h.runId);
    return { ok: true, state: svc.publicState(h), resumed: false, awayMs: 0 };
  });

  app.get("/api/game/state", async (req) => {
    const h = activeRun(await requireUser(req));
    return { ok: true, state: svc.publicState(h), resumed: true, awayMs: svc.awayMs(h) };
  });
  app.get("/api/me/game", async (req) => {
    const h = activeRun(await requireUser(req));
    return { ok: true, state: svc.publicState(h), resumed: true, awayMs: svc.awayMs(h) };
  });

  const doAct = async (req: FastifyRequest, reply: FastifyReply, h: RunHandle, u: AuthedUser) => {
    writeGuard(req, u.sessionId);
    const env = parse(ActionEnvelopeSchema, req.body);
    if (env.action.type === "CREATE_PLAYER_LISTING" || env.action.type === "CANCEL_PLAYER_LISTING") {
      if (u.kind !== "registered") throw new ApiError("FORBIDDEN", "Sign in to create or manage a player market listing.");
      if (!chain.enabled || h.state.chainMode !== "testnet") throw new ApiError("CHAIN_UNAVAILABLE", "Player listings are unavailable until this server has verified Testnet resource custody.");
      if (h.ownerId !== u.userId) throw new ApiError("FORBIDDEN", "This listing must belong to the signed-in player's city.");
    }
    const r = svc.act(h, env);
    if (!r.ok) {
      req.log.info({ runId: h.runId, action: env.action.type, code: r.error!.code }, "action rejected");
      return reply.status(httpStatus(r.error!.code)).send({ ok: false, error: r.error, stateVersion: r.stateVersion });
    }
    return { ok: true, stateVersion: r.stateVersion, events: r.events ?? [], result: r.result ?? {}, replayed: r.replayed, state: svc.publicState(h) };
  };
  app.post("/api/game/actions", async (req, reply) => {
    const u = await requireUser(req);
    return doAct(req, reply, activeRun(u), u);
  });

  const streamRun = (req: FastifyRequest, reply: FastifyReply, h: RunHandle) => {
    const send = openSse(req, reply, originFor(req));
    const from = lastEventId(req);
    const missed = db.prepare("SELECT seq, event_json FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT 2000").all(h.runId, from) as { seq: number; event_json: string }[];
    for (const m of missed) send("economy", JSON.parse(m.event_json), m.seq);
    let lastSent = missed.length ? missed[missed.length - 1].seq : from;
    const unsubscribe = svc.subscribe(h, (msg) => {
      if (msg.kind === "event") {
        if (msg.event.seq <= lastSent) return; // never deliver an event twice on one connection
        lastSent = msg.event.seq;
        send("economy", msg.event, msg.event.seq);
      } else if (msg.kind === "state") send("state", msg.state);
      else send("tick", msg.frame);
    });
    send("state", svc.publicState(h));
    req.raw.on("close", () => {
      unsubscribe();
      req.log.debug({ runId: h.runId }, "sse closed");
    });
  };
  app.get("/api/game/events", async (req, reply) => streamRun(req, reply, activeRun(await requireUser(req))));

  app.get("/api/transactions", async (req) => {
    const h = activeRun(await requireUser(req));
    return { ok: true, transactions: svc.publicState(h).trades };
  });
  app.get<{ Params: { id: string } }>("/api/transactions/:id", async (req) => {
    const h = activeRun(await requireUser(req));
    const t = svc.publicState(h).trades.find((x) => x.tradeId === req.params.id);
    if (!t) throw new ApiError("NOT_FOUND", "Transaction not found.");
    return { ok: true, transaction: t };
  });
  app.get("/api/economy/history", async (req) => {
    const h = activeRun(await requireUser(req));
    const st = svc.publicState(h);
    return { ok: true, dayReports: st.dayReports, merchants: st.merchants.map((m) => ({ merchantId: m.merchantId, name: m.name, priceHistory: m.priceHistory })) };
  });
  app.get("/api/account/near", async (req) => {
    const u = await requireUser(req);
    return { ok: true, near: profile(u).near, network: chain.enabled ? "testnet" : null, resourceContractId: chain.resourceContractId };
  });

  // ------------------------------------------------------------ legacy run-scoped routes (kept for tools/tests)
  app.post("/api/runs", async (req) => {
    const u = await requireUser(req);
    writeGuard(req, u.sessionId);
    const body = parse(CreateRunRequestSchema, req.body);
    const h = svc.createRun(u.userId, body);
    return { ok: true, state: svc.publicState(h) };
  });
  app.get("/api/runs", async (req) => {
    const u = await requireUser(req);
    const rows = db.prepare("SELECT run_id, seed, scenario_id, mode, chain_mode, created_at, finished, score FROM runs WHERE owner_id = ? ORDER BY created_at DESC LIMIT 20").all(u.userId);
    return { ok: true, runs: rows };
  });
  app.get<{ Params: { id: string } }>("/api/runs/:id/state", async (req) => {
    const u = await requireUser(req);
    return { ok: true, state: svc.publicState(svc.requireOwner(req.params.id, u.userId)) };
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/actions", async (req, reply) => {
    const u = await requireUser(req);
    return doAct(req, reply, svc.requireOwner(req.params.id, u.userId), u);
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/quote", async (req, reply) => {
    const u = await requireUser(req);
    writeGuard(req, u.sessionId);
    const q = parse(QuoteRequestSchema, req.body);
    const h = svc.requireOwner(req.params.id, u.userId);
    const r = svc.act(h, { action: { type: "REQUEST_QUOTE", sellerId: q.sellerId, item: q.item, quantity: q.quantity }, idempotencyKey: q.idempotencyKey });
    if (!r.ok) return reply.status(httpStatus(r.error!.code)).send({ ok: false, error: r.error, stateVersion: r.stateVersion });
    const state = svc.publicState(h);
    const quote = state.quotes.find((x) => x.quoteId === r.result?.quoteId) ?? null;
    return { ok: true, stateVersion: r.stateVersion, events: r.events ?? [], result: { ...(r.result ?? {}), quote }, replayed: r.replayed, state };
  });
  app.get<{ Params: { id: string } }>("/api/runs/:id/market", async (req) => {
    const u = await requireUser(req);
    const st = svc.publicState(svc.requireOwner(req.params.id, u.userId));
    return { ok: true, phase: st.clock.phase, marketOpen: st.clock.phase !== "finished", world: st.world, merchants: st.merchants, regulator: st.regulator, quotes: st.quotes, trades: st.trades, marketListings: st.marketListings };
  });
  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string; eventsAfter?: string; asset?: string } }>("/api/runs/:id/ledger", async (req) => {
    const u = await requireUser(req);
    svc.requireOwner(req.params.id, u.userId);
    const cursor = Math.max(0, Number(req.query.cursor ?? 0) || 0);
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200) || 200));
    const eventsAfter = Math.max(0, Number(req.query.eventsAfter ?? 0) || 0);
    const rows = db.prepare("SELECT seq, entry_json FROM ledger WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(req.params.id, cursor, limit) as { seq: number; entry_json: string }[];
    const ev = db.prepare("SELECT event_json FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(req.params.id, eventsAfter, limit) as { event_json: string }[];
    let entries = rows.map((r) => JSON.parse(r.entry_json));
    if (req.query.asset) entries = entries.filter((e) => e.asset === req.query.asset);
    return { ok: true, entries, events: ev.map((e) => JSON.parse(e.event_json)), nextCursor: rows.length === limit ? rows[rows.length - 1].seq : null };
  });
  app.get<{ Params: { id: string } }>("/api/runs/:id/events", async (req, reply) => {
    const u = await requireUser(req);
    streamRun(req, reply, svc.requireOwner(req.params.id, u.userId));
  });

  // ------------------------------------------------------------ Economy Lab (never touches a player's save)
  const sandbox = async (req: FastifyRequest) => ({ ok: true, replay: svc.createReplay(parse(ReplayRequestSchema, req.body)) });
  app.post("/api/replays", sandbox);
  app.post("/api/economy/sandbox", sandbox);
  app.get<{ Params: { id: string } }>("/api/replays/:id", async (req) => ({ ok: true, replay: svc.getReplay(req.params.id).summary }));
  app.get<{ Params: { id: string }; Querystring: { format?: string; seconds?: string } }>("/api/replays/:id/events", async (req, reply) => {
    const { summary, events } = svc.getReplay(req.params.id);
    if (req.query.format === "json") return { ok: true, replay: summary, events };
    const seconds = Math.min(600, Math.max(1, Number(req.query.seconds ?? 60) || 60));
    const send = openSse(req, reply, originFor(req));
    send("replay_summary", summary);
    const lastTick = events.length ? events[events.length - 1].tick : 0;
    const msPerTick = (seconds * 1000) / Math.max(1, lastTick);
    let i = Math.max(0, lastEventId(req));
    const started = Date.now() - (i > 0 ? events[Math.min(i, events.length - 1)].tick * msPerTick : 0);
    const timer = setInterval(() => {
      const simTick = (Date.now() - started) / msPerTick;
      while (i < events.length && events[i].tick <= simTick) {
        send("replay", events[i], i + 1);
        i++;
      }
      if (i >= events.length) {
        send("replay_done", { replayId: summary.replayId, traceHash: summary.traceHash });
        clearInterval(timer);
        reply.raw.end();
      }
    }, 100);
    req.raw.on("close", () => clearInterval(timer));
  });
  app.post("/api/replays/compare", async (req) => {
    const body = parse(CompareRequestSchema, req.body);
    const a: ReplaySummary = svc.createReplay({ seed: body.seed, scenarioId: body.scenarioId, policyId: body.policies[0], days: body.days, condition: body.condition });
    const b: ReplaySummary = svc.createReplay({ seed: body.seed, scenarioId: body.scenarioId, policyId: body.policies[1], days: body.days, condition: body.condition });
    const diff = (label: string, x: number, y: number, fmt: (n: number) => string) => (x !== y ? `${label}: ${a.policyId} ${fmt(x)} vs ${b.policyId} ${fmt(y)}` : null);
    const cr = (n: number) => `₡${(n / 100).toFixed(2)}`;
    const pct = (n: number) => `${(n / 100).toFixed(1)}%`;
    const sum = (r: ReplaySummary, k: "solar" | "diesel") => r.daily.reduce((s, d) => s + d.generationMixWh[k], 0);
    const differences = [
      diff("Net worth", a.final.netWorthCc, b.final.netWorthCc, cr),
      diff("Reliability", a.final.reliabilityBps, b.final.reliabilityBps, pct),
      diff("City GDP", a.final.cityGdpCc, b.final.cityGdpCc, cr),
      diff("Closures", a.final.closures, b.final.closures, String),
      diff("Solar energy", sum(a, "solar"), sum(b, "solar"), (n) => `${(n / 1000).toFixed(1)} kWh`),
      diff("Diesel energy", sum(a, "diesel"), sum(b, "diesel"), (n) => `${(n / 1000).toFixed(1)} kWh`),
    ].filter((x): x is string => !!x);
    return { ok: true, seed: body.seed, a, b, differences };
  });

  // ------------------------------------------------------------ weekly challenge (same seed + world for everyone)
  app.get("/api/challenge", async () => {
    const week = isoWeek();
    const c = challengeFor(week);
    return { ok: true, week, seed: c.seed, condition: c.condition, conditionName: c.name, description: c.description, days: 3 };
  });

  app.post("/api/challenge/start", async (req) => {
    const u = await requireUser(req);
    writeGuard(req, u.sessionId);
    const week = isoWeek();
    const c = challengeFor(week);
    const row = db.prepare("SELECT run_id FROM challenge_runs WHERE player_id = ? AND week = ?").get(u.userId, week) as { run_id: string } | undefined;
    if (row) {
      const h = svc.requireOwner(row.run_id, u.userId);
      return { ok: true, state: svc.publicState(h), resumed: true, awayMs: svc.awayMs(h) };
    }
    const h = svc.createRun(u.userId, { scenarioId: "starter", seed: c.seed, mode: "challenge", worldMode: "scenario", worldPreset: c.condition, campaignDays: 3, challengeWeek: week });
    db.prepare("INSERT INTO challenge_runs (player_id, week, run_id, created_at) VALUES (?, ?, ?, ?)").run(u.userId, week, h.runId, new Date().toISOString());
    return { ok: true, state: svc.publicState(h), resumed: false, awayMs: 0 };
  });

  app.get("/api/challenge/leaderboard", async (req) => {
    const u = await auth.authenticate(req);
    const week = isoWeek();
    const c = challengeFor(week);
    const rows = db
      .prepare(
        `SELECT l.run_id, l.owner_id, l.score, l.net_worth_cc, l.reliability_bps, p.display_name
         FROM leaderboard l JOIN challenge_runs c ON c.run_id = l.run_id LEFT JOIN players p ON p.player_id = l.owner_id
         WHERE c.week = ? ORDER BY l.score DESC, l.created_at ASC LIMIT 20`,
      )
      .all(week) as { run_id: string; owner_id: string; score: number; net_worth_cc: number; reliability_bps: number; display_name: string | null }[];
    return {
      ok: true,
      week,
      condition: c.name,
      seed: c.seed,
      entries: rows.map((r, i) => ({ rank: i + 1, displayName: r.display_name ?? "Operator", score: r.score, netWorthCc: r.net_worth_cc, reliabilityBps: r.reliability_bps, you: !!u && u.userId === r.owner_id })),
    };
  });

  // ------------------------------------------------------------ world data (display only; the game uses the cached dataset)
  app.get("/api/world/oil", async () => {
    const snap = await oilSnapshot();
    return { ok: true, ...snap, weekly2026: BRENT_DATASET.weekly2026 };
  });

  // ------------------------------------------------------------ chain transparency
  app.get("/api/chain/status", async () => {
    const st = await chainStatus(chain);
    lastChainHealth = !chain.enabled ? "disabled" : st.rpcReachable && st.contractDeployed ? "ok" : "degraded";
    return {
      ok: true,
      mode: chain.enabled ? "testnet" : "disabled",
      network: chain.enabled ? "testnet" : null,
      rpcUrl: chain.enabled ? chain.rpcUrl : null,
      rpcReachable: st.rpcReachable,
      resourceContractId: chain.resourceContractId,
      contractDeployed: st.contractDeployed,
      vaultAccountId: chain.vaultAccountId,
      merchantAccounts: MERCHANT_IDS.map((m) => ({ merchantId: m, accountId: chain.merchants[m]?.accountId ?? null })),
      rivalAccountId: chain.rivalAccountId,
      explorerBaseUrl: chain.enabled ? chain.explorerTxBase : null,
      tokenIds: TOKEN_IDS,
      trustBoundary:
        "Electricity, heat, customers, city merchants and NPC decisions are simulated by this server and are reproducible from seed + action log. On Testnet, the shared fuel exchange holds every player's warehouse fuel, open offers (escrow) and trader stock as NEP-245 balances; players' ids live in the vault's namespace and only the vault operator can move them, while each trader signs its own trades. Credits are fictional and never touch the chain. No contract verifies that electricity was produced.",
      issues: st.issues,
      exchange: deps.xsvc
        ? {
            mode: deps.xsvc.sandbox ? ("sandbox" as const) : ("testnet" as const),
            traderAccounts: Object.values(deps.xsvc.state.traders).map((t) => ({ traderId: t.traderId, name: t.params.name, accountId: chain.traders[t.traderId]?.accountId ?? null })),
            reconcile: deps.xsvc.lastReconcile,
            note: deps.xsvc.modeConflict ?? (deps.xsvc.sandbox ? "The exchange runs on this server's ledger; NEAR Testnet is not configured for it, so it records no transaction hashes." : "Exchange fuel is held on NEAR Testnet; every deposit, offer, sale and delivery home is a contract call."),
          }
        : undefined,
    };
  });
  app.get("/api/chain/market-listings", async (req) => {
    const u = await requireUser(req);
    const h = activeRun(u);
    const rows = db.prepare("SELECT listing_id, kind, merchant_id, status, tx_hash, signer_id, last_error FROM marketplace_jobs WHERE run_id = ? ORDER BY updated_at DESC").all(h.runId) as {
      listing_id: string; kind: string; merchant_id: string | null; status: string; tx_hash: string | null; signer_id: string | null; last_error: string | null;
    }[];
    return {
      ok: true,
      listings: rows.map((row) => ({
        listingId: row.listing_id,
        operation: row.kind,
        merchantId: row.merchant_id,
        status: row.status,
        txHash: row.tx_hash,
        signerId: row.signer_id,
        explorerUrl: row.tx_hash && chain.enabled ? `${chain.explorerTxBase}${row.tx_hash}` : null,
        lastError: row.last_error,
      })),
    };
  });
  app.get<{ Params: { hash: string }; Querystring: { sender?: string } }>("/api/chain/transfers/:hash", async (req) => {
    const hash = req.params.hash;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(hash)) throw new ApiError("VALIDATION_FAILED", "Not a base58 transaction hash.");
    if (!chain.enabled) return { ok: true, txHash: hash, status: "not_configured", explorerUrl: null, receiverId: null, signerId: null, detail: "Chain mode is disabled on this server." };
    const job = db.prepare("SELECT signer_id FROM chain_jobs WHERE tx_hash = ?").get(hash) as { signer_id: string } | undefined;
    const sender = req.query.sender ?? job?.signer_id;
    if (!sender) throw new ApiError("VALIDATION_FAILED", "Unknown hash: pass ?sender=<signer account id>.");
    const r = await lookupTx(chain, hash, sender);
    return { ok: true, txHash: hash, status: r.status, explorerUrl: `${chain.explorerTxBase}${hash}`, receiverId: "receiverId" in r ? r.receiverId : null, signerId: "signerId" in r ? r.signerId : sender, detail: r.detail };
  });

  // ------------------------------------------------------------ health & config
  app.get("/api/health", async (_req, reply) => {
    let dbOk = true;
    try {
      db.prepare("SELECT 1").get();
    } catch {
      dbOk = false;
    }
    if (!dbOk) reply.status(503);
    return { ok: dbOk, db: dbOk ? "ok" : "error", chain: lastChainHealth, activeRuns: [...svc.runs.values()].filter((h) => h.running).length, version: API_VERSION };
  });

  app.get("/api/config/public", async () => ({
    ok: true,
    apiVersion: API_VERSION,
    schemaVersion: "blackout.state.v1",
    scenarios: [
      { scenarioId: "starter", name: SCENARIOS.starter.name, available: true, description: SCENARIOS.starter.description },
      { scenarioId: "fuel_squeeze", name: SCENARIOS.fuel_squeeze.name, available: true, description: SCENARIOS.fuel_squeeze.description },
    ],
    timing: {
      tickMs: 1000,
      ticksPerGameHour: 10,
      morningTicks: 0,
      operatingTicks: TIMING.OPERATING_TICKS,
      settlementTicks: 0,
      waveIntervalTicks: TIMING.WAVE_INTERVAL_TICKS,
      wavesPerDay: TIMING.WAVES_PER_DAY,
      campaignDays: 0,
      day1SkipsMorning: true,
    },
    pausePolicy: `The world advances 1 tick/second while you are connected. With no live connection for ${AUTO_PAUSE_MS / 1000}s the city pauses and resumes exactly where you left it. The server never fast-forwards more than 5 s of missed time.`,
    offlinePolicy:
      "Leaving pauses your city: no fuel burns, no customer bills, no rent and no bankruptcy while you are away. Contracts resume mid-delivery when you return. Economy Lab simulations never touch your save.",
    chainMode: chain.enabled ? "testnet" : "disabled",
    authModes: ["guest", ...(auth.supabase.providers.google ? ["google"] : []), ...(auth.supabase.providers.email || auth.supabase.local.enabled ? ["email"] : [])],
    auth: {
      guest: true as const,
      supabaseUrl: auth.supabase.enabled ? auth.supabase.url : null,
      supabaseAnonKey: auth.supabase.enabled ? auth.supabase.anonKey : null,
      google: auth.supabase.providers.google,
      email: auth.supabase.providers.email || auth.supabase.local.enabled,
      local: auth.supabase.local.enabled,
      localShowsCode: auth.supabase.local.showCode,
    },
    disclaimer: "Credits are imaginary game currency; they cannot be withdrawn, redeemed or traded for money.",
  }));

  if (deps.rsvc) registerRegionRoutes(app, { rsvc: deps.rsvc, requireUser, writeGuard, parse, originFor, httpStatus, relayer: deps.relayer, identity: (u) => gameIdentity(auth, chain, u, !!deps.relayer?.cfg.enabled), economy: deps.economy });
  if (deps.xsvc) registerExchangeRoutes(app, { xsvc: deps.xsvc, svc, auth, allowGuests: !!deps.exchangeAllowGuests, requireUser, writeGuard, parse, activeRun });
}
