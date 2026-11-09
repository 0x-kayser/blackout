/**
 * Vesper Market: the shared market town every player trades in. Merchants are agents with their own wallets and
 * inventories; prices come from stock and recent demand (packages/sim/src/town/merchantPricing.ts).
 *
 * Units: credits in cc (1 credit = 100 cc); item quantities in whole units (see ITEMS).
 */
import { z } from "zod";

export const ITEM_IDS = ["fuel:natural-gas", "fuel:diesel", "permit:carbon", "certificate:renewable", "material:steel", "part:turbine"] as const;
export type ItemId = (typeof ITEM_IDS)[number];
export const ItemIdSchema = z.enum(ITEM_IDS);

export const ITEMS: Record<ItemId, { name: string; unit: string; units: string; icon: string; blurb: string }> = {
  "fuel:natural-gas": { name: "Natural gas", unit: "MMBtu", units: "MMBtu", icon: "🔥", blurb: "Burned by gas turbines. About 10 MMBtu makes one megawatt-hour." },
  "fuel:diesel": { name: "Diesel", unit: "L", units: "L", icon: "🛢️", blurb: "Burned by diesel peakers. About 265 litres per megawatt-hour." },
  "permit:carbon": { name: "Carbon permit", unit: "t", units: "t CO₂", icon: "📜", blurb: "Your fuelled plants surrender one per tonne of CO₂. Without them the regulator charges 25% more in cash." },
  "certificate:renewable": { name: "Renewable certificate", unit: "MWh", units: "certificates", icon: "🌿", blurb: "Earned for every megawatt-hour your solar farms deliver. Sell them to the green desk." },
  "material:steel": { name: "Steel", unit: "t", units: "t", icon: "🏗️", blurb: "Every plant and line upgrade needs it. Bought automatically when you build if you don't hold enough." },
  "part:turbine": { name: "Turbine parts", unit: "kit", units: "kits", icon: "⚙️", blurb: "Repair a tripped plant at once instead of waiting hours." },
};

export const TradeRequestSchema = z.object({
  merchantId: z.string().min(1).max(40),
  item: ItemIdSchema,
  side: z.enum(["buy", "sell"]),
  quantity: z.number().int().min(1).max(10_000_000),
  idempotencyKey: z.string().min(8).max(80),
});
export type TradeRequest = z.infer<typeof TradeRequestSchema>;

export const InvestRequestSchema = z.object({
  merchantId: z.string().min(1).max(40),
  amountCc: z.number().int().min(1_000_00).max(100_000_000_00),
  idempotencyKey: z.string().min(8).max(80),
});

export interface PriceWhy {
  /** One line per factor, each with the multiplier it applied. */
  lines: { label: string; factor: string }[];
  summary: string;
}

export interface MerchantItemView {
  item: ItemId;
  stock: number;
  target: number;
  /** null = this merchant doesn't sell / buy it. */
  askCc: number | null;
  bidCc: number | null;
  referenceCc: number;
  why: PriceWhy;
  /** Price an hour of town time ago, for ▲▼. */
  askAnHourAgoCc: number | null;
  history: number[];
}

export interface MerchantView {
  merchantId: string;
  name: string;
  person: string;
  face: string;
  personality: string;
  open: boolean;
  cashCc: number;
  /** Credits needed to reopen a closed shop. */
  reopenCc: number;
  fixedCcPerDay: number;
  profitCcToday: number;
  items: MerchantItemView[];
  investors: { playerId: string; name: string; investedCc: number; shareBps: number; mine: boolean }[];
  closedReason: string | null;
  chainAccount: string | null;
  lastTradeAt: number;
}

export interface TownTrade {
  seq: number;
  tick: number;
  label: string;
  merchantId: string;
  who: string;
  whoKind: "player" | "you" | "npc" | "bot";
  item: ItemId;
  side: "buy" | "sell";
  quantity: number;
  priceCc: number;
  totalCc: number;
}

