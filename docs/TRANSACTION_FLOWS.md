# Transaction flows

Every chain operation is one row in `chain_ops` (migration 013) with a deterministic id. Lifecycle:

```
created ──submit──▶ submitted ──FINAL, success──▶ settled ──▶ effects applied once (effects_applied = 1)
                       │   └──FINAL, failure──▶ failed (retried only if transient: low float, nonce, timeout)
                       └──no answer──▶ looked up by hash, then by reading the contract (grant / power_order / epoch / nft_token)
local  (no chain configured: recorded, never sent)
```

Power orders add their own states in the game (`firms.ts`): **placing** (escrow submitted) → **open** (escrow
confirmed; the seller delivers) → **awaiting** (window over, delivery measured) → **settled** (confirmation final;
seller paid, buyer refunded the rest), or **failed** (the escrow never happened; nothing moved) / **expired**
(nobody confirmed; the buyer was refunded in full).

## Flow A — a player buys fuel from an NPC merchant

1. MARKET → a merchant → Buy (`POST /api/town/trade`, idempotency key from the client).
2. `TownService.trade` prices it with `merchantPricing.ts`, checks the merchant's stock and the player's cash, and
   records it on both ledgers in one synchronous step (or not at all).
3. `TownEpoch` records the player's −credits, merchant's +credits and item movement. After the player wallet's resource
   baseline is confirmed, `EconomyService.queueSettlement` submits these as a zero-sum `settle_batch`: credits move
   between the player's assigned Testnet account and the merchant; the NEP-245 resource moves between the merchant
   account and the player's assigned account. Before that boundary, trades stay against shared world custody and the
   bootstrap reads the player's current inventory before transferring it once.
4. Region epochs separately account for resource consumed by the simulation. They subtract market trade flows, convert
   the player's net inventory change to whole NEP-245 units, and batch consumed units back to world custody. Fractional
   simulation units remain off chain until a whole token unit is gained or consumed. Consumption returns units to the
   custody pool; it does not burn or redeem them. No transaction is sent for each simulation tick.
5. A retry of the trade returns the stored result; a retry of the batch is checked against the contract's unique epoch
   ID and reconciled by reading `epoch` after an unknown outcome. The batch is zero-sum and succeeds in full or not at all.

## Flow B — an NPC buys electricity from a player (the main demonstration)

1. A storm (or night) cuts Solara's panels; Halvard always needs power. At the window boundary each company runs its
   rule (`firmPolicy.ts`) over the offers it can see, including players' spare capacity (`regionPowerOffer`).
2. The company decides, e.g. *"Short 12 MW: buying 12 MW from Harbor Volt at ₡94/MWh, cheaper than the ₡165/MWh a
   missed kWh costs it."* The order is created in state **placing**, its escrow reserved from the company's cash.
3. `EconomyService.queueOrder` → op `order:<id>`: **`power_order_place`, signed by the company's own account**,
   paying `ceil(kWh × price / 1000)` credits into escrow, `seller_id` = the player's wallet. The contract checks the
   company's limits and balance.
4. Confirmed → the order is **open** → the player's region gets a `POWER_EXPORT`: a firm load at their node for the
   rest of the window. Their plants run harder; they buy that energy from their regional market.
5. Window over → the region reports delivered kWh → op `confirm:<id>`: **`power_order_confirm`, signed by the
   operator**. The contract pays the player's wallet for what was delivered and refunds the rest to the company.
6. Confirmed → the order is **settled** in the market ledger and the player's region gets a `POWER_PAID` of exactly
   the amount the contract paid (idempotency key `pw:p:<order>`: applied once, ever).

The company's decision, the escrow transaction and the confirmation are all in MARKET → Power companies → Recent
deals, with links to both transactions.

## Flow C — an NPC buys from another NPC

Same as B with the seller `vesper-northwind…`. Northwind bought the gas for the MWh it sold from Ingrid or Bayo at
their price when it committed (a market trade from its own wallet, settled in the next market batch), so it delivers
in full and the operator confirms the whole order.

## Flow D — a player sells a plant to another player

1. MARKET → Plants for sale → *Sell one of yours* (`POST /api/plants/list`). The plant is locked in the seller's region
   (it can't also go to VoltLine) and the operator lists its NFT for the seller: `plant_list` (`plantMarket.ts`).
2. Another company presses **Buy** (`POST /api/plants/buy`). The price is held in the buyer's region at once.
3. One transaction, `plant_buy_for`: the buyer's credits go to the seller and the NFT (with its plant account) to the
   buyer, atomically; a stale or short sale is refused whole.
4. Final → the plant leaves the seller's grid (`PLANT_OUT`, price paid) and joins the buyer's where it stood, with its
   health, charge and token id (`PLANT_IN`). Refused → the held price goes back and the plant stays for sale.

Live on testnet (2026-11-09): Eastside Battery, ₡20,000, one transaction
[GBTrhzDT…](https://testnet.nearblocks.io/txns/GBTrhzDTGGq8krMmuXdca2tGo3JqURgBqSANs9sdHQU6) carrying both the `mt_transfer` (credits buyer → seller)
and the `nft_transfer` (NFT seller → buyer); the listing was [G9cETXth…](https://testnet.nearblocks.io/txns/G9cETXthZq2A3grjnFgERDMAnPk3RPe9Phpu9hF6jdRX).

## Failure handling (tested in `tests/integration/economy.test.ts`)

| What goes wrong | What happens |
|---|---|
| The company's escrow is refused (limit, balance, kill switch) | order **failed** with the reason; its reservation released; no export, no money |
| The response is lost | op stays **submitted**; looked up later; contract read decides; never sent twice |
| A grant or batch is retried | single-use grant/epoch ID is read back from the contract and recognised as already done |
| The grid float is short | batch **failed** as transient; floats topped up from the bucket; retried |
| A resource market batch is ahead of the inventory snapshot | Town item settlement is held until the baseline lands; later region debits wait for unsettled market item credits |
| Nobody confirms a delivery | after the deadline anyone can call `power_order_expire`: full refund to the buyer |
| NPC spending is switched off | server stops placing orders; contract refuses any that arrive |
