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
export const SetTariffSchema = z.object({
  type: z.literal("SET_TARIFF"),
  districtId: id(),
  rateCcPerKwh: rate(),
});
export const ServiceGeneratorSchema = z.object({ type: z.literal("SERVICE_GENERATOR"), generatorId: id() });
export const BuyUpgradeSchema = z.object({ type: z.literal("BUY_UPGRADE"), upgradeId: UpgradeIdSchema });
export const UnlockDistrictSchema = z.object({ type: z.literal("UNLOCK_DISTRICT"), districtId: id() });
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
  SetTariffSchema,
  ServiceGeneratorSchema,
  BuyUpgradeSchema,
  UnlockDistrictSchema,
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
export const SystemActionSchema = z.discriminatedUnion("type", [SettleTradeSchema]);

export const ActionEnvelopeSchema = z.object({
  action: PlayerActionSchema,
  /** Client-generated unique key (e.g. crypto.randomUUID()). Retries MUST reuse it. */
  idempotencyKey: z.string().min(8).max(100),
  /** Optional optimistic concurrency: rejected with STALE_STATE if it differs from the run's stateVersion. */
  expectedStateVersion: z.number().int().nonnegative().optional(),
});
