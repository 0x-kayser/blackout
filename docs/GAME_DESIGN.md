# BLACKOUT — game design (as implemented)

The numbers live in `packages/sim/src/region/config.ts`; the rules in `packages/sim/src/region/*.ts`.

## The regional power game
**Primary question:** demand vs available economic generation, and who covers the shortfall.

| Loop | Length | What happens |
|---|---|---|
| Immediate | 10–30 s | a trip, a spike, a blackout: start a plant, discharge a battery, change an offer |
| Operating | 3–5 min (one game day = 288 intervals of 5 game minutes = 4.8 min) | evening peak, fuel buying, tenders, builds landing |
| Session | 15–30 min | licences, line upgrades, asset sales, the weekly challenge (3 game days) |
| Persistent | days | your region keeps its state; it only runs while you watch |

### Region
Seven load centres on a radial network: North Solar Belt, Central City (hub), Industrial South, Port, Tech Corridor,
Hospital District, Residential East. Six corridors with MW limits (Eastside Line 150 MW is the bottleneck) and
upgrades owned by whoever pays for them.

### Fleet at start
| Plant | Owner | MW |
|---|---|---|
| Kestrel Peaker (OCGT, Industrial South; starts offline: you start it) | you | 120 |
| Eastside Battery (Residential East; starts 80% charged) | you | 80 MW / 160 MWh |
| Harbor CCGT, Southgate CCGT, Ridge OCGT, Cityline OCGT, Solar Belt | VoltLine | 420, 260, 140, 130, 180 |
| Northwind Co-op Solar | Northwind | 150 |
| Eastbank Gas Engines | Eastbank | 140 |
| Harbor Diesel Peakers | Harbor Diesel | 80 |

### Market
Each interval every online plant offers (`GenerationOffer`: available MW, minimum MW at 0, offer price, marginal cost,
ramp) and every load segment bids (`LoadBid`: essential at its value of lost load, flexible at what the power earns
it). The clearing maximises welfare subject to line limits; nodal prices come from the residual graph; the cap is
₡5,000/MWh. Loads pay their node's price, generators receive theirs, the difference is congestion rent paid to line
owners.

### Your decisions
Start/stop thermal plants; offer at cost, at a markup, or only into scarcity; battery auto/charge/discharge/hold;
build (5 technologies, sizes gated by licence, cost × steel index); upgrade lines; buy fuel or auto-buy; borrow and
repay; list plants for sale and accept bids; buy plants VoltLine sells in distress; meet regulator tenders.

### Consequences
Businesses earn per MWh they can use, pay wages to households and fixed costs; health follows cash, debt and
blackouts; distressed businesses lay people off (households earn less, commerce sells less), closed ones vanish from
demand until outside investors reopen them when power is cheap. Steel output sets construction costs. VoltLine
mothballs plants when it can't cover interest. The regulator fines idle fuelled capacity during shedding (after the
first minute) and caps offers above max(2× cost, ₡1,000).

### Licences
| Licence | Needs | Opens |
|---|---|---|
| Independent Generator | start | diesel, 60 MW OCGT, solar 50/100 MW, batteries 50/100 MW |
| Regional Producer | 3,000 MWh | CCGT 250 MW, OCGT 120 MW, solar 200 MW |
| System Partner | 15,000 MWh, 97% reliability | CCGT 400 MW, battery 200 MW |
| Grid Anchor | 45,000 MWh, 98% | — |

### Score (weekly challenge)
profit/100 − 40 × MWh left dark − 2 × t CO₂ + 20 × (average business output − 80%).

## Classic city mode (/city)

**Every light changes the economy.** The grid keeps failing. You start with one diesel set behind a shop and grow
into the utility that powers the whole city. Shops, homes, hospitals, factories and the arena call you when they go
dark. What you charge, how reliably you deliver and how well you build the grid decide whether they prosper, and
that decides your demand. Fuel comes from NPC traders with their own NEAR wallets, shared by every player's city.

This file records what the code does. The numbers live in `packages/sim/src/config.ts` and
`packages/sim/src/policies/*.ts`.

## The loops
| Every… | You… | Pressure |
|---|---|---|
| 30 s (a wave) | take a call: accept, counter ×2 or decline; tap a generator | 10 s timer (7 s for Code Red); VoltLine takes what you miss; capacity, fuel, CO₂ allowance and the feeder must all fit |
| few minutes | buy diesel (Market), trade on the Vesper Fuel Exchange, service generators, set tariffs | merchant prices move with their stock, real 2026 Brent and the exchange traders' premium |
| stage | connect districts, upgrade substations, build plants | each stage needs energy delivered, districts connected and capacity installed |
| shift (24 game hours = 4 min) | finish three goals | streak: +10% goal rewards per consecutive shift, up to +50% |

The city never stops for a calendar: there are no day gates. Time of day changes light, solar output and the evening
peak. Leave and your city pauses (no fuel burns, no bills); your exchange offers keep selling.

## Company stages (progress = the business)
| Stage | Name | Needs | Opens |
|---|---|---|---|
| 1 | Street Generator | start | Market Quarter, rooftop solar, a second diesel set |
| 2 | Neighbourhood Utility | 25 kWh delivered | Riverside Homes, fuel terminal, batteries; VoltLine competes; Code Red calls; generators run hot |
| 3 | District Utility | 150 kWh, 2 districts, 10 kW | Hospital Row, Tech Hub, Port District, 20 kW diesel plant, grid battery |
| 4 | City Utility | 600 kWh, 4 districts, 30 kW | Industrial Park, Downtown, 10 kW solar farm |
| 5 | Grid Operator | 2,000 kWh, all 7 districts, 60 kW | the whole city on your grid |

