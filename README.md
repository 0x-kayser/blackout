# BLACKOUT — Every Light Changes the Economy

A persistent browser game for the NEAR Hackathon **Games With Real Economies** track. You run a small power company in a
city whose grid keeps failing. Shops go dark and ask you for electricity at a price; you accept, haggle or decline,
route the load onto a generator and watch the street light up. What you charge and how reliably you deliver decides
whether those shops make money — which decides tomorrow's demand. Three fuel merchants, a rival power company and a
carbon regulator make their own decisions from their own stock, cash and policies.

> **Honesty box.** Credits are imaginary, non-redeemable game currency. Electricity, customers and NPC decisions are
> simulated on our server and are reproducible from a seed. **NEAR testnet is not deployed** and Google/email sign-in
> is not connected to a Supabase project. The player-owned exchange currently has contract escrow primitives only;
> its game API, NPC listing decisions and interface are not implemented. There are no real contract IDs, account IDs
> or transaction hashes in this repo.

## Play it locally (no accounts, no keys)

```bash
pnpm install
```
```bash
pnpm dev
```
Open **http://localhost:5173** → *Play now*. (API on :8787; Vite proxies `/api`.) Node ≥ 22.5, pnpm 10.

Production-style single container (API serves the built app on one origin):
```bash
docker build -t blackout . && docker run -p 8787:8787 -v blackout-data:/data -e COOKIE_SECURE=false -e WEB_ORIGINS=http://localhost:8787 blackout
```

## Why the economy *is* the gameplay
* Shops earn only while powered, from a bounded pool of outside shoppers (the only money entering the city). They pay
  wages, stock, grid power, your bill and rent. Overcharge or fail them and they struggle, switch to the rival or close
  — and your demand shrinks. Serve them fairly and the district's activity grows.
* Merchants hold finite stock and real cash, price from **one readable file**
  ([`merchantPricing.ts`](packages/sim/src/policies/merchantPricing.ts)), restock from an importer with lead time and
  cash limits, ration when oil rises, can go broke and recover. Buy a seller's cheap stock and its next quote rises —
  the tooltip shows the exact numbers.
* The rival has its own plant, fuel, permits, cash and an adaptive margin; it only takes customers it can physically
  serve, and reprices from what it actually paid for fuel.
* The regulator's permit price reacts to everyone's emissions. Diesel cannot run without allowance.
* Only the outside world is scripted: real 2026 Brent prices (weekly, cached, sourced) and the permit-cap schedule.

## How it plays
* **Every 30 seconds** an outage: a request card (kW, hours, price, what it pays you, what it costs you in diesel and
  CO₂, your margin and theirs). Accept/counter/decline → tap a generator → the building lights up when the server
  confirms the first delivered tick. The first three requests are a gentle untimed tutorial.
* **Continuously:** buy fuel and permits, install solar/battery/a second generator, set tariffs, service generators,
  unlock Hospital Row and the Tech Hub. Day and night change light and solar output but never stop play. Leave and the
  city pauses; come back and it resumes exactly where you were.
* **Economy Lab:** simulate a week with two strategies on the same seed in under a few seconds; charts, a 60-second
  playback and a downloadable event ledger. Same seed + strategy = same trace hash.

## What's live vs configured vs not built
| Feature | Status |
|---|---|
| Guest play, saves, resume, offline pause | **works** (tested in browser + Playwright) |
| Continuous city, contracts, fuel/CO₂/credits accounting, merchants, rival, regulator, upgrades, districts | **works** |
| Economy Lab (deterministic 7-day replay, compare, ledger download) | **works** |
| Google / email sign-in (Supabase, PKCE, JWKS verification), guest → account upgrade | code implemented; local auth tests pass; **needs `SUPABASE_URL` + `SUPABASE_ANON_KEY` for provider verification** |
| X sign-in | **deferred** — X API access is no longer free for new developers; no button shown |
| NEP-245 resource contract (diesel, permits, parts) | local WASM build; 19 Rust tests; **not deployed** |
| Player listing escrow | contract methods tested; **not connected to player API/UI or NPC decision loop** |
| Real testnet diesel transfers from merchant NPC accounts to the game vault | code path tested against fake RPC; **not live-verified; needs credentials, funding and bootstrap** |
| Public URL | container built and smoke-tested; **no host yet** |
| Generator NFTs (NEP-171), hedging, LLM dialogue, residential district | not built |

