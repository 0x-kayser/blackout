# Plan: Vesper Fuel Exchange (a shared, cross-city market on NEAR)

Status: **phases 1–6 implemented and tested locally (2026-11-08).** Nothing is deployed: the Testnet run needs the
operator's funded account and Supabase project (see "Your steps" at the end).
Written against the working tree at `31ccc5f` + uncommitted marketplace work.

## Why

Two weaknesses found in the track audit, one fix:

1. **NEAR has no job only a chain can do.** Every city is one player's private save on our server. Putting that city's
   fuel receipts on-chain only makes the receipts public.
2. **The game is single-player.** Nobody trades with, competes with or depends on another human, and nothing happens
   while you're away.

A market *shared by every city* fixes both. No single save owns it, players depend on each other's surplus and
shortages, and your fuel can sell while you're offline. NEAR becomes the neutral ledger for that shared market: who
holds which fuel on the exchange, what is locked in an order, and every fill.

The one-line answer to "what is NEAR doing here?" becomes:
**"Your city runs on our server. The regional fuel exchange that every city trades on runs on NEAR."**

## Player experience

- **Warehouse.** Your city tank holds 60 L. The exchange gives you a warehouse on top of it. Move fuel from tank to
  warehouse and back. Warehouse fuel is yours on the exchange and can be listed or brought home.
  Gameplay: stockpile before an oil shock, sell into someone else's shortage. A small daily storage fee is a credit
  sink that stops endless hoarding.
- **Sell.** Post an ask: a quantity and a price per litre. Other players or exchange traders buy it, even while you're
  offline.
- **Buy.** "Buy 20 L at the best price" walks the asks from cheapest up. The fuel lands in your warehouse, with a
  one-tap "deliver to tank".
- **While you were away.** On return: "Northline Haulage bought 20 L of your diesel for ₡262. Your 40 L ask is still
  open." This is the hook that brings players back.
- **Why prices differ between cities.** Each city follows its own Brent week and has its own world events (both
  already true in the sim). City A can be in a shortage while city B has surplus. That spread is the opportunity, and
  it's what makes players depend on each other.
- **No chain friction.** No wallet, no gas, no pop-ups. Trades show as "Delivering…" for the second or two NEAR takes
  to finalise. The Verify panel links every fill to its transaction.

## Who is on the exchange

| Actor | On-chain identity | Signs its own transactions? | Policy |
|---|---|---|---|
| Players (registered only) | Player id `p<hash>.<vault>` (contract-held balance; the account need not exist yet) | No. The operator signs within a namespace the contract enforces (see below) | Human |
| 3 exchange traders: Harbor Import Terminal, Northline Haulage, Kettle & Sons | Real Testnet accounts, e.g. `bo-harbor-terminal.testnet` | **Yes**, function-call keys limited to `npc_*` exchange methods | `packages/sim/src/policies/exchangeTraders.ts` (one readable file) |

The traders are the "NPCs with wallets". They hold **finite on-chain diesel** and a finite off-chain credit budget.
They post asks and standing bids priced from replacement cost, their own inventory, recent exchange volume and the
Brent index. They import (mint) only when their inventory and cash allow, with a lead time. They can run short, widen
spreads, ration or stop buying when cash runs out. That is the same economic logic local merchants already use, now
acting on a market shared by every player.

Traders also provide **liquidity**. The market works with a single player at a demo, and gets richer with more.

## Custody and trust model (stated honestly)

- **Fuel on the exchange is on-chain.** Warehouse balances, open asks (escrow) and trader inventories are NEP-245
  balances. Total diesel supply on the contract equals exchange fuel. Fuel in city tanks stays in the game save
  (off-chain).
- **Boundary = mint/burn.** Tank → warehouse: the city ledger debits fuel and the operator calls `exchange_deposit`,
  which mints to the player's id. Warehouse → tank: `exchange_redeem` burns, then the city ledger credits fuel.
  Consumption no longer has to be reconciled on-chain (no `settle_day`), because burned fuel never left the city.
