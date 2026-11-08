# Economy rules

All values are in `packages/sim/src/config.ts` (tuning) and `packages/sim/src/policies/merchantPricing.ts`
(the one merchant pricing file). Units: see `packages/shared/src/units.ts`.

## Physics
| Rule | Value | Code |
|---|---|---|
| Energy per tick | `W / 10` Wh (1 tick = 0.1 h) | `whPerTick` |
| Diesel | 0.30 L/kWh → 3 mL per 10 Wh | `fuelMlForWh` |
| CO₂ | 2.68 kg/L → 2680 mg per mL | `co2MgForFuelMl` |
| Permit | 10 kg CO₂ | `PERMIT_MG` |
| Worked check | 4 kW × 8 h = 32 kWh → 9.6 L → 25.728 kg | test `unit math` |
| Heat (day ≥ 2) | above 90% load: +(load%−90%)×10 permille/tick (+10 if wear > 80%); else −25/tick | `heatTick` |
| Breakdown | heat 1000 → offline 30 ticks (3 game h); its contracts fail | |
| Service | 60 credits, wear reset, offline the first 12 game hours of the day | `SERVICE_GENERATOR` |
| Solar | 2 kW × hourly profile; 0 from 20:00 to 06:00 | `SOLAR_PROFILE_BPS` |
| Battery | 10 kWh, 2.5 kW, 90% efficiency applied on discharge | `dispatchTick` |

A diesel contract can be assigned only if fuel and permit allowance **not already reserved** by the remaining hours
of active contracts cover the full contract (`reservedFuelMl`, `reservedPermitMg`). Delivery debits fuel and retires
allowance every tick; if either runs out the contract fails, the meter stops and only undelivered escrow is refunded.

## Starting kit
5 kW diesel set · 20 L in a 60 L tank · 1,000 credits · 6 permits (60 kg) · Market Quarter unlocked (5 businesses,
5.1 kW combined peak) · default tariff 8 credits/kWh.

## Customers
| Business | kW | revenue/powered h | wages+stock/powered h | rent/day | start cash | break-even ₡/kWh |
|---|---|---|---|---|---|---|
| Cold Room | 1.5 | 40 | 20 | 120 | 150 | 13.33 |
| Sunrise Bakery | 1.2 | 30 | 16 | 100 | 120 | 11.66 |
| Corner Pharmacy | 0.8 | 26 | 14 | 90 | 120 | 15.00 |
| Byte Cyber Café | 1.0 | 28 | 15 | 100 | 100 | 13.00 |
| Mama Ade's Corner Shop | 0.6 | 16 | 9 | 55 | 80 | 11.66 |

Cold Room fixture (tested): profit per powered hour = 40 − 20 − 1.5 × tariff → **+8.00 at 8 credits/kWh, −2.50 at 15**.

* **Revenue** only while powered (grid, you or the rival): `revenue/h × districtActivityIndex`, capped by the district's
  outside demand (Market Quarter: 160 credits/h × activity). Paid by `world:shoppers` — **the only net faucet**.
* **Costs:** wages & stock while open (`world:wages_suppliers`), grid power at 7 credits/kWh outside outages
  (`world:grid`), your bill from escrow, rent at settlement (`world:landlords`). A business pays only what it has;
  shortfalls are recorded as unpaid, cash never goes negative.
* **Requests:** a business in outage requests its demand for 1–3 game hours. Opening offer = your district tariff if it
  is within the customer's ceiling, otherwise 90% of the ceiling. It must be able to escrow the full payment; if not it
  shortens the request or stays dark.
* **Ceiling** = break-even × (75% + 25% × loyalty), −10% if cash is below one day of rent, −15% in price-sensitive
  districts, and capped at rival tariff + 1 credit when the rival could serve it.
* **Counter:** if your counter ≤ ceiling the customer accepts it; otherwise it moves `concession` (30–45%) of the way
  toward min(counter, ceiling); after 2 rounds it walks away (rival may bid).
* **Loyalty** at settlement: +1% per hour you served, −0.8% per dark outage hour, −10% if your average rate exceeded its
  break-even. Decline −2%, expiry −2%, failed service −15%, cancel −10%.
* **Struggling / closed:** cash < rent at settlement → struggling; 2 consecutive → closed. **Reopening:** after ≥ 1 day
  closed, if district activity ≥ 90% and the district reinvestment pool can fund one day of rent.
