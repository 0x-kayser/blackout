# NEAR Games With Real Economies — compliance status

**Audit date:** 2026-11-10
**Overall status:** A read-only Railway audit confirmed the separate Testnet power economy was connected, with 21
settled and 6 submitted operations at the time checked. Chain status and transaction verification stay out of the
player interface; operators use the protected `/api/admin/chain-audit` endpoint. The distinct NEP-245 player-resource
adapter was disabled, so no live player-resource trade is claimed. A separate power-economy Testnet contract and
standalone transactions are documented in [`TESTNET_DEMO.md`](TESTNET_DEMO.md). Local UI changes in this checkout
must be built and deployed before they can be claimed as part of the Railway experience. A fresh public-config read
still reports guest and Google sign-in enabled and email disabled; this confirms configuration, not a real Google
consent round-trip.

## NEP-245 resource-market deployment preflight and hard blockers

The BLACKOUT app itself is deployed on Railway. No NEAR account creation, funding, NEP-245 resource-contract
deployment, or player-resource transfer was attempted during this audit. This workspace has `.env` for the Google
client and `.env.economy` for the separate power-economy service. The latter is not a configuration for the
NEP-245 resource adapter. Resource-specific configuration was missing:

- `NEAR_CHAIN_ENABLED`, `NEAR_PARENT_ACCOUNT_ID`, `NEAR_PARENT_PRIVATE_KEY`
- `NEAR_RESOURCE_CONTRACT_ID`, `NEAR_VAULT_ACCOUNT_ID`, `NEAR_VAULT_OPERATOR_PRIVATE_KEY`
- `NEAR_MERCHANT_{EMBER,LANTERN,HARBOR}_ACCOUNT_ID` and corresponding restricted keys

The separate power-economy parent account is not assumed to be funded or authorized for resource-contract deployment.
The public explorer blocked balance reads and the local RPC check could not resolve its host, so the resource deployer’s
available Testnet NEAR was not verified. The preflight therefore stops before resource deployment. Google Identity
Services does not require Supabase; email login remains unavailable in production. Bootstrap code is not deployment
evidence.

## Capability matrix

| Track capability | Current implementation | On-chain vs off-chain | Status |
|---|---|---|---|
| NPC economic agents | Deterministic merchant agents have finite stock, cash, reserve floors, replacement-cost pricing, demand response, restock lead times, rationing and readable pricing rules. A separate Testnet power-economy service has NPC accounts and recorded settlements. | The separate Testnet service proves some power-economy operations settle on chain. Merchant resource inventory, policy decisions and player commodity trades remain simulation state; the settlement count does not prove NEP-245 fuel or material transfers. | Autonomous economy implemented; live resource-market NPC balances and inventory transfers are not verified. |
| NEP-245 resources | `contracts/near/src/lib.rs` implements the multi-token contract, resource IDs, units, balance views, transfers, approvals, capped/idempotent NPC transfers, settlement checks, and listing escrow primitives. `scripts/near-bootstrap.ts` registers diesel, permits and selected materials. | Contract code and tests are local. Merchant minting currently provisions diesel only. No deployed contract or live resource balances exist. Carbon permits/materials are not connected to gameplay settlement. | Local contract implementation; not deployed. |
| NPC to game vault trade | `apps/api/src/chain.ts`, `apps/api/src/workers.ts`, and `apps/api/src/services.ts` provide a real-transfer path when the resource adapter is configured: a merchant function-call key submits NEP-245 diesel into a shared vault and the final RPC outcome is reconciled with the game trade. | Resource transfer would be on-chain; credits and each player's game allocation remain off-chain. The server manages the vault key. | Code path exists; resource-specific credentials/configuration are absent and no live resource transfer was verified. |
| Player ownership and listings | `packages/sim/src/marketplace.ts`, `apps/api/src/routes.ts`, `apps/api/src/services.ts`, `apps/api/src/workers.ts`, and `apps/web/src/ui/Panels.tsx` implement registered-player listings, chain-backed fuel reservation, cancellable seven-day listings, autonomous merchant evaluation, and off-chain game-credit settlement. Migration `004_marketplace_jobs.sql` stores durable jobs. | The server maps the authenticated player ID to a shared custodial vault allocation. The contract moves the resource from that vault into listing escrow, then to a registered NPC account. The listing price and payment are off-chain fictional credits. | Local end-to-end path and fake-RPC behavior tested; live contract/account/transaction evidence unavailable. |
| Social and email login | Guest sessions, Google Identity Services, Google-to-player mapping, and guest-to-account save migration are in `apps/api/src/auth.ts`, `apps/api/src/routes.ts`, and `apps/web/src/api/auth.ts`. The local welcome screen places Google sign-in beside guest play. | Authentication is off-chain. The separate power-economy service can provision a server-managed Testnet account for a registered player; the NEP-245 listing path still lacks its own configured resource ownership path. | Public production config reports guest and Google sign-in enabled; email is disabled. Automated Google token-verification tests pass; the real Google consent round-trip remains unverified. |
| Invisible custody and judge audit | The player interface has no wallet or transaction-verification screen. Chain status and evidence are exposed only through `/api/admin/chain-audit`, `/api/economy/admin/audit`, and operator-only `/api/chain/*` routes. | The operator audit requires `ECONOMY_ADMIN_TOKEN` in an `x-admin-token` header. Configured server keys remain on the server; the player interface does not show them. | Deployed to Railway. The audit returned 403 without the token and 200 with the configured Railway token. |
| Progressive challenge loop | After the three-step tutorial, the live HUD shows the next operating permit, delivered-energy progress and any reliability target. The permit screen shows plant unlocks. A second HUD card opens the rotating, seeded three-day challenge and leaderboard. Live cash pressure now routes players to credit, fuel-spend or asset-sale options. | Permit goals use the same rules enforced by the simulation. Challenge runs use a separate fixed scenario; the live company remains saved. There are no XP levels or login streak penalties. | Implemented locally in `apps/web/src/region/ui/Progression.tsx`, `Guide.tsx` and `Dock.tsx`. Difficulty thresholds themselves have not been retuned; the growing permit requirements and reliability targets are the progression challenge. |
| Financial-action clarity | Market orders show a current estimate, total, cash and inventory after the order, merchant constraints and separate fees. Investments show the projected profit share; loans show principal, per-day interest, and default risk. Plant purchases, offers and listings have review steps. | Game credits and prices are fictional, off-chain and non-redeemable. A quote does not reserve a price; the server rechecks on confirmation. | Implemented locally in the market, investment, loan and plant-sale UI; API quote routes are read-only. |
| NEAR Intents | No integration. The live game's resource adapter is disabled, and no supported cross-asset or cross-chain path has been shown to improve a real player transaction. | Not applicable. | Deliberately not used; USDC is not needed for the current game flow. |
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
- Player market: `apps/web/src/ui/Panels.tsx`; operator evidence: `GET /api/admin/chain-audit`, `GET /api/economy/admin/audit`
- Auth and ownership description: `apps/api/src/auth.ts`, `apps/api/src/routes.ts`, `apps/web/src/api/auth.ts`
- Bootstrap and key scopes: `scripts/near-bootstrap.ts`

