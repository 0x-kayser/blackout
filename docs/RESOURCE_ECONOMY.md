# BLACKOUT finite resource economy

BLACKOUT uses finite fuel and industrial materials to make power dispatch, construction, repairs and trading compete for the same scarce stock.

## What is implemented

- A fresh Vesper Market begins with a fixed ledger endowment of natural gas, diesel, carbon permits, steel and turbine parts. Renewable certificates remain producible by solar generation.
- Merchant opening stock and later deliveries move from reserve accounts. Deliveries stop when the reserve is empty; merchant trade only moves existing inventory between actors.
- Some stock begins sealed and is released on market days 90 and 210. Those releases transfer existing units into circulation and do not mint additional stock.
- Quotes rise as reserves are drawn down, on top of the existing inventory, demand, merchant margin and crisis effects. Quotes explain the reserve multiplier.
- Reserve thresholds and scheduled releases produce player-visible events. The market sheet shows the amounts left and suggests an in-game decision with a direct path to the affected merchant.
- Each saved regional grid has a fixed gas and diesel allotment. Local suppliers draw from it, prices react to depletion, and later deposits are released from that allotment. Player plants continue to buy through the shared Vesper Market.
- The replay can run either 7 days or 365 days from a deterministic seed. Both use the normal Vesper tick rules, NPC companies, bot trades, weather/news events and the same fixed endowment. It does not alter live player balances or the live market.

## Resource quantities

The fresh Vesper Market endowment is configured in `packages/sim/src/town/config.ts`:

| Resource | Fixed market endowment |
| --- | ---: |
| Natural gas | 25,000,000 MMBtu |
| Diesel | 75,000,000 L |
| Carbon permits | 900,000 t |
| Steel | 180,000 t |
| Turbine parts | 5,000 kits |

The private regional grid allotments are configured in `packages/sim/src/region/config.ts`: 36,000,000 MMBtu of gas and 60,000,000 L of diesel per saved region. They represent the grid simulation's local supplier pool; they are a separate ledger from the shared Vesper Market.

## Save migration and current limits

Old Vesper Market saves are not reset. The migration records the amount historically imported in the old ledger, keeps current balances, and does not add a new reserve or allow new finite-resource imports. Historic consumption predates this feature and cannot be reconstructed as a genesis-wide cap.

Old regional saves receive a one-time reserve migration based on their current held resources and the configured regional allocation, then use finite refills thereafter. The live Vesper Market endowment is shared across players, but each player's private grid simulation currently has its own fixed regional allotment. The two ledgers are not globally reconciled across all saved regions, and the UI labels them separately. A single global cap across every player's regional supplier accounts would require shared allocation and burn reconciliation across region saves.

The current integration does not add exploration, player-controlled extraction, recycling, or player economic professions. The fixed deposits and market/grid constraints bring finite-resource strategy into BLACKOUT's existing power-company loop without replacing it with a separate mining game.
