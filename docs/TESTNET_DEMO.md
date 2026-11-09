# Testnet demo

**Status: deployed and run on testnet (2026-11-09).** Contract
[`vesper-econ.blackout-kay.testnet`](https://testnet.nearblocks.io/address/vesper-econ.blackout-kay.testnet). The full
list of 40 transactions from the run, every one FINAL and successful, is in [TESTNET_RUN.md](TESTNET_RUN.md); the key
ones are in the evidence table below. Each was also re-checked independently by reading the contract and the RPC.

## What you need

* A NEAR testnet account you own, with about **9 testnet NEAR** (one faucet-funded account is enough) (testnet NEAR is free and has no value; the contract's
  storage, ~607 KB, takes about 6.1 of it). Create one with the NEAR CLI
  (`near account create-account sponsor-by-faucet-service <name>.testnet …`) or a testnet wallet, and top it up from
  the testnet faucet if needed.
* Its private key (`ed25519:…`), which stays on your machine: the bootstrap uses it as the contract owner and never
  writes it to the server's env.

## Steps

```bash
pnpm build:contract
```
```bash
NEAR_PARENT_ACCOUNT_ID=you.testnet NEAR_PARENT_PRIVATE_KEY=ed25519:... pnpm chain:economy
```
Creates the contract and every account (list in NEAR_ARCHITECTURE.md), deploys, initialises the treasury, registers
the NPCs and their limits, and writes the server's env to `.env.economy` (git-ignored). Re-running reuses accounts
it already created.

```bash
pnpm chain:demo
```
Runs the real server code and engine against testnet, faster than real time: a signed-in demo company gets its
wallet and starting capital, starts its turbine, a storm parks over Vesper, and three power windows run with the NPC
companies deciding for themselves. Prints every transaction with its explorer link and writes `docs/TESTNET_RUN.md`.

To play on testnet instead, add the lines of `.env.economy` to the API's environment and start it
(`pnpm dev`). The API logs `economy: NEAR testnet (<contract>)`.

## Keeping it running (operations)

Lessons from running it live, each now handled in code:

| What happens on testnet | What to do |
|---|---|
| The free RPC endpoints rate-limit (429) | nothing: calls are paced and fail over between `NEAR_RPC_URL` and `NEAR_RPC_FALLBACK_URLS`; rate-limited operations retry |
| A transaction is lost in transit | nothing: after two minutes unconfirmed the server reads the contract; batches and grants are re-sent (single-use ids), NPC orders are not |
| An escrow lands after the game gave up on its order | nothing: the escrow sweeper queues `power_order_expire` and the buyer is refunded |
| The contract's storage NEAR runs low | closed orders are deleted and batches leave only a marker; `pnpm chain:upgrade` redeploys and prunes old orders |
| A server key's gas allowance runs out ("Not enough allowance") | `pnpm chain:keys` rotates the operator and company keys to uncapped function-call keys (same methods), then restart the API |
| An account that pays fees runs low ("Not enough balance") | top it up from your account: the operator spends roughly 0.06 testnet NEAR an hour |
| NEAR and the game drift apart after an incident | `POST /api/economy/admin/resync` with `x-admin-token: $ECONOMY_ADMIN_TOKEN`, repeated until it answers `done`: it pauses NPCs, waits for escrow to clear, withdraws batches that never landed, settles each NPC's and wallet's exact difference, and resumes NPCs once those corrections land |

## What a judge can check

| Check | Where |
|---|---|
| The accounts | MARKET → Power companies (each company's account link); ⚙︎ → Money (wallet, treasury, grid, world, every NPC) |
| Transaction hashes | ⚙︎ → Money → Transactions; MARKET → Recent deals (escrow and confirmation links) |
| Balances | ⚙︎ → Money shows "on NEAR" next to "in the game"; or `mt_balance_of` on the contract |
| The treasury | ⚙︎ → Money → The treasury (`economy_info`): supply, buckets, what each has granted |
| Autonomous decisions | MARKET → Power companies: each company's own reasoning; What happened; toasts when one buys from you |
| A real purchase | buy fuel in MARKET; it settles in the next market batch (≤ 72 s) |
| Fast-forward | MARKET → ⏩ Watch a week: the same engine and rules, seven days, a storm on day 2, your company included |
| Ownership | ⚙︎ → Money → Your plants on NEAR: each plant an NFT with its own account |

Contract calls to try from the NEAR CLI (view, free): `economy_info {}`, `mt_balance_of {"account_id": "...",
"token_id": "credit:vesper"}`, `power_order {"order_id": "..."}`, `grant {"grant_id": "start:<player>"}`,
`nft_tokens_for_owner {"account_id": "<wallet>"}`.

## Evidence table

From the run of 2026-11-09 (`docs/TESTNET_RUN.md`), re-checked on chain afterwards:

| Item | Signed by | Transaction |
|---|---|---|
| Contract | — | [vesper-econ.blackout-kay.testnet](https://testnet.nearblocks.io/address/vesper-econ.blackout-kay.testnet) |
| Player wallet created | `vesper-players` | [yAdMLPXk…](https://testnet.nearblocks.io/txns/yAdMLPXk4XJAhvT5YvG9JxXMS7nKsGeJPoE9BhPtsju) |
| Player starting grant, ₡300,000 from the `players` bucket | operator | [C8vaJoGc…](https://testnet.nearblocks.io/txns/C8vaJoGcVC8WnLSNdPxJNysVGWpsMF7MtqfhKiE9h6wS) |
| **NPC → player**: Halvard escrows for 25 MW from the player | **Halvard's own key** | [29puvnaE…](https://testnet.nearblocks.io/txns/29puvnaE6DQogvwRwoYrzFXPDgSfWxNWneP1FwzGdB1B) |
| …delivery confirmed: 70,822 of 75,000 kWh, player paid ₡7,015.62, Halvard refunded ₡413.88 | operator | [6nu7BEPg…](https://testnet.nearblocks.io/txns/6nu7BEPgGU2NhND4JfAanNiQ8VD7dWyGQ1E1w1EM4YEc) |
| **NPC → player**: Solara (night, panels at 0%) escrows for 20 MW from the player | **Solara's own key** | [7caiaxoa…](https://testnet.nearblocks.io/txns/7caiaxoaH91NE4R323dVkvFmsnDgVxachEXHY16SVF4f) |
| …delivery confirmed: 56,678 of 60,000 kWh, paid ₡5,500.03 | operator | [EunfzMh6…](https://testnet.nearblocks.io/txns/EunfzMh6DwiyWQj8VvFF7zhtUAMBGCqJszSoPXPuyYhk) |
| **NPC → NPC**: Solara escrows for 20 MW from Northwind Gas Power | **Solara's own key** | [HM5YseWY…](https://testnet.nearblocks.io/txns/HM5YseWYUsXjiL9LMoTLcEmYvzhQ9wYVWv3aF4iS3L8a) |
| …delivered in full (60,000 kWh), Northwind paid ₡4,044 | operator | [8VyC1QFu…](https://testnet.nearblocks.io/txns/8VyC1QFurRBGYrWDiVzubx7onbLygJ4MfUMFrbK3ZorB) |
| NPC starting capital (e.g. Halvard, ₡400,000) | operator | [7xbv14Va…](https://testnet.nearblocks.io/txns/7xbv14Vaqg7mwoRuSizLumwK1aHey5srovX8q4AjPtvA) |
| Market batch: trades and items settled together | operator | [8e5TtXAA…](https://testnet.nearblocks.io/txns/8e5TtXAAnMuNEwZ2fnWZfoXju6mfLAbLbsmCkWcSpHFL) |
| Region earnings batch | operator | [2e5pFzrr…](https://testnet.nearblocks.io/txns/2e5pFzrrARdqiQD4TLuQ9J2rW5naVDGnY8DbuuWW1vts) |
| Plant Asset minted to the player (Kestrel Peaker) | operator | [C6a9oGkn…](https://testnet.nearblocks.io/txns/C6a9oGknCJj8sUP6sGmg9fvXzxcmSYfeffX5fwuET64e) |

After the run the credit supply was still exactly 200,000,000,000 cc (₡2 billion): nothing was created. The third
window's three orders were escrowed but the run stopped before they delivered; they stay open until their deadline,
after which anyone can call `power_order_expire` and the buyers are refunded in full.
