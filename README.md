# BLACKOUT — Every Light Changes the Economy

A regional power-system strategy game for the NEAR Hackathon **Games With Real Economies** track. You run a power
company in the Vesper region: seven load centres, six transmission lines, a gigawatt of demand and never quite enough
cheap generation. Every five game minutes a real merit-order market clears. When supply runs short, prices spike,
customers switch off, then the lights go out — and businesses with real balance sheets lose money, lay people off
and close. You decide what runs, what gets built, where, and with whose money.

> **Honesty box.** Credits are imaginary, non-redeemable game currency. The simulation (market, plants, businesses,
> suppliers, banks, VoltLine) runs on our server and is reproducible from a seed. Weather comes live from Open-Meteo;
> Brent from EIA (live with a key, bundled dataset without); gas and carbon are labelled reference values unless you
> configure a live source. The NEAR contract (NEP-245 resources incl. `credit:vesper`, NEP-171 Plant Assets with
> plant accounts, settlement epochs) and the NEP-366 relayer are built and tested locally; **they are live only after
> you deploy with your own funded Testnet account** (`pnpm chain:bootstrap`). Nothing in this repository claims a
> deployment that hasn't happened.

## Play it locally
```bash
pnpm install
```
```bash
AUTH_LOCAL_EMAIL=true AUTH_LOCAL_EMAIL_SHOW_CODE=true pnpm dev
```
Open **http://localhost:5173**. The first page has two buttons: **▶ Play as guest** (one tap and you're in the
region) or **Sign in** with Google or an email code, so your company follows you to any device. A guest can sign in
later from ⚙︎ → Account and keep everything. Returning players skip the title and land back in their region. The
original city game is still playable at **/city**. Node ≥ 22.5, pnpm 10. Set `WORLD_INPUTS=off` to skip live weather.

## How you learn it: by playing
There is no manual and no menu. The first minute is three taps on glowing buttons in the world; the clock waits for
you, then runs just long enough to show what your tap did.

| You see | You tap | What happens |
|---|---|---|
| Dusk. One district, Residential East, sits dark inside a pulsing red ring: *LIGHTS OUT*. | **⚡ Send power** on your battery | Its windows light up again; your cash starts rising. |
| *The region is short of power.* | **▶ Start turbine** on your gas turbine | It spins up, smokes, and earns on every megawatt. |
| *Your battery won't last all night.* | **+ Build diesel plant** on the glowing pad | A plant starts rising in Residential East. |

