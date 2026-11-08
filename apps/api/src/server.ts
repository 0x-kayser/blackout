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
}

export async function buildServer(opts: BuildOptions = {}): Promise<{ app: FastifyInstance; db: Db; svc: RunService; chain: ChainConfig; auth: AuthService }> {
  const db = openDb(opts.dbPath ?? process.env.DATABASE_PATH ?? "data/blackout.sqlite");
  const chain = opts.chain ?? loadChainConfig();
  const svc = new RunService(db, chain, opts.now);
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
  registerRoutes(app, { db, svc, chain, auth, allowedOrigins, secureCookies: process.env.COOKIE_SECURE === "true" });
  const dist = opts.webDist === undefined ? (process.env.WEB_DIST ?? resolve(import.meta.dirname, "../../../dist")) : opts.webDist;
  if (dist && existsSync(resolve(dist, "index.html"))) {
    await app.register(fastifyStatic, { root: resolve(dist), prefix: "/", wildcard: false });
    // SPA fallback for client routes; API 404s stay JSON
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "No such endpoint." } });
      return reply.sendFile("index.html");
    });
  }
  return { app, db, svc, chain, auth };
}

async function main() {
  const { app, db, svc, chain, auth } = await buildServer({ logger: process.env.LOG_JSON !== "false" });
  const stopDriver = startDriver(svc);
  const stopChain = startChainWorker(db, svc, chain);
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  await app.listen({ port, host });
  console.log(`BLACKOUT API listening on http://${host}:${port}`);
  console.log(`chain mode: ${chain.enabled ? `testnet (${chain.resourceContractId})` : `disabled (missing ${chain.missing.join(", ")})`}`);
  console.log(`auth: guest${auth.supabase.enabled ? ` + supabase (${[auth.supabase.providers.google && "google", auth.supabase.providers.email && "email"].filter(Boolean).join(", ")})` : " only (SUPABASE_URL / SUPABASE_ANON_KEY not set)"}`);
  const shutdown = async () => {
    stopDriver();
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
