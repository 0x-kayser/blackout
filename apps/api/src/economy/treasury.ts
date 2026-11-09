/**
 * The treasury plan: how much money exists and who it is for. Used by the bootstrap (to call `init_economy`) and by
 * the server (to know what each grant should be). Amounts are in cc, the contract's unit: 1 cc = ₡0.01.
 *
 * Sizing (from the game's own numbers, not round guesses):
 *   - a new company starts with STARTER_GRANT_CC = ₡300,000 (region config). 500 companies = ₡150 million.
 *   - the nine Vesper Market merchants start with ₡375,000 between them; the three power companies with ₡950,000.
 *     NPC capital is capped at ₡6 million: room to fund a second season of companies, never to bail anyone out.
 *   - the grid clearing account pays players for the electricity their regions' homes and businesses buy, and is
 *     paid back when players build, maintain and pay for energy. A busy player nets roughly ₡50k–₡200k a game day,
 *     so the city budget is ₡1.2 billion, released to the clearing account in tranches as it runs low.
 *   - the outside world (importers, outside customers, aluminium buyers, the water utility) needs a float to pay
 *     Vesper's merchants and companies before it is paid back for imports: ₡300 million, also in tranches.
 *   - the rest is a reserve nobody can spend until the owner moves it into a bucket with `issue`-style governance.
 * Total ₡2 billion (200,000,000,000 cc). The contract allows at most ₡500 million more in its lifetime (`issue_cap`).
 */
import { region, town } from "@blackout/sim";

export const STARTER_GRANT_CC = region.regionConfig.STARTER_GRANT_CC;

export const TREASURY_PLAN = {
  totalSupply: 200_000_000_000,
  issueCap: 50_000_000_000,
  buckets: [
    { name: "city", cap: 120_000_000_000, maxPerGrant: 5_000_000_000, oncePerAccount: false },
    { name: "world", cap: 30_000_000_000, maxPerGrant: 2_000_000_000, oncePerAccount: false },
    { name: "npc", cap: 600_000_000, maxPerGrant: 60_000_000, oncePerAccount: true },
    { name: "players", cap: 15_000_000_000, maxPerGrant: STARTER_GRANT_CC, oncePerAccount: true },
    { name: "reserve", cap: 34_400_000_000, maxPerGrant: 0, oncePerAccount: false },
  ],
} as const;

/** One tranche from the city budget to the grid clearing account, and from the world bucket to the world account. */
export const GRID_TRANCHE_CC = 2_000_000_000;
export const WORLD_TRANCHE_CC = 1_000_000_000;
/** Top a float up when it falls below this share of a tranche. */
export const TOPUP_BELOW_BPS = 3_000;

/** Every NPC with its own NEAR account: the nine merchants and the three power companies. */
export const NPC_IDENTITIES: { id: string; name: string; kind: "merchant" | "company"; startCc: number; signs: boolean }[] = [
  ...town.townConfig.MERCHANTS.map((m) => ({ id: m.chainName, name: m.name, kind: "merchant" as const, startCc: m.cashCc, signs: false })),
  ...town.FIRMS.map((f) => ({ id: f.chainName, name: f.name, kind: "company" as const, startCc: f.cashCc, signs: true })),
];

/** Spending limits the contract enforces on each company's own key (per payment, per UTC day). */
export const NPC_LIMITS = { maxPerPaymentCc: 3_000_000, maxPerDayCc: 40_000_000 };

{
  const sum = TREASURY_PLAN.buckets.reduce((a, b) => a + b.cap, 0);
  if (sum !== TREASURY_PLAN.totalSupply) throw new Error(`treasury buckets add up to ${sum}, not ${TREASURY_PLAN.totalSupply}`);
}
