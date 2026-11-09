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
Open **http://localhost:5173**. No menu: a guest session starts and you're in the region. The original city game is
still playable at **/city**. Node ≥ 22.5, pnpm 10. Set `WORLD_INPUTS=off` to skip live weather.

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
| Social/email login, no seed phrases, popups or gas | Guest → email or Google; the relayer pays gas; no chain words in play |
| Pricing rules in one readable file, reasoning in a tooltip | [`merchantPricing.ts`](packages/sim/src/town/merchantPricing.ts); hover any price |
| Fast-forward a week in a minute | **⏩ Watch a week** in MARKET: seven market days, four bot companies, 60 seconds |
| Game loop on paper first | [docs/GAME_LOOP.md](docs/GAME_LOOP.md) |
| Multiple players | Every player trades with the same merchants; their trades show in the live feed and move your prices |

## Vesper Market
Nine stalls in the middle of the region: Ingrid and Bayo (gas), Kettle, Dayo and Chioma (diesel), Lena (renewable
certificates), Ruth (carbon permits), Pavel (steel) and Nkechi (turbine kits). Tap a stall: its wallet, stock, buy
and sell prices with the reasoning, recent trades, investors, and buttons to trade or invest. MARKET shows them all
plus what you hold and a live feed of who's trading.

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

## NEAR, invisibly (§15–29)
| Layer | What it is | Where |
|---|---|---|
| Fast simulation | Off-chain, deterministic, server-authoritative | `packages/sim/src/region` |
| Settlement epochs | Every 3 game hours: each identity's net credit change (zero-sum), every Plant Asset's owner and record, SHA-256 | `settlement.ts` (sim), `settlement_epochs` table, `apps/api/src/settlement.ts` worker → `settle_epoch` |
| Resources (NEP-245) | `fuel:diesel`, `fuel:natural-gas`, `permit:carbon`, `certificate:renewable`, `credit:vesper` | `contracts/near/src/lib.rs`, registered by the bootstrap |
| Plant Assets (NEP-171) | Token `p00042` ↔ keyless account `p00042.<contract>`; only the current owner can move its balances; whole-asset sales in credits, atomic | `contracts/near/src/plants.rs` |
| NPC accounts | VoltLine, suppliers (the exchange traders), banks, regulator; settlement may debit only consenting accounts | bootstrap + `NEAR_NPC_*` |
| Gasless | NEP-366 relayer: allowlisted BLACKOUT methods, ≤1 yocto, bounded gas, signature check, rate limit, idempotent, persisted | `apps/api/src/relayer.ts`, `POST /api/relay` |
| Identity | `GameIdentity` over guest / Google / email (passkey slot) | `apps/api/src/identity.ts`, `GET /api/identity` |

**Not done:** NEAR Intents (no `ExternalSettlementAdapter` implementation is claimed), passkey sign-in, and automatic
`plant_mint` from the game (minting needs an attached deposit, so a function-call key can't do it; mint with the owner
key for now). Settlement debits a player only while they haven't taken self-custody.

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
| Contract: Plant Assets, plant accounts, sales, settlement of every item token, region tokens | 42 Rust tests; WASM builds; **deploy with `pnpm chain:bootstrap`** |
| Settlement worker, relayer | tested against fake submitters; **live after bootstrap** (`NEAR_SETTLEMENT_ENABLED=true`, `NEAR_RELAYER_*`) |
| Email sign-in | works locally (code on screen); production uses Supabase |
| Google sign-in | code complete; needs your Supabase project and Google OAuth client |
| Classic city game + shared fuel exchange | still works at `/city` |

## Demo script (§65, 3 minutes)
1. Open the game: the crisis is already happening — read the Pulse question aloud.
2. Start Kestrel, discharge the battery: the shortfall closes on screen.
3. Tap the Residential East price: *why* it costs what it costs.
4. Build a peaker on the pad; open GRID and upgrade the Eastside Line.
5. Open **What happened**: follow one causal chain from a trip to a layoff.
6. PORTFOLIO: your Plant Assets; list one; accept VoltLine's bid.
7. ⚙︎ → Verify: epochs re-hashed in the browser; Economy Lab replay.

## Commands
| | |
|---|---|
| `pnpm dev` | API + web (hot reload) |
| `pnpm test` | 160 TS tests (Vesper Market, power market, region engine and API, relayer, settlement, world inputs, plus the classic game) |
| `pnpm test:e2e` | Playwright: the first session, the market (tooltip, trade, feed, watch a week), a phone layout, and the 8 classic journeys |
| `pnpm test:contract` | 42 Rust contract tests |
| `pnpm typecheck` | type check (also `cd apps/web && npx tsc --noEmit`) |
| `pnpm build` | production web build into `dist/` |
| `pnpm build:contract` / `pnpm chain:bootstrap` | build and deploy the contract to Testnet with your account |

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