Then the full game opens: the System Pulse (demand, available, reserve, spot price, cash), the dock (DISPATCH,
BUILD, MARKET, GRID, PORTFOLIO) and one line at the bottom that always names the most useful next move, with a
button that does it ("Residential East is dark → ⚡ Discharge Eastside Battery", "Power sells for ₡250 and Kestrel
makes it for ₡63 → ▶ Start", "Eastside Line is full → Upgrade"). Tap anything in the world to see what it is and why
its price is what it is. **What happened** tells the region's story, cause by cause, in the words of the people in it.

## The brief, requirement by requirement
| The brief asks | In BLACKOUT |
|---|---|
| Players gather materials and trade with NPC merchants | Your solar earns **renewable certificates**; your plants burn **gas and diesel**, surrender **carbon permits**, need **steel** to build and **turbine kits** to repair. You buy and sell all six at Vesper Market. |
| Each merchant is an agent with its own wallet and inventory | Nine merchants, each with cash, stock, rent, imports and outside customers, shown on its stall and in its shop (and, on Testnet, its own account). |
| Prices from stock and recent demand | `stock factor × demand factor × margin`, recalculated every tick |
| Flood the market and it gets cheap | Sell certificates and Lena's price falls for every player; buy gas and it rises for everyone |
| A broke merchant closes until someone invests | Shops close when cash runs out; **Invest** reopens them and pays you a share of profits daily |
| Items are NEP-245, one contract | `fuel:natural-gas`, `fuel:diesel`, `permit:carbon`, `certificate:renewable`, `material:steel`, `part:turbine`, `credit:vesper` in one contract; market epochs settle each one (`settle_items`) |
| Social/email login, no seed phrases, popups or gas | The first page offers guest play, Google or an email code; the relayer pays gas; no chain words in play |
| Pricing rules in one readable file, reasoning in a tooltip | [`merchantPricing.ts`](packages/sim/src/town/merchantPricing.ts); hover any price. Outside events live in [`news.ts`](packages/sim/src/town/news.ts) and show up in the same tooltip |
| Fast-forward a week in a minute | **⏩ Watch a week** in MARKET: seven market days, four bot companies, 60 seconds |
| Game loop on paper first | [docs/GAME_LOOP.md](docs/GAME_LOOP.md) |
| Multiple players | Every player trades with the same merchants; their trades show in the live feed and move your prices |

## Vesper Market
Nine stalls in the middle of the region: Ingrid and Bayo (gas), Kettle, Dayo and Chioma (diesel), Lena (renewable
certificates), Ruth (carbon permits), Pavel (steel) and Nkechi (turbine kits). Tap a stall: its wallet, stock, buy
and sell prices with the reasoning, recent trades, investors, and buttons to trade or invest. MARKET shows them all
plus what you hold and a live feed of who's trading.

**The news moves the market.** About once a minute a story breaks outside Vesper: an LNG tanker stuck in fog, Henry
Hub up 18%, a cold snap, a drivers' strike, a sunny week flooding Lena with certificates, a steel strike, a turbine
recall. Each story multiplies a real flow (a merchant's imports, its outside customers, its outside suppliers or the
outside reference price) for a couple of minutes; it never sets a price. Stock and demand move, the pricing rule does
the rest, and the price tooltip names the story. A ticker under the top bar shows each running story with the price
it is moving (*Steelworkers strike at the port · ₡344 ▲20%*). Gas and diesel prices then flow into every region, so a
delayed tanker shows up in your evening power price. The stories and their exact effects are in
[`news.ts`](packages/sim/src/town/news.ts).

**The region never goes quiet.** Random trips, storms and supply cuts still happen, and once the first minute is over
an incident desk guarantees one at least every 2½ minutes: a storm front (solar drops), a heatwave (demand rises), a
breakdown at a rival's plant (supply drops and prices jump), or a fuel supplier's imports cut. Each moves the market
through the same physics and appears in **What happened** with its causes. It is seeded, so every challenge player
lives through the same story.

## The game
* **Market (§6–7).** Pure deterministic clearing (`packages/sim/src/region/market.ts`): `GenerationOffer`s and
  `LoadBid`s, welfare-maximising min-cost flow over a radial network (so flows are exact DC flows), nodal prices from
  the residual graph, price cap ₡5,000. Demand response comes before shedding; the hospital is shed last.
* **Generation (§5).** OCGT, CCGT (slow start, 40% minimum), diesel peaker, solar (sun × cloud × heat), batteries
  (state of charge, 93.8% each way, wear per cycle). Marginal cost = fuel × heat rate + variable O&M + carbon; ramp
  limits; forced outages; heat derating; fuel inventory limits output.
* **Actors (§8, §12).** Twelve businesses and households with cash, debt, employees, production and health; wages flow
  to households, whose income drives commerce. VoltLine adapts its margin, pays debt, pays dividends, invests when
  prices stay high, sells and mothballs plants in distress. Six fuel suppliers import, price by scarcity and ration.
  Two banks lend on leverage. The regulator caps offers during shedding, fines idle fuelled capacity and funds
  reliability tenders from carbon revenue. Steel output sets construction costs. Nobody is bailed out.
* **Money (§13–14).** A genesis treasury funds every opening balance and your one-time starter grant; a double-entry
  ledger keeps credits, gas and diesel summing to zero.
* **Progression.** Licences (Independent Generator → Regional Producer → System Partner → Grid Anchor) unlock bigger
  plants by energy delivered and regional reliability; tenders, asset sales and the weekly leaderboard.

## NEAR: the money is real, the chain is invisible
Full write-ups: [architecture](docs/NEAR_ARCHITECTURE.md) · [economy model](docs/ECONOMY_MODEL.md) ·
[wallets and treasury](docs/WALLET_AND_TREASURY.md) · [transaction flows](docs/TRANSACTION_FLOWS.md) ·
[testnet demo](docs/TESTNET_DEMO.md).

| Piece | What it is | Where |
|---|---|---|
| Money | `credit:vesper` (the game's ₡, 1 unit = ₡0.01) in one NEP-245 contract with every item; **fixed supply** minted once into a treasury split into capped buckets; `issue` owner-only and capped for life | `contracts/near/src/economy.rs`, `apps/api/src/economy/treasury.ts` |
| Player wallets | a real NEAR account per signed-in player, created once, key encrypted on the server; starting capital ₡300,000 from the treasury, once per account | `apps/api/src/economy/service.ts`, `wallets.ts` |
| NPC wallets | each merchant and power company its own account; the companies sign their own purchases with function-call keys, bounded per payment and per day, with kill switches | bootstrap, `power_order_place` |
| NPC power companies | Halvard Aluminium, Solara Energy, Northwind Gas Power decide every 3 market hours from their cash, the weather, gas prices and offers | `packages/sim/src/town/firmPolicy.ts`, `firms.ts` |
| Power-delivery escrow | the buyer escrows, the player's grid delivers (measured), the operator confirms, the seller is paid for what arrived | `power_order_place` / `power_order_confirm`, region `export:` loads |
| Settlement | market and region epochs in atomic multi-token batches; nothing per tick | `settle_batch`, `EconomyService.queueSettlement` |
| Ownership | each player's plants minted as NEP-171 Plant Assets to their wallet, moved out when sold | `plants.rs`, `EconomyService.syncPlants` |
| Reliability | every chain operation once (`chain_ops`), hash recorded before broadcast, `FINAL` required, unknown outcomes reconciled by reading the contract | `gateway.ts`, `service.ts` |

**Status: live on testnet.** Contract [`vesper-econ.blackout-kay.testnet`](https://testnet.nearblocks.io/address/vesper-econ.blackout-kay.testnet);
a run on 2026-11-09 settled 40 transactions, including NPCs paying a player for power with their own keys and an NPC
buying from another NPC ([evidence](docs/TESTNET_DEMO.md#evidence-table)). Reproduce with `pnpm chain:economy`, then
`pnpm chain:demo`.

**Not done:** player-to-player equipment sales in the game (the contract's atomic `plant_buy` exists), a key-export
screen for self-custody, wallets for guests (they get one when they sign in), NEAR Intents.

## How this meets the track (§64)
* **Games With Real Economies (primary):** prices, wages, debt, closures and construction costs all emerge from
  actors' own rules; scarcity is real and nobody prints money.
* **NFTs That Do Something (secondary):** a Plant Asset *is* the plant — its account earns, holds fuel and credits,
  and control moves with the token.
* **Agent Economy:** the NPCs decide autonomously in simulation; on-chain they are accounts with scoped keys, not
  autonomous on-chain agents. We don't claim more.

## What's live vs configured
| Feature | Status |
|---|---|
| Regional game: market, plants, actors, events, world inputs, 3D client, persistence, weekly challenge, Economy Lab | **works** (Vitest, Playwright) |
| Live weather (Open-Meteo) | **works** with network; falls back to the last saved snapshot |
| Contract: treasury, escrow, batch settlement, Plant Assets, every item token | 53 Rust tests; **deployed** to `vesper-econ.blackout-kay.testnet` |
| Economy service: wallets, NPC orders, settlement, reconciliation | 9 integration tests; **ran live on testnet** (40 final transactions); the dev server uses it once `.env.economy` is in its env |
| NPC power companies and the power desk | **works** off chain (9 sim tests); visible in MARKET and in Watch a week |
| Email sign-in | works locally (code on screen); production uses Supabase |
| Google sign-in | code complete; needs your Supabase project and Google OAuth client |
| Classic city game + shared fuel exchange | still works at `/city` |

## Demo script (§65, 3 minutes)
1. Open the game: **▶ Play as guest** (or sign in). The crisis is already happening — read the Pulse question aloud.
2. Start Kestrel, discharge the battery: the shortfall closes on screen.
3. Tap the Residential East price: *why* it costs what it costs.
4. Build a peaker on the pad; open GRID and upgrade the Eastside Line.
5. Open **What happened**: follow one causal chain from a trip to a layoff.
6. MARKET → Power companies: a company explains why it bought your power; follow the deal to "paid".
7. PORTFOLIO: your Plant Assets; list one; accept VoltLine's bid.
8. Point at the news ticker: tap the story, the merchant opens, hover the price and the story is in the reasoning.
9. ⚙︎ → Money: your wallet, the treasury, every NPC wallet and every transaction. ⚙︎ → Verify: epochs re-hashed.

## Commands
| | |
|---|---|
| `pnpm dev` | API + web (hot reload) |
| `pnpm test` | 184 TS tests (Vesper Market, power market, region engine and API, relayer, settlement, world inputs, plus the classic game) |
| `pnpm test:e2e` | Playwright: the first session, the market (tooltip, trade, feed, watch a week), a phone layout, and the 8 classic journeys |
| `pnpm test:contract` | 53 Rust contract tests |
| `pnpm typecheck` | type check (also `cd apps/web && npx tsc --noEmit`) |
| `pnpm build` | production web build into `dist/` |
| `pnpm build:contract` / `pnpm chain:economy` | build, deploy and initialise the economy on testnet with your account |
| `pnpm chain:demo` | run the real economy against testnet and write `docs/TESTNET_RUN.md` |

## Docs
[Game design](docs/GAME_DESIGN.md) · [Architecture](docs/ARCHITECTURE.md) · [API contract](docs/API_CONTRACT.md) ·
[Security](docs/SECURITY.md) · [NEAR setup](docs/NEAR_TESTNET_SETUP.md) · [Deployment](docs/DEPLOYMENT.md) ·
[Auth decision](docs/AUTH_PROVIDER_DECISION.md) · [Shared exchange (classic)](docs/SHARED_EXCHANGE_PLAN.md)

## Libraries and prior work
TypeScript, React 19, Vite 7, three.js, @react-three/fiber, @react-three/drei, Zod 4, Fastify 5, `node:sqlite`, jose,
@supabase/supabase-js, near-api-js 7, near-sdk-rs 5.30, Vitest, Playwright. Weather: Open-Meteo. Brent: U.S. EIA
(via FRED when offline). No templates.

## License
MIT — see [LICENSE](LICENSE).