- **Credits stay off-chain**, fictional and non-redeemable. Each purchase reserves the buyer's credits in their city
  and pays the seller only after the on-chain transfer confirms. It's the same two-phase pattern the current listing
  flow uses.
- **What the contract enforces.** The operator can move balances **only** for ids inside its player namespace
  (`*.<vault>`). It can never move a trader's or any external account's tokens. Traders move only their own tokens.
  Escrowed fuel can't be listed twice, and every fill and deposit id is single-use.
- **What players trust the server for.** That a deposit was really backed by tank fuel, and that credits are paid.
  The DB-vs-chain reconciler below makes that checkable.
- **Ownership upgrade (optional, phase 6).** Because `p<hash>.<vault>` is a sub-account name only the vault can create,
  a player can later *claim* it: we create the account with the player's own key, and their warehouse becomes
  self-custodied. No one needs this to play.

## Contract changes (`contracts/near/src/lib.rs`)

Keep the NEP-245 core. Add:

| Method | Caller | Effect |
|---|---|---|
| `exchange_deposit(player, amount, deposit_id)` | operator | Mint `DIESEL_100ML` to `player` (must be in `*.<vault>`); `deposit_id` single-use |
| `exchange_redeem(player, amount, redeem_id)` | operator | Burn from `player`; single-use id |
| `exchange_ask(owner, order_id, amount, unit_price_cc)` | operator (player ids) **or** the trader itself | Move `amount` from owner to escrow; record order |
| `exchange_cancel(order_id)` | operator (player orders) / owning trader | Escrow → owner |
| `exchange_fill(order_id, buyer, amount, fill_id)` | operator (player buyer) / buying trader | Escrow → buyer; supports partial fills; `fill_id` single-use |
| `npc_import(amount, import_id)` | trader | Mint to self, capped per day by `register_trader(max_import_per_day)` |
| `exchange_order(order_id)`, `exchange_fill_status(fill_id)` | view | For reconciliation |

Also fix the approval deviations found in the audit (`mt_is_approved` signature, `mt_revoke_all`) and remove
`custodial_*`, `npc_transfer` and `settle_day` once the old flows are retired. Emit `mt_mint`, `mt_burn` and
`mt_transfer` events for every move.

## Backend

**Engine (pure, deterministic, `packages/sim/src/exchange/`)**
- `state.ts`: the order book, trader inventories and cash, the exchange ledger (double-entry), and the price history.
- `matching.ts`: price-time priority, partial fills, the price band (0.5× to 3× replacement cost) that blocks credit
  laundering between accounts.
- `policies/exchangeTraders.ts`: one file, with every decision returning a `reasons` object for the tooltip (as
  `merchantPricing.ts` does).
- The exchange ticks every 30 s of wall time, independent of any city, so it keeps running when every player is
  offline.

**City side (`packages/sim`)**: new system actions, never accepted from clients:
`EXCHANGE_DEPOSIT_RESERVE / _RESULT`, `EXCHANGE_REDEEM_RESULT`, `EXCHANGE_BUY_RESERVE / _RESULT`,
`EXCHANGE_SALE_SETTLED`. Cross-city money and fuel go through a per-city `world:exchange` account, so each city's
ledger still sums to zero. A new global invariant test checks that the sum of every city's `world:exchange` balance,
plus the traders' balances, equals zero. Cities stay deterministic from seed + action log, because exchange
outcomes are recorded actions, exactly like `SETTLE_TRADE` today.

**API (`apps/api`)**
- Migration `005_exchange.sql`: `exchange_orders`, `exchange_fills`, `exchange_jobs`, `exchange_snapshots`,
  `player_chain_ids`.
- `ExchangeService`: serialises all order-book changes in one SQLite transaction. Uses sagas with idempotency keys
  across buyer city, seller city and chain, and reuses the worker's rules: persist the hash before broadcast,
  reconcile by hash then by contract view, never refund an unknown outcome.
- Routes:
  - `GET /api/exchange/book`
  - `GET /api/exchange/history`
  - `POST /api/exchange/deposit|redeem|ask|cancel|buy` (registered players only; guests can browse)
