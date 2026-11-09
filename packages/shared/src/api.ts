/**
 * REST/SSE contract for apps/api, plus a tiny typed client that apps/web can use.
 * See docs/API_CONTRACT.md for examples and state diagrams.
 */
import { z } from "zod";
import { ActionEnvelopeSchema } from "./actions.ts";
import { EconomyEventSchema, LedgerEntrySchema } from "./events.ts";
import {
  ChainModeSchema,
  GameStatePublicSchema,
  MarketItemSchema,
  MarketListingSchema,
  MerchantSchema,
  QuoteSchema,
  RegulatorSchema,
  RunModeSchema,
  TradeSchema,
  WorldSchema,
} from "./schemas.ts";

export const ERROR_CODES = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "RATE_LIMITED",
  "STALE_STATE",
  "INVALID_PHASE",
  "INVALID_STATE",
  "REQUEST_EXPIRED",
  "MAX_COUNTERS_REACHED",
  "CUSTOMER_CANNOT_PAY",
  "CAPACITY_EXCEEDED",
  "GENERATOR_OFFLINE",
  "INSUFFICIENT_FUEL",
  "INSUFFICIENT_PERMITS",
  "TANK_FULL",
  "QUOTE_EXPIRED",
  "QUOTE_MISMATCH",
  "INSUFFICIENT_CREDITS",
  "OUT_OF_STOCK",
  "RATION_LIMIT",
  "MERCHANT_CLOSED",
  "REQUIREMENT_NOT_MET",
  "TX_PENDING",
  "TX_FAILED",
  "CHAIN_UNAVAILABLE",
  "ALREADY_PROCESSED",
  "RUN_FINISHED",
  "ACCOUNT_EXISTS",
  "AUTH_PROVIDER_UNAVAILABLE",
  "INTERNAL",
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ApiErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export const ErrorResponseSchema = z.object({ ok: z.literal(false), error: ApiErrorSchema });

// ---- session
export const StartSessionRequestSchema = z.object({ kind: z.literal("guest").default("guest") });
export const StartSessionResponseSchema = z.object({
  ok: z.literal(true),
  sessionId: z.string(),
  /** Bearer token. Also set as HTTP-only cookie `bo_session`. Not a NEAR key. */
  token: z.string(),
  user: z.object({ userId: z.string(), kind: z.literal("guest") }),
  authMode: z.literal("guest_local"),
  note: z.string(),
});

// ---- runs
export const CreateRunRequestSchema = z.object({
  scenarioId: z.enum(["starter", "fuel_squeeze", "oil_shock_2026"]).default("starter"),
  seed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
  mode: RunModeSchema.exclude(["replay", "challenge"]).default("guest_demo"),
  /** Optional: "calm" turns off world events and market flashes (tests, tutorials, demos of one mechanic). */
  worldMode: z.enum(["living", "historical", "calm"]).optional(),
});
export const RunStateResponseSchema = z.object({ ok: z.literal(true), state: GameStatePublicSchema });

export const ActionRequestSchema = ActionEnvelopeSchema;
export const ActionResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    stateVersion: z.number().int(),
    /** Events produced synchronously by this action (also delivered over SSE). */
    events: z.array(EconomyEventSchema),
    /** Action-specific payload, e.g. { contractId }, { quote }, { trade }. */
    result: z.record(z.string(), z.unknown()),
    /** True when this idempotency key was already processed; the original result is returned. */
    replayed: z.boolean(),
    state: GameStatePublicSchema,
  }),
  z.object({ ok: z.literal(false), error: ApiErrorSchema, stateVersion: z.number().int().optional() }),
]);

export const MarketResponseSchema = z.object({
  ok: z.literal(true),
  phase: z.string(),
  marketOpen: z.boolean(),
  world: WorldSchema,
  merchants: z.array(MerchantSchema),
  regulator: RegulatorSchema,
  quotes: z.array(QuoteSchema),
  trades: z.array(TradeSchema),
  marketListings: z.array(MarketListingSchema),
});

