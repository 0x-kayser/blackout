/**
 * BLACKOUT API server.  `pnpm dev`  ->  http://localhost:8787
 */
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { JWTVerifyGetKey } from "jose";
import { AuthService, loadSupabaseConfig, type SupabaseConfig } from "./auth.ts";
import { loadChainConfig, type ChainConfig } from "./chain.ts";
import { openDb, type Db } from "./db.ts";
import { registerRoutes } from "./routes.ts";
import { RunService } from "./services.ts";
import { startChainWorker, startDriver } from "./workers.ts";
import { ExchangeService, startExchangeDriver } from "./exchange.ts";
import { RegionService, startRegionDriver } from "./region.ts";
import { TownService, startTownDriver } from "./town.ts";
import { Relayer, loadRelayConfig, type RelaySubmit } from "./relayer.ts";
import { startSettlementWorker } from "./settlement.ts";
import { loadEconomyConfig, type EconomyConfig } from "./economy/config.ts";
import { NearGateway, type ChainGateway } from "./economy/gateway.ts";
import { EconomyService } from "./economy/service.ts";
import { PlantMarket } from "./economy/plantMarket.ts";
import { ResourceMarket, startResourceMarketDriver } from "./economy/resourceMarket.ts";
import { LiveWorldInputs, StaticWorldInputs, type WorldInputProvider } from "./world.ts";
import { pathToFileURL } from "node:url";

export interface BuildOptions {
  dbPath?: string;
  chain?: ChainConfig;
  allowedOrigins?: string[];
  now?: () => number;
  logger?: boolean;
  supabase?: SupabaseConfig;
  /** Test hook: a local JWKS instead of fetching the Supabase one. */
  jwks?: JWTVerifyGetKey;
  /** Test hook: a local JWKS instead of Google's published keys. */
  googleJwks?: JWTVerifyGetKey;
  /** Directory with the built web app to serve at / (single-origin deployment). */
  webDist?: string | null;
  /** Local demos only: let guests trade on the shared exchange (default: EXCHANGE_ALLOW_GUESTS env). */
  exchangeAllowGuests?: boolean;
  /** Real-world inputs; tests pass a static provider. Default: live (WORLD_INPUTS=off disables fetching). */
  world?: WorldInputProvider;
  /** Test hook for the NEP-366 relayer. */
  relay?: { cfg: ReturnType<typeof loadRelayConfig>; submit: RelaySubmit };
  /** Let visitors play without signing in (default: ALLOW_GUEST_PLAY env; production leaves it off). */
  guestPlay?: boolean;
  /** The on-chain economy: tests pass a config and a gateway (or null for no chain). */
  economy?: { cfg?: EconomyConfig; gateway?: ChainGateway | null };
}

export async function buildServer(opts: BuildOptions = {}): Promise<{ app: FastifyInstance; db: Db; svc: RunService; chain: ChainConfig; auth: AuthService; xsvc: ExchangeService; rsvc: RegionService; tsvc: TownService; economy: EconomyService; plants: PlantMarket; resourceMarket: ResourceMarket }> {
  const db = openDb(opts.dbPath ?? process.env.DATABASE_PATH ?? "data/blackout.sqlite");
  const chain = opts.chain ?? loadChainConfig();
  const svc = new RunService(db, chain, opts.now);
  const xsvc = new ExchangeService(db, svc, chain);
  const world = opts.world ?? (process.env.WORLD_INPUTS === "off" ? new StaticWorldInputs() : new LiveWorldInputs(db, fetch, { enabled: true }));
  const ecoCfg = opts.economy?.cfg ?? loadEconomyConfig();
  const ecoGw = opts.economy && "gateway" in opts.economy ? (opts.economy.gateway ?? null) : ecoCfg.enabled ? new NearGateway(ecoCfg) : null;
  const ecoLive = ecoCfg.enabled && !!ecoGw;
  // epochs are queued for settlement when either the on-chain economy or the legacy settlement worker is on
  const settlementOn = ecoLive || (chain.enabled && process.env.NEAR_SETTLEMENT_ENABLED === "true");
  const rsvc = new RegionService(db, world, { enabled: settlementOn }, opts.now);
  const tsvc = new TownService(db, world.current(), settlementOn);
  rsvc.town = tsvc;
  const exchangeAllowGuests = opts.exchangeAllowGuests ?? process.env.EXCHANGE_ALLOW_GUESTS === "true";
  const relayer = opts.relay ? new Relayer(db, opts.relay.cfg, opts.relay.submit, opts.now) : new Relayer(db, loadRelayConfig());
  const allowedOrigins = opts.allowedOrigins ?? (process.env.WEB_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173").split(",").map((s) => s.trim()).filter(Boolean);
  const auth = new AuthService(db, opts.supabase ?? loadSupabaseConfig(), opts.jwks, opts.googleJwks);
  const economy = new EconomyService(db, ecoCfg, ecoGw, rsvc, tsvc, (uid) => auth.player(uid)?.kind === "registered");
  tsvc.economy = economy;
  const plants = new PlantMarket(db, economy, rsvc);
  const resourceMarket = new ResourceMarket(db, economy, rsvc, tsvc);
  const app = Fastify({
    // structured JSON logs; credentials and cookies are redacted, never logged
    logger: opts.logger ? { level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.authorization", "req.headers.cookie", "res.headers[\"set-cookie\"]"] } : false,
    bodyLimit: 64 * 1024,
    trustProxy: process.env.TRUST_PROXY === "true",
    genReqId: (req) => {
      const h = req.headers["x-request-id"];
      return typeof h === "string" && /^[\w-]{8,64}$/.test(h) ? h : randomUUID();
    },
  });
  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });
  await app.register(cors, { origin: allowedOrigins, credentials: true });
  registerRoutes(app, { db, svc, chain, auth, allowedOrigins, secureCookies: process.env.COOKIE_SECURE === "true", xsvc, exchangeAllowGuests, rsvc, relayer, economy, plants, resourceMarket, guestPlay: opts.guestPlay ?? process.env.ALLOW_GUEST_PLAY === "true" });
  const dist = opts.webDist === undefined ? (process.env.WEB_DIST ?? resolve(import.meta.dirname, "../../../dist")) : opts.webDist;
  if (dist && existsSync(resolve(dist, "index.html"))) {
    await app.register(fastifyStatic, { root: resolve(dist), prefix: "/", wildcard: false });
    // SPA fallback for client routes; API 404s stay JSON
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "No such endpoint." } });
      return reply.sendFile("index.html");
    });
  }
  return { app, db, svc, chain, auth, xsvc, rsvc, tsvc, economy, plants, resourceMarket };
}

