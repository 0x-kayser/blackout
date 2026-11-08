/**
 * Double-entry asset ledger. Every credit, litre of diesel and gram of permit
 * allowance lives in exactly one account. Accounts named `world:*` are the only
 * faucets/sinks and may go negative; every other account is hard-floored at 0.
 * Invariant (tested): for each asset, the sum over all accounts is always 0.
 */
import { SimError, type Asset, type Ctx, type SimState } from "./state.ts";

export const ACC = {
  player: "player",
  rival: "rival",
  regulator: "regulator",
  escrowContracts: "escrow:contracts",
  escrowTrades: "escrow:trades",
  escrowListings: "escrow:listings",
  escrowMarket: "escrow:market",
  /** Credits held for shared-exchange purchases that are still settling. */
  escrowExchange: "escrow:exchange",
  business: (id: string) => `business:${id}`,
  merchant: (id: string) => `merchant:${id}`,
  districtPool: (id: string) => `district_pool:${id}`,
  // faucets & sinks
  genesis: "world:genesis",
  shoppers: "world:shoppers",
  wagesSuppliers: "world:wages_suppliers",
  grid: "world:grid",
  landlords: "world:landlords",
  importer: "world:importer",
  equipment: "world:equipment",
  fuelBurned: "world:fuel_burned",
  permitsRetired: "world:permits_retired",
  permitIssuer: "world:permit_issuer",
  /** The shared Vesper Fuel Exchange, seen from one city: fuel and credits that left for or arrived from it. */
  exchange: "world:exchange",
  /** The City Council's emergency fund pays daily-goal rewards. */
  council: "world:city_council",
} as const;

export const isWorld = (acct: string): boolean => acct.startsWith("world:");

export function bal(s: SimState, asset: Asset, acct: string): number {
  return s.balances[asset][acct] ?? 0;
}

const INSUFFICIENT: Record<Asset, "INSUFFICIENT_CREDITS" | "INSUFFICIENT_FUEL" | "INSUFFICIENT_PERMITS"> = {
  credits_cc: "INSUFFICIENT_CREDITS",
  fuel_ml: "INSUFFICIENT_FUEL",
  permit_mg: "INSUFFICIENT_PERMITS",
};

export function transfer(
  s: SimState,
  ctx: Ctx,
  asset: Asset,
  from: string,
  to: string,
  amount: number,
  reason: string,
  refId: string | null = null,
  txHash: string | null = null,
): void {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new SimError("INTERNAL", `ledger amount must be a non-negative integer, got ${amount}`);
  }
  if (amount === 0) return;
  if (from === to) throw new SimError("INTERNAL", "self transfer");
  const fb = bal(s, asset, from);
  if (!isWorld(from) && fb < amount) {
    throw new SimError(INSUFFICIENT[asset], `${from} has ${fb} ${asset}, needs ${amount}`, { asset, from, have: fb, need: amount });
  }
  const book = s.balances[asset];
  book[from] = fb - amount;
  book[to] = bal(s, asset, to) + amount;
  s.ledgerSeq += 1;
  ctx.ledger.push({
    seq: s.ledgerSeq,
    runId: s.runId,
    day: s.day,
    tick: s.tick,
    asset,
    from,
    to,
    amount,
    fromBalanceAfter: book[from],
    toBalanceAfter: book[to],
    reason,
    refId,
    source: txHash ? "testnet_transaction" : ctx.source,
    txHash,
  });
}

/** Moves min(amount, available) and returns what was actually moved. */
export function transferUpTo(
  s: SimState,
  ctx: Ctx,
  asset: Asset,
  from: string,
  to: string,
  amount: number,
  reason: string,
  refId: string | null = null,
): number {
  const avail = isWorld(from) ? amount : Math.max(0, Math.min(amount, bal(s, asset, from)));
  transfer(s, ctx, asset, from, to, avail, reason, refId);
  return avail;
}

export function sumAsset(s: SimState, asset: Asset): number {
  return Object.values(s.balances[asset]).reduce((a, b) => a + b, 0);
}