Each promotion pays a City Council grant (₡100 → ₡2,000) and VoltLine invests too (+6 kW per stage).

## Distribution: substations, feeders, losses
Power flows from your plants through one substation and feeder per district. A call can only be accepted if the
district's feeder can carry it on top of what it already carries; the error says which feeder is full. Upgrading a
substation (level 1 → 3) doubles and then doubles again its capacity. Longer feeders lose energy, so every kWh sold
there burns more diesel.

| District | Opens at | Connect | Feeder L1 / L2 / L3 | Line loss | Customers |
|---|---|---|---|---|---|
| Market Quarter | start | — | 6 / 12 / 24 kW | 0% | Cold Room, bakery, pharmacy, cyber café, corner shop (haggle) |
| Riverside Homes | 2 | ₡250 | 7 / 14 / 28 kW | 3.5% | flats, school, laundromat (tight budgets) |
| Hospital Row | 3 | ₡300 | 8 / 16 / 32 kW | 5% | clinic, lab (fixed tariff) |
| Tech Hub | 3 | ₡500 | 10 / 20 / 40 kW | 5% | co-working, server room (walk away from gougers) |
| Port District | 3 | ₡1,200 | 14 / 28 / 56 kW | 7% | cold chain, dry dock, fish market |
| Industrial Park | 4 | ₡2,500 | 22 / 44 / 88 kW | 9% | textile mill, recycler, bottling plant |
| Downtown | 4 | ₡3,500 | 26 / 52 / 104 kW | 6% | tower, mall, arena (price-sensitive) |

Waves grow with the city: more connected districts means more calls per wave. The regulator's daily permit supply
also scales with the districts you serve.

## Plants and storage
Shed diesel 5 kW (start) · second diesel 5 kW · rooftop solar 2 kW · 10 kWh battery · fuel terminal +200 L ·
20 kW diesel plant · grid battery +50 kWh / +10 kW · 10 kW solar farm. Solar follows the sun; batteries store surplus
solar at 90% round-trip; diesel needs fuel and CO₂ allowance for every tick it runs.

## The economy (everyone decides for themselves)
* **Businesses** earn only while powered, from a bounded pool of outside shoppers. They pay wages, stock, rent and your
  bill; overcharge or fail them and they struggle, switch to VoltLine or close; serve them well and their district
  grows.
* **Town fuel merchants** (Ember, Lantern, Harbor) hold finite stock and cash and price from one rule file. They
  restock with lead time and cash limits **from the exchange traders**: the traders' scarcity premium reaches every town
  as a recorded price signal, so a busy city anywhere raises diesel prices everywhere.
* **Exchange traders** are the NPCs with wallets: Ingrid Halvorsen (Harbor Import Terminal: deep, slow, thin spreads),
  Bayo Northcott (Northline Haulage: fast trucks, rations hard), Old Man Kettle (buys cheap, sells dear), Dayo Swift
  (Swift Tankers: restocks in hours, undercuts), Chioma Okafor (Okafor & Daughters: hoards dips, sells squeezes) and
  Professor Lena Brandt (Greenline Fuel Fund: cheap, steady, big). They hold
  on-chain diesel and a credit budget, post asks and bids from their own stock, cash and recent flow, import within a
  daily cap, ration at their reserve, buy cheap player offers and supply the towns. Every decision shows its reasons.
* **VoltLine** has its own plant, fuel, permits, cash and an adaptive margin; it only takes customers it can serve.
* **The regulator** prices carbon permits from everyone's emissions.

## A market that keeps moving
On top of the multi-shift world events, a **market flash** can start every 15 seconds once the tutorial is over
(seeded, at most three at once, 45–150 s each): tanker queue, price war, heat spike, night market, carbon audit,
panic buying, port strike, solar clearance, convoy, factory rush, cool rain, holiday lull. Each moves the same bounded
levers as world events (import capacity and cost, merchant caution, shopper demand, permit supply, solar prices,
outage length), so merchants, traders, customers and VoltLine react through their own rules. Traders decide every
5 s; every wave each town receives the traders' current premium. Presets (the weekly challenge) and historical mode
never get flashes, so challenge runs stay comparable.

## People
44 buildings in seven districts, each run by a named owner with a trait shown on calls, in the inspector and in the
**People** panel, which also lists every NPC wallet (diesel, credits, prices, reasons and, on Testnet, the account).

## Making it fun
* **Code Red:** about 15% of calls from stage 2 pay double, can't be haggled and give you 7 seconds.
* **Shift goals and streaks:** three goals each shift (earn, keep N lit, finish N contracts, answer a Code Red, sell
  on the Exchange), paid by the City Council; finish all three to grow the streak.
* **Next move:** a single line under the map always says what matters most right now, with a button to do it.
* **The map is the game:** feeders glow with load, substations show their level, the Exchange port, fuel depot,
  VoltLine plant and locked districts are all tappable, trucks carry fuel, and money floats up from lit buildings.
* **Story:** neighbours with names and chapters that follow your growth.
* **Sound and music:** synthesized cues and an original generated loop; both stop when you leave the page.

## Why players come back
Offers that sell while you're away, a streak to protect, the next stage in sight, and a world (oil, events, other
players) that keeps moving.

## Fast-forward
The Economy Lab simulates a week of the same rules for two strategies on one seed in about a second, with charts, a
60-second replay and a downloadable ledger. Same seed + strategy = same trace hash.