export const QuoteRequestSchema = z.object({
  sellerId: z.string(),
  item: MarketItemSchema,
  quantity: z.number().int().min(1).max(60_000),
  idempotencyKey: z.string().min(8).max(100),
});

export const LedgerResponseSchema = z.object({
  ok: z.literal(true),
  entries: z.array(LedgerEntrySchema),
  events: z.array(EconomyEventSchema),
  nextCursor: z.number().int().nullable(),
});

// ---- replays / observatory
export const ReplayPolicyIdSchema = z.enum(["diesel", "diversified", "gouger"]);
/** Economy Lab world conditions (fixed, reproducible event schedules) + "historical" (EIA-sourced notes). */
export const LabConditionSchema = z.enum(["calm", "disruption", "recovery", "demand_surge", "carbon_tightening", "solar_boom", "historical"]);
export const ReplayRequestSchema = z.object({
  seed: z.number().int().min(0).max(2 ** 31 - 1).default(424242),
  scenarioId: z.enum(["starter", "fuel_squeeze", "oil_shock_2026"]).default("starter"),
  policyId: ReplayPolicyIdSchema.default("diesel"),
  days: z.number().int().min(1).max(7).default(7),
  condition: LabConditionSchema.default("calm"),
});
export const ReplayDaySchema = z.object({
  day: z.number().int(),
  playerCashCc: z.number().int(),
  playerFuelMl: z.number().int(),
  permitAllowanceMg: z.number().int(),
  revenueCc: z.number().int(),
  reliabilityBps: z.number().int(),
  gdpCc: z.number().int(),
  oilIndexCenti: z.number().int(),
  merchantPrices: z.record(z.string(), z.number().int()),
  merchantStockMl: z.record(z.string(), z.number().int()),
  rivalTariffCcPerKwh: z.number().int(),
  rivalCashCc: z.number().int(),
  openBusinesses: z.number().int(),
  closures: z.array(z.string()),
  generationMixWh: z.object({ diesel: z.number().int(), solar: z.number().int(), battery: z.number().int() }),
  businessCashCc: z.record(z.string(), z.number().int()),
  merchantCashCc: z.record(z.string(), z.number().int()),
  playerCo2Mg: z.number().int(),
  importCapacityBps: z.number().int(),
  activeWorldEvents: z.array(z.object({ headline: z.string(), verification: z.enum(["fictional", "sourced"]) })),
  rivalSolarW: z.number().int(),
});
export const ReplaySummarySchema = z.object({
  replayId: z.string(),
  seed: z.number().int(),
  scenarioId: z.string(),
  scenarioVersion: z.string(),
  policyId: ReplayPolicyIdSchema,
  days: z.number().int(),
  condition: LabConditionSchema,
  source: z.literal("replay_simulation"),
  label: z.literal("SIMULATED FUTURE SCENARIO — no blockchain settlement"),
  eventCount: z.number().int(),
  /** sha256 of the normalised event + ledger trace: same seed + policy => same hash. */
  traceHash: z.string(),
  wallMs: z.number().int(),
  daily: z.array(ReplayDaySchema),
  final: z.object({
    netWorthCc: z.number().int(),
    reliabilityBps: z.number().int(),
    cityGdpCc: z.number().int(),
    closures: z.number().int(),
    score: z.number().int(),
  }),
});
export const ReplayResponseSchema = z.object({ ok: z.literal(true), replay: ReplaySummarySchema });
export const CompareRequestSchema = z.object({
  seed: z.number().int().min(0).max(2 ** 31 - 1).default(424242),
  scenarioId: z.enum(["starter", "fuel_squeeze", "oil_shock_2026"]).default("starter"),
  policies: z.tuple([ReplayPolicyIdSchema, ReplayPolicyIdSchema]).default(["diesel", "diversified"]),
  days: z.number().int().min(1).max(7).default(7),
  condition: LabConditionSchema.default("calm"),
});
export const CompareResponseSchema = z.object({
  ok: z.literal(true),
  seed: z.number().int(),
  a: ReplaySummarySchema,
  b: ReplaySummarySchema,
  differences: z.array(z.string()),
});

