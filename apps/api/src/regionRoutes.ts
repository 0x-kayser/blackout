/**
 * Regional power game routes. Every write is idempotent per region + idempotency key; the client never sends
 * prices or outcomes, only decisions (RegionActionSchema).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CreateRegionRequestSchema, InvestQuoteRequestSchema, InvestRequestSchema, RegionActionEnvelopeSchema, TradeQuoteRequestSchema, TradeRequestSchema, type ErrorCode } from "@blackout/shared";
import { region } from "@blackout/sim";
import type { AuthedUser } from "./auth.ts";
import { openSse } from "./events.ts";
import type { RegionService } from "./region.ts";
import type { Relayer } from "./relayer.ts";
import type { GameIdentity } from "./identity.ts";
import type { EconomyService } from "./economy/service.ts";
import type { PlantMarket } from "./economy/plantMarket.ts";
import { z } from "zod";
import { ApiError } from "./services.ts";

export interface RegionRouteDeps {
  rsvc: RegionService;
  requireUser: (req: FastifyRequest) => Promise<AuthedUser>;
  writeGuard: (req: FastifyRequest, key: string) => void;
  parse: <T>(schema: { safeParse: (x: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown[] } } }, body: unknown) => T;
  originFor: (req: FastifyRequest) => string | null;
  httpStatus: (code: ErrorCode) => number;
  relayer?: Relayer;
  identity?: (u: AuthedUser) => GameIdentity;
  economy?: EconomyService;
  plants?: PlantMarket;
}

const DeskSchema = z.object({ sell: z.boolean(), markupBps: z.number().int().min(0).max(20_000) });

const DelegateSchema = z.object({
  idempotencyKey: z.string().min(8).max(80),
  delegate: z.object({
    senderId: z.string().min(2).max(64),
    receiverId: z.string().min(2).max(64),
    nonce: z.string().regex(/^\d{1,20}$/),
    maxBlockHeight: z.string().regex(/^\d{1,20}$/),
    publicKey: z.string().min(40).max(120),
    actions: z.array(z.object({ methodName: z.string().min(1).max(64), args: z.record(z.string(), z.unknown()), gas: z.string().regex(/^\d{1,20}$/), deposit: z.string().regex(/^\d{1,40}$/) })).min(1).max(3),
    signature: z.string().min(40).max(120),
  }),
});

const labCache = new Map<string, unknown>();

export function registerRegionRoutes(app: FastifyInstance, d: RegionRouteDeps): void {
  const { rsvc } = d;

  /* ---------------------------------------------------------------- game-facing company settings */

  app.get("/api/economy/desk", async (req) => {
    const u = await d.requireUser(req);
    if (!d.economy) throw new ApiError("NOT_FOUND", "No economy on this server.");
    // Preserve server-side account setup while returning only the preference the game needs.
    await d.economy.view(u.userId);
    return { ok: true, desk: d.economy.desk(u.userId) };
  });

  app.post("/api/economy/desk", async (req) => {
    const u = await d.requireUser(req);
    d.writeGuard(req, u.sessionId);
    if (!d.economy) throw new ApiError("NOT_FOUND", "No economy on this server.");
    d.economy.setDesk(u.userId, d.parse(DeskSchema, req.body));
    return { ok: true, desk: d.economy.desk(u.userId) };
  });

  /* ---------------------------------------------------------------- plants between companies */

  app.get("/api/plants/market", async (req) => {
    let viewer: string | null = null;
    try {
      viewer = (await d.requireUser(req)).userId;
    } catch {
      /* anyone can look */
    }
    return { ok: true, sales: d.plants?.view(viewer) ?? [] };
  });
  app.post("/api/plants/list", async (req) => {
    const u = await d.requireUser(req);
    d.writeGuard(req, u.sessionId);
    const b = d.parse(z.object({ plantId: z.string().min(1).max(64), priceCc: z.number().int().min(100_00).max(100_000_000_00) }), req.body);
    d.plants!.list(u.userId, b.plantId, b.priceCc);
    return { ok: true, sales: d.plants!.view(u.userId) };
  });
  app.post("/api/plants/cancel", async (req) => {
    const u = await d.requireUser(req);
    d.writeGuard(req, u.sessionId);
    d.plants!.cancel(u.userId, d.parse(z.object({ saleId: z.string().min(1).max(40) }), req.body).saleId);
    return { ok: true, sales: d.plants!.view(u.userId) };
  });
  app.post("/api/plants/buy", async (req) => {
    const u = await d.requireUser(req);
    d.writeGuard(req, u.sessionId);
    d.plants!.buy(u.userId, d.parse(z.object({ saleId: z.string().min(1).max(40) }), req.body).saleId);
    return { ok: true, sales: d.plants!.view(u.userId) };
  });

  // emergency stop for NPC spending (contract switch + server switch); needs ECONOMY_ADMIN_TOKEN
  app.post("/api/economy/admin/npc-spending", async (req) => {
    const token = req.headers["x-admin-token"];
    if (!d.economy?.cfg.adminToken || token !== d.economy.cfg.adminToken) throw new ApiError("FORBIDDEN", "Admin token required.");
    const body = d.parse(z.object({ paused: z.boolean() }), req.body);
    d.economy.pauseNpcSpending(body.paused);
    return { ok: true, npcSpending: !body.paused };
  });

  // re-line NEAR up with the game after an incident (see EconomyService.resync); call until it says "done"
  app.post("/api/economy/admin/resync", async (req) => {
    const token = req.headers["x-admin-token"];
    if (!d.economy?.cfg.adminToken || token !== d.economy.cfg.adminToken) throw new ApiError("FORBIDDEN", "Admin token required.");
    return { ok: true, ...(await d.economy.resync()) };
  });

  // Operator-only evidence for judges and incident review; never exposed through the player interface.
  app.get<{ Querystring: { limit?: string; offset?: string } }>("/api/economy/admin/audit", async (req) => {
    const token = req.headers["x-admin-token"];
    if (!d.economy?.cfg.adminToken || token !== d.economy.cfg.adminToken) throw new ApiError("FORBIDDEN", "Admin token required.");
    const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 100) || 100));
    const requestedOffset = Number(req.query.offset ?? 0);
    const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.min(2_147_483_647, Math.trunc(requestedOffset))) : 0;
    return { ok: true, audit: await d.economy.auditEvidence(limit, offset) };
  });

  app.get("/api/region", async (req) => {
    const u = await d.requireUser(req);
    const h = rsvc.liveFor(u.userId);
    return { ok: true, view: rsvc.view(h) };
  });

  app.post("/api/region/new", async (req) => {
    const u = await d.requireUser(req);
    d.writeGuard(req, u.sessionId);
    const body = d.parse(CreateRegionRequestSchema, req.body);
    const h = rsvc.create(u.userId, body.mode);
    return { ok: true, view: rsvc.view(h) };
  });

  app.get<{ Params: { id: string } }>("/api/region/:id", async (req) => {
    const u = await d.requireUser(req);
    return { ok: true, view: rsvc.view(rsvc.requireOwner(req.params.id, u.userId)) };
  });

  app.post<{ Params: { id: string } }>("/api/region/:id/actions", async (req, reply: FastifyReply) => {
    const u = await d.requireUser(req);
    d.writeGuard(req, u.sessionId);
    const env = d.parse(RegionActionEnvelopeSchema, req.body);
    const h = rsvc.requireOwner(req.params.id, u.userId);
    const r = rsvc.act(h, env.action, `${u.userId}:${env.idempotencyKey}`, "player", env.expectedVersion);
    if (!r.ok && r.error) return reply.status(d.httpStatus(r.error.code as ErrorCode)).send({ ok: false, error: r.error, view: r.view });
    return r;
  });

  app.get<{ Params: { id: string } }>("/api/region/:id/stream", async (req, reply) => {
    const u = await d.requireUser(req);
    const h = rsvc.requireOwner(req.params.id, u.userId);
    const send = openSse(req, reply, d.originFor(req));
    send("view", rsvc.view(h));
    const off = rsvc.subscribe(h, (v) => send("view", v, v.interval));
    // the shared market rides on the same connection
    const offTown = rsvc.town ? rsvc.town.subscribe(u.userId, (tv) => send("town", tv)) : () => undefined;
    if (rsvc.town) send("town", rsvc.town.view(u.userId));
    req.raw.on("close", () => {
      off();
      offTown();
    });
  });

  app.get<{ Params: { id: string } }>("/api/region/:id/epochs", async (req) => {
    const token = req.headers["x-admin-token"];
    if (!d.economy?.cfg.adminToken || token !== d.economy.cfg.adminToken) throw new ApiError("FORBIDDEN", "Admin token required.");
    return { ok: true, epochs: rsvc.epochs(req.params.id) };
  });

  app.get<{ Querystring: { week?: string } }>("/api/region/leaderboard", async (req) => ({ ok: true, entries: rsvc.leaderboard(req.query.week) }));
  app.get("/api/region/challenge", async () => ({ ok: true, challenge: rsvc.challengeInfo() }));

  app.get<{ Querystring: { seed?: string; days?: string } }>("/api/region/lab", async (req) => {
    const seed = Math.max(1, Math.min(2 ** 31 - 1, Number(req.query.seed ?? 42) || 42));
    const days = Math.max(1, Math.min(7, Number(req.query.days ?? 7) || 7));
    const key = `${seed}:${days}`;
    if (!labCache.has(key)) {
      if (labCache.size > 32) labCache.clear();
      labCache.set(key, { gasHeavy: region.runRegionLab("gas_heavy", seed, days), solarStorage: region.runRegionLab("solar_storage", seed, days) });
    }
    return { ok: true, lab: labCache.get(key) };
  });

  app.get("/api/world", async () => ({ ok: true, snapshot: rsvc.world.current() }));

  /* ------------------------------------------------------------- Vesper Market (shared by every player) */

  const townOrFail = () => {
    if (!rsvc.town) throw new ApiError("NOT_FOUND", "The market isn't running on this server.");
    return rsvc.town;
  };
  app.get("/api/town", async (req) => {
    let viewer: string | null = null;
    try {
      viewer = (await d.requireUser(req)).userId;
    } catch {
      /* anyone can look at the market */
    }
    return { ok: true, town: townOrFail().view(viewer) };
  });
  app.post("/api/town/quote", async (req) => {
    const u = await d.requireUser(req);
    const body = d.parse(TradeQuoteRequestSchema, req.body);
    const h = rsvc.liveFor(u.userId);
    return { ok: true, quote: townOrFail().tradeQuote(h, body) };
  });
  app.post("/api/town/invest-quote", async (req) => {
    const u = await d.requireUser(req);
    const body = d.parse(InvestQuoteRequestSchema, req.body);
    const h = rsvc.liveFor(u.userId);
    return { ok: true, quote: townOrFail().investmentQuote(h, body) };
  });
  app.post("/api/town/trade", async (req) => {
    const u = await d.requireUser(req);
    d.writeGuard(req, u.sessionId);
    const body = d.parse(TradeRequestSchema, req.body);
    const t = townOrFail();
    const h = rsvc.liveFor(u.userId);
    const r = t.trade({ userId: u.userId, name: rsvc.nameOf(u.userId) }, h, rsvc, body, body.idempotencyKey);
    return { ...r, view: rsvc.view(h), town: t.view(u.userId) };
  });
  app.post("/api/town/invest", async (req) => {
    const u = await d.requireUser(req);
    d.writeGuard(req, u.sessionId);
    const body = d.parse(InvestRequestSchema, req.body);
    const t = townOrFail();
    const h = rsvc.liveFor(u.userId);
    const r = t.invest({ userId: u.userId, name: rsvc.nameOf(u.userId) }, h, rsvc, body, body.idempotencyKey);
    return { ...r, view: rsvc.view(h), town: t.view(u.userId) };
  });
  app.get<{ Querystring: { seed?: string; days?: string } }>("/api/town/fastforward", async (req) => {
    const seed = Math.max(1, Math.min(999_999, Number(req.query.seed ?? 42) || 42));
    const days: 7 | 365 = req.query.days === "365" ? 365 : 7;
    // a signed-in player's company joins the week with what its plants have spare right now
    let you: { name: string; kw: number; priceCcPerMWh: number } | null = null;
    try {
      const u = await d.requireUser(req);
      const h = rsvc.liveFor(u.userId);
      const o = region.regionPowerOffer(h.state, d.economy?.desk(u.userId).markupBps ?? 1_500);
      if (o.kw > 0) you = { name: rsvc.nameOf(u.userId) === "An unnamed power company" ? "Your company" : rsvc.nameOf(u.userId), kw: Math.min(o.kw, 30_000), priceCcPerMWh: o.priceCcPerMWh };
    } catch {
      /* watching without a session: the week runs without you */
    }
    return { ok: true, week: townOrFail().fastForward(seed, you, days) };
  });

  /** GameIdentity: who is playing, however they signed in (§25). */
  app.get("/api/identity", async (req) => {
    const u = await d.requireUser(req);
    const identity = d.identity?.(u) ?? null;
    if (!identity) return { ok: true, identity: null };
    const playerIdentity = { userId: identity.userId, displayName: identity.displayName, kind: identity.kind, providers: identity.providers };
    return { ok: true, identity: playerIdentity };
  });

  /** Gasless meta-transactions (NEP-366): the game relayer pays, only for allowlisted BLACKOUT calls. */
  app.post("/api/relay", async (req, reply) => {
    const u = await d.requireUser(req);
    d.writeGuard(req, u.sessionId);
    const body = d.parse(DelegateSchema, req.body);
    if (!d.relayer) return reply.status(503).send({ ok: false, error: { code: "CHAIN_UNAVAILABLE", message: "Gasless transactions aren't configured on this server." } });
    const r = await d.relayer.relay(u.userId, body.idempotencyKey, body.delegate);
    if (r.status === "rejected") return reply.status(r.error?.startsWith("Too many") ? 429 : 422).send({ ok: false, error: { code: r.error?.startsWith("Too many") ? "RATE_LIMITED" : "VALIDATION_FAILED", message: r.error }, request: r });
    return { ok: true, request: r };
  });

  void ApiError;
}
