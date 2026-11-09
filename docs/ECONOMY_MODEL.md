# Economy model

The economy is the gameplay: players run power companies, NPCs run businesses, and money moves only when someone
pays someone. This page is how money circulates and the rules that keep it honest.

## Who pays whom

```
                 ┌──────────── treasury (fixed supply, minted once) ─────────────┐
                 │ grants: player starting capital, NPC capital, grid & world floats│
                 └──────┬───────────────┬───────────────┬──────────────┬─────────┘
                        ▼               ▼               ▼              ▼
   players' companies ◀──power sales── grid clearing     NPC companies   outside world
        │   ▲               (homes, businesses,   │   ▲           (importers, customers)
        │   │                VoltLine, builders)   │   │                 ▲     │
        │   └──── escrow: companies buy power ─────┘   │                 │     │
        │                                              │                 │     │
        └── fuel, steel, kits, permits ──▶ merchants ──┴── imports ──────┘     │
            certificates ◀──────────────── merchants ◀──── outside customers ──┘
```

* **Players** earn from their region (homes and businesses pay for electricity: on chain, the grid clearing account
  pays), from NPC companies that buy their spare power (escrow, signed by the company), and from merchants who buy
  their certificates and pay dividends. They spend on fuel, steel, kits and permits (merchants), and on building,
  maintenance and energy bought for contracts (grid clearing).
* **Merchants** sell to players and to outside customers (paid by the world), buy imports (paid to the world), pay
  rent (to the world), and close when they run out of money.
* **NPC power companies** (`packages/sim/src/town/firms.ts`):
  * *Halvard Aluminium* buys power and sells aluminium to the outside world: revenue only for power it actually got.
  * *Solara Energy* sells its panels' output to the water utility (paid by the world, by the kWh delivered) and buys
    backup when clouds or night cut its panels; it pays a penalty for every promised kWh it can't cover.
  * *Northwind Gas Power* sells power, and buys the gas for every MWh it sells from Ingrid or Bayo, at their price.
* **The grid clearing account** stands for everything inside players' regions (households, firms, VoltLine, banks,
  builders). Each region is a private simulation, so these actors are aggregated into one funded account rather than
  given wallets that every new region would fund again.
* **The outside world** is everything beyond Vesper. It is funded from its own treasury bucket and paid back by
  imports, so it can run low, and when it does, outside customers stop paying: a recession, not a mint.

## Invariants (tested)

* Every transfer: sender down by X, receiver up by X. The total supply never changes except by `issue` (owner-only,
  capped) — `town.test.ts`, `firms.test.ts`, `economy_tests.rs`, `economy.test.ts`.
* Producing electricity creates no money. A company is paid only when a named counterparty pays it: the buyer of the
  power, the water utility, the buyers of aluminium (`firms.test.ts`: "never create money").
* An NPC cannot spend money it does not have: it plans within cash − escrow − a day's fixed costs, and the contract
  refuses an escrow above its balance or its limits (`economy_tests.rs`: "cannot spend money it does not have").
* NPCs can go broke: below a fifth of a day's costs they stop trading; outside investors rescue them after two days,
  from the world account (`firms.test.ts`).
* Promised money is never shown as paid: an order is "paying into escrow", "delivering", "confirming delivery", then
  "paid" only after the confirmation is final. Escrowed amounts are shown separately from cash.

## The power desk: decisions

Every 36 market ticks (3 market hours, ~36 s), `firmPolicy.ts`:

* Halvard pays up to 85% of what a MWh of aluminium is worth, within what it can afford, cheapest offers first.
* Solara buys the gap between its promise (20 MW) and what its panels make (sun × cloud), if backup is cheaper than
  the penalty.
* Northwind offers its 25 MW at `gas ask × heat rate × 1.35 + running costs`, limited by the gas it can afford.
* Players offer their spare capacity (`region/powerOffer.ts`): available minus dispatched, at the higher of their
  marginal cost and their node's price, plus their markup (default 15%; adjustable in MARKET).

Each decision is stored with its reasoning, built from the numbers the company used, and shown in MARKET.

## How delivery is real

A power contract becomes a firm load at the seller's node in their region's market (`engine.ts`, `export:` bids).
The seller buys that energy from the regional market at the node price (so contracts can lose money when the region
is dear), and delivered kWh are measured interval by interval. If the region is short, contract loads are curtailed
first (they are "flexible"), and the buyer pays only for what arrived; the rest of its escrow comes back.

## Starting sizes (from the game's own numbers)

| Who | Start | Why |
|---|---|---|
| A new company | ₡300,000 | `STARTER_GRANT_CC`, unchanged from the game |
| Nine merchants | ₡375,000 total | their configured cash |
| Halvard / Solara / Northwind | ₡400,000 / ₡250,000 / ₡300,000 | about 10–20 days of their fixed costs |
| Grid float | ₡20 million per tranche | a busy player nets ₡50k–₡200k a game day |
| World float | ₡10 million per tranche | merchants' and companies' outside sales |

A simulated week (`firms-week` check, seed 7): Halvard +18%, Solara +29%, Northwind −2% (thin margins), a player
offering 20 MW earned ₡223k from the companies; credits summed to zero every tick.