// ---- chain transparency
export const ChainStatusResponseSchema = z.object({
  ok: z.literal(true),
  mode: ChainModeSchema,
  network: z.string().nullable(),
  rpcUrl: z.string().nullable(),
  rpcReachable: z.boolean().nullable(),
  resourceContractId: z.string().nullable(),
  contractDeployed: z.boolean().nullable(),
  vaultAccountId: z.string().nullable(),
  merchantAccounts: z.array(z.object({ merchantId: z.string(), accountId: z.string().nullable() })),
  rivalAccountId: z.string().nullable(),
  explorerBaseUrl: z.string().nullable(),
  tokenIds: z.array(z.string()),
  trustBoundary: z.string(),
  issues: z.array(z.string()),
  /** The shared fuel exchange: where its fuel lives and whether it matches the contract. */
  exchange: z
    .object({
      mode: z.enum(["sandbox", "testnet"]),
      traderAccounts: z.array(z.object({ traderId: z.string(), name: z.string(), accountId: z.string().nullable() })),
      reconcile: z
        .object({ checkedAt: z.string(), inBalance: z.boolean().nullable(), accountsChecked: z.number(), mismatches: z.array(z.object({ label: z.string(), accountId: z.string(), expectedMl: z.number(), onChainMl: z.number() })), note: z.string() })
        .nullable(),
      note: z.string(),
    })
    .optional(),
});
export const TransferStatusResponseSchema = z.object({
  ok: z.literal(true),
  txHash: z.string(),
  status: z.enum(["confirmed", "failed", "pending", "unknown", "not_configured"]),
  explorerUrl: z.string().nullable(),
  receiverId: z.string().nullable(),
  signerId: z.string().nullable(),
  detail: z.string(),
});
export const MarketListingEvidenceResponseSchema = z.object({
  ok: z.literal(true),
  listings: z.array(z.object({
    listingId: z.string(),
    operation: z.enum(["list", "cancel", "fill"]),
    merchantId: z.string().nullable(),
    status: z.enum(["pending", "submitted", "confirmed", "failed", "timeout"]),
    txHash: z.string().nullable(),
    signerId: z.string().nullable(),
    explorerUrl: z.string().nullable(),
    lastError: z.string().nullable(),
  })),
});

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  db: z.enum(["ok", "error"]),
  chain: z.enum(["disabled", "ok", "degraded"]),
  activeRuns: z.number().int(),
  version: z.string(),
});
export const PublicConfigSchema = z.object({
  ok: z.literal(true),
  apiVersion: z.string(),
  schemaVersion: z.literal("blackout.state.v1"),
  scenarios: z.array(z.object({ scenarioId: z.string(), name: z.string(), available: z.boolean(), description: z.string() })),
  timing: z.object({
    tickMs: z.number().int(),
    ticksPerGameHour: z.number().int(),
    morningTicks: z.number().int(),
    operatingTicks: z.number().int(),
    settlementTicks: z.number().int(),
    waveIntervalTicks: z.number().int(),
    wavesPerDay: z.number().int(),
    campaignDays: z.number().int(),
    day1SkipsMorning: z.boolean(),
  }),
  pausePolicy: z.string(),
  chainMode: ChainModeSchema,
  authModes: z.array(z.string()),
  /** Present only when the server has a Supabase project configured. The anon key is public by design. */
  auth: z.object({
    guest: z.literal(true),
    supabaseUrl: z.string().nullable(),
    supabaseAnonKey: z.string().nullable(),
    google: z.boolean(),
    /** Direct Google sign-in (Google Identity Services) when set; otherwise Google goes through Supabase. */
    googleClientId: z.string().nullable().optional(),
    email: z.boolean(),
    /** Local email-code sign-in (development / self-hosted demo without Supabase). */
    local: z.boolean(),
    /** Local test mode only: the code is shown on screen instead of being emailed. */
    localShowsCode: z.boolean(),
  }),
  offlinePolicy: z.string(),
  disclaimer: z.string(),
});