/** The economy's worker: open the market on chain once, queue settlement, submit and reconcile operations. */
export function startEconomyWorker(economy: EconomyService, ms = 3_000): () => void {
  if (!economy.live) return () => undefined;
  let beats = 0;
  const t = setInterval(() => {
    void (async () => {
      try {
        await economy.ensureTownOpen();
        economy.finishResync();
        await economy.queueSettlement();
        economy.syncPlants();
        await economy.processOps();
        if (beats % 20 === 0) economy.sweepEscrows();
        if (beats++ % 20 === 0) await economy.topUpFloats();
      } catch (e) {
        console.error("economy worker", e);
      }
    })();
  }, ms);
  return () => clearInterval(t);
}

async function main() {
  const { app, db, svc, chain, auth, xsvc, rsvc, tsvc, economy, resourceMarket } = await buildServer({ logger: process.env.LOG_JSON !== "false" });
  const stopRegion = startRegionDriver(rsvc);
  const stopTown = startTownDriver(tsvc);
  // the legacy per-identity settlement never runs alongside the economy's batch settlement
  const stopSettlement = !economy.live && process.env.NEAR_SETTLEMENT_ENABLED === "true" ? startSettlementWorker(db, chain) : () => undefined;
  const stopEconomy = startEconomyWorker(economy);
  const stopResourceMarket = startResourceMarketDriver(resourceMarket);
  const stopDriver = startDriver(svc);
  const stopExchange = startExchangeDriver(xsvc);
  const stopChain = startChainWorker(db, svc, chain, 2_000, xsvc);
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  await app.listen({ port, host });
  console.log(`BLACKOUT API listening on http://${host}:${port}`);
  console.log(`chain mode: ${chain.enabled ? `testnet (${chain.resourceContractId})` : `disabled (missing ${chain.missing.join(", ")})`}`);
  console.log(`exchange: ${xsvc.sandbox ? `sandbox (server ledger only; Testnet exchange needs ${chain.enabled ? chain.exchangeMissing.join(", ") : "chain mode"})` : "testnet"}`);
  console.log(`economy: ${economy.live ? `NEAR testnet (${economy.cfg.contractId})` : `game server only (missing ${economy.cfg.missing.slice(0, 4).join(", ")}${economy.cfg.missing.length > 4 ? ", …" : ""})`}`);
  console.log(`google sign-in: ${auth.supabase.googleClientId ? "on (Google Identity Services)" : auth.supabase.providers.google ? "via Supabase" : "off (set GOOGLE_CLIENT_ID)"}`);
  console.log(`auth: guest${auth.supabase.enabled ? ` + supabase (${[auth.supabase.providers.google && "google", auth.supabase.providers.email && "email"].filter(Boolean).join(", ")})` : " only (SUPABASE_URL / SUPABASE_ANON_KEY not set)"}`);
  const shutdown = async () => {
    stopDriver();
    stopRegion();
    stopTown();
    tsvc.checkpoint();
    stopSettlement();
    stopEconomy();
    stopResourceMarket();
    rsvc.shutdown();
    stopExchange();
    stopChain();
    svc.shutdown();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