- Reconciler job: compare `mt_supply`, each player's balance and open escrow against the DB every few minutes; show
  the result in Verify ("Exchange in balance ✓ — last checked 12:04").

**Abuse controls**
- Registered accounts only.
- Starter fuel can't be deposited (only fuel bought from a merchant or the exchange).
- Daily deposit caps.
- The price band.
- Challenge runs excluded.

## Frontend (`apps/web`)

- **Exchange panel** (new toolbar tab):
  - best ask and bid, a 24-hour price sparkline, and a "your city vs exchange" price comparison;
  - Warehouse card: a tank ⇄ warehouse slider and storage fee;
  - Sell form and My orders (status, partial fills, cancel);
  - Buy form showing which asks it will walk.
- Trader cards reuse the merchant card, with the "See reasoning" tooltip.
- A "While you were away" card on return, plus ticker headlines for big fills and trader shortages.
- **Verify**: contract id, every deposit, fill and redeem hash, the reconciler status, and trader account links. No
  chain words outside Verify.

## Retire or keep

- **Local merchant purchases go off-chain.** They become plain city simulation, which removes today's mismatch
  between on-chain merchant stock (5,000 L) and sim stock (30–200 L) and the "pending" step on every local purchase.
- **Today's NPC listing flow is replaced by the exchange.** Your local merchants can still buy from you: their restock
  logic gains "buy from exchange if cheaper than import" (phase 5).
- The Economy Lab replay stays standalone. It can add a simulated exchange with bot players later.

## Phases

| # | Work | Size | Depends on |
|---|---|---|---|
| 0 | **You:** funded Testnet parent account; Supabase project with Google + email | — | — |
| 1 | ✅ Contract methods + Rust tests (namespace guard, partial fills, single-use ids, mint/burn caps) | M | — |
| 2 | ✅ Exchange engine + trader policy + invariant tests (pure TS, no chain) | M | — |
| 3 | ✅ City system actions + migration + `ExchangeService` + routes + fake-RPC tests | L | 1, 2 |
| 4 | ✅ Exchange panel, away card, Verify additions, Playwright journey (two players, one sells, one buys) | M | 3 |
| 5 | ✅ Bootstrap v2, reconciler, retire old chain legs (behind a flag) · ⏳ deploy + record hashes (needs your account) · ✅ town merchants restock from the exchange traders | M | 0, 3 |
| 6 | ✅ Optional: claim a warehouse as your own NEAR account | S | 5 |

Phases 1 and 2 can run in parallel. The phase 4 UI can start against stubbed routes once phase 3's route shapes are
fixed.

## What landed (phases 1–2)

**Contract** (`contracts/near/src/lib.rs`, tests in `contracts/near/src/tests.rs`; 27 Rust tests pass, the WASM builds)
- `register_trader`, `exchange_deposit`, `exchange_redeem`, `exchange_ask`, `exchange_cancel`, `exchange_fill`
  (partial fills), `npc_import` (per-UTC-day cap). Views: `exchange_order`, `exchange_op("<kind>:<id>")`,
  `trader_config`, `player_namespace`.
- The operator can act only on ids ending in `.<operator_id>`, and traders only on themselves. Tests cover:
  - the operator trying to move or route a trader's tokens;
  - deposits to external accounts or look-alike names (`evilvault.testnet`);
  - one trader acting for another, or for a player;
  - reused deposit, fill and import ids;
  - overfilling an order, filling a filled order, or buying your own order;
  - the daily import cap and its reset.
- `mt_revoke_all` added. `mt_is_approved` keeps its documented `owner_id` deviation.
- The old `custodial_*`, `npc_transfer` and `settle_day` methods are **still present**, so today's API keeps
  working; remove them in phase 5.

