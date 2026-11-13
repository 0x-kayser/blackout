# BLACKOUT — Every Light Changes the Economy

A regional power-system strategy game for the NEAR Hackathon **Games With Real Economies** track.

**The story (fiction).** It is November 2026. Gulf shipping disruptions have pushed imported gas and diesel sharply
higher just as a new carbon rule makes unpermitted emissions dearer. The Strait of Hormuz disruption and the
"COP31 Sovereign Grid Accord" are a *fictional scenario* inspired by real 2026 events, not a record of them. Vesper's
monopoly utility, **VoltLine Energy** (Victor Lane, ₡15M in debt), lets its turbines trip and Residential East goes
dark. **Mama Ade** lends you a shed and a diesel generator. Then the Regulator hands you the region's idle Kestrel
Peaker. You keep Vesper lit. Full story: [docs/STORYLINE_AND_PITCH.md](docs/STORYLINE_AND_PITCH.md).

**What you play.** One crisis at two scales:
* **Act I, Street Microgrid (`/city`):** a 5 kW diesel set behind Mama Ade's shop, 44 local businesses, 9 story
  chapters, and fuel prices that follow a bundled U.S. EIA Brent crude dataset.
* **Act II, Regional Command (`/`):** the 120 MW Kestrel Peaker and the 80 MW / 160 MWh Eastside Battery, seven load
  centres, six transmission lines and about a gigawatt of demand. Every five game minutes a merit-order market clears.
  When supply runs short, prices spike, customers switch off, then the lights go out, and businesses with their own
  balance sheets lose money, lay people off and close. You decide what runs, what gets built, where, and with whose money.

**Why it fits the track.** The economy runs without developer input and you can watch it:

| Track ask | Where to see it |
|---|---|
| NPCs with wallets | Nine merchants and four rival power companies (VoltLine, Northwind Co-op, Eastbank Energy, Harbor Diesel) each hold their own cash and stock, and twelve regional actors (hospital, steel works, port, data centre, households…) have their own balance sheets. See them in **Vesper Market** and the **Who's Who** board |
| Prices from stock and demand | One readable rule, [`merchantPricing.ts`](packages/sim/src/town/merchantPricing.ts); the tooltip names the news story behind a move |
| Economy that evolves without a patch | A news story about once a minute, an incident at least every 2½ minutes, a weekly seeded crisis, and four **Hot Desk** calls from the region's people |
| Player-owned markets | Invest in a closed shop, buy VoltLine's plants, sell power to the region |
| Players never notice the chain | No wallet, seed phrase or gas in normal play; settlement runs behind the game |

## A living Vesper: the people layer
These four additions give the economy a voice. They are presentation and simulation, and they add no on-chain
functionality.

* **Hot Desk.** After the first-night rescue, four people phone with a yes-or-no decision: Dr. Nadia Petrov
  (hospital voltage), Marta Ivanova (steel retainer), Rosa Delgado (port cold chain) and Amara Obi (evening market).
  Each shows its exact cost and payoff before you answer. Outcomes move credits and the health or output of the actor
  involved. They never move merchant items, so they do not touch the NEP-245 flow.
* **98.4 Vesper FM and The Vesper Chronicle.** Open **📻 98.4 FM · News & Chronicle** for a radio host, call-ins from
  the cast and a daily front page. Every line is generated from the live game state (reserve, prices, closures,
  your delivered energy), so it changes as the grid changes.
* **Who's Who and the Operating Certificate.** The Company view and the Operations view list the four rival
  generators with live cash, debt, capacity and output, and show your permit rank and reliability on a certificate.
* **Merchant mood.** Each of the nine merchants shows a mood (🟢 thriving, 🔵 steady, 🟡 stock tight, 🟠 cash-worried,
  🔴 shuttered), what they are doing at this hour, how many days of overhead their cash covers, and a line of their
  own. The mood is computed from the merchant's real cash, daily costs and stock, so a squeezed shop looks squeezed.

How they stay honest: the engine remains deterministic and zero-sum (every asset still sums to zero, and settlement
epochs still verify), Hot Desk answers are recorded actions so saves and replays reproduce them, and Hot Desk is
switched off in the shared weekly challenge so its leaderboard stays fair.

