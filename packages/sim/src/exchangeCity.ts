/**
 * One city's side of the shared Vesper Fuel Exchange. The exchange itself is a
 * separate engine (./exchange); a city only ever sees three server-injected,
 * idempotent system actions, so each city stays deterministic from seed + its
 * own action log:
 *
 *   EXCHANGE_DEPOSIT      tank -> world:exchange (only bought, unreserved fuel)
 *   EXCHANGE_BUY_RESERVE  credits -> escrow:exchange while a purchase settles
 *   EXCHANGE_EFFECT       a settled exchange outcome (paid, delivered, refunded, fee)
 *
 * `world:exchange` is this city's view of the exchange: everything that left for it
 * or arrived from it. The exchange engine checks that all cities and its traders
 * balance as a whole.
 */
import type { ExchangeCityEffect } from "@blackout/shared";
import { ACC, bal, transfer, transferUpTo } from "./ledger.ts";
import { playerFreeFuelMl } from "./policies/playerMarket.ts";
import { SimError, cr, emit, type Ctx, type SimState } from "./state.ts";
import { ensureGoals, goalsTick } from "./goals.ts";

const L = (ml: number) => (ml / 1000).toFixed(1);

/** Bought (never starter) fuel that is not committed to a contract, in whole 100 mL units. */
export function exchangeDepositableFuelMl(s: SimState): number {
  if (s.mode !== "play") return 0;
  return Math.floor(Math.min(s.player.exchangeEligibleFuelMl ?? 0, playerFreeFuelMl(s)) / 100) * 100;
}

function requirePlay(s: SimState): void {
  if (s.mode !== "play") throw new SimError("FORBIDDEN", "Only your continuous city can trade on the shared exchange.");
}

export function exchangeDeposit(s: SimState, ctx: Ctx, depositId: string, quantityMl: number) {
  requirePlay(s);
  const can = exchangeDepositableFuelMl(s);
  if (quantityMl > can) {
    throw new SimError("INSUFFICIENT_FUEL", `Only ${L(can)} L can go to the exchange: fuel you bought that isn't promised to a customer. Starter fuel stays in the city.`, { depositableMl: can });
  }
  transfer(s, ctx, "fuel_ml", ACC.player, ACC.exchange, quantityMl, "exchange_deposit", depositId);
  s.player.exchangeEligibleFuelMl -= quantityMl;
  emit(s, ctx, "EXCHANGE_FUEL_SENT", ["player", ACC.exchange], `${L(quantityMl)} L left your tank for your exchange warehouse.`, { depositId, quantityMl });
  return { depositId, quantityMl };
}

export function exchangeBuyReserve(s: SimState, ctx: Ctx, buyId: string, totalCc: number, quantityMl: number) {
  requirePlay(s);
  // Exchange purchases land in the warehouse, not the tank; tank room is checked when fuel is brought home.
  transfer(s, ctx, "credits_cc", ACC.player, ACC.escrowExchange, totalCc, "exchange_buy_reserve", buyId);
  emit(s, ctx, "EXCHANGE_PAYMENT_RESERVED", ["player", ACC.exchange], `${cr(totalCc)} credits held for ${L(quantityMl)} L from the exchange while it is delivered to your warehouse.`, { buyId, totalCc, quantityMl });
  return { buyId, totalCc };
}

export function applyExchangeEffect(s: SimState, ctx: Ctx, e: ExchangeCityEffect) {
  switch (e.op) {
    case "credit":
      transfer(s, ctx, "credits_cc", ACC.exchange, ACC.player, e.amountCc, "exchange_sale", e.fillId);
      s.dayStats.revenueCc += e.amountCc;
      ensureGoals(s).exchangeSales += 1;
      goalsTick(s, ctx);
      emit(s, ctx, "EXCHANGE_SALE_PAID", ["player", ACC.exchange], `Exchange sale settled: +${cr(e.amountCc)} credits.`, { fillId: e.fillId, amountCc: e.amountCc });
      break;
    case "capture_payment":
      transfer(s, ctx, "credits_cc", ACC.escrowExchange, ACC.exchange, e.amountCc, "exchange_buy_paid", e.fillId);
      s.dayStats.spendCc += e.amountCc;
      emit(s, ctx, "EXCHANGE_PAYMENT_CAPTURED", ["player", ACC.exchange], `Exchange purchase delivered to your warehouse; ${cr(e.amountCc)} credits paid.`, { fillId: e.fillId, amountCc: e.amountCc });
      break;
    case "release_payment":
      transfer(s, ctx, "credits_cc", ACC.escrowExchange, ACC.player, e.amountCc, "exchange_buy_released", e.fillId);
      emit(s, ctx, "EXCHANGE_PAYMENT_RELEASED", ["player", ACC.exchange], `An exchange purchase did not go through; ${cr(e.amountCc)} credits returned.`, { fillId: e.fillId, amountCc: e.amountCc });
      break;
    case "deliver_fuel":
      transfer(s, ctx, "fuel_ml", ACC.exchange, ACC.player, e.amountMl, "exchange_delivery", e.redeemId);
      // fuel that came through the market can go back to it
      s.player.exchangeEligibleFuelMl = (s.player.exchangeEligibleFuelMl ?? 0) + e.amountMl;
      emit(s, ctx, "EXCHANGE_FUEL_RECEIVED", ["player", ACC.exchange], `${L(e.amountMl)} L arrived in your tank from your exchange warehouse.`, { redeemId: e.redeemId, amountMl: e.amountMl });
      break;
    case "refund_fuel":
      transfer(s, ctx, "fuel_ml", ACC.exchange, ACC.player, e.amountMl, "exchange_deposit_refund", e.depositId);
      s.player.exchangeEligibleFuelMl = (s.player.exchangeEligibleFuelMl ?? 0) + e.amountMl;
      emit(s, ctx, "EXCHANGE_FUEL_RETURNED", ["player", ACC.exchange], `The move to your warehouse failed; ${L(e.amountMl)} L is back in your tank.`, { depositId: e.depositId, amountMl: e.amountMl });
      break;
    case "charge_fee": {
      const paid = transferUpTo(s, ctx, "credits_cc", ACC.player, ACC.exchange, e.amountCc, "exchange_storage_fee", e.effectId);
      s.dayStats.spendCc += paid;
      emit(s, ctx, "EXCHANGE_STORAGE_FEE", ["player", ACC.exchange], paid === e.amountCc ? `Exchange warehouse storage: ${cr(paid)} credits.` : `Exchange warehouse storage: ${cr(paid)} of ${cr(e.amountCc)} credits (the rest was waived: your balance ran out).`, { day: e.day, amountCc: e.amountCc, paidCc: paid });
      break;
    }
  }
  return { effectId: e.effectId, creditsCc: bal(s, "credits_cc", ACC.player), fuelMl: bal(s, "fuel_ml", ACC.player) };
}
