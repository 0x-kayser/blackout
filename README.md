# BLACKOUT — Every Light Changes the Economy

A regional power-system strategy game for the NEAR Hackathon **Games With Real Economies** track. You run a power
company in the Vesper region: seven load centres, six transmission lines, a gigawatt of demand and never quite enough
cheap generation. Every five game minutes, the simulated merit-order market clears. When supply runs short, prices
spike, customers switch off, then the lights go out — and businesses with their own balance sheets lose money, lay
people off and close. You decide what runs, what gets built, where, and with whose money.

> **Live game:** [blackout-production-c7fc.up.railway.app](https://blackout-production-c7fc.up.railway.app). Production currently offers guest play and Google sign-in. Email sign-in is not configured.
>
> **Economy and chain status:** Credits are fictional, non-redeemable game currency, and the simulation is
> server-authoritative. Railway has a separate NEAR Testnet economy service configured. A Testnet contract and a
> standalone run with 40 successful transactions are documented in [`docs/TESTNET_DEMO.md`](docs/TESTNET_DEMO.md).
> The public config reports `chainMode: disabled` for the NEP-245 resource-market adapter, so player resource
> listings and those transfers are not active in the deployed game. Testnet evidence applies to the documented demo
> flow; it is not proof that every live game interaction settles on chain.

## Play in production

Open the [live game](https://blackout-production-c7fc.up.railway.app/) and choose **Play as guest** to enter
immediately. Your guest session is saved in that browser. To use your company on another device, choose **Sign in to
save your company** and continue with Google. A first-time Google sign-in upgrades the current guest company; a
returning Google account opens its saved company. No external wallet, seed phrase, or gas setup is needed for normal
play.

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
pnpm 10. Set `WORLD_INPUTS=off` to skip live weather.

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
| Players gather materials and trade with NPC merchants | The simulated Vesper Market trades fuel, permits, certificates, steel and repair parts. The production NEP-245 resource adapter is disabled; those in-game trades are not evidence of on-chain resource transfers. |
| Each merchant is an agent with its own wallet and inventory | Nine merchants have independent simulated cash, stock, imports and customers. A separate Testnet demo provisions NPC accounts; that setup is documented below. |
| Prices from stock and recent demand | `stock factor × demand factor × margin`, recalculated every tick |
| Flood the market and it gets cheap | Sell certificates and Lena's price falls for every player; buy gas and it rises for everyone |
| A broke merchant closes until someone invests | Shops close when cash runs out; **Invest** reopens them and pays you a share of profits daily |
| Items are NEP-245, one contract | Contract code and a Testnet demo are available. The live Railway public config reports `chainMode: disabled`, so the deployed player resource-market flow is not active. |
| Social/email login, no seed phrases, popups or gas | Production offers guest and Google sign-in. Email is off. Normal play does not ask for a wallet, seed phrase or gas. |
| Pricing rules in one readable file, reasoning in a tooltip | [`merchantPricing.ts`](packages/sim/src/town/merchantPricing.ts); hover any price. Outside events live in [`news.ts`](packages/sim/src/town/news.ts) and show up in the same tooltip |
| Fast-forward a week in a minute | **⏩ Watch a week** in MARKET: seven market days, four bot companies, 60 seconds |
| Game loop on paper first | [docs/GAME_LOOP.md](docs/GAME_LOOP.md) |
| Multiple players | Every player trades with the same merchants; their trades show in the live feed and move your prices |

## Vesper Market
Nine stalls in the middle of the region: Ingrid and Bayo (gas), Kettle, Dayo and Chioma (diesel), Lena (renewable
certificates), Ruth (carbon permits), Pavel (steel) and Nkechi (turbine kits). Tap a stall: its ledger balance, stock, buy
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
* **In-game money (§13–14).** A simulation treasury funds every opening balance and your one-time starter grant; a
  double-entry ledger keeps credits, gas and diesel summing to zero.
* **Progression.** Licences (Independent Generator → Regional Producer → System Partner → Grid Anchor) unlock bigger
  plants by energy delivered and regional reliability; tenders, asset sales and the weekly leaderboard.

## NEAR integration and current status

NEAR Testnet has no monetary value, and BLACKOUT credits cannot be redeemed. Railway's separate economy service is
configured for Testnet; its supported settlement flows are distinct from the legacy NEP-245 resource-market adapter.
The public game config currently reports `chainMode: disabled` for that adapter, which disables on-chain player
resource listings and transfers in the deployed game. A successful standalone Testnet run should not be presented
as proof that a particular public-game interaction settled on chain.

Full write-ups: [architecture](docs/NEAR_ARCHITECTURE.md) · [economy model](docs/ECONOMY_MODEL.md) ·
[wallets and treasury](docs/WALLET_AND_TREASURY.md) · [transaction flows](docs/TRANSACTION_FLOWS.md) ·
[testnet demo](docs/TESTNET_DEMO.md).

| Piece | Status |
|---|---|---|
| Testnet contract | [`vesper-econ.blackout-kay.testnet`](https://testnet.nearblocks.io/address/vesper-econ.blackout-kay.testnet) is used by the separately documented demo. |
| Testnet evidence | [`docs/TESTNET_DEMO.md`](docs/TESTNET_DEMO.md) records a run on 2026-11-09 with 40 final transactions and explorer links. |
| Railway economy service | Configured separately for NEAR Testnet; check transaction evidence before attributing a specific gameplay event to chain settlement. |
| Live game resource adapter | Disabled in the current Railway config (`chainMode: disabled`). On-chain player resource listings and transfers are unavailable in the deployed game. |
| Game credits | Fictional, non-redeemable credits. They are not cash or a promise of a token payout. |
| Wallet UX | Guest and Google onboarding do not require an external wallet, seed phrase or gas prompt. Do not describe an account as self-custodied unless that behavior is implemented and verified. |
| NEAR Intents | Not integrated; the project has no demonstrated transaction path that needs it. |

## How this meets the track (§64)
* **Games With Real Economies (primary):** prices, wages, debt, closures and construction costs all emerge from
  actors' simulation rules. Game credits remain fictional and non-redeemable.
* **Agent Economy:** NPCs make autonomous decisions in the simulation. The standalone Testnet demo shows NPC-signed
  transactions; do not imply those accounts or transfers are active in every public-game interaction.
* **On-chain ownership:** the contract supports NEP-245 resources and Plant Assets, but the live Railway config
  disables the resource adapter. See the compliance and Testnet demo documents for the exact scope and evidence.

## What's live vs configured
| Feature | Status |
|---|---|
| Regional game: market, plants, actors, events, persistence and 3D client | **Live** at the Railway URL above; guest journey and live region connection were smoke-checked. |
| Live weather (Open-Meteo) | **works** with network; falls back to the last saved snapshot |
| Guest access | **Enabled** in production. |
| Google sign-in | **Configured** with Google Identity Services. The sign-in bundle and public config are deployed; a real Google account consent round-trip still needs browser verification. See [setup](docs/AUTH_PROVIDER_DECISION.md#google-sign-in-without-supabase-simplest). |
| Email sign-in | **Disabled** in production. Local development can use the on-screen email code. |
| NEAR Testnet contract and standalone demo | **Deployed and demonstrated** as documented in [`docs/TESTNET_DEMO.md`](docs/TESTNET_DEMO.md). |
| NEP-245 resource adapter in the live game | **Disabled** in current Railway config; player resource listings and transfers are not available. |
| Seven-day market replay | Available through **Watch a week** in MARKET; sandbox replay is distinct from Testnet settlement. |
| Classic city game | Available at **/city**. |

## Demo script (§65, 3 minutes)
1. Open the [live game](https://blackout-production-c7fc.up.railway.app/): choose **▶ Play as guest** or sign in with Google. The crisis is already happening — read the Pulse question aloud.
2. Start Kestrel, discharge the battery: the shortfall closes on screen.
3. Tap the Residential East price: *why* it costs what it costs.
4. Build a peaker on the pad; open GRID and upgrade the Eastside Line.
5. Open **What happened**: follow one causal chain from a trip to a layoff.
6. Open **MARKET** and **Watch a week** to show the evolving simulated economy.
7. For chain evidence, use the separate [`docs/TESTNET_DEMO.md`](docs/TESTNET_DEMO.md) walkthrough and its explorer links. Do not present it as a live player resource-market transaction from the Railway game.

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
