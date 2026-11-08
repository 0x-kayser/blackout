# BLACKOUT — game design (as implemented)

**Every light changes the economy.** You run a small emergency power company in a city whose grid keeps failing.
Shops lose power, ask you for electricity and offer a price. What you charge and how reliably you deliver decides
whether they make money, which decides tomorrow's demand.

Source design: `Blackout Game Loop Design1.pdf` (Abdulsalam, 2026-11-07). This file records what the code does.

## Every 30 seconds — an outage wave
1. A business goes dark (`OUTAGE_STARTED`) and sends a request card: kW, hours, offered credits/kWh, the money it
   will escrow, the fuel and CO₂ it will cost you and your expected margin (all server-computed).
2. Accept, counter (≤ 2 rounds; the customer answers from its own margin, loyalty and the rival's price) or decline.
   From Day 1 wave 4 requests have a 10 s timer.
3. Route the load onto a generator. Capacity counts every active contract, not just this wave. Above 90% load heat
   climbs (from Day 2) until the set breaks.
4. The next tick the lights come back (`SERVICE_STARTED`); each tick burns fuel, retires permit allowance and bills
   the customer for energy actually delivered.

Failure moments: fuel or permits run out mid-contract (service drops, unearned escrow refunded, loyalty −15%); a
generator overheats and is offline 3 game hours; the rival takes a customer you missed.

| Stage | When | Added |
|---|---|---|
| Tutorial | first 3 waves | 1 request, no visible timer (customers wait up to 6 game hours), no heat. Wave 1 is always the Cold Room: 1.5 kW × 2 h at 8 credits/kWh |
| Normal | wave 4 onward | 2 requests, 10 s timers |
| Pressure | from the second game day | heat & breakdowns; the rival bids for anything you miss; customers may switch provider |
| Expert | third game day or ≥ 10 kW capacity | up to 3 requests; regulator cuts the permit cap |

## Continuous play — no forced days
The city never stops. Play for three minutes or an hour; leave and it pauses exactly where you were.

* **Day and night (environmental):** 24 game hours = 4 real minutes. Daylight drives solar output, the sky, window
  glow and street lights; outages cluster into an evening peak. Nothing pauses at night.
* **Background rollover at 06:00:** shops pay rent and update loyalty (and may struggle, close or reopen), merchants
  restock or go broke, the regulator issues the day's permit supply and reprices, the rival restocks and reprices, the
  oil index steps to the next observed Brent week. A `DAY_SETTLED` summary appears in Business → but play continues.
* **Always open:** the Market (fuel and permits), Equipment (solar, battery, second diesel set, servicing, tariffs)
  and Expansion (districts unlock with capacity and credits).
* **Progression:** objectives (restore the Cold Room, earn, buy, install solar or a battery, reach 10 kW, unlock
  Hospital Row) and pressure that grows with your progress: tutorial → two timed requests → heat + rival → three
  requests once you have 10 kW.

## Observatory (fast-forward)
The same engine runs 7 days with a scripted *player-policy* bot (decisions only, never outcomes) in ~0.5 s and can be
streamed over 60 s. Same seed + same policy ⇒ byte-identical trace hash. Different policies ⇒ different cash, stock,
reliability and generation mix.

## What makes it an economy (not a script)
* Outside shoppers are the only ongoing source of credits and only pay powered shops.
* Merchants hold real stock and cash, price from one readable policy, restock from an importer with cash and capacity
  limits, can go broke and recover.
* The rival has its own plant, fuel, permits, cash and an adaptive margin; it can only win what it can physically serve.
* The regulator's permit price reacts to everyone's emissions; the cap tightens.
* Only the outside world is scripted: the oil index series per day and the permit cap schedule.

## Deliberately not in this build
Session-ending campaigns (removed by design), hedging, NEP-171 generator NFT, Residential district, LLM dialogue, live oil prices, multiplayer generator market.
