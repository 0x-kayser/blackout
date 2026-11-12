# Test report — 2026-11-11

Run on Windows 11, Node 24, pnpm 10.33.4, against upstream `main` at `9b29530` plus the local story edits.

| Suite | Command | Result |
|---|---|---|
| Unit + integration (vitest) | `pnpm test` | **206 passed**, 22 files |
| Type check | `pnpm typecheck` | clean |
| Browser journeys (Playwright, Chromium) | `pnpm test:e2e` | **14 tests** (12 desktop + 2 mobile); the last run had 13 passing and one stale test, now fixed (it clicked a "Verify" button that the player UI no longer has). The "Watch a week" test timed out once in a full run on a slow machine and passes on its own. |
| NEP-245 / NEP-171 contract (Rust) | `pnpm test:contract` | **not run in this pass** (no Rust toolchain on the test machine). The source has 54 `#[test]` functions across `tests.rs`, `economy_tests.rs` and `plant_tests.rs`. |
| Web build | `pnpm build:web` | passes; Vite warns about chunks over 900 kB (the lazy 3D scene) |
| Live NEAR Testnet | n/a | not exercised here; see [NEAR_TRACK_COMPLIANCE.md](NEAR_TRACK_COMPLIANCE.md) |

Windows notes: `playwright.config.ts` uses POSIX shell syntax (`rm -f`, inline `VAR=x`), so on Windows start the API
yourself and point Playwright at it. The API entry guard in `apps/api/src/server.ts` now uses `pathToFileURL`, which
fixed a silent exit on Windows paths.

## Vitest files
| Area | Files (tests) |
|---|---|
| Region engine | `region/region.test.ts` (17), `region/market.test.ts` (6) |
| Town market | `town/town.test.ts` (15), `town/firms.test.ts` (9) |
| City engine and economy | `engine.test.ts` (21), `economy.test.ts` (18), `goals.test.ts` (4), `grid.test.ts` (6), `marketplace.test.ts` (4) |
| Fuel exchange engine | `exchange.test.ts` (14) |
| API integration | `region` (19), `economy` (18), `exchange` (12), `api` (10), `auth` (8), `chain` (8), `relay` (6), `google` (4), `local-auth` (2), `plants` (2), `signin-first` (1) |
| Server-sent events | `e2e/sse.test.ts` (2) |

## What the older city-mode suites cover (still true; the region and town suites above are newer)
**Unit (packages/sim):** starting kit; 0.3 L/kWh and 2.68 kg/L (32 kWh → 9.6 L → 25.728 kg); Cold Room tutorial exact
accounting; continuous clock (rollover every 240 ticks, 8 waves/day, no phase stops, contracts cross midnight, market
open mid-day); tutorial patience and lapse; capacity across overlapping contracts (`CAPACITY_EXCEEDED`, no fuel
burned); fuel/permit reservation; permit hard cap mid-contract; cancel refunds only unearned escrow; counters max 2;
request expiry; heat → breakdown → refunds; day-1 no heat; purity of `nextState`/`applyAction`/`tick`; ledger sums to 0
and no negative private balances; Cold Room ±margins; closure by cash rule not by day; merchant price up/down on
scarcity/surplus/demand/oil; explanation equals inputs; co-op hoarding/rationing; last-litre race; stale quotes;
chain-leg compensation exactly once; tank and credit limits; regulator supply; restock with cash/capacity/lead time;
insolvency and recovery; rival feasibility and repricing; solar zero at night; battery never creates energy;
deterministic replay hash; policy divergence; gouger loses customers.

**Integration (apps/api):** owner scoping; paused-until-connected; Cold Room over HTTP; idempotent retries; STALE_STATE;
oversize/system-action/foreign-origin rejection; market quote/buy/expiry; crash recovery (byte-identical state, no
duplicate events); replays deterministic + labelled; honest disabled chain status; **auth**: JWT verification (wrong
issuer/audience/signature/expiry rejected), one player per identity, client cannot pick player id, save/restore across
"restart", offline pause (no fuel burned while away), guest upgrade, never overwrite an existing account, logout.
**Chain worker (fake RPC):** confirm once with real hash, definitive failure compensates once, unknown reconciles
without re-broadcast, crash after signing reconciles without re-signing, guest runs never create jobs, receipt-failure
parsing. **SSE (real socket):** ids, Last-Event-ID resume, unauthorised rejection.

**Browser (Playwright):** guest tutorial → power restored → credits increase; reload → same city, one contract, live;
market purchase → stock falls, price changes, "game ledger" label; install solar → appears in plant, credits debited;
Economy Lab same seed → same hash, 8 charts; mobile → controls reachable, no horizontal overflow.

## Not tested (and why)
| Journey | Reason |
|---|---|
| Real Google / email sign-in | no Supabase project credentials (verification code tested with local JWKS) |
| Real NEAR testnet transfer + balance check | no funded testnet account; contract deployment pending |
| Production URL | no host account |
| 1024 px tablet | checked visually only (layout breakpoint), no automated test |
