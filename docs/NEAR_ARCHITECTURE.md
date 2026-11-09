# NEAR architecture

BLACKOUT is a power-company game. Its economy (weather, generation, prices, every NPC decision) runs off chain in a
deterministic engine. NEAR testnet holds the money, who owns it, and every payment between real accounts. Players
never see a wallet prompt, a seed phrase or a fee.

> **Status.** Deployed and run on testnet on 2026-11-09: contract `vesper-econ.blackout-kay.testnet`, 40 final
> transactions including NPC-signed purchases from a player and from another NPC. Evidence:
> [TESTNET_DEMO.md](TESTNET_DEMO.md#evidence-table) and [TESTNET_RUN.md](TESTNET_RUN.md).

## Integration map: what existed, what changed

| Existing piece | Where | What changed for NEAR |
|---|---|---|
| Sign-in: guest cookie, Google/email via Supabase, local email codes | `apps/api/src/auth.ts` | unchanged; signed-in (`registered`) players now get a wallet |
| Player model | `players` table | new `player_wallets` table (migration 013), one row per player |
| Currency: Vesper credits, ₡ (integer cc, 1 cc = ₡0.01) | everywhere | unchanged; on chain it is the `credit:vesper` token, same unit |
| Starting money: `STARTER_GRANT_CC` = ₡300,000 per region | `packages/sim/src/region/config.ts` | the wallet's starting capital is the same amount, paid once from the treasury's `players` bucket |
| How money is created in a region | region genesis (`createRegion`) | unchanged in the simulation; on chain no region mints anything (see "Grid clearing" below) |
| Region ledger (double entry) and settlement epochs | `packages/sim/src/region/state.ts`, `settlement.ts` | epochs now leave out market trades and power-desk payments (they settle elsewhere); `forceCloseEpoch` for wallet openings |
| Vesper Market ledger and epochs | `packages/sim/src/town/engine.ts` | identities: each merchant and company its own account, each player `player:<id>`, everything else `world`; epochs leave out flows already settled through escrow |
| NPC decisions | `merchantPricing.ts`, `economy.ts` (region actors) | **new**: three shared NPC power companies with their own wallets and rules, `firmPolicy.ts`, `firms.ts` |
| Plant ownership | region `plants[].ownerId` | each wallet holder's plants minted as NEP-171 Plant Assets; sold plants leave the wallet |
| Market trades | `TownService.trade` | unchanged; settled to the player's wallet in batches |
| Delivery of electricity | region market clearing (`clearMarket`) | power contracts are firm "export" loads at the seller's node; delivered kWh is measured each interval |
| Tests and deploy | Vitest, Playwright, cargo test | +11 contract tests, +9 sim tests, +9 integration tests; `pnpm chain:economy`, `pnpm chain:demo` |

## Components

```
browser ──HTTPS──> API (Fastify)
                    ├─ RegionService     each player's region (off chain, 1 interval = 1 s)
                    ├─ TownService       Vesper Market + NPC power companies (off chain, shared by everyone)
                    └─ EconomyService    apps/api/src/economy/service.ts
                         ├─ player_wallets     a NEAR account per signed-in player (key encrypted at rest)
                         ├─ chain_ops          every chain operation once, with its state and tx hash
                         └─ NearGateway        apps/api/src/economy/gateway.ts → NEAR testnet RPC
                                                 └─ contract: contracts/near (economy.rs, plants.rs, lib.rs)
```

* **Contract** (`contracts/near/src`): one NEP-245 multi-token contract holds the money and every item
  (`credit:vesper`, gas, diesel, permits, certificates, steel, turbine kits), NEP-171 Plant Assets, the fixed-supply
  treasury, NPC spending limits, power-delivery escrow and atomic batch settlement.
* **EconomyService**: opens wallets, turns NPC decisions into NPC-signed transactions, batches settlement, reconciles
  unknown outcomes by reading the contract, and carries confirmed results back into the game.
* **NearGateway**: signs, records the hash *before* broadcasting, broadcasts, waits for `FINAL`, and reports
  `settled` only for a successful outcome with no failed receipt.

## Accounts on NEAR

| Account | Holds | Signs | Key on the server |
|---|---|---|---|
| `vesper-econ.<you>` | the contract | — | none (owner is your own account) |
| your parent account | contract owner: tokens, `init_economy`, limits, `issue` | admin calls | **never** |
| `vesper-op.<you>` | the operator | grants, batches, delivery confirmations, plant mints | function-call key, those methods only |
| `vesper-treasury.<you>` | the whole supply until granted | nothing | none |
| `vesper-grid.<you>` | grid clearing (inside players' regions) | nothing | none |
| `vesper-world.<you>` | the outside world, and the market's item stock | nothing | none |
| `vesper-players.<you>` | parent of player wallets | creates wallets | full key (holds only NEAR to fund wallets) |
| `p<hash>.vesper-players.<you>` | a player's wallet | (its own key, server-held, encrypted) | encrypted |
| `vesper-<npc>.<you>` × 12 | each merchant and power company | companies: `power_order_place` | companies: function-call key, that method only |

## On chain / off chain

| Off chain (the engine) | On chain (the contract) |
|---|---|
| weather, solar output, demand, fuel burn, grid failures | who holds every credit and every market item |
| market clearing every interval, nodal prices | each payment between real accounts |
| every NPC decision (merchant prices, company purchases) | NPC companies' signed escrow for the power they buy |
| real-time play and visuals | delivery confirmation and the resulting payment |
| region economies (homes, businesses, VoltLine, banks) | one grid clearing account standing for all of them |
| | Plant Assets (who owns each player's plants) |

Nothing is written per simulation tick. Market epochs settle every 72 seconds, region epochs are batched across
players, and power orders are one escrow and one confirmation per deal (every 36 seconds per company at most).

## Source of truth

* **Confirmed balances**: the contract. The game shows "on NEAR" next to "in the game"; the difference is what has
  not settled yet (seconds) and power payments in escrow. The server never creates spendable credits: the treasury
  minted all of them once.
* **Game state**: the server. It changes only after the chain confirms where money is involved: an order goes live
  only once its escrow is confirmed; a delivery is paid in the game only once `power_order_confirm` is final.
* **Unknown outcomes**: the op stays `submitted` and is looked up by its hash; if that fails, the contract is read
  (`grant`, `power_order`, `epoch`, `nft_token`, account existence). Nothing is resubmitted blindly; every id is
  single-use on chain anyway.

## Security

* Keys: owner key never on the server; operator and companies hold function-call keys limited to named methods and a
  gas allowance; the player-parent key can only spend its own NEAR. Player wallet keys are AES-256-GCM encrypted with
  `WALLET_KEY_SECRET`. No key reaches the browser. `.env.economy` and `.near-credentials/` are git-ignored.
* NEP-245 transfers need exactly 1 yoctoNEAR, which function-call keys cannot attach. So NPC spending goes through
  `power_order_place`, which accepts a registered NPC with no deposit **and** enforces that NPC's per-payment cap,
  daily cap, its pause switch and a global kill switch; anyone else must attach 1 yocto.
* The contract only lets the operator debit accounts that consented to game custody (registered NPCs, the operator,
  unreleased player wallets, plant accounts). A player can call `release_to_owner` to leave that custody for good.
* Credits have a fixed supply: `mt_mint` refuses them after genesis; `issue` is owner-only and capped for life.
* The chain trusts the operator on **delivery** (it cannot measure electricity). It cannot trust it with more: a
  confirmation can never pay out more than the buyer escrowed, and never twice.

## Not done (exact)

* **Player-to-player equipment sales** (Flow D) are not wired into the game. The contract has atomic
  `plant_list` / `plant_buy` (credits and the NFT move in one call) and the relayer accepts player-signed `plant_buy`,
  but each player's plants live in their own region, and moving a plant between two players' grids is not built.
* **Wallet key export** (for self-custody) has no UI; the contract side (`release_to_owner`) exists.
* **Guests** have no wallet; they get one the moment they sign in, with their current balance.
* **NEAR Intents** are not used and not claimed.