> **Live game:** [blackout-production-c7fc.up.railway.app](https://blackout-production-c7fc.up.railway.app). Production currently offers guest play and Google sign-in. Email sign-in is not configured.
>
> **Economy and chain status:** Credits are fictional, non-redeemable game currency, and the simulation is
> server-authoritative. The root Testnet economy supports the player electricity market and NEP-245 settlement for
> merchant resources. Commit `bf3dd76` adds player resource custody and batched consumption reconciliation. It is pushed
> to the repository; the public app and API health endpoint responded successfully, but Railway's deployment metadata
> was unavailable, so the running release cannot yet be tied to that commit. A verified player transaction is also
> required before that resource flow can be claimed as live. The older standalone
> commodity-listing adapter remains disabled. See [`docs/NEAR_TRACK_COMPLIANCE.md`](docs/NEAR_TRACK_COMPLIANCE.md) and
> [`docs/TESTNET_DEMO.md`](docs/TESTNET_DEMO.md) for exact evidence and limitations.

## Play in production

Open the [live game](https://blackout-production-c7fc.up.railway.app/) and choose **Play as guest** to enter
immediately. Your guest session is saved in that browser. To use your company on another device, choose **Continue
with Google**. A first-time Google sign-in upgrades the current guest company; a
returning Google account opens its saved company. No external wallet, seed phrase, or gas setup is needed for normal
play. The welcome screen offers an optional one-minute **How to play** tour before entry, explaining the rescue,
dispatch and build controls, merchant trading, campaign permits, and weekly crisis. The in-game rescue then guides the
first three actions on the map.

Google uses Google Identity Services directly. The production Google OAuth client must allow
`https://blackout-production-c7fc.up.railway.app` under **Authorized JavaScript origins**. The deployed public
configuration advertises Google sign-in, but a real account consent round-trip should be checked in a browser before
claiming it has been end-to-end verified. Email sign-in is currently unavailable in production.

## Play it locally

```bash
pnpm install
```

```bash
ALLOW_GUEST_PLAY=true AUTH_LOCAL_EMAIL=true AUTH_LOCAL_EMAIL_SHOW_CODE=true pnpm dev
```

Open **http://localhost:5173**. This command enables guest play and local email-code sign-in; during development the
code is shown on screen. To enable Google locally, set `GOOGLE_CLIENT_ID` and add
`http://localhost:5173` to that OAuth client's Authorized JavaScript origins. Do not set
`AUTH_LOCAL_EMAIL_SHOW_CODE=true` in production. The original city game is still playable at **/city**. Node ≥ 22.5,
pnpm 10. Set `WORLD_INPUTS=off` to skip live weather. On Windows, set those variables in PowerShell (`$env:ALLOW_GUEST_PLAY="true"`) before `pnpm dev`.

## Your first night in Vesper
You enter through a rescue briefing. The first three steps each have a short explanation, a direct action button, and
a matching marker on the city map. Restore Eastside, bring Kestrel online, then build a reserve plant before the full
map and company controls open.

| You see | You tap | What happens |
|---|---|---|
| Dusk. One district, Residential East, sits dark inside a pulsing red ring: *LIGHTS OUT*. | **⚡ Send power** on your battery | Its windows light up again; your cash starts rising. |
| *The region is short of power.* | **▶ Start turbine** on your gas turbine | It spins up, smokes, and earns on every megawatt. |
| *Your battery won't last all night.* | **+ Build diesel plant** on the glowing pad | A plant starts rising in Residential East. |

Then the campaign stays in view while you play: it shows the next city goal, progress toward it, what new builds it
will unlock, and a field note with the best available action. The bottom dock opens **Power**, **Build**, **Market**,
**Map**, or **Company** without taking you away from the city. Select a plant, district, or merchant to see what
it is doing and why its price is what it is. **📻 98.4 FM · News & Chronicle** tells the region's story, cause by cause.

## The brief, requirement by requirement
| The brief asks | In BLACKOUT |
|---|---|
| Players gather materials and trade with NPC merchants | The Vesper Market simulates fuel, permits, certificates, steel and repair parts. The root economy now maps those trades and consumed whole units to player NEP-245 balances in batches; a real post-deploy transaction is still needed to verify this build. |
| Each merchant is an agent with its own wallet and inventory | Nine merchants have independent simulated cash, stock, imports and customers. A separate Testnet demo provisions NPC accounts; that setup is documented below. |
| Prices from stock and recent demand | `stock factor × demand factor × margin`, recalculated every tick |
| Flood the market and it gets cheap | Sell certificates and Lena's price falls for every player; buy gas and it rises for everyone |
| A broke merchant closes until someone invests | Shops close when cash runs out; **Invest** reopens them and pays you a share of profits daily |
| Progressive challenges with a clear next action | A three-step rescue opens the four-permit campaign; the city HUD keeps one live objective, its progress and the best next move visible. A shared three-day crisis rotates weekly. |
| Items are NEP-245, one contract | The root economy uses the existing `vesper-econ.blackout-kay.testnet` contract and its registered market IDs. The separate legacy listing adapter is disabled. |
| Social/email login, no seed phrases, popups or gas | Production offers guest and Google sign-in. Email is off. Normal play does not ask for a wallet, seed phrase or gas. |
| Pricing rules in one readable file, reasoning beside each price | [`merchantPricing.ts`](packages/sim/src/town/merchantPricing.ts); open a merchant stall to see why a quote moved. Outside events live in [`news.ts`](packages/sim/src/town/news.ts) and appear in the same explanation. |
| Fast-forward a week in a minute | **⏩ Watch a week** in MARKET: seven market days, four bot companies, 60 seconds |
| Game loop on paper first | [docs/GAME_LOOP.md](docs/GAME_LOOP.md) |
| Multiple players | Every player trades with the same merchants; their trades show in the live feed and move your prices |

## Vesper Market
Nine stalls in the middle of the region: Ingrid and Bayo (gas), Kettle, Dayo and Chioma (diesel), Lena (renewable
certificates), Ruth (carbon permits), Pavel (steel) and Nkechi (turbine kits). The market opens on merchant stalls and
what you hold, before news and replay details. Each stall says **Shop this stall** and opens its stock, buy and sell
prices with the reasoning, a reviewable quote, recent trades, investors, and trade or invest actions. MARKET also
shows the live feed of who's trading.

**Merchants have moods.** Open a stall and a *Mood & daily routine* panel shows how the merchant is doing and what
they are doing right now (morning, afternoon or night). A shuttered shop says what it needs to reopen; a stressed one
says why it is pricing to protect the till.

**Every financial action is reviewable.** Before a market order, the game shows the estimated average price, total,
cash and inventory after the order, and whether the merchant can fill it. Investments show the projected share of
future shop profits; loans show interest and default consequences; plant purchases, offers and listings have a review
step. Quotes are estimates rather than price reservations, so the server checks the order again when you confirm.
When cash is low, the portfolio points to borrowing, asset sales, the power desk and fuel-spending controls. These
balances and trades remain fictional game credits, not redeemable money.

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

**Progress has a next step after the rescue.** In a live region, the campaign card stays visible with the next goal,
delivered-energy progress, the reliability target when one applies, and the builds it unlocks. The Campaign view shows
the whole route. The weekly crisis is available from the same card, with its shared, seeded challenge and leaderboard;
its opening fuel, weather or carbon condition rotates weekly and actually changes the simulation inputs. Everyone gets
the same conditions and seeded grid incidents for that week, while the live company stays saved. Progress comes from
running the grid, not login streaks or missed-day penalties.

The player account menu is beside the in-game clock. It offers company naming and a visible **Sign out** action.
Account preferences open from the separate gear button; campaign progress stays in the city HUD and Campaign view.

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
* **In-game money (§13–14).** A simulation treasury funds every opening balance and your one-time starter grant; a
  double-entry ledger keeps credits, gas and diesel summing to zero.
* **Progression.** Licences (Independent Generator → Regional Producer → System Partner → Grid Anchor) unlock bigger
  plants by energy delivered and regional reliability; tenders, asset sales and the weekly leaderboard.

## NEAR integration and current status

NEAR Testnet has no monetary value, and BLACKOUT credits cannot be redeemed. The root `ECONOMY_*` service connects the
NPC merchant and power-company market to `vesper-econ.blackout-kay.testnet`; the player electricity market has a real
escrow path. This revision adds player resource balances and consumption reconciliation through that same contract.
The change must be deployed and exercised by a player before it counts as live resource-trade evidence. The separate
legacy adapter still uses a different shared-vault flow and remains disabled. Do not present a standalone Testnet demo,
opening batch, or resync as a live player resource trade.

Full write-ups: [architecture](docs/NEAR_ARCHITECTURE.md) · [economy model](docs/ECONOMY_MODEL.md) ·
[wallets and treasury](docs/WALLET_AND_TREASURY.md) · [transaction flows](docs/TRANSACTION_FLOWS.md) ·
[testnet demo](docs/TESTNET_DEMO.md).

The player interface has no wallet, chain status, or transaction-verification screen. Operators can inspect actual
configured settlement status and recorded transaction evidence through the protected `GET /api/admin/chain-audit?limit=100&offset=0`
endpoint. It requires the server-side `ECONOMY_ADMIN_TOKEN` in an `x-admin-token` header; never put that token in the
web client or a public issue. Advance `offset` by `limit` to page through the retained history. A disabled adapter or
empty transaction log is reported as such, not as a successful on-chain trade.

| Piece | Status |
|---|---|---|
| Testnet contract | [`vesper-econ.blackout-kay.testnet`](https://testnet.nearblocks.io/address/vesper-econ.blackout-kay.testnet) is used by the separately documented demo. |
| Testnet evidence | [`docs/TESTNET_DEMO.md`](docs/TESTNET_DEMO.md) records a run on 2026-11-09 with 40 final transactions and explorer links. |
| Root Railway economy service | Configured for NEAR Testnet; merchant and power-company transactions use the root contract. Verify audit evidence before attributing a particular gameplay event to settlement. |
| Player NEP-245 resources | Commit `bf3dd76` reconciles player holdings and resource consumption; its Railway rollout and an independently verified player trade still need confirmation. |
| Legacy commodity-listing adapter | Disabled. Do not confuse it with the root Vesper Market or player electricity offer market. |
| Game credits | Fictional, non-redeemable credits. They are not cash or a promise of a token payout. |
| Wallet UX | Guest and Google onboarding do not require an external wallet, seed phrase or gas prompt. Do not describe an account as self-custodied unless that behavior is implemented and verified. |
| NEAR Intents | Not integrated; the project has no demonstrated transaction path that needs it. |

## How this meets the track (§64)
* **Games With Real Economies (primary):** prices, wages, debt, closures and construction costs all emerge from
  actors' simulation rules. Game credits remain fictional and non-redeemable.
* **Agent Economy:** NPCs make autonomous decisions in the simulation. The standalone Testnet demo shows NPC-signed
  transactions; do not imply those accounts or transfers are active in every public-game interaction.
* **On-chain ownership:** the root economy settles player resources and Plant Assets through NEAR Testnet accounts;
  the newly added resource custody path needs a production transaction trace. See the compliance and Testnet demo
  documents for exact scope and evidence.

## What's live vs configured
| Feature | Status |
|---|---|
| Regional game: market, plants, actors, events, persistence and 3D client | **Live** at the Railway URL above; guest journey and live region connection were smoke-checked. |
| Live weather (Open-Meteo) | **works** with network; falls back to the last saved snapshot |
| Guest access | **Enabled** in production. |
| Google sign-in | **Configured** with Google Identity Services. The sign-in bundle and public config are deployed; a real Google account consent round-trip still needs browser verification. See [setup](docs/AUTH_PROVIDER_DECISION.md#google-sign-in-without-supabase-simplest). |
| Email sign-in | **Disabled** in production. Local development can use the on-screen email code. |
| NEAR Testnet contract and standalone demo | **Deployed and demonstrated** as documented in [`docs/TESTNET_DEMO.md`](docs/TESTNET_DEMO.md). |
| Root NEP-245 player-resource settlement | **Implemented and pushed in `bf3dd76`; the exact Railway release and a real player trade are still pending verification.** |
| Legacy fuel-listing adapter | **Disabled** in Railway; it is a separate contract flow. |
| Hot Desk, Vesper FM and Chronicle, Who's Who, merchant moods | **In this repository** (branch `feat/living-vesper`); they appear on the live site after the next Railway deploy. Credits and health only; none of it settles on chain. |
| Seven-day market replay | Available through **Watch a week** in MARKET; sandbox replay is distinct from Testnet settlement. |
| Classic city game | Available at **/city**. |

## Demo script (§65, 3 minutes)
1. Open the [live game](https://blackout-production-c7fc.up.railway.app/): choose **▶ Play as guest** or sign in with Google. The crisis is already happening — read the Pulse question aloud.
2. Start Kestrel, discharge the battery: the shortfall closes on screen.
3. Tap the Residential East price: *why* it costs what it costs.
4. Build a peaker on the pad; open GRID and upgrade the Eastside Line.
5. Open **📻 98.4 FM · News & Chronicle**: the host and the front page describe the grid you just changed.
6. When a **Hot Desk** call appears (shortly after the rescue), read the cost and payoff, then answer it.
7. Open **MARKET**, pick a merchant and show the *Mood & daily routine* panel and the price reasoning.
8. Open **Company** to show **Who's Who**: VoltLine and the other three generators with live cash and capacity.
9. Back in MARKET, choose **Watch a week** to show the evolving simulated economy.
10. For chain evidence, use the separate [`docs/TESTNET_DEMO.md`](docs/TESTNET_DEMO.md) walkthrough and its explorer links. Do not present it as a live player resource-market transaction from the Railway game.

## Commands
| | |
|---|---|
| `pnpm dev` | API + web (hot reload) |
| `pnpm test` | Run the Vitest unit and integration suite |
| `pnpm test:e2e` | Run the Playwright browser journeys |
| `pnpm test:contract` | Run the NEAR contract Rust tests |
| `pnpm typecheck` | type check (also `cd apps/web && npx tsc --noEmit`) |
| `pnpm build` | production web build into `dist/` |
| `pnpm build:contract` | Build the NEAR contract WASM |
| `pnpm chain:economy` | Deploy and initialise the Testnet economy (requires a funded Testnet account and credentials) |
| `pnpm chain:demo` | Run the documented economy flow against Testnet and write `docs/TESTNET_RUN.md` |

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
