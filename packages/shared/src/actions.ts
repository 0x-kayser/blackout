/**
 * PlayerAction: the ONLY way a client can change a run. The client never sends
 * prices it wants honoured (only a quoteId), never sends outcomes, and never
 * sends free-form text that affects economics.
 */
import { z } from "zod";
import { MarketItemSchema, UpgradeIdSchema } from "./schemas.ts";

const id = () => z.string().min(1).max(120);
/** Tariffs/counters: 0.01 .. 100 credits per kWh. */
const rate = () => z.number().int().min(1).max(10_000);

export const AcceptRequestSchema = z.object({
  type: z.literal("ACCEPT_REQUEST"),
  requestId: id(),
  /** Optional: accept and assign in one step. */
  generatorId: id().optional(),
});
export const CounterRequestSchema = z.object({
  type: z.literal("COUNTER_REQUEST"),
  requestId: id(),
  rateCcPerKwh: rate(),
});
export const DeclineRequestSchema = z.object({ type: z.literal("DECLINE_REQUEST"), requestId: id() });
export const AssignContractSchema = z.object({
  type: z.literal("ASSIGN_CONTRACT"),
  contractId: id(),
  generatorId: id(),
});
export const CancelContractSchema = z.object({ type: z.literal("CANCEL_CONTRACT"), contractId: id() });
export const RequestQuoteSchema = z.object({
  type: z.literal("REQUEST_QUOTE"),
  /** "merchant:<id>" or "regulator". */
  sellerId: id(),
  item: MarketItemSchema,
  /** Diesel in mL (max 60 L), permits in whole permits (max 20). */
  quantity: z.number().int().min(1).max(60_000),
});
export const BuySchema = z.object({
  type: z.literal("BUY"),
  quoteId: id(),
  quantity: z.number().int().min(1).max(60_000),
});
export const CreatePlayerListingSchema = z.object({
  type: z.literal("CREATE_PLAYER_LISTING"),
  listingId: id(),
  quantityMl: z.number().int().min(100).max(60_000).multipleOf(100),
  unitPriceCcPerL: z.number().int().min(1).max(100_000),
});
export const CancelPlayerListingSchema = z.object({ type: z.literal("CANCEL_PLAYER_LISTING"), listingId: id() });
export const SetTariffSchema = z.object({
  type: z.literal("SET_TARIFF"),
  districtId: id(),
  rateCcPerKwh: rate(),
});
export const ServiceGeneratorSchema = z.object({ type: z.literal("SERVICE_GENERATOR"), generatorId: id() });
export const BuyUpgradeSchema = z.object({ type: z.literal("BUY_UPGRADE"), upgradeId: UpgradeIdSchema });
export const UnlockDistrictSchema = z.object({ type: z.literal("UNLOCK_DISTRICT"), districtId: id() });
/** Raise a connected district's substation one level: more feeder capacity into that district. */
export const UpgradeSubstationSchema = z.object({ type: z.literal("UPGRADE_SUBSTATION"), districtId: id() });
/** Ends the morning market or the settlement report early. */
export const ReadySchema = z.object({ type: z.literal("READY") });
/** Real-time driver controls; handled by the API, not recorded in the sim. */
export const PauseSchema = z.object({ type: z.literal("PAUSE") });
export const ResumeSchema = z.object({ type: z.literal("RESUME") });

export const PlayerActionSchema = z.discriminatedUnion("type", [
  AcceptRequestSchema,
  CounterRequestSchema,
  DeclineRequestSchema,
  AssignContractSchema,
  CancelContractSchema,
  RequestQuoteSchema,
  BuySchema,
  CreatePlayerListingSchema,
  CancelPlayerListingSchema,
  SetTariffSchema,
  ServiceGeneratorSchema,
  BuyUpgradeSchema,
  UnlockDistrictSchema,
  UpgradeSubstationSchema,
  ReadySchema,
  PauseSchema,
  ResumeSchema,
]);