export const PlayerProfileSchema = z.object({
  playerId: z.string(),
  displayName: z.string(),
  /** True once the player has named their company (only then is the name shown to other players). */
  companyNamed: z.boolean().optional(),
  kind: z.enum(["guest", "registered"]),
  loginMethod: z.string(),
  identities: z.array(z.object({ provider: z.string(), loginMethod: z.string().nullable(), lastLoginAt: z.string() })),
  activeRunId: z.string().nullable(),
  near: z.object({
    mode: z.enum(["custodial_vault", "none"]),
    accountId: z.string().nullable(),
    provisioning: z.string(),
    explanation: z.string(),
  }),
  createdAt: z.string(),
});
export const MeResponseSchema = z.object({ ok: z.literal(true), player: PlayerProfileSchema });
export const GameStartRequestSchema = z.object({
  scenarioId: z.enum(["starter", "fuel_squeeze", "oil_shock_2026"]).default("oil_shock_2026"),
  /** living (default) = real Brent + fictional local events; historical = real Brent + EIA-sourced notes only. */
  worldMode: z.enum(["living", "historical", "calm"]).default("living"),
  /** true abandons the current save and starts a new city (old save is kept read-only). */
  fresh: z.boolean().default(false),
});
export const GameStateResponseSchema = z.object({
  ok: z.literal(true),
  state: GameStatePublicSchema,
  resumed: z.boolean(),
  /** Wall-clock ms the world was paused while the player was away (0 for new games). */
  awayMs: z.number().int().nonnegative(),
});
export const LeaderboardResponseSchema = z.object({
  ok: z.literal(true),
  week: z.string(),
  condition: z.string(),
  seed: z.number().int(),
  entries: z.array(z.object({ rank: z.number().int(), displayName: z.string(), score: z.number().int(), netWorthCc: z.number().int(), reliabilityBps: z.number().int(), you: z.boolean() })),
});
export const OilResponseSchema = z.object({
  ok: z.literal(true),
  source: z.enum(["eia_live", "cached_dataset"]),
  asOf: z.string(),
  latest: z.object({ date: z.string(), usdPerBarrel: z.number() }),
  freshness: z.string(),
  attribution: z.string(),
  sourceUrl: z.string(),
  weekly2026: z.array(z.object({ weekStart: z.string(), usdPerBarrel: z.number() })),
});
export type PlayerProfile = z.infer<typeof PlayerProfileSchema>;
export type LeaderboardResponse = z.infer<typeof LeaderboardResponseSchema>;
export type OilResponse = z.infer<typeof OilResponseSchema>;
export type LabCondition = z.infer<typeof LabConditionSchema>;
export type GameStateResponse = z.infer<typeof GameStateResponseSchema>;

export type ApiError = z.infer<typeof ApiErrorSchema>;
export type StartSessionResponse = z.infer<typeof StartSessionResponseSchema>;
export type CreateRunRequest = z.input<typeof CreateRunRequestSchema>;
export type ActionRequest = z.infer<typeof ActionRequestSchema>;
export type ActionResult = z.infer<typeof ActionResultSchema>;
export type MarketResponse = z.infer<typeof MarketResponseSchema>;
export type LedgerResponse = z.infer<typeof LedgerResponseSchema>;
export type ReplayRequest = z.input<typeof ReplayRequestSchema>;
export type ReplaySummary = z.infer<typeof ReplaySummarySchema>;
export type ReplayDay = z.infer<typeof ReplayDaySchema>;
export type CompareResponse = z.infer<typeof CompareResponseSchema>;
export type ChainStatusResponse = z.infer<typeof ChainStatusResponseSchema>;
export type TransferStatusResponse = z.infer<typeof TransferStatusResponseSchema>;
export type PublicConfig = z.infer<typeof PublicConfigSchema>;
export type ReplayPolicyId = z.infer<typeof ReplayPolicyIdSchema>;