**Exchange engine** (`packages/sim/src/exchange/`, exported as `exchange` from `@blackout/sim`; 13 tests in
`packages/sim/test/exchange.test.ts`)
- **Two-phase operations.** Every operation is reserved, then settled. Each returns `ChainEffect`s (what to submit to
  NEAR, using the contract's single-use ids) and `CityEffect`s (what to apply to a player's save). Phase 3 turns these
  into jobs.
- **Settlement helpers.** `settleChainOp` takes a verified outcome. `settleAllPending` confirms everything at once
  and is meant for sandbox mode and tests.
- **Trader rules** live in `packages/sim/src/policies/exchangeTraders.ts`. There are three traders: Harbor Import
  Terminal, Northline Haulage and Kettle & Sons. They price from import cost, scarcity and yesterday's flow, never
  sell below cost plus margin, and never bid at or above import cost. They ration at their reserve floor, restock
  within cash, cap and lead time, stop buying when cash runs out, and recover from sales.
- **Checks.**
  - `exchangeInvariants` runs after every tick in the tests: each asset sums to zero, escrows match open and pending
    orders, and no order is oversold.
  - `expectedChainBalances` is what a reconciler will compare against the contract (not built yet; see below).
  - A 7-day scripted run with three players is byte-identical across reruns, and its prices and volumes change over
    the week.

**Defaults taken for the open decisions** (all easy to change)
- Exchange actions are meant for signed-in players; the engine itself is identity-agnostic, and enforcement lands in
  phase 3.
- Storage fee: `storageFeeBps: 100` (1% of import-cost value per exchange day).
- Local purchases are untouched for now.

## What landed (phase 3)

**City side** (`packages/sim/src/exchangeCity.ts`). There are three new system actions that clients can never send:
- `EXCHANGE_DEPOSIT`: tank → `world:exchange`. Only bought fuel that isn't promised to a customer can leave
  (`player.exchangeEligibleFuelMl`); starter fuel can't.
- `EXCHANGE_BUY_RESERVE`: holds credits in `escrow:exchange` while a purchase settles.
- `EXCHANGE_EFFECT`: credit, capture/release payment, deliver/refund fuel, storage fee.

Every city stays deterministic from seed + action log, and the 7-day replay hash is unchanged. The public player
state gains `exchangeDepositableFuelMl` and `exchangeReservedCc`.

**Server** (`apps/api/src/exchange.ts`, migration `005_exchange.sql`)
- **Atomic changes.** `ExchangeService.mutate` runs the engine on a copy and refuses any change that breaks an
  invariant. State, events, ledger, chain jobs and city effects commit in one SQLite transaction.
- **City effects** are applied to the player's city as idempotent actions (`xfx:<effectId>`), so each lands
  exactly once, including across restarts.
- **Clock.** One tick every 5 s (`startExchangeDriver`). Each exchange day follows one observed 2026 Brent week,
  like the cities. Finished records are pruned daily.
- **Sandbox mode** (the default until traders are configured): chain operations settle immediately with **no
  transaction hash**.
- **Testnet mode** turns on when chain mode is on and every `NEAR_TRADER_*` variable is set. Then
  `processExchangeJobs` (`apps/api/src/workers.ts`):
  - submits each operation with the right signer (`exchangeCall` in `apps/api/src/chain.ts`);
  - persists the hash before broadcast;
  - reconciles by hash, then by the contract's own records (`exchange_op` / `exchange_order`);
  - never re-broadcasts, and never settles an outcome it can't see.

**Routes** (`apps/api/src/exchangeRoutes.ts`). Every write is idempotent per player and key, and a retry returns
the first result.
- `GET /api/exchange`: the book, the traders with their reasons, your warehouse, orders and fills, recent events
  ("while you were away"), and `canTrade` with the reason when you can't.
- `POST /api/exchange/quote`
- `POST /api/exchange/deposit`
- `POST /api/exchange/redeem`: checks tank room first.
- `POST /api/exchange/asks`
- `POST /api/exchange/asks/:orderId/cancel`
- `POST /api/exchange/buy`: rolls back the city's credit hold if the exchange refuses.

Trading needs a signed-in account; guests can browse. `EXCHANGE_ALLOW_GUESTS=true` opens trading to guests for
local demos.

