# NEAR Games With Real Economies — compliance status

**Audit date:** 2026-11-08  
**Overall status:** the player-listing and autonomous-purchase path is now wired through the local simulation, API,
durable worker, marketplace UI, and optional evidence panel. The live on-chain acceptance criteria remain unmet: no
Testnet deployment, NPC accounts, or verified transaction evidence are available. Fake-RPC tests are local evidence,
not proof of a live deployment.

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
| Player ownership and listings | `packages/sim/src/marketplace.ts`, `apps/api/src/routes.ts`, `apps/api/src/services.ts`, `apps/api/src/workers.ts`, and `apps/web/src/ui/Panels.tsx` implement registered-player listings, chain-backed fuel reservation, cancellable seven-day listings, autonomous merchant evaluation, and off-chain game-credit settlement. Migration `004_marketplace_jobs.sql` stores durable jobs. | The server maps the authenticated player ID to a shared custodial vault allocation. The contract moves the resource from that vault into listing escrow, then to a registered NPC account. The listing price and payment are off-chain fictional credits. | Local end-to-end path and fake-RPC behavior tested; live contract/account/transaction evidence unavailable. |
| Social and email login | Guest sessions, Supabase JWT handling, Google/email provider integration points, and guest-to-account save migration are in `apps/api/src/auth.ts`, `apps/api/src/routes.ts`, and `apps/web/src/api/auth.ts`. | Authentication is off-chain. A registered identity currently maps to shared custodial vault allocation, not an individual NEAR account. | Local code exists; missing Supabase configuration prevents provider verification. |
| Invisible custody | Normal purchases and listings read as deliveries, listings, and credits. Players do not connect a wallet or see seed phrase, gas, or chain prompts. `/api/account/near`, account settings, and the optional Verify panel explain custody and expose evidence. | Server holds merchant function-call keys and the vault operator function-call key; users cannot withdraw in this build. Gas comes from account allowances funded by bootstrap. | UX separation covered by browser tests; no live custody setup. |
| NEAR Intents | No integration. The present concrete chain leg is a same-network NEP-245 resource transfer; no supported cross-asset or cross-chain flow has been shown to improve it. | Not applicable. | Deliberately not used. |
| Continuous economy and replay | `packages/sim` contains live continuous city play and deterministic economy rules. `packages/sim/src/replay.ts` reuses simulation rules for seven-day fast-forward; the Economy Lab shows replay data. | Simulation-only; replay does not submit chain transactions. | Implemented locally; deterministic behavior is covered by tests. |

## Resource ownership, custody and settlement limits

- The current player resource allocation is per-run game state, not a personal Testnet account. The shared vault is
  custodial; players have no private key and cannot withdraw assets. The listing contract records the authenticated
  player ID as seller and holds the listed resource on that player's behalf.
- A run's listable diesel starts at zero. It increases only after a confirmed NPC-to-vault transfer, decreases when
  the simulation consumes fuel or reserves a listing, and cannot exceed the player's free fuel after active-contract
  reservations. Starter-kit diesel is not listable. On-chain escrow and the aggregate vault balance provide the final
  transfer check; the per-player attribution remains trusted server state.
- Gameplay fuel consumption is still simulated off-chain. It conservatively reduces the run's listable allocation but
  does not yet burn or reconcile the corresponding Testnet tokens. This leaves unallocated tokens in the shared vault
  and is a known custody-accounting gap; do not describe simulation consumption as an on-chain burn.
- The two-phase NPC purchase path reserves fictional game credits before the NEP-245 transfer. It releases those
  credits to the player only after final transfer confirmation. A definitive failure refunds the NPC and reopens the
  listing. Unknown outcomes keep the resource and credit reservations locked and are reconciled by transaction hash
  and contract listing view; they are never blindly re-broadcast or refunded.
- Cancellation and expiry return escrowed fuel only after a confirmed contract result. A definitive cancellation
  failure restores the active listing; an unknown result keeps it pending. The unit price is contract metadata only;
  credits are non-redeemable and no atomic on-chain payment exists.
- Fake-RPC integration tests exercise the listing create → NPC policy decision → resource settlement flow. They do
  not constitute a live Testnet demo.

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
- Listing economy, player-market policy and durable operations: `packages/sim/src/marketplace.ts`,
  `packages/sim/src/policies/playerMarket.ts`, `database/migrations/004_marketplace_jobs.sql`
- Player market and judge-only chain evidence: `apps/web/src/ui/Panels.tsx`, `GET /api/chain/market-listings`
- Auth and ownership description: `apps/api/src/auth.ts`, `apps/api/src/routes.ts`, `apps/web/src/api/auth.ts`
- Bootstrap and key scopes: `scripts/near-bootstrap.ts`

Verification run for this audit:

- `pnpm typecheck` — passed.
- `pnpm test` — 71/71 passed (7 files), including listing ownership, NPC policy decisions, settlement/refunds,
  registered-player route enforcement, fake-RPC marketplace settlement, deterministic replay, and SSE. The sandbox
  blocked loopback binding initially; rerunning with local-network permission passed.
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

The guest game, electricity loop, seven-day replay, and listing UI can be demonstrated locally. A configured Testnet
demo would proceed through a registered city, confirmed diesel purchase, player listing, autonomous NPC evaluation,
and final NEP-245 transfer; transaction hashes appear in the optional Verify panel. The live chain-dependent demo is
currently blocked because no Testnet contract or accounts have been provisioned. Fake-RPC fixtures must never be shown
as live settlement evidence.

To complete the chain demo, obtain a funded Testnet parent account and configure Supabase for Google/email login.
Then run the existing bootstrap, verify the deployed contract and account permissions, and exercise the implemented
purchase → listing → autonomous NPC fill path against Testnet. Record account/contract IDs and transaction hashes only
after observing final RPC outcomes and independently re-querying them.

## Known gaps against acceptance criteria

1. Three NPC Testnet accounts holding and transferring NEP-245 resources: **not provisioned or live-verified**.
2. Registered-player Testnet ownership model: **shared custodial allocation only; no individual account; no live setup**.
3. Player-owned active listing with actual balance reservation: **local flow implemented; live contract escrow unverified**.
4. Autonomous NPC evaluation and purchase of player listings: **policy and worker implemented; live NPC transfer unverified**.
5. Real verifiable Testnet transaction hash: **none available**.
6. Exactly-once listing payment reconciliation/refund: **local idempotent flow implemented and fake-RPC tested; live RPC outcomes unverified**.
7. Economy evolves without a developer patch: **local deterministic simulation and durable Testnet job worker implemented; live operation unverified**.
8. Wallet-free normal gameplay: **supported by local game code; provider and chain credentials absent**.
9. Judge evidence: **optional panel and authenticated listing-evidence route implemented; no live evidence yet**.