**On-chain (when configured):** diesel purchases are NEP-245 `npc_transfer`s signed by the merchant's scoped
function-call key into a **custodial game vault** (players hold no keys; the per-player split is the game DB).
**Off-chain:** credits, electricity, customers, NPC decisions, permits, the rival's trades. The purchase is not atomic
across both: credits are reserved in the game ledger and settled or refunded exactly once from a verified RPC outcome.

## Commands
| | |
|---|---|
| `pnpm dev` | API + web (hot reload) |
| `pnpm test` | 65 TS tests (engine, API, auth, chain worker, SSE) |
| `pnpm test:e2e` | 7 Playwright browser journeys (builds the app, runs the API on one origin) |
| `pnpm test:contract` | 19 Rust contract tests |
| `pnpm typecheck` | type check (also `cd apps/web && npx tsc --noEmit`) |
| `pnpm build` | production web build into `dist/` |
| `pnpm db:migrate` | apply `database/migrations` |
| `pnpm sim:replay --seed 424242 --policy diesel --days 7 --scenario oil_shock_2026` | deterministic fast-forward in the terminal (`--policy diversified`, `--ledger`, `--out trace.json`) |
| `pnpm build:contract` / `pnpm chain:bootstrap` | NEAR testnet setup (see docs) |

## Verify an NPC transfer (after chain setup)
Play → Market → buy diesel → the purchase shows "Settling on NEAR testnet…" until final → "verified on NEAR" links to
the explorer. The **Verify** panel lists the contract, vault and merchant account ids from `/api/chain/status`;
`GET /api/chain/transfers/<hash>` re-checks a hash against the RPC. Steps: [NEAR_TESTNET_SETUP.md](docs/NEAR_TESTNET_SETUP.md).

## Engine facts
1 tick = 1 s = 6 game minutes; day = 240 ticks. Energy/tick = W/10 Wh; diesel = 0.3 mL per Wh; CO₂ = 2680 mg per mL;
permit = 10 kg. All quantities are integers (credits in cents, W, Wh, mL, mg); billing uses a cumulative floor so it
never exceeds delivered energy. Every asset sits in a double-entry ledger that always sums to zero.
More: [ECONOMY_RULES.md](docs/ECONOMY_RULES.md).

## Docs
[Architecture](docs/ARCHITECTURE.md) · [API contract](docs/API_CONTRACT.md) · [Auth decision](docs/AUTH_PROVIDER_DECISION.md) ·
[Economy rules](docs/ECONOMY_RULES.md) · [Security](docs/SECURITY.md) · [NEAR setup](docs/NEAR_TESTNET_SETUP.md) ·
[Chain evidence](docs/CHAIN_EVIDENCE.md) · [Deployment](docs/DEPLOYMENT.md) · [Integration report](docs/INTEGRATION_REPORT.md) ·
[NEAR track compliance](docs/NEAR_TRACK_COMPLIANCE.md) · [Test report](docs/TEST_REPORT.md) · [Implementation audit](docs/IMPLEMENTATION_AUDIT.md) · [Decisions](docs/DECISIONS.md)

## Libraries and prior work
TypeScript, React 19, Vite 7, Zod 4, Fastify 5, `node:sqlite`, jose, @supabase/supabase-js, near-api-js 7, near-sdk-rs
5.30, Vitest, Playwright. Brent data: U.S. EIA via FRED (`DCOILBRENTEU`). Visual language from the frontend workstream's
first pass. No templates or pre-hackathon code. Design source: *Blackout: Game Loop Design* (2026-11-07).

## License
MIT — see [LICENSE](LICENSE).
