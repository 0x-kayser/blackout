# BLACKOUT — Every Light Changes the Economy

A persistent browser game for the NEAR Hackathon **Games With Real Economies** track. The grid keeps failing. You start
with one diesel set behind a shop and grow into the company that powers the whole city: you buy fuel, build plants,
run substations and feeders into seven districts, and win customers from VoltLine, your rival. Fuel comes from
NPC traders with their own NEAR wallets, and every player's city buys from the same traders on one shared exchange,
so one city's appetite moves everyone's prices.

> **Honesty box.** Credits are imaginary, non-redeemable game currency. Electricity, customers and city NPC
> decisions are simulated on our server and reproducible from a seed. The NEP-245 contract, NPC trader wallets and the
> exchange's Testnet settlement are built and tested locally (Rust unit tests + fake-RPC integration tests); **they
> are live only after you run the bootstrap with your own funded Testnet account** (see
> [`docs/SHARED_EXCHANGE_PLAN.md`](docs/SHARED_EXCHANGE_PLAN.md) → "Your steps to go live"). Google sign-in needs your
> Supabase project; email codes work locally out of the box.

## Play it locally

```bash
pnpm install
```
```bash
AUTH_LOCAL_EMAIL=true AUTH_LOCAL_EMAIL_SHOW_CODE=true pnpm dev
```
Open **http://localhost:5173** → *Play now* (or *Continue with email*: on localhost the 6-digit code is shown on screen).
API on :8787; Vite proxies `/api`. Node ≥ 22.5, pnpm 10.

Production-style single container (API serves the built app on one origin):
```bash
docker build -t blackout . && docker run -p 8787:8787 -v blackout-data:/data -e COOKIE_SECURE=false -e WEB_ORIGINS=http://localhost:8787 blackout
```

## What you do
* **Every 30 seconds: sell power.** A business goes dark and calls you: kW, hours, price, your margin after diesel
  and carbon. Accept, haggle twice or decline; wait and VoltLine takes the customer. 🚨 **Code Red** calls pay double
  with a 7-second timer and cost reputation if missed. Tap a generator and the street lights up; you're paid per kWh
  delivered.
