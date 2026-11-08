# NEAR Games With Real Economies — compliance status

**Audit date:** 2026-11-08  
**Overall status:** local foundations exist; the track's live on-chain acceptance criteria are not met. No Testnet
deployment, account IDs, or transaction evidence were available, and the player marketplace is not wired into the API
or game UI. Do not present the contract primitives as a working player exchange.

## Deployment preflight and hard blockers

No external account creation, funding, deployment, or transaction was attempted. The repository environment had no
`.env`, `.env.chain`, or `.env.local` file. These required values were missing:

- `NEAR_CHAIN_ENABLED`, `NEAR_PARENT_ACCOUNT_ID`, `NEAR_PARENT_PRIVATE_KEY`
- `NEAR_RESOURCE_CONTRACT_ID`, `NEAR_VAULT_ACCOUNT_ID`, `NEAR_VAULT_OPERATOR_PRIVATE_KEY`
- `NEAR_MERCHANT_{EMBER,LANTERN,HARBOR}_ACCOUNT_ID` and corresponding private keys
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`

There is no funded Testnet parent account or provider configuration available to verify. The preflight therefore stops
before deployment, as required. Bootstrap code is not deployment evidence.

## Capability matrix

| Track capability | Current implementation | On-chain vs off-chain | Status |
|---|---|---|---|
| NPC economic agents | Three deterministic merchant agents with finite diesel stock, cash, reserve floors, replacement-cost pricing, demand response, restock lead times, rationing and readable pricing rules. | All decisions and economic balances are in the simulation. The NEAR bootstrap can create three accounts and mint diesel, but it has not been run. | Simulation implemented; genuine NPC wallets not provisioned. |
| NEP-245 resources | `contracts/near/src/lib.rs` implements the multi-token contract, resource IDs, units, balance views, transfers, approvals, capped/idempotent NPC transfers, settlement checks, and listing escrow primitives. `scripts/near-bootstrap.ts` registers diesel, permits and selected materials. | Contract code and tests are local. Merchant minting currently provisions diesel only. No deployed contract or live resource balances exist. Carbon permits/materials are not connected to gameplay settlement. | Local contract implementation; not deployed. |
| NPC to game vault trade | `apps/api/src/chain.ts`, `apps/api/src/workers.ts`, and `apps/api/src/services.ts` provide a real-transfer path when configured: merchant function-call key submits NEP-245 diesel into shared vault; final RPC outcome is reconciled with the game trade. | Resource transfer would be on-chain; credits and each player's game allocation remain off-chain. The server manages the vault key. | Code path exists; credentials are absent and no live transfer was verified. |
| Player ownership and listings | The contract has `custodial_list`, `custodial_cancel_listing`, `custodial_fill_listing`, and a listing view. It escrows resources held by the shared vault, stores opaque player ID and off-chain credit price, and only allows the operator to fill an active listing to a registered NPC. The player listing API, durable listing state, NPC discovery/policy integration, and UI are absent. | The escrow resource move would be on-chain. Player allocation, seller identity, policy decision and credit payment would be trusted/off-chain. There is no atomic resource-plus-credit settlement because credits are fictional game ledger balances. | Contract primitive only; acceptance criteria not met. |
| Social and email login | Guest sessions, Supabase JWT handling, Google/email provider integration points, and guest-to-account save migration are in `apps/api/src/auth.ts`, `apps/api/src/routes.ts`, and `apps/web/src/api/auth.ts`. | Authentication is off-chain. A registered identity currently maps to shared custodial vault allocation, not an individual NEAR account. | Local code exists; missing Supabase configuration prevents provider verification. |
| Invisible custody | Normal game actions do not require a wallet, seed phrase, NEAR gas, or wallet popup. Purchase and failure copy describe delivery and refunds without naming the chain; transaction status, account IDs and explorer links live in the optional Verify panel. `/api/account/near` describes shared custody when configured. | Server holds merchant function-call keys and the vault operator function-call key; users cannot withdraw in this build. Gas comes from account allowances funded by bootstrap. | Player-facing copy and navigation updated; no live custody setup. |
| NEAR Intents | No integration. The present concrete chain leg is a same-network NEP-245 resource transfer; no supported cross-asset or cross-chain flow has been shown to improve it. | Not applicable. | Deliberately not used. |
| Continuous economy and replay | `packages/sim` contains live continuous city play and deterministic economy rules. `packages/sim/src/replay.ts` reuses simulation rules for seven-day fast-forward; the Economy Lab shows replay data. | Simulation-only; replay does not submit chain transactions. | Implemented locally; deterministic behavior is covered by tests. |

## Resource ownership, custody and settlement limits

- The current player resource allocation is per-run game state, not a Testnet player account balance. The one shared
  vault is custodial; players have no private key and cannot withdraw assets.
- Existing confirmed NPC diesel purchases transfer resources into the vault. The simulation then credits player fuel
  in its own ledger. Gameplay consumption does not currently burn or periodically reconcile the corresponding
  on-chain resource, so the two balances are not a complete ownership accounting system.
- Listing contract methods can escrow vault-held NEP-245 resources, but do not verify a player's game allocation, reserve
  off-chain credits, or enforce a payment. The intended seller would have to be checked by an API and settlement worker;
  those are not present.
- `unit_price_cc` is off-chain, non-redeemable game credits. It is metadata only to the contract. A future two-phase
  settlement must reserve the buyer's credits before the chain call, keep them reserved while outcome is unknown,
  release them only after the escrow-to-NPC transfer is verified, and refund them exactly once on a definitive failure.
  Unknown outcomes require reconciliation before either settlement or refund.
- No exact API/UI player listing demo or autonomous NPC listing purchase is available in this repository state.

## Restricted authorization model in bootstrap

If run by an authorized developer using a funded Testnet parent account, `scripts/near-bootstrap.ts` creates a
resource-contract owner, custodial vault and three merchant accounts. It writes full-access account keys only to the
local git-ignored `.near-credentials/blackout/` directory. Server-facing keys are function-call keys:

- Each merchant key: receiver is the resource contract; method is `npc_transfer`; the contract caps the merchant's
  transfer per call and rejects duplicate trade IDs. It cannot transfer another account's assets.
- Vault operator key: receiver is the resource contract; methods are `custodial_list`, `custodial_cancel_listing`, and
  `custodial_fill_listing`. It can move only resources already held by the vault or listing escrow, and a fill target
  must be a registered NPC. The trusted operator can direct an active listing to an NPC without on-chain credit
  settlement; the future API must enforce policy, buyer budget, and off-chain settlement exactly once.
- The contract owner's full-access key stays on the developer machine and is not emitted in server environment lines.

These are properties of the bootstrap and contract code, not keys/accounts currently created on Testnet.

## Local verification and reproduction

Source locations:

- Simulation, merchant policy, customer/rival rules and replay: `packages/sim/src/`
- NEP-245 resource contract and tests: `contracts/near/src/lib.rs`, `contracts/near/src/tests.rs`
- Testnet adapter, purchase worker and reconciliation: `apps/api/src/chain.ts`, `apps/api/src/workers.ts`,
  `apps/api/src/services.ts`
- Auth and ownership description: `apps/api/src/auth.ts`, `apps/api/src/routes.ts`, `apps/web/src/api/auth.ts`
- Bootstrap and key scopes: `scripts/near-bootstrap.ts`

Verification run for this audit:

- `pnpm typecheck` — passed.
- `pnpm test` — 65/65 passed (6 files), including API, auth, fake-RPC reconciliation, deterministic replay, and SSE.
  The first sandbox run could not bind loopback (`EPERM`); rerunning with local-network permission passed.
- `pnpm test:contract` — 19/19 Rust tests passed.
- `pnpm build:contract` — produced `contracts/near/res/blackout_resources.wasm` using the plain Cargo fallback. `cargo-near`
  was not installed, so NEAR-specific WASM compatibility and Testnet loading are unverified.
- `pnpm build:web` — passed; Vite emitted upstream Zod comment-annotation warnings and completed the build.
- `git diff --check` — passed.
- `pnpm test:e2e` — 7/7 browser journeys passed (6 desktop and 1 mobile). The market journey verifies that normal
  purchase copy contains no chain, wallet, or gas terms while the optional Verify panel retains NEAR evidence. This
  validates UX separation, not live Testnet settlement.

Local tests and fake RPC fixtures do not constitute live Testnet evidence. Do not infer a deployment from a successful
build.

## Judge demo path and current availability

The guest game, electricity loop and seven-day replay can be demonstrated locally. The chain-dependent steps are not
available yet: no real NPC accounts exist, no Testnet transaction has been verified, and the player listing route,
NPC purchase agent integration, and UI are missing. The Verify panel is a discreet location for chain evidence once
there is real evidence. Do not walk judges through a mock transaction as if it were a Testnet settlement.

To complete the chain demo, first obtain a funded Testnet parent account and configure Supabase if social login is
required. Then complete and test the API/UI listing reservation and exactly-once payment reconciliation path before
running bootstrap or claiming the acceptance criteria. Record real account/contract IDs and transaction hashes only
after observing final RPC outcomes and independently re-querying them.

## Known gaps against acceptance criteria

1. Three NPC Testnet accounts holding and transferring NEP-245 resources: **not provisioned or live-verified**.
2. Registered-player Testnet ownership model: **shared custodial allocation only; no individual account; no live setup**.
3. Player-owned active listing with actual balance reservation: **not wired end-to-end**.
4. Autonomous NPC evaluation and purchase of player listings: **not implemented in the API/game loop**.
5. Real verifiable Testnet transaction hash: **none available**.
6. Exactly-once listing payment reconciliation/refund: **not implemented**.
7. Economy evolves without a developer patch: **local deterministic simulation exists; persistent Testnet market jobs are not added**.
8. Wallet-free normal gameplay: **supported by local game code; provider and chain credentials absent**.
9. Judge evidence: **Verify panel and transaction lookup paths exist for current NPC-to-vault trades; no live evidence yet**.
