/**
 * Shared Vesper Fuel Exchange: one order book every city trades on. Pure data;
 * the engine in ./engine.ts is the only thing that changes it.
 *
 * Units: fuel in mL (always a multiple of 100 = one on-chain DIESEL_100ML unit),
 * credits in cc (1/100 credit), prices in cc per litre.
 */
import type { TraderDecision, TraderParams, TraderStatus } from "../policies/exchangeTraders.ts";

export type ExchangeAsset = "fuel_ml" | "credits_cc";

export type OwnerRef = { kind: "player"; id: string } | { kind: "trader"; id: string };

/**
 * placing    -> waiting for the on-chain escrow to confirm (not matchable)
 * open       -> on the book
 * cancelling -> cancel submitted (not matchable)
 * filled / cancelled / rejected are terminal
 */
export type OrderStatus = "placing" | "open" | "cancelling" | "filled" | "cancelled" | "rejected";

export interface ExchangeOrder {
  orderId: string;
  owner: OwnerRef;
  quantityMl: number;
  filledMl: number;
  /** Held for fills whose on-chain transfer has not confirmed yet. */
  reservedMl: number;
  unitPriceCcPerL: number;
  status: OrderStatus;
  createdTick: number;
  expiresTick: number | null;
  /** Set when the owner (or expiry) asked to cancel. */
  cancelReason: "owner" | "expired" | "reprice" | null;
  seq: number;
  error: string | null;
}

export type FillStatus = "pending" | "settled" | "failed";

export interface ExchangeFill {
  fillId: string;
  orderId: string;
  seller: OwnerRef;
  buyer: OwnerRef;
  quantityMl: number;
  unitPriceCcPerL: number;
  totalCc: number;
  status: FillStatus;
  reservedTick: number;
  settledTick: number | null;
  txHash: string | null;
  error: string | null;
}

export type OpKind = "deposit" | "redeem" | "import" | "supply";

export interface ExchangeOp {
  opId: string;
  kind: OpKind;
  owner: OwnerRef;
  quantityMl: number;
  /** Imports: credits already paid to the importer. Supplies: credits the cities pay the trader. */
  costCc: number;
  /** ordered -> (imports only) waiting for delivery; pending -> waiting for the chain; then settled/failed. */
  status: "ordered" | "pending" | "settled" | "failed";
  createdTick: number;
  arrivesTick: number | null;
  txHash: string | null;
  error: string | null;
}

export interface TraderState {
  traderId: string;
  params: TraderParams;
  status: TraderStatus;
  decision: TraderDecision | null;
  askOrderId: string | null;
  pendingImportId: string | null;
  soldTodayMl: number;
  boughtTodayMl: number;
  soldYesterdayMl: number;
  boughtYesterdayMl: number;
  importedTodayMl: number;
}

export interface ExchangeDayStats {
  day: number;
  oilIndexCenti: number;
  volumeMl: number;
  valueCc: number;
  lastPriceCcPerL: number | null;
  bestAskCcPerL: number | null;
  bestBidCcPerL: number | null;
}

export interface ExchangeConfig {
  ticksPerDay: number;
  /** Player asks expire after this many ticks. */
  playerAskLifetimeTicks: number;
  /** Player ask prices must sit within [min, max] x import cost. */
  priceBandMinBps: number;
  priceBandMaxBps: number;
  /** Storage fee per day on warehouse fuel, as a share of its import-cost value. */
  storageFeeBps: number;
  /** Most fuel one player can move from city tank to the exchange per exchange day. */
  maxDepositPerDayMl: number;
  baseReferenceCcPerL: number;
  referenceIndexCenti: number;
}

