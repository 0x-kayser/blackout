# Decisions log

Each entry: decision · why · consequence. Newest last.

## D0 — Inputs and scope
* **`00_BLACKOUT_SHARED_PRODUCT_SPEC.md` was not available** on the build machine. The binding inputs used were the
  backend brief, the frontend prompt (`01_…TERRA_FRONTEND.md`, read only to
  shape the DTOs) and the design PDF (`Blackout Game Loop Design1.pdf`). Where the PDF and prompt disagree the prompt
  wins (e.g. 15 s settlement instead of 20 s; Day 1 skips the market). **If the shared spec contradicts anything here,
  please flag it.**
* Official sources checked on 2026-11-07: NEP-245 (`near/NEPs/neps/nep-0245.md`), hackathon rules
  (`nearhackathon.com/HACKATHON.md`, deadline 2026-11-14 23:59 UTC, LICENSE required), games track brief.

## Fixed-point representation
* Credits in centi-credits, power in W (100 W quanta), energy in Wh, diesel in mL, CO₂ in mg, ratios in bps.
  0.3 L/kWh becomes "3 mL per 10 Wh" and 2.68 kg/L becomes "2680 mg per mL", so every per-tick fuel and CO₂ amount is
  an exact integer. 100 W quanta make `W/10 Wh` per tick exact.
* Money derived from energy uses a **cumulative floor** (`billed = floor(totalWh × rate / 1000)`), so billed never
  exceeds delivered energy and rounding never drifts. Leftover escrow from rounding is refunded at completion.
* Business revenue per tick accumulates in milli-credits with a carried remainder.

## Time
* 1 tick = 1 s = 6 game minutes. The engine has no wall clock; the API driver maps seconds onto ticks.
* Pause policy: runs start paused until an SSE client connects, auto-pause after 15 s without clients, never
  fast-forward more than 5 s after a stall. Chosen over "server keeps running" because a single-player 15-minute
  session should not be lost to a sleeping laptop, and over "client-driven ticks" because clients are untrusted.
* Tutorial requests (Day 1 waves 1–3) have no timer and stay open until the day ends.

## Engine shape
* `nextState(state, actions)`: applies actions in order (each atomic; failures reported, not applied) then one tick.
  `applyAction` / `tick` are the pure single-step forms; `*Mut` variants exist for the server driver and replays.
* RNG: sfc32, state stored inside the game state. Waves are rolled **when they start** — there is no pre-rolled
  future schedule to leak to the client.
* All assets live in one double-entry ledger with `world:*` faucet/sink accounts; non-world accounts are hard-floored at
  0 by construction. Invariant tested: every asset sums to 0.

## Economy choices (see ECONOMY_RULES.md)
* The city grid exists outside outages (7 credits/kWh, a sink). Businesses earn only while powered.
* Closure rule: a business is *struggling* when cash < its daily fixed costs at settlement, and *closes* after 2
  consecutive such settlements. With the starting cash, the Cold Room does **not** close by day 3 even when gouged —
  the design doc's "closes by day 3" claim is not reproduced because the math does not support it. Thinner businesses
  (corner shop) can close.
* Reopening is funded only from a district reinvestment pool fed by real shopper spending (5% extra outside demand),
  never minted.
* Merchant floor = import cost × (1 + min margin). The wholesaler's min margin is 0 so surplus stock can actually
  lower its price (a test caught that a positive floor made "price falls on surplus" impossible).
* The rival never loads its plant above 90% (its policy), so it needs no heat model; it obeys the same fuel/permit/cash
  ledger as the player.
* Carbon: diesel cannot run without allowance (hard cap), so the week-end "carbon audit fine" from the PDF can never
  trigger; the audit reports this explicitly.

## Quotes and trades
* Quote TTL = 15 ticks; quotes bind seller, item, max quantity, unit price, buyer and market version. A quote can be
  used once. Stock is re-checked at BUY time, so two quotes for the last litre cannot both succeed.
* Trades reserve credits and stock into `escrow:trades` atomically. Settlement (confirm or compensate) is a recorded
  `SETTLE_TRADE` system action, applied exactly once.

## NEAR standards and chain design
* **One NEP-245 contract** (`contracts/near`) holds every item type. Token ids: `DIESEL_100ML` (1 unit = 100 mL),
  `CARBON_PERMIT_10KG`, `REPAIR_PART`, `SOLAR_COMPONENT`, `BATTERY_COMPONENT`; decimals 0.