export interface TownEvent {
  seq: number;
  tick: number;
  severity: "info" | "good" | "warn" | "crisis";
  title: string;
  detail: string;
  merchantId: string | null;
  /** "news" for stories from outside the market (news.ts), "power" for the power desk; shop events leave it unset. */
  kind?: "news" | "power";
  /** For power events: the seller ("player:<id>" or "firm:<id>"), so a player sees their own deals. */
  who?: string;
}

export interface TownNews {
  seq: number;
  headline: string;
  detail: string;
  tone: "warn" | "good";
  items: ItemId[];
  merchantIds: string[];
  /** e.g. "imports ×0.15", "outside price ×1.18" */
  effects: string[];
  ticksLeft: number;
  ageTicks: number;
}

export interface TownView {
  tick: number;
  clock: string;
  merchants: MerchantView[];
  trades: TownTrade[];
  events: TownEvent[];
  players: number;
  /** Your stake and what you're owed. */
  you: { investedCc: number; dividendsCcTotal: number; pendingCc: number } | null;
  steelSupplyBps: number;
  /** Stories in the news right now and what each does to the market. */
  news?: TownNews[];
  /** Vesper's NPC companies and the power desk. */
  companies?: CompaniesView;
}

export interface CompanyView {
  firmId: string;
  name: string;
  person: string;
  face: string;
  kind: "smelter" | "solar" | "gas";
  blurb: string;
  open: boolean;
  cashCc: number;
  escrowedCc: number;
  spendableCc: number;
  profitCcToday: number;
  revenueCcToday: number;
  boughtKwh: number;
  soldKwh: number;
  productionBps: number;
  /** The company's own reasoning for its latest decision, built from the numbers it used. */
  lastWhy: string;
  /** Its NEAR account, when the server is connected to testnet. */
  chainAccount: string | null;
}

export interface PowerOrderView {
  orderId: string;
  buyerId: string;
  buyerName: string;
  sellerName: string;
  mine: boolean;
  kw: number;
  kwh: number;
  priceCcPerMWh: number;
  escrowCc: number;
  status: "placing" | "open" | "awaiting" | "settled" | "failed" | "expired";
  deliveredKwh: number | null;
  paidCc: number;
  refundCc: number;
  why: string;
  startTick: number;
  endTick: number;
  failReason: string | null;
  /** The buyer's escrow transaction and the operator's confirmation, on NEAR testnet. */
  txHash: string | null;
  confirmTxHash: string | null;
}

export interface CompaniesView {
  cloudPct: number;
  sunBps: number;
  windowTicksLeft: number;
  firms: CompanyView[];
  offers: { sellerKey: string; sellerName: string; kw: number; priceCcPerMWh: number; why: string; mine: boolean }[];
  orders: PowerOrderView[];
}

export interface FastForwardFrame {
  tick: number;
  label: string;
  merchants: { merchantId: string; open: boolean; cashCc: number; prices: Partial<Record<ItemId, number>>; stock: Partial<Record<ItemId, number>> }[];
  /** The NPC power companies' cash and output at this moment. */
  companies?: { firmId: string; name: string; open: boolean; cashCc: number; productionBps: number }[];
  cloudPct?: number;
  /** What your company had earned from the power desk so far in this week (projected). */
  youEarnedCc?: number;
}

export interface FastForwardResult {
  seed: number;
  days: number;
  frames: FastForwardFrame[];
  events: TownEvent[];
  bots: { name: string; strategy: string; cashCc: number; netWorthCc: number }[];
  /** Each NPC company's week: cash at the start and end, power bought and sold. */
  companies?: { firmId: string; name: string; startCc: number; endCc: number; boughtMWh: number; soldMWh: number; open: boolean }[];
  /** Your company in the week, if it had spare power to offer: what it was projected to offer and earn. */
  you?: { name: string; kw: number; priceCcPerMWh: number; earnedCc: number; deals: number } | null;
  trades: number;
  traceHash: string;
}