**Tests** (`tests/integration/exchange.test.ts`, 8 tests)
- **Sandbox:**
  - two-player deposit → ask → buy → take home;
  - the seller is paid while offline;
  - starter fuel is refused;
  - retries are replayed;
  - a trader discovers a cheap ask;
  - an unfillable buy leaves credits untouched;
  - guests are blocked by default;
  - state survives a restart.
- **Testnet against a fake RPC:**
  - every operation maps to the right contract call and signer;
  - a deposit stays pending until confirmed, then settles once with the real hash;
  - lost broadcasts are never re-sent or settled;
  - contract-record reconciliation works;
  - a definite failure refunds the tank.

**Not built yet (moved to phase 5):**
- The periodic reconciler that compares `expectedChainBalances` with live contract balances.
- The Verify panel's "exchange in balance" line.
- Bootstrap v2: trader accounts, keys and starting stock.

**Notes for deploy**
- The contract's storage layout changed, so the next deploy must be a **fresh account**. That's fine, because nothing
  is deployed yet.
- The contract pays storage for new player ids, orders and receipts from its own balance; fund the contract account
  accordingly.
- Engine import caps are per exchange day (4 minutes), while the contract caps per UTC day. Set the on-chain
  `max_import_per_day` to at least the engine's daily cap × 360 exchange days per UTC day, or reduce how often
  traders import.
- Trader start stock must be minted to the trader accounts at bootstrap, and player ids must be `p<hash>.<vault>`.

## Done means (judge demo)

1. Player A (Google) moves 30 L from tank to warehouse and lists 20 L at ₡12/L. Verify shows the deposit and the
   listing escrow on Testnet.
2. Player B (email, different city, in a shortage) buys 20 L. The fill hash appears and B's tank fills. A is offline.
3. A returns and sees "Player B bought 20 L for ₡240", and A's credits went up.
4. Northline Haulage runs low, raises its ask and stops bidding. Its reasons tooltip says why, and its on-chain
   balance on the explorer matches.
5. The reconciler reads "in balance", and `mt_supply` equals the fuel on the exchange.

## Decisions for you

1. Local purchases off-chain, NEAR for the exchange only (recommended), or keep both?
2. Exchange for signed-in players only, with guests browsing (recommended)?
3. Should warehouse storage cost a daily fee (recommended: small, ~1% per game day)?

## What landed (phases 4–6)

**Phase 4: the Exchange in the game.** These live in `apps/web/src/ui/Exchange.tsx` and `apps/web/src/api/exchange.ts`.
- **Toolbar tab.** A new Exchange tab (hidden during the weekly challenge) opens the trading screen.
- **Live prices.** The top strip shows what traders sell at, what they buy at, the last trade, import cost and a
  price trend.
- **Opportunity hint.** It compares the board with your own town's merchants. For example, it can tell you the
  exchange is cheaper, or that traders pay more than your merchants charge.
- **Warehouse controls.** Move fuel between tank and warehouse, see the storage fee, and get a clear reason when
  starter fuel can't be sold.
- **Selling.** One-tap prices ("Sell fast" at the best bid, "Undercut", "Hold out") and an instant-sale hint.
- **Buying.** A live quote across sellers before you commit.
- **Order book, traders and your trades.** Depth bars, each trader's status and reasoning, and your offers and
  fills with progress.
- **Sign-in prompt.** When trading is locked for a guest, the panel shows the sign-in options inline.
- **"While you were away" card.** On return it tells you what sold, for how much, and to whom.
- **Market panel.** The old "sell to local merchants" section now points to the Exchange.
- **Verify panel.** It now leads with the exchange: settlement mode, contract, vault, your exchange id, trader
  accounts, the reconciler result and your exchange transaction hashes. It no longer lists environment-variable
  names to players.
- **Playwright journey.** City A sells to a trader; city B, a separate player, buys from the same board and takes it
  home. All 8 browser journeys pass.