* **Every few minutes: run the business.** Keep diesel in the tank while prices move with each merchant's stock and
  real 2026 Brent oil. Sell spare fuel to other cities on the **Vesper Fuel Exchange** at your price (it sells while
  you're away), or buy when the board is cheaper than your town.
* **As you grow: build the grid.** Every district is fed through a substation. A feeder only carries so much: upgrade
  substations to take bigger customers, and remember longer feeders lose energy (more diesel per kWh). Add plants:
  a second set, a 20 kW diesel plant, rooftop solar, a 10 kW solar farm, battery banks, a fuel terminal.
* **Progress is the business, not the calendar.** Five company stages (Street Generator → Neighbourhood Utility →
  District Utility → City Utility → Grid Operator) are earned by energy delivered, districts connected and capacity
  installed. Each stage opens districts and plant types and brings a City Council grant; VoltLine grows with you.
* **Every shift (4 minutes): three goals** with Council rewards and a streak worth up to +50%.
* **The market never sits still.** Every few seconds a market flash can hit: tanker queues, merchant price wars, heat
  spikes, night markets, carbon audits, panic buying, port strikes, solar clearance sales, convoys, rush orders,
  rain and holiday lulls. Merchants reprice, traders shift their asks every 5 s, and each wave every town hears the
  traders' latest premium.
* **44 buildings across seven districts, each run by a named person** (Tunde's Cold Room, Mayor Adaeze's City Hall,
  Big Joe's steelworks…). The **People** panel shows everyone, including every NPC wallet and its balances.
* **The bar under the map always says your next move.**

## Why players come back
* Exchange offers keep selling while you're offline; you return to "while you were away you sold 20 L for ₡262".
* Streaks are on the line every shift.
* The next stage is always in view, with exactly what it unlocks.
* The world keeps moving: real oil prices, fictional storms and supply shocks, and other players draining or
  restocking the traders.

## How this meets the track
| Track ask | In BLACKOUT |
|---|---|
| **NPCs with wallets** | Six exchange traders, each a named character with its own strategy (Ingrid Halvorsen's Harbor Import Terminal, Bayo Northcott's Northline Haulage, Old Man Kettle, Dayo Swift's Swift Tankers, Chioma Okafor's hoarding family firm, Professor Brandt's Greenline Fuel Fund), each with its own Testnet account and function-call key that the contract only lets act for itself. They hold finite on-chain diesel and a credit budget, price from one readable rule file, import with lead times, ration at their reserve, buy cheap player offers, **and supply every player's town merchants**, so their wallets drive every city's fuel prices. |
| **Player-owned markets** | The shared exchange: your warehouse, your price, your offers, sold to other players and traders across all cities. And your own power company: you set the tariff and compete for customers. |
| **Economies that evolve without a dev patch** | Merchant restocks drain trader wallets → traders raise asks → every town's import premium rises (a recorded, replayable signal) → retail diesel follows. Businesses struggle, switch to VoltLine or close; districts grow when served well. The rival reprices from what it paid. |
| **Judged on the game loop** | 30-second calls, minute-scale fuel and trading, stage-scale grid building, shift goals and streaks. |
| **Bonus: players never notice the chain** | No wallet, seed phrase, gas or pop-up anywhere in play. Chain proof lives in the optional Verify panel. |
| Lean on: NEP-245 | One multi-token contract: player warehouses, offer escrow, trader stock, imports, town supply, self-custody release. |
| Lean on: social login | Continue with Google (Supabase) and email codes that work on any device; guest cities move into the account. |
| Lean on: agent NPCs | Rule-based economic agents with explainable decisions (every price shows its reasons). |
| Lean on: NEAR Intents | Not used: optional, no testnet, and the game's assets are custom NEP-245 tokens. |

## What's live vs configured
| Feature | Status |
|---|---|
| The game: calls, Code Red, contracts, grid (stages, substations, feeders, losses, 7 districts, 7 plant/storage upgrades), merchants, rival, regulator, goals and streaks, story | **works** (unit, integration and Playwright tests) |
| Vesper Fuel Exchange (warehouse, offers, buys, trader NPCs, town supply, price signal) | **works in sandbox mode** locally; Testnet settlement path built and fake-RPC tested |
| NEP-245 contract (exchange, traders, supply, self-custody) | 30 Rust tests; WASM builds; **deploy with `pnpm chain:bootstrap`** |
| Email sign-in | **works locally** (code on screen); production uses Supabase |
| Google sign-in | code complete; **needs your Supabase project + Google OAuth client** |
| Economy Lab (deterministic 7-day fast-forward, compare, ledger) | **works** |

## Commands
| | |
|---|---|
| `pnpm dev` | API + web (hot reload) |
| `pnpm test` | 107 TS tests (engine, grid, goals, exchange, API, auth, chain workers, SSE) |
| `pnpm test:e2e` | 8 Playwright browser journeys incl. a two-player exchange trade (builds the app, runs the API on one origin) |
| `pnpm test:contract` | 30 Rust contract tests |
| `pnpm typecheck` | type check (also `cd apps/web && npx tsc --noEmit`) |
| `pnpm build` | production web build into `dist/` |
| `pnpm db:migrate` | apply `database/migrations` |
| `pnpm sim:replay --seed 424242 --policy diesel --days 7 --scenario oil_shock_2026` | deterministic fast-forward in the terminal (`--policy diversified`, `--ledger`, `--out trace.json`) |
| `pnpm build:contract` / `pnpm chain:bootstrap` | NEAR testnet setup (see docs) |

## Verify the chain (after `pnpm chain:bootstrap`)
Play normally: nothing in the game asks about wallets. Open the optional **Verify** panel to see the contract, the
vault, each trader's account and your exchange id, every deposit / offer / sale / delivery hash, and whether the
exchange's books match the contract (`mt_balance_of` per account, checked every minute). `GET /api/chain/status`
returns the same. Local fake-RPC tests are not live evidence. Steps: [NEAR_TESTNET_SETUP.md](docs/NEAR_TESTNET_SETUP.md)
and [SHARED_EXCHANGE_PLAN.md](docs/SHARED_EXCHANGE_PLAN.md).

## Engine facts
1 tick = 1 s = 6 game minutes; a shift (24 game hours) = 240 ticks. Energy/tick = W/10 Wh; diesel = 0.3 mL per Wh; CO₂ = 2680 mg per mL;
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
