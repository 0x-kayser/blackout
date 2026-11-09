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
import { LiveWorldInputs, StaticWorldInputs, type WorldInputProvider } from "./world.ts";

export interface BuildOptions {
  dbPath?: string;
  chain?: ChainConfig;
  allowedOrigins?: string[];
  now?: () => number;
  logger?: boolean;
  supabase?: SupabaseConfig;
  /** Test hook: a local JWKS instead of fetching the Supabase one. */
  jwks?: JWTVerifyGetKey;
  /** Directory with the built web app to serve at / (single-origin deployment). */
  webDist?: string | null;
  /** Local demos only: let guests trade on the shared exchange (default: EXCHANGE_ALLOW_GUESTS env). */
  exchangeAllowGuests?: boolean;
  /** Real-world inputs; tests pass a static provider. Default: live (WORLD_INPUTS=off disables fetching). */
  world?: WorldInputProvider;
  /** Test hook for the NEP-366 relayer. */
  relay?: { cfg: ReturnType<typeof loadRelayConfig>; submit: RelaySubmit };
}

export async function buildServer(opts: BuildOptions = {}): Promise<{ app: FastifyInstance; db: Db; svc: RunService; chain: ChainConfig; auth: AuthService; xsvc: ExchangeService; rsvc: RegionService; tsvc: TownService }> {
  const db = openDb(opts.dbPath ?? process.env.DATABASE_PATH ?? "data/blackout.sqlite");
  const chain = opts.chain ?? loadChainConfig();
  const svc = new RunService(db, chain, opts.now);
  const xsvc = new ExchangeService(db, svc, chain);
  const world = opts.world ?? (process.env.WORLD_INPUTS === "off" ? new StaticWorldInputs() : new LiveWorldInputs(db, fetch, { enabled: true }));
  const settlementOn = chain.enabled && process.env.NEAR_SETTLEMENT_ENABLED === "true";
  const rsvc = new RegionService(db, world, { enabled: settlementOn }, opts.now);
  const tsvc = new TownService(db, world.current(), settlementOn);
  rsvc.town = tsvc;
  const exchangeAllowGuests = opts.exchangeAllowGuests ?? process.env.EXCHANGE_ALLOW_GUESTS === "true";
  const relayer = opts.relay ? new Relayer(db, opts.relay.cfg, opts.relay.submit, opts.now) : new Relayer(db, loadRelayConfig());
  const allowedOrigins = opts.allowedOrigins ?? (process.env.WEB_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173").split(",").map((s) => s.trim()).filter(Boolean);
  const auth = new AuthService(db, opts.supabase ?? loadSupabaseConfig(), opts.jwks);
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
  registerRoutes(app, { db, svc, chain, auth, allowedOrigins, secureCookies: process.env.COOKIE_SECURE === "true", xsvc, exchangeAllowGuests, rsvc, relayer });
  const dist = opts.webDist === undefined ? (process.env.WEB_DIST ?? resolve(import.meta.dirname, "../../../dist")) : opts.webDist;
  if (dist && existsSync(resolve(dist, "index.html"))) {
    await app.register(fastifyStatic, { root: resolve(dist), prefix: "/", wildcard: false });
    // SPA fallback for client routes; API 404s stay JSON
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "No such endpoint." } });
      return reply.sendFile("index.html");
    });
  }
  return { app, db, svc, chain, auth, xsvc, rsvc, tsvc };
}

async function main() {
  const { app, db, svc, chain, auth, xsvc, rsvc, tsvc } = await buildServer({ logger: process.env.LOG_JSON !== "false" });
  const stopRegion = startRegionDriver(rsvc);
  const stopTown = startTownDriver(tsvc);
  const stopSettlement = process.env.NEAR_SETTLEMENT_ENABLED === "true" ? startSettlementWorker(db, chain) : () => undefined;
  const stopDriver = startDriver(svc);
  const stopExchange = startExchangeDriver(xsvc);
  const stopChain = startChainWorker(db, svc, chain, 2_000, xsvc);
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  await app.listen({ port, host });
  console.log(`BLACKOUT API listening on http://${host}:${port}`);
  console.log(`chain mode: ${chain.enabled ? `testnet (${chain.resourceContractId})` : `disabled (missing ${chain.missing.join(", ")})`}`);
  console.log(`exchange: ${xsvc.sandbox ? `sandbox (server ledger only; Testnet exchange needs ${chain.enabled ? chain.exchangeMissing.join(", ") : "chain mode"})` : "testnet"}`);
  console.log(`auth: guest${auth.supabase.enabled ? ` + supabase (${[auth.supabase.providers.google && "google", auth.supabase.providers.email && "email"].filter(Boolean).join(", ")})` : " only (SUPABASE_URL / SUPABASE_ANON_KEY not set)"}`);
  const shutdown = async () => {
    stopDriver();
    stopRegion();
    stopTown();
    tsvc.checkpoint();
    stopSettlement();
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