// ---------------------------------------------------------------- client
export class BlackoutApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * Minimal fetch-based client. Every response is validated with the shared schemas,
 * so a contract drift fails loudly instead of rendering wrong numbers.
 */
export function createApiClient(baseUrl: string, opts: { token?: string; fetchImpl?: typeof fetch } = {}) {
  const f = opts.fetchImpl ?? fetch;
  let token = opts.token;
  async function call<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const res = await f(`${baseUrl}${path}`, {
      method,
      credentials: "include",
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json: any = await res.json();
    if (json && json.ok === false && json.error) {
      throw new BlackoutApiError(json.error.code, json.error.message, res.status, json.error.details);
    }
    return schema.parse(json);
  }
  return {
    setToken(t: string) {
      token = t;
    },
    startSession: async () => {
      const r = await call("POST", "/api/session/start", StartSessionResponseSchema, { kind: "guest" });
      token = r.token;
      return r;
    },
    createRun: (req: CreateRunRequest) => call("POST", "/api/runs", RunStateResponseSchema, req),
    getState: (runId: string) => call("GET", `/api/runs/${runId}/state`, RunStateResponseSchema),
    act: (runId: string, req: ActionRequest) => call("POST", `/api/runs/${runId}/actions`, ActionResultSchema, req),
    market: (runId: string) => call("GET", `/api/runs/${runId}/market`, MarketResponseSchema),
    quote: (runId: string, req: z.infer<typeof QuoteRequestSchema>) =>
      call("POST", `/api/runs/${runId}/quote`, ActionResultSchema, req),
    ledger: (runId: string, cursor = 0, limit = 200) =>
      call("GET", `/api/runs/${runId}/ledger?cursor=${cursor}&limit=${limit}`, LedgerResponseSchema),
    /** SSE URL; pass token as query because EventSource cannot set headers. */
    eventsUrl: (runId: string) => `${baseUrl}/api/runs/${runId}/events${token ? `?token=${encodeURIComponent(token)}` : ""}`,
    createReplay: (req: ReplayRequest) => call("POST", "/api/replays", ReplayResponseSchema, req),
    getReplay: (id: string) => call("GET", `/api/replays/${id}`, ReplayResponseSchema),
    replayEventsUrl: (id: string) => `${baseUrl}/api/replays/${id}/events`,
    compare: (req: z.input<typeof CompareRequestSchema>) => call("POST", "/api/replays/compare", CompareResponseSchema, req),
    chainStatus: () => call("GET", "/api/chain/status", ChainStatusResponseSchema),
    marketListingEvidence: () => call("GET", "/api/chain/market-listings", MarketListingEvidenceResponseSchema),
    transfer: (hash: string) => call("GET", `/api/chain/transfers/${hash}`, TransferStatusResponseSchema),
    health: () => call("GET", "/api/health", HealthResponseSchema),
    me: () => call("GET", "/api/me", MeResponseSchema),
    startGame: (req: z.input<typeof GameStartRequestSchema> = {}) => call("POST", "/api/game/start", GameStateResponseSchema, req),
    gameState: () => call("GET", "/api/game/state", GameStateResponseSchema),
    gameAct: (req: ActionRequest) => call("POST", "/api/game/actions", ActionResultSchema, req),
    gameEventsUrl: () => `${baseUrl}/api/game/events${token ? `?token=${encodeURIComponent(token)}` : ""}`,
    linkGuest: (guestToken: string) => call("POST", "/api/auth/link-guest", MeResponseSchema, { guestToken }),
    logout: () => call("POST", "/api/auth/logout", z.object({ ok: z.literal(true) }), {}),
    leaderboard: () => call("GET", "/api/challenge/leaderboard", LeaderboardResponseSchema),
    oil: () => call("GET", "/api/world/oil", OilResponseSchema),
    config: () => call("GET", "/api/config/public", PublicConfigSchema),
  };
}
export type BlackoutApiClient = ReturnType<typeof createApiClient>;