/** Actions injected by the server itself (chain worker). Never accepted from clients. */
export const SettleTradeSchema = z.object({
  type: z.literal("SETTLE_TRADE"),
  tradeId: id(),
  outcome: z.enum(["confirmed", "failed"]),
  txHash: z.string().nullable(),
  error: z.string().nullable(),
});
export const ReserveMarketPurchaseSchema = z.object({
  type: z.literal("RESERVE_MARKET_PURCHASE"),
  listingId: id(),
  merchantId: id(),
});
export const ExpireMarketListingSchema = z.object({ type: z.literal("EXPIRE_MARKET_LISTING"), listingId: id() });
export const MarketListingResultSchema = z.object({
  type: z.literal("MARKET_LISTING_RESULT"),
  listingId: id(),
  operation: z.enum(["list", "cancel", "fill"]),
  outcome: z.enum(["confirmed", "failed"]),
  merchantId: id().nullable(),
  txHash: z.string().nullable(),
  error: z.string().nullable(),
});
/** Shared exchange (server-injected): move tradeable fuel from the city tank to the player's exchange warehouse. */
export const ExchangeDepositSchema = z.object({
  type: z.literal("EXCHANGE_DEPOSIT"),
  depositId: id(),
  quantityMl: z.number().int().min(100).max(60_000).multipleOf(100),
});
/** Shared exchange: hold credits for a purchase until its on-chain transfer settles. */
export const ExchangeBuyReserveSchema = z.object({
  type: z.literal("EXCHANGE_BUY_RESERVE"),
  buyId: id(),
  totalCc: z.number().int().min(1),
  quantityMl: z.number().int().min(100).multipleOf(100),
});
const cc = () => z.number().int().min(0);
const ml = () => z.number().int().min(100).multipleOf(100);
export const ExchangeCityEffectSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("credit"), effectId: id(), amountCc: cc(), fillId: id() }),
  z.object({ op: z.literal("capture_payment"), effectId: id(), amountCc: cc(), fillId: id() }),
  z.object({ op: z.literal("release_payment"), effectId: id(), amountCc: cc(), fillId: id() }),
  z.object({ op: z.literal("deliver_fuel"), effectId: id(), amountMl: ml(), redeemId: id() }),
  z.object({ op: z.literal("refund_fuel"), effectId: id(), amountMl: ml(), depositId: id() }),
  z.object({ op: z.literal("charge_fee"), effectId: id(), amountCc: cc(), day: z.number().int() }),
]);
export type ExchangeCityEffect = z.infer<typeof ExchangeCityEffectSchema>;
/** Shared exchange: apply one settled exchange outcome to this city exactly once. */
export const ExchangeEffectSchema = z.object({ type: z.literal("EXCHANGE_EFFECT"), effect: ExchangeCityEffectSchema });
/** Shared exchange: the traders' scarcity premium on imported fuel, applied to this city's merchants. */
export const ExchangePriceSignalSchema = z.object({
  type: z.literal("EXCHANGE_PRICE_SIGNAL"),
  premiumBps: z.number().int().min(-2_000).max(5_000),
  bestAskCcPerL: z.number().int().min(0).nullable(),
});
export const SystemActionSchema = z.discriminatedUnion("type", [
  SettleTradeSchema,
  ReserveMarketPurchaseSchema,
  ExpireMarketListingSchema,
  MarketListingResultSchema,
  ExchangeDepositSchema,
  ExchangeBuyReserveSchema,
  ExchangeEffectSchema,
  ExchangePriceSignalSchema,
]);

export const ActionEnvelopeSchema = z.object({
  action: PlayerActionSchema,
  /** Client-generated unique key (e.g. crypto.randomUUID()). Retries MUST reuse it. */
  idempotencyKey: z.string().min(8).max(100),
  /** Optional optimistic concurrency: rejected with STALE_STATE if it differs from the run's stateVersion. */
  expectedStateVersion: z.number().int().nonnegative().optional(),
});