**Phase 5: Testnet readiness.**
- **Bootstrap v2** (`scripts/near-bootstrap.ts`):
  - creates the three trader accounts and mints each exactly the starting stock the engine expects;
  - registers them with a daily import cap;
  - gives every key only its own methods: operator `exchange_*` (plus legacy `custodial_*`), traders `npc_import`
    and `exchange_ask`/`_cancel`/`_fill`;
  - writes `NEAR_TRADER_*` and `NEAR_CITY_PURCHASES_ON_CHAIN=false` to `.env.chain`.
- **City merchant purchases are local simulation by default.** The old per-city on-chain leg and player listings
  stay available behind `NEAR_CITY_PURCHASES_ON_CHAIN=true`, and their tests still pass. NEAR's job is now one
  thing: the shared exchange.
- **Reconciler** (`apps/api/src/reconciler.ts`). Every 60 s it compares each trader, the contract escrow and each
  player warehouse with `mt_balance_of`. It skips the check while operations settle, reports mismatches without
  "fixing" them, and shows the result in `/api/chain/status` and the Verify panel.
- **Mode guard** (migration `006`). A sandbox exchange can never quietly continue as a Testnet one. The server stays
  in the saved mode and explains how to reset.
- **Town merchants restock from the traders (built after phase 6).** Every `MERCHANT_RESTOCK_ORDERED` in a player's
  city draws that fuel from the traders' wallets (`supplyCities`; on-chain the trader burns it with
  `npc_supply_city`). Each new shift the city receives the traders' scarcity premium as a recorded
  `EXCHANGE_PRICE_SIGNAL` action, which feeds its merchants' import cost. Each city's replay stays exact, because
  the signal is in its action log.

**Phase 6: optional self-custody.**
- **Contract.** `release_to_owner()` is called by the player's own namespaced account once it exists. It needs no
  open offers; after it, the operator can never move that id again. `is_released` is the matching view, and open
  offers are counted per owner, so escrow can never be stranded. There are 2 new Rust tests (29 in total).
- **Operator script** (`scripts/claim-warehouse.ts`). Run on request, it refuses while offers or operations are open
  and creates `p<hash>.<vault>` with the player's public key, using the vault's full-access key from
  `.near-credentials` (never the server env). It then marks the player self-custodied (migration `007`), and the
  API stops acting for them.

## The fun layer (shipped alongside)
- **Daily goals and streaks** (`packages/sim/src/goals.ts`). Every game day brings three goals, paid by the City
  Council fund: earn X, keep N businesses lit, finish N contracts, answer a Code Red, sell on the Exchange. Finish
  all three to grow a streak worth +10% rewards per day, up to +50%. The goals card sits on the map and works on
  mobile.
- **Code Red emergencies.** From day 2, about 15% of calls are emergencies: double pay, no haggling, a 7-second
  timer and a reputation penalty if missed. They show as a pulsing red card with a countdown, a red burst on the
  map and an optional siren.
- **Calmer feedback.** At most three toasts at once, no toasts for the rival's own deliveries, and synthesized
  sounds (off by default) for restores, rewards and sales.
- **Replay hash.** These are new game rules, so the 7-day replay trace changed to
  `88ce1e2740a9e7d09b22cee4ab05ff66c1cc95155f36deae11910fa9ff46607c`. It is still deterministic and identical on
  every rerun, and `docs/examples` were regenerated from a real run.

## Your steps to go live
1. A funded Testnet parent account. Then run `pnpm build:contract` and
   `NEAR_PARENT_ACCOUNT_ID=… NEAR_PARENT_PRIVATE_KEY=… pnpm chain:bootstrap`.
2. Copy `.env.chain` into the server env and start with an **empty** database, or delete the exchange tables.
   `/api/chain/status` should show `exchange.mode: "testnet"`.
3. A Supabase project with Google and email (`docs/AUTH_PROVIDER_DECISION.md` → "Turning it on").
4. Play the demo path once and record the contract id, trader accounts and the deposit, offer, fill and redeem
   hashes in `docs/CHAIN_EVIDENCE.md`.