export interface ExchangeState {
  version: 1;
  tick: number;
  day: number;
  oilIndexCenti: number;
  config: ExchangeConfig;
  balances: Record<ExchangeAsset, Record<string, number>>;
  orders: Record<string, ExchangeOrder>;
  fills: Record<string, ExchangeFill>;
  ops: Record<string, ExchangeOp>;
  traders: Record<string, TraderState>;
  depositsToday: Record<string, number>;
  today: { volumeMl: number; valueCc: number; lastPriceCcPerL: number | null };
  history: ExchangeDayStats[];
  seq: number;
  ledgerSeq: number;
  eventSeq: number;
}

export type ExchangeEventType =
  | "OIL_UPDATED"
  | "DEPOSIT_REQUESTED"
  | "DEPOSITED"
  | "DEPOSIT_FAILED"
  | "REDEEM_REQUESTED"
  | "REDEEMED"
  | "REDEEM_FAILED"
  | "ASK_PLACED"
  | "ASK_OPENED"
  | "ASK_REJECTED"
  | "CANCEL_REQUESTED"
  | "ORDER_CANCELLED"
  | "CANCEL_FAILED"
  | "FILL_RESERVED"
  | "FILL_SETTLED"
  | "FILL_FAILED"
  | "TRADER_STATUS"
  | "TRADER_IMPORT_ORDERED"
  | "TRADER_IMPORT_ARRIVED"
  | "TRADER_IMPORT_FAILED"
  | "STORAGE_FEE"
  | "CITY_SUPPLIED"
  | "CITY_SUPPLY_FAILED"
  | "DAY_CLOSED";

export interface ExchangeEvent {
  seq: number;
  tick: number;
  day: number;
  type: ExchangeEventType;
  /** "player:<id>", "trader:<id>", "order:<id>", "fill:<id>" */
  actors: string[];
  explanation: string;
  data: Record<string, unknown>;
}

export interface ExchangeLedgerEntry {
  seq: number;
  tick: number;
  asset: ExchangeAsset;
  from: string;
  to: string;
  amount: number;
  reason: string;
  refId: string | null;
}

/** On-chain work the server must submit; `opId` is the contract's single-use id. */
export type ChainEffect =
  | { kind: "chain"; op: "deposit"; opId: string; playerId: string; amountMl: number }
  | { kind: "chain"; op: "redeem"; opId: string; playerId: string; amountMl: number }
  | { kind: "chain"; op: "ask"; opId: string; owner: OwnerRef; amountMl: number; unitPriceCcPerL: number }
  | { kind: "chain"; op: "cancel"; opId: string; owner: OwnerRef }
  | { kind: "chain"; op: "fill"; opId: string; orderId: string; buyer: OwnerRef; amountMl: number }
  | { kind: "chain"; op: "import"; opId: string; traderId: string; amountMl: number }
  /** A trader sells fuel to the merchants of players' cities: burned from its wallet as it leaves the exchange. */
  | { kind: "chain"; op: "supply"; opId: string; traderId: string; amountMl: number };

/** Changes the server must apply to a player's city save (each `effectId` is single-use). */
export type CityEffect =
  | { kind: "city"; op: "credit"; effectId: string; playerId: string; amountCc: number; fillId: string }
  | { kind: "city"; op: "capture_payment"; effectId: string; playerId: string; amountCc: number; fillId: string }
  | { kind: "city"; op: "release_payment"; effectId: string; playerId: string; amountCc: number; fillId: string }
  | { kind: "city"; op: "deliver_fuel"; effectId: string; playerId: string; amountMl: number; redeemId: string }
  | { kind: "city"; op: "refund_fuel"; effectId: string; playerId: string; amountMl: number; depositId: string }
  | { kind: "city"; op: "charge_fee"; effectId: string; playerId: string; amountCc: number; day: number };

export type ExchangeEffect = ChainEffect | CityEffect;

export interface ExchangeCtx {
  events: ExchangeEvent[];
  effects: ExchangeEffect[];
  ledger: ExchangeLedgerEntry[];
}

export const newExchangeCtx = (): ExchangeCtx => ({ events: [], effects: [], ledger: [] });