* Core NEP-245 methods, events (`standard: nep245`, `version: 1.0.0`), 1-yocto transfers, `mt_transfer_call` with
  `mt_resolve_transfer`, approvals (`mt_approve`, `mt_revoke`, `mt_is_approved`).
  **Deviation:** `mt_is_approved` takes an extra leading `owner_id`, because balances are fungible per (token, owner)
  and the standard signature cannot identify whose approval is meant. `mt_approval_of(owner, token, account)` is an
  extra view.
* **Function-call keys cannot attach deposits**, so the 1-yocto rule makes `mt_transfer` unusable from a scoped NPC key.
  Extension `npc_transfer`: a registered NPC moves only **its own** tokens, without a deposit, capped per call, and
  idempotent on `trade_id`. NPC keys are function-call keys restricted to the resource contract.
* **Custody:** players have no NEAR account in this build (guest only). Bought diesel goes to a **custodial game vault**
  account; the per-run sub-ledger is the game DB. This is stated in the UI chain drawer and README.
* **Credits stay off-chain.** The purchase is therefore *not atomic*: the chain leg (diesel) is settled by the worker and
  the game ledger reserves/compensates around it. No "atomic exchange" is claimed.
* **Permits are simulation-only in this build** (regulator sales are game-ledger trades). The contract has the token id
  and `settle_day` checks permit arithmetic, but the API does not yet call `settle_day`.
* **Consumption:** diesel burned in the simulation is not burned on-chain in real time. `settle_day` lets the operator
  burn consumed diesel from its own custody balance in one nightly batch; wiring it into settlement is a known gap.
* Signing: `near-api-js@7` `Account.createSignedTransaction` + `provider.sendTransactionUntil(…, "FINAL")`. The tx
  hash is computed from the signed bytes and **persisted before broadcast**; unknown outcomes are reconciled by hash and
  then by the contract's `trade_status` view; nothing is ever re-broadcast blindly or auto-compensated while unknown.
* Toolchain: local rustc 1.81 could not build current near-sdk (transitive crates require edition 2024), so the
  contract pins `rust-toolchain.toml` to 1.99.1 with near-sdk 5.30.1.

## Accounts and auth
* Guest-only auth (random token, sha256 stored). No email/social login is implemented and none is faked; the UI must
  label guest mode. Creating NEAR testnet accounts was **not** done by the assistant (account creation is left to the
  developer via `scripts/near-bootstrap.sh`).

## Not built (honest gaps at contract freeze v1)
* NEP-171 generator NFT, hedging, LLM dialogue, live oil feed, residential district, social login, on-chain permits,
  automatic `settle_day` calls, leaderboard UI endpoint.

## v2 — continuous world, real auth, real client (2026-11-08)
* **Continuous play replaces the 3-day campaign** (new brief): days are environmental; settlement is a background
  rollover. `campaignDays = 0` for real cities; Economy Lab replays still run a fixed 7 days.
* **Difficulty from progress**, not day number (`pressureLevel`).
* **Tutorial patience:** first 3 requests have no visible timer; customers wait up to 6 game hours. An unbounded
  version was tried and rejected: an ignored tutorial request could keep a shop dark until it went bankrupt.
* **Requests lapse when the grid returns** before the player connects (they are moot).
* **Cold Room rent 160 → 120 credits/day** so neglect alone does not close it within 3 days; design-doc margins kept.
* **Auth:** Supabase (Google + email magic link) verified locally via JWKS; guest sessions kept; X deferred (cost).
  See AUTH_PROVIDER_DECISION.md.
* **Players own one active save**; guest → account upgrade never overwrites an existing city.
* **Offline policy:** pause on disconnect (no background burn/bills/bankruptcy) rather than simulated catch-up — simpler,
  fair, and impossible to exploit or be punished by.
* **Checkpoints every 5 ticks** + deterministic replay-forward on restore (a restart previously lost up to 30 s).
* **Database stays SQLite** (one instance, persistent volume) instead of switching to Postgres mid-hackathon; numbered
  SQL migrations in `database/migrations`.
* **Single origin:** the API serves the built web app; dev uses a Vite proxy. No URLs hard-coded in components.
* **Renderer:** custom Canvas-2D isometric engine (~600 lines) instead of Phaser/Pixi: needs were hit-testing,
  zoom/pan, lighting and cables; no heavy dependency.
* **Oil input:** cached weekly Brent 2026 (EIA via FRED) with 50% pass-through to diesel import cost; new cities use it.
* Terra's mock transport and its non-canonical action names were removed; its palette, typography and welcome styling
  were kept.
