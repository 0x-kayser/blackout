/**
 * EconomyEvent: semantic, append-only facts emitted by the authoritative engine
 * (or by the chain worker for verified testnet outcomes). The UI animates these;
 * it never infers outcomes on its own.
 */
import { z } from "zod";
import { EventSourceSchema } from "./schemas.ts";

export const EVENT_TYPES = [
  "RUN_STARTED",
  "PHASE_CHANGED",
  "DAY_STARTED",
  "OIL_INDEX_UPDATED",
  "WAVE_STARTED",
  "OUTAGE_STARTED",
  "CUSTOMER_REQUESTED",
  "PLAYER_COUNTERED",
  "CUSTOMER_COUNTERED",
  "CUSTOMER_REJECTED_COUNTER",
  "CONTRACT_ACCEPTED",
  "REQUEST_DECLINED",
  "REQUEST_EXPIRED",
  "LOAD_ASSIGNED",
  "SERVICE_STARTED",
  "ENERGY_DELIVERED",
  "FUEL_CONSUMED",
  "CO2_EMITTED",
  "CONTRACT_COMPLETED",
  "CONTRACT_FAILED",
  "CONTRACT_CANCELLED",
  "CONTRACT_EXPIRED",
  "REFUND_ISSUED",
  "OUTAGE_ENDED",
  "WAVE_COMPLETED",
  "OVERHEAT_WARNING",
  "GENERATOR_BROKEN",
  "GENERATOR_REPAIRED",
  "GENERATOR_SERVICED",
  "BATTERY_UPDATED",
  "BUSINESS_STATUS_CHANGED",
  "CUSTOMER_SWITCHED_PROVIDER",
  "RIVAL_WON_CONTRACT",
  "RIVAL_DECLINED_CONTRACT",
  "RIVAL_REPRICED",
  "RIVAL_PURCHASED",
  "QUOTE_CREATED",
  "QUOTE_EXPIRED",
  "TRADE_RESERVED",
  "TRADE_CONFIRMED",
  "TRADE_FAILED",
  "MERCHANT_REPRICED",
  "MERCHANT_RESTOCK_ORDERED",
  "MERCHANT_RESTOCK_DELIVERED",
  "MERCHANT_CLOSED",
  "MERCHANT_REOPENED",
  "PERMITS_PURCHASED",
  "REGULATOR_NOTICE",
  "TARIFF_SET",
  "UPGRADE_PURCHASED",
  "DISTRICT_UNLOCKED",
  "TUTORIAL_STEP",
  "DAY_SETTLED",
  "CAMPAIGN_FINISHED",
] as const;

export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = (typeof EVENT_TYPES)[number];

export const EconomyEventSchema = z.object({
  /** Strictly increasing per run, starting at 1. Used as SSE id / Last-Event-ID. */
  seq: z.number().int().positive(),
  eventId: z.string(), // `${runId}:${seq}`
  runId: z.string(),
  day: z.number().int(),
  tick: z.number().int().nonnegative(),
  /** "HH:MM" game time during operating phase, otherwise the phase name. */
  clock: z.string(),
  type: EventTypeSchema,
  source: EventSourceSchema,
  /** Entity ids involved, e.g. ["business:cold_room", "generator:gen_1"]. */
  actors: z.array(z.string()),
  /** Human-readable causal explanation derived from the same numbers as `data`. */
  explanation: z.string(),
  data: z.record(z.string(), z.unknown()),
  /** Only for source=testnet_transaction, and only from a verified RPC result. */
  txHash: z.string().nullable(),
  /** Added by the API when persisted (ISO-8601). Excluded from determinism checks. */
  serverTime: z.string().optional(),
});

/** Credit/fuel/permit movements: double-entry, immutable. */
export const LedgerEntrySchema = z.object({
  seq: z.number().int().positive(),
  runId: z.string(),
  day: z.number().int(),
  tick: z.number().int().nonnegative(),
  asset: z.enum(["credits_cc", "fuel_ml", "permit_mg"]),
  from: z.string(),
  to: z.string(),
  amount: z.number().int().positive(),
  fromBalanceAfter: z.number().int(),
  toBalanceAfter: z.number().int(),
  reason: z.string(),
  refId: z.string().nullable(),
  source: EventSourceSchema,
  txHash: z.string().nullable(),
});
