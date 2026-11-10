/**
 * Shared Vesper Fuel Exchange routes. Anyone signed in (guests included) can browse the book; trading
 * needs a registered account unless the server explicitly allows guests (EXCHANGE_ALLOW_GUESTS=true, for
 * local demos). Every write is idempotent per player + idempotency key, and every city change is a
 * recorded system action, so retries and restarts never double-move fuel or credits.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AnyAction } from "@blackout/shared";
import { exchange as X } from "@blackout/sim";
import { z } from "zod";
import type { AuthService, AuthedUser } from "./auth.ts";
import type { ExchangeService } from "./exchange.ts";
import { ApiError, type RunHandle, type RunService } from "./services.ts";

export interface ExchangeRouteDeps {
  xsvc: ExchangeService;
  svc: RunService;
  auth: AuthService;
  allowGuests: boolean;
  requireUser: (req: FastifyRequest) => Promise<AuthedUser>;
  writeGuard: (req: FastifyRequest, key: string) => void;
  parse: <T>(schema: { safeParse: (x: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown[] } } }, body: unknown) => T;
  activeRun: (u: AuthedUser) => RunHandle;
}

const Qty = z.number().int().min(100).max(60_000).multipleOf(100);
const Key = z.string().min(8).max(100);
const Price = z.number().int().min(1).max(100_000);
const L = (ml: number) => (ml / 1000).toFixed(1);

export function registerExchangeRoutes(app: FastifyInstance, d: ExchangeRouteDeps): void {
  const { xsvc, svc } = d;
  const me = (u: AuthedUser) => ({ kind: "player" as const, id: u.userId });

  const tradeBlocker = (u: AuthedUser | null): string | null => {
    if (!u) return "Start a city to use the exchange.";
    if (u.kind !== "registered" && !d.allowGuests) return "Sign in with Google or email to trade on the shared exchange. Guests can browse it.";
    return null;
  };

  /** Authenticates a trading request and returns the player's continuous city. */
  const trader = async (req: FastifyRequest) => {
    const u = await d.requireUser(req);
    d.writeGuard(req, u.sessionId);
    const blocked = tradeBlocker(u);
    if (blocked) throw new ApiError("FORBIDDEN", blocked);
    const run = d.activeRun(u);
    if (run.state.mode !== "play") throw new ApiError("FORBIDDEN", "Only your continuous city can trade on the shared exchange.");
    if (xsvc.isSelfCustodied(u.userId)) throw new ApiError("FORBIDDEN", "This company’s exchange holdings are no longer managed in the game. They cannot be traded here.");
    xsvc.chainIdFor(u.userId);
    return { u, run };
  };

  const cityAct = (run: RunHandle, action: AnyAction, idempotencyKey: string) => {
    const r = svc.act(run, { action, idempotencyKey }, "chain_worker");
    if (!r.ok) throw new ApiError(r.error!.code, r.error!.message, r.error!.details);
    return r;
  };

  /** Runs `fn` once per (player, kind, key); a retry returns the first result. Failures are not stored. */
  const once = <T extends Record<string, unknown>>(u: AuthedUser, kind: string, key: string, fn: (id: string) => T): T & { replayed: boolean } => {
    const id = xsvc.requestId(u.userId, kind, key);
    const prior = xsvc.priorRequest<T>(id);
    if (prior) return { ...prior, replayed: true };
    const result = fn(id);
    xsvc.saveRequest(id, u.userId, kind, result);
    return { ...result, replayed: false };
  };

  const respond = (u: AuthedUser, run: RunHandle, extra: Record<string, unknown>) => ({ ok: true, ...extra, exchange: xsvc.view(u.userId), state: svc.publicState(run) });

  app.get("/api/exchange", async (req) => {
    const u = await d.auth.authenticate(req);
    let depositableFuelMl = 0;
    let hasCity = false;
    if (u) {
      try {
        const run = d.activeRun(u);
        hasCity = run.state.mode === "play";
        depositableFuelMl = svc.publicState(run).player.exchangeDepositableFuelMl;
      } catch {
        hasCity = false;
      }
    }
    const blocked = tradeBlocker(u) ?? (hasCity ? null : "Start your city to trade on the exchange.");
    return { ok: true, canTrade: !blocked, blockedReason: blocked, depositableFuelMl, ...xsvc.view(u?.userId ?? null) };
  });

  app.post("/api/exchange/quote", async (req) => {
    const u = await d.requireUser(req);
    const b = d.parse(z.object({ quantityMl: Qty, maxPriceCcPerL: Price.nullable().optional() }), req.body);
    return { ok: true, quote: X.quoteBuy(xsvc.state, u.userId, b.quantityMl, b.maxPriceCcPerL ?? null) };
  });

  /** Tank -> warehouse. Only fuel the player bought (not starter fuel) and has not promised to a customer. */
  app.post("/api/exchange/deposit", async (req) => {
    const { u, run } = await trader(req);
    const b = d.parse(z.object({ quantityMl: Qty, idempotencyKey: Key }), req.body);
    const r = once(u, "dep", b.idempotencyKey, (depositId) => {
      const left = X.playerExchangeView(xsvc.state, u.userId).depositLeftTodayMl;
      if (b.quantityMl > left) throw new ApiError("VALIDATION_FAILED", `You can move ${L(left)} L more to the exchange today.`, { depositLeftTodayMl: left });
      cityAct(run, { type: "EXCHANGE_DEPOSIT", depositId, quantityMl: b.quantityMl }, `xdep:${depositId}`);
      try {
        xsvc.mutate((s, ctx) => X.requestDeposit(s, ctx, { playerId: u.userId, quantityMl: b.quantityMl, depositId }));
      } catch (e) {
        // the exchange refused after the tank was debited: put the fuel straight back
        cityAct(run, { type: "EXCHANGE_EFFECT", effect: { op: "refund_fuel", effectId: `refund:${depositId}:rollback`, amountMl: b.quantityMl, depositId } }, `xfx:refund:${depositId}:rollback`);
        throw e;
      }
      return { depositId };
    });
    return respond(u, run, r);
  });

  /** Warehouse -> tank. Delivered to the city only after the exchange confirms the burn. */
  app.post("/api/exchange/redeem", async (req) => {
    const { u, run } = await trader(req);
    const b = d.parse(z.object({ quantityMl: Qty, idempotencyKey: Key }), req.body);
    const r = once(u, "red", b.idempotencyKey, (redeemId) => {
      const p = svc.publicState(run).player;
      const incoming = X.playerExchangeView(xsvc.state, u.userId).pendingRedeemMl;
      const room = p.tankCapacityMl - p.fuelMl - p.pendingFuelMl - incoming;
      if (b.quantityMl > room) throw new ApiError("TANK_FULL", `Your tank has room for ${L(Math.max(0, room))} L.`, { roomMl: Math.max(0, room) });
      xsvc.mutate((s, ctx) => X.requestRedeem(s, ctx, { playerId: u.userId, quantityMl: b.quantityMl, redeemId }));
      return { redeemId };
    });
    return respond(u, run, r);
  });

  app.post("/api/exchange/asks", async (req) => {
    const { u, run } = await trader(req);
    const b = d.parse(z.object({ quantityMl: Qty, unitPriceCcPerL: Price, idempotencyKey: Key }), req.body);
    const r = once(u, "ask", b.idempotencyKey, (orderId) => {
      xsvc.mutate((s, ctx) => X.placeAsk(s, ctx, { owner: me(u), quantityMl: b.quantityMl, unitPriceCcPerL: b.unitPriceCcPerL, orderId }));
      return { orderId };
    });
    return respond(u, run, r);
  });

  app.post<{ Params: { orderId: string } }>("/api/exchange/asks/:orderId/cancel", async (req) => {
    const { u, run } = await trader(req);
    const o = xsvc.state.orders[req.params.orderId];
    if (!o) throw new ApiError("NOT_FOUND", "No such order.");
    if (o.owner.kind !== "player" || o.owner.id !== u.userId) throw new ApiError("FORBIDDEN", "This order belongs to someone else.");
    if (o.status === "cancelling" || o.status === "cancelled") return respond(u, run, { orderId: o.orderId, replayed: true });
    xsvc.mutate((s, ctx) => X.requestCancel(s, ctx, o.orderId, "owner", me(u)));
    return respond(u, run, { orderId: o.orderId, replayed: false });
  });

  /** Buys from the cheapest asks. Credits are held in the city until each transfer settles. */
  app.post("/api/exchange/buy", async (req) => {
    const { u, run } = await trader(req);
    const b = d.parse(z.object({ quantityMl: Qty, maxPriceCcPerL: Price.nullable().optional(), idempotencyKey: Key }), req.body);
    const max = b.maxPriceCcPerL ?? null;
    const r = once(u, "buy", b.idempotencyKey, (buyId) => {
      const q = X.quoteBuy(xsvc.state, u.userId, b.quantityMl, max);
      if (q.quantityMl < b.quantityMl) throw new ApiError("OUT_OF_STOCK", `Only ${L(q.quantityMl)} L is on offer${max ? " at that price" : ""}.`, { availableMl: q.quantityMl });
      cityAct(run, { type: "EXCHANGE_BUY_RESERVE", buyId, totalCc: q.totalCc, quantityMl: b.quantityMl }, `xbuy:${buyId}`);
      try {
        const { result } = xsvc.mutate((s, ctx) => X.reserveBuy(s, ctx, { playerId: u.userId, quantityMl: b.quantityMl, maxPriceCcPerL: max, buyId }));
        return { buyId, totalCc: result.totalCc, quantityMl: b.quantityMl, fillIds: result.fills.map((f) => f.fillId) };
      } catch (e) {
        cityAct(run, { type: "EXCHANGE_EFFECT", effect: { op: "release_payment", effectId: `release:${buyId}:rollback`, amountCc: q.totalCc, fillId: `${buyId}:rollback` } }, `xfx:release:${buyId}:rollback`);
        throw e;
      }
    });
    return respond(u, run, r);
  });
}
