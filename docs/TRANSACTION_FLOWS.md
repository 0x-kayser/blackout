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
3. The market's next epoch (every 72 s) contains the player's −credits and the merchant's +credits and −fuel.
   `EconomyService.queueSettlement` turns it into **one** `settle_batch` signed by the operator: the player's credits
   from their wallet to the merchant's account, and the fuel from the merchant's account to grid custody (it is
   delivered into the player's plants, which burn it off chain). Credits and fuel move in the same transaction, or
   neither does (`economy_tests.rs`: "batch settlement moves credits and items together").
4. A retry of the trade returns the stored result; a retry of the batch is refused on chain (`Epoch already settled`).

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

## Flow D — player-to-player equipment sale

**Not wired into the game.** The contract supports it atomically (`plant_list`, then `plant_buy` moves the buyer's
credits to the seller and the NFT to the buyer in one call; the plant's own account and balances follow the token),
and the relayer accepts a player-signed `plant_buy`. What's missing is moving a physical plant between two players'
regions. Meanwhile, plants a player owns are minted to their wallet and leave it when they sell to an NPC
(`EconomyService.syncPlants`), so on-chain ownership follows the game.

## Failure handling (tested in `tests/integration/economy.test.ts`)

| What goes wrong | What happens |
|---|---|
| The company's escrow is refused (limit, balance, kill switch) | order **failed** with the reason; its reservation released; no export, no money |
| The response is lost | op stays **submitted**; looked up later; contract read decides; never sent twice |
| A grant or batch is retried | refused on chain (single-use id) and recognised as already done |
| The grid float is short | batch **failed** as transient; floats topped up from the bucket; retried |
| Nobody confirms a delivery | after the deadline anyone can call `power_order_expire`: full refund to the buyer |
| NPC spending is switched off | server stops placing orders; contract refuses any that arrive |
