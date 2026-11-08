# Test report — 2026-11-08

| Suite | Command | Result |
|---|---|---|
| Engine + economy (vitest) | `pnpm test` | **65 passed** (incl. API, auth, chain worker, SSE below) |
| NEP-245 contract (Rust) | `pnpm test:contract` | **19 passed** (includes escrow primitive tests) |
| Browser journeys (Playwright, Chromium) | `pnpm test:e2e` | **7 passed** (6 desktop + 1 Pixel 7), after aligning selectors to the current intro, market and replay UI |
| Type check | `pnpm typecheck` + `apps/web` tsc | clean |
| Contract WASM build | `pnpm build:contract` | passed with plain Cargo fallback; `cargo-near` absent, so Testnet compatibility not verified |
| Container | `docker build` + run | health, web at `/`, SPA fallback, JSON 404, guest session, JSON logs ✓ |
| Log redaction | inject request with bearer + cookie | 0 secret occurrences in logs ✓ |

## What the suites cover
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
