import type { z } from "zod";
import type * as S from "./schemas.ts";
import type * as A from "./actions.ts";
import type * as E from "./events.ts";

export type RunMode = z.infer<typeof S.RunModeSchema>;
export type Phase = z.infer<typeof S.PhaseSchema>;
export type EventSource = z.infer<typeof S.EventSourceSchema>;
export type ChainMode = z.infer<typeof S.ChainModeSchema>;
export type TradeChainStatus = z.infer<typeof S.TradeChainStatusSchema>;
/** Alias requested by the spec: the stable status the UI renders for a trade. */
export type TradeStatus = TradeChainStatus;
export type BusinessStatus = z.infer<typeof S.BusinessStatusSchema>;
export type PowerSource = z.infer<typeof S.PowerSourceSchema>;
export type Provider = z.infer<typeof S.ProviderSchema>;
export type RequestStatus = z.infer<typeof S.RequestStatusSchema>;
export type ContractStatus = z.infer<typeof S.ContractStatusSchema>;
export type WaveStatus = z.infer<typeof S.WaveStatusSchema>;
export type GeneratorType = z.infer<typeof S.GeneratorTypeSchema>;
export type GeneratorStatus = z.infer<typeof S.GeneratorStatusSchema>;
export type MarketItem = z.infer<typeof S.MarketItemSchema>;
export type Mood = z.infer<typeof S.MoodSchema>;
export type Trend = z.infer<typeof S.TrendSchema>;
export type UpgradeId = z.infer<typeof S.UpgradeIdSchema>;

export type ClockPublic = z.infer<typeof S.ClockSchema>;
export type RunPublic = z.infer<typeof S.RunSchema>;
export type PlayerPublic = z.infer<typeof S.PlayerSchema>;
export type GeneratorPublic = z.infer<typeof S.GeneratorSchema>;
export type BatteryPublic = z.infer<typeof S.BatterySchema>;
export type DistrictPublic = z.infer<typeof S.DistrictSchema>;
export type BusinessPublic = z.infer<typeof S.BusinessSchema>;
export type BusinessDay = z.infer<typeof S.BusinessDaySchema>;
export type ContractRequestPublic = z.infer<typeof S.RequestSchema>;
export type PowerContractPublic = z.infer<typeof S.ContractSchema>;
export type PriceReasons = z.infer<typeof S.PriceReasonsSchema>;
export type MerchantPublic = z.infer<typeof S.MerchantSchema>;
export type MarketQuote = z.infer<typeof S.QuoteSchema>;
export type TradePublic = z.infer<typeof S.TradeSchema>;
export type MarketListingPublic = z.infer<typeof S.MarketListingSchema>;
export type RivalPublic = z.infer<typeof S.RivalSchema>;
export type RegulatorPublic = z.infer<typeof S.RegulatorSchema>;
export type WorldPublic = z.infer<typeof S.WorldSchema>;
export type WavePublic = z.infer<typeof S.WaveSchema>;
export type DayReport = z.infer<typeof S.DayReportSchema>;
export type CampaignSummary = z.infer<typeof S.CampaignSummarySchema>;
export type TutorialPublic = z.infer<typeof S.TutorialSchema>;
export type ChainInfo = z.infer<typeof S.ChainInfoSchema>;
export type GameStatePublic = z.infer<typeof S.GameStatePublicSchema>;

export type PlayerAction = z.infer<typeof A.PlayerActionSchema>;
export type SystemAction = z.infer<typeof A.SystemActionSchema>;
export type AnyAction = PlayerAction | SystemAction;
export type ActionEnvelope = z.infer<typeof A.ActionEnvelopeSchema>;

export type EconomyEvent = z.infer<typeof E.EconomyEventSchema>;
/** Spec name for the same thing: everything the server pushes over SSE. */
export type ServerEvent = EconomyEvent;
export type LedgerEntry = z.infer<typeof E.LedgerEntrySchema>;
export type WorldEventPublic = z.infer<typeof S.WorldEventPublicSchema>;
export type WorldModifiersPublic = z.infer<typeof S.WorldModifiersSchema>;
export type StoryPublic = z.infer<typeof S.StorySchema>;