* **District activity** (70%–130%) moves with outage reliability (any provider), −5% per gouged business, −3% per closure.
* **Switching provider (day ≥ 2):** after `gougeTolerance` gouges (Tech Hub: 2), or with loyalty < 35% when the rival is
  >1 credit cheaper and within the customer's break-even. Customers return when you are >1 credit cheaper or the rival
  could not serve someone yesterday.

## Merchants (one policy file)
```
baseReplacement = 10.00 credits/L × oilIndex / 100
scarcity        = clamp((target − sellable) / target, −1, +1)      sellable = stock − reserve floor
demandDelta     = clamp((yesterdaySales − baseline) / baseline, −1, +1)
price           = round10(clamp(baseReplacement × (1 + w_s·scarcity + w_d·demandDelta + markup), floor, 3 × base))
floor           = baseReplacement × (1 + minMargin)
```
| Merchant | policy | w_s | w_d | markup | min margin | stock / target / reserve | upstream/day | cash |
|---|---|---|---|---|---|---|---|---|
| Ember Wholesale | efficient_wholesaler | 0.45 | 0.20 | 2% | 0% | 150 / 200 / 0 L | 120 L | 1,200 |
| Lantern Corner Fuel | low_stock_boutique | 0.60 | 0.20 | 4% | 1% | 30 / 30 / 0 L | 25 L | 300 |
| Harbor Fuel Co-op | reserve_cooperative | 0.45 | 0.20 | 8% (+10% hoarding when oil rises and stock < target) | 5% | 200 / 200 / 120 L | 80 L | 800 |

Harbor rations to 25% of sellable stock per trade while oil is rising. Every price change emits `MERCHANT_REPRICED`
with the full `reasons` object (the UI tooltip shows exactly these numbers).

**Restocking (settlement):** if stock + pending < reorder point (60/70/80% of target) the merchant orders
`min(target − stock − pending, upstream capacity, (cash − operating reserve) / import cost)` from `world:importer`,
pays now, receives next morning. The wholesaler defers while oil is falling and stock > 40% of target. Daily overhead
15–30 credits. **Insolvency:** empty tanks and unable to fund a 1 L order above its reserve → `MERCHANT_CLOSED`; it reopens
when an order becomes affordable (e.g. oil falls) and the delivery arrives.

## Rival — VoltLine Power Co.
8 kW plant (never loaded above 90%), 30 L fuel / 80 L tank, 8 permits, 1,500 credits.
`tariff = round10((fuelBasis × 0.3 + permitPrice × 0.0804 + 0.50) × (1 + margin))`, clamped 5–20 credits/kWh.
Margin starts 35% and adapts ±5% per day (won ≥ 3 → up; won 0 → down), within 10–60%. Shops 30 s into each morning:
cheapest open merchant, up to 2 days of fuel, permits up to 1.5 days, limited by cash. Bids (day ≥ 2) on requests you
miss, only if it has capacity, fuel and permits, its tariff ≥ its unit cost, the customer's ceiling accepts it and the
customer can escrow.

## Regulator
Daily permit cap 8, 8, 6, 6, 5, 5, 4 (day 3 cut announced at dawn). Price = 25 credits × (1 + 0.5 × (yesterday's total
emissions − yesterday's cap)/cap) (+15% on a cap cut), clamped 60%–250%. Unsold permits are withdrawn at night.

## Faucets and sinks
| Account | Role |
|---|---|
| `world:genesis` | starting endowments only (run creation) |
| `world:shoppers` | **only ongoing credit faucet** (outside demand) |
| `world:wages_suppliers`, `world:grid`, `world:landlords` | business sinks |
| `world:importer` | merchant restock payments (credits sink) and diesel source |
| `world:equipment` | upgrades, servicing, district unlocks |
| `world:fuel_burned`, `world:permits_retired`, `world:permit_issuer` | physical sinks / regulator supply |
| `escrow:contracts`, `escrow:trades` | temporary holds; always drain to 0 |

The player cannot create credits by recycling trades: every purchase moves real stock for real credits, and there is
no sell-back path.

## Replay policies
`diesel` (Cheap Diesel First), `diversified` (Storage First: solar then battery when affordable, ~1 day of fuel),
`gouger` (posts 15 credits/kWh). Seed 424242, 7 days, starter scenario: see README for the current outcome table.