Verification run for this audit:

- `pnpm typecheck` — passed on 2026-11-10, including the local UI and API changes.
- `pnpm build:contract` — produced `contracts/near/res/blackout_resources.wasm` using the plain Cargo fallback. `cargo-near`
  was not installed, so NEAR-specific WASM compatibility and Testnet loading are unverified.
- `pnpm build:web` — passed on 2026-11-10; Vite emitted upstream Zod comment-annotation and large-chunk warnings and completed the build.
- Focused Google and region API integration tests passed, including Google token validation, read-only trade quotes, and read-only investment quotes that match completed investment shares.
- Full `pnpm test` — **not green**: 178 passed, 23 failed, 2 skipped. Failures include legacy tests expecting player-facing chain fields/routes that the current privacy model withholds, one legacy Cold Room assignment assertion, and an E2E SSE suite that cannot bind loopback in this sandbox. Review and update those suites before treating the repository's full test command as passing.
- `git diff --check` — passed on 2026-11-10.
- UI browser smoke check — not run: browser control is disabled in Work settings, and the local browser surface is unavailable. No production UI behavior is claimed from this check.

Local tests and fake RPC fixtures do not constitute live Testnet evidence. Do not infer a deployment from a successful
build.

## Judge demo path and current availability

The guest game, electricity loop, operating-permit progression, weekly challenge, seven-day replay, and listing UI can be
demonstrated locally. To inspect chain evidence, use the protected operator audit route from a trusted environment;
the player UI intentionally does not show transaction hashes. The deployed resource-market adapter was observed
disabled, so a live NEP-245 player listing or NPC fill is not currently claimed. Fake-RPC fixtures must never be
shown as live settlement evidence.

To complete the chain demo, identify a funded and authorized Testnet deployer for the NEP-245 resource contract,
configure the resource adapter, run the existing bootstrap, verify the deployed contract and account permissions, and
exercise the purchase → listing → autonomous NPC fill path against Testnet. Google login already works in code and is
advertised by production config; email is not configured. Record account/contract IDs and transaction hashes only
after observing final RPC outcomes and independently re-querying them.

## Known gaps against acceptance criteria

1. NEP-245 resource balances and transfers for three NPCs: **not provisioned or live-verified**. Separate NPC cash accounts and power-economy settlement evidence do not prove resource ownership.
2. Registered-player Testnet identity: **server-managed account provisioning exists in the separate power-economy service; the resource marketplace does not yet tie listings to that account or escrow**.
3. Player-owned active listing with actual balance reservation: **local flow implemented; live contract escrow unverified**.
4. Autonomous NPC evaluation and purchase of player listings: **policy and worker implemented; live NPC transfer unverified**.
5. Real verifiable Testnet transaction hash: **none available**.
6. Exactly-once listing payment reconciliation/refund: **local idempotent flow implemented and fake-RPC tested; live RPC outcomes unverified**.
7. Economy evolves without a developer patch: **local continuous simulation and deterministic replay are implemented; the separate Testnet power service has recorded operations, but live autonomous NEP-245 resource trading is unverified**.
8. Wallet-free normal gameplay: **guest and Google login are enabled in production config; the separate server-managed Testnet account is not exposed in the normal game loop**.
9. Judge evidence: **protected operator audit routes implemented locally; the public resource-market adapter was observed disabled and must be rechecked after deployment**.
