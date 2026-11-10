# BLACKOUT — the game loop, on paper

The brief: *"Design the game loop on paper first: what the player does every 30 seconds, every 5 minutes and every
session."* This is that design, and the game follows it. Clock: one interval = 5 game minutes = 1 real second; a game
day is 288 intervals (4.8 minutes). Vesper Market keeps its own clock at the same speed and never stops.

## The world in one paragraph
You run a power company in the Vesper region. Seven districts, six power lines, businesses and households with
their own balance sheets, a rival (VoltLine) and, at its heart, **Vesper Market**: nine merchants, each an agent
with its own wallet and inventory, who sell you what power plants burn and build with and buy what they produce.
Every player trades with the same merchants, so everyone's buying and selling moves everyone's prices.

## Every 30 seconds — react
| Something happens | You do | You see |
|---|---|---|
| A district goes dark (a trip, a full line, an empty battery) | discharge a battery, start a plant, repair with kits | its windows light up, the red ring stops |
| A merchant's price jumps or dips (▲▼ on its stall) | buy fuel cheap, sell certificates before others flood the desk | your trade in the live feed, the price moving |
| You wonder why something costs what it costs | hover a price | the merchant's reasoning: stock, recent demand, margin, and the news story moving it |
| A story breaks (BREAKING under the top bar: a tanker stuck, a cold snap, a steel strike) | buy before the price climbs, or sell into it | the ticker's price moving ▲▼ as the story plays out |
| An incident hits the region (storm, heatwave, a rival's plant trips) | start a plant, discharge a battery, sell into the spike | the spot price jumping, then settling as you respond |

The bottom line of the screen always names the single most useful move, with a button that does it.

## Every 5 minutes (one game day) — plan
| Need | Decision |
|---|---|
| The evening peak (19:00) | keep enough plants committed, batteries charged, fuel stocked |
| Fuel and permits | buy from the cheapest open merchant, or leave auto-buy on; permits save 25% on carbon |
| Growth | build where power is dearest; every build needs **steel** from Pavel's yard, so steel prices matter |
| Income | power sales, congestion rent on lines you upgraded, regulator tenders, certificate sales, **dividends** from shops you invested in |
| The market's mood | a shop closed? invest to reopen it and own a share; someone flooding certificates? sell before the price falls |

## Every session (15–30 minutes) — grow
* Earn operating permits by delivering power and maintaining regional reliability; each permit opens larger plants.
* Own shares in merchants; they pay you every market day, even while you're away.
* Finish this week's challenge (same seed and scenario inputs for every player) and compare on the leaderboard. The
  weekly opening condition rotates between fuel pressure, recovery, heat-driven demand, carbon costs and renewable
  opportunity; seeded grid incidents then give every player in that week the same follow-on story.

## Why come back
Your investments keep paying, the market keeps moving with other players, VoltLine keeps competing, and the real
weather and fuel prices feeding the world have changed since you left.

## The economy rules (and where they live)
| Rule | File |
|---|---|
| How every merchant prices (stock × recent demand × margin, plus two special rules) | [`packages/sim/src/town/merchantPricing.ts`](../packages/sim/src/town/merchantPricing.ts) |
| The news: every story and exactly which flow it multiplies | [`packages/sim/src/town/news.ts`](../packages/sim/src/town/news.ts) |
| Merchants: wallets, stock, imports, outside customers, rent, closing, investing, dividends | [`packages/sim/src/town/engine.ts`](../packages/sim/src/town/engine.ts), numbers in [`config.ts`](../packages/sim/src/town/config.ts) |
| The power market (merit order, line limits, nodal prices) | [`packages/sim/src/region/market.ts`](../packages/sim/src/region/market.ts) |
| Businesses, households, VoltLine, banks, regulator | [`packages/sim/src/region/economy.ts`](../packages/sim/src/region/economy.ts) |
| Watch a week (bots) | [`packages/sim/src/town/bots.ts`](../packages/sim/src/town/bots.ts) |

## The cause-and-effect chains the player can watch
* **Flood → cheap:** sell certificates to Lena faster than companies buy them → her stock climbs → her price falls for
  every player → she runs out of cash → **her shop closes** → nobody can sell certificates until someone invests →
  the investor earns a share of her profits.
* **Corner → dear:** buy up gas → stock falls and recent demand rises → gas gets dearer → every region's gas turbines
  cost more to run → evening power prices rise.
* **Steel:** players' power keeps their steel mills running → the mills feed Pavel's yard → steel stays cheap → plants
  stay affordable. Blackouts at the mills mean dearer steel for everyone.
