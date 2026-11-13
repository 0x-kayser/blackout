# NEAR Games With Real Economies — implementation and evidence

**Track:** `games` — Games With Real Economies
**Audit date:** 2026-11-13
**Scope:** Current local source tree. This audit does not assert that the latest source is on GitHub or deployed to Railway.

## Summary

BLACKOUT models a continuously changing electricity and resource economy. The codebase includes autonomous merchant
policies, a NEP-245 resource contract, custodially provisioned player Testnet accounts, the player-owned resource
listing flow, guest/Google onboarding, and deterministic replay.

The player resource exchange is implemented in this checkout and has local integration and contract test coverage.
Its newly added contract methods have not been deployed to the existing Testnet contract from this checkout, and no
live player listing or fill transaction hash is claimed. The current Railway release has not been tied to this source
revision. Fake-chain results are application tests, not Testnet evidence.

The previously documented contract is `vesper-econ.blackout-kay.testnet`, owned by `blackout-kay.testnet`, with
`vesper-op.blackout-kay.testnet` as operator. The registered root market resource IDs are `fuel:natural-gas`,
`fuel:diesel`, `permit:carbon`, `certificate:renewable`, `material:steel`, and `part:turbine`. Units are defined by
`packages/sim/src/region/config.ts` (`TOWN_UNITS`). The historic demo record is in [`TESTNET_DEMO.md`](TESTNET_DEMO.md).

The old standalone commodity adapter (`NEAR_CHAIN_ENABLED`, `NEAR_RESOURCE_CONTRACT_ID`, vault keys and
`DIESEL_100ML`-style IDs) is separate from the root market and remains disabled. Do not treat it as evidence for the
new player exchange.

## Capability matrix

| Capability | Implementation in this checkout | Chain vs. game server | Evidence/status |
|---|---|---|---|
| NPC economic agents | Merchant policies use finite inventory, demand, replacement cost, cash reserves, restock time and world conditions. Power companies evaluate electricity offers. | Decisions and continuous simulation run off chain. Settled resource and electricity movements use each NPC's Testnet account when the service is configured. | Policy code and tests are local. Earlier read-only Testnet balance observations and transactions are recorded in [`TESTNET_DEMO.md`](TESTNET_DEMO.md); no new live market trade is claimed here. |
| NEP-245 resources | `contracts/near/src/lib.rs` implements the multi-token interface and root resource methods. `apps/api/src/economy/service.ts` maps game resource units to the contract IDs and batches economy reconciliation. | Token balances and confirmed whole-unit transfers are on chain. Fractional simulation quantities, dispatch and tick-by-tick use remain off chain; consumption is reconciled in batches. | Existing contract deployment is documented. New listing methods in this checkout still need to be deployed. Contract unit tests cover escrow and settlement. |
| Player wallet provisioning and storage | The server provisions a Testnet subaccount, encrypts its key, registers its NEP-245 storage with a sponsored deposit, and waits for final registration before starting credit/resource settlement. Existing active accounts are checked before further settlement. | Account key custody, identity mapping and setup are server-managed. The server/player-parent pays the storage deposit and transaction fees. | Fake-chain tests exercise account creation, storage registration and ordering. No post-change live player setup was performed. This is custodial, not self-custody. |
| Player-owned resource listing | `ResourceMarket` checks the authenticated player's game inventory and actual NEP-245 balance, reserves quantity in the region ledger, and creates contract escrow. A player can withdraw an open or buying offer. | `resource_listing_create` escrows the resource from the registered player account. `resource_listing_cancel` returns it after final confirmation. The UI does not expose chain details. | API, UI and migration are implemented locally. Live Testnet behavior is unverified until contract and service deployment. |
| Autonomous NPC purchase | Eligible merchants compare their current bid, open status, warehouse room, local cash after daily costs, and on-chain credit balance. A fill is queued only for an NPC whose policy accepts the offer. | `resource_listing_fill` atomically transfers the escrowed NEP-245 resource to the registered NPC and `credit:vesper` from NPC to seller. Local market records update only after final chain success. | Local fake-chain integration and Rust contract tests cover successful fills, refusal and idempotent local settlement. No live player listing purchase hash exists. |
| Listing cancellation and failure handling | Create, fill and cancel operations use deterministic IDs. Unknown outcomes are reconciled by reading the contract listing. A cancel waits for an in-flight fill; failed fills release local NPC cash while leaving the resource escrowed. | The contract state decides whether the sale, return or payment occurred. If settlement is unknown, the listing stays reserved pending reconciliation; the server does not guess or send a second sale. | Local tests cover cancellation, transfer and retry paths. Live RPC behavior remains to be demonstrated. |
| Player credits | `credit:vesper` is the game's non-redeemable credit unit. | The root Testnet economy contract moves it during configured settlements. It has no real-world value and is not a payout promise. | Contract and historic demo evidence are documented. It must never be described as cash or redeemable USDC. |
| Guest and Google login | Guest play and Google Identity Services are present. Guest progress can be upgraded to a registered identity. Email magic-link login is disabled in production. | Identity/session data and save migration are off chain. Testnet account keys are controlled by the service. | Source/tests cover the integration. A real Google consent-and-return check is still required before claiming the current production flow is verified. |
| Invisible chain and judge audit | Player routes omit account IDs and transaction hashes. Protected operator audit routes expose sanitized operation outcomes and transaction evidence. | Audit routes require `ECONOMY_ADMIN_TOKEN`; signing keys remain server side. | Route and access-control tests are local. Production availability of the new listing calls is unverified. |
| Progressive game loop and crisis decisions | The rescue flow, persistent campaign objective, merchant market, seeded crises and deterministic replay are part of the game. Events change generation, demand, price and reliability through simulation rules. | Game state and challenge scoring are off chain. Replay never creates Testnet transactions. | Source and local tests cover simulation behavior. The current public release revision has not been independently checked against this checkout. |
| NEAR Intents | Not integrated. There is no demonstrated supported cross-chain flow that improves the current resource or electricity trade. | Not applicable. | Deliberately excluded; the game works with direct Testnet contract calls. |

## Player resource sale sequence

1. The authenticated player submits a resource, whole quantity and ask. `apps/api/src/economy/resourceMarket.ts` checks
   that the resource is supported, the game inventory can cover it, the assigned account is active, and the final
   on-chain balance equals the game ledger's available balance.
2. The API records an idempotent listing and reserves the offered quantity in the player's region inventory. It queues
   `resource_listing_create` with the registered seller account, listing ID, resource ID, quantity and unit price.
3. The contract verifies the seller is an active custodial player account, transfers the exact resource into escrow,
   and writes an active listing. The offer becomes available to NPC policy evaluation only after final confirmation.
4. The market worker evaluates open offers. It requires an eligible merchant, enough warehouse room, an ask at or
   below its current bid, enough local cash after the daily reserve, and enough on-chain `credit:vesper`.
5. On acceptance, the API reserves the merchant's local cash and submits `resource_listing_fill`. One contract call
   transfers the escrowed item to the NPC and the agreed game credits to the seller. Contract state makes the listing
   single-use. The game ledgers apply the result once after final success.
6. A withdrawal queues `resource_listing_cancel`; the UI keeps the quantity reserved until the contract confirms the
   returned resource. If a purchase is in flight, it resolves first. A failed or unknown outcome is reconciled from
   `listing(listing_id)` before the API releases or retries anything.

The NPC policy, identity, cash reserves and game inventory remain off chain. The resource and game-credit movements
for a completed Testnet sale are on chain. Credits are non-redeemable. No player receives seed phrases, wallet popups,
or gas prompts.

## Custody, authorization and prerequisites

- Registered player accounts are subaccounts under the configured player-parent account. The service encrypts their
  keys and controls signing. This is a custodial account model.
- The player-parent sponsors `storage_deposit` for the contract's 0.01 NEAR storage requirement before the wallet is
  opened for game-credit or resource transfers. Every network action must still be verified against Testnet.
- Each merchant transaction key is scoped to the contract and its allowed methods. The operator function-call key must
  include `resource_listing_create`, `resource_listing_cancel` and `resource_listing_fill` for this feature.
- The contract restricts listing creation to a registered player account, cancellation to return the resource to its
  stored seller, and fills to registered NPCs. The operator cannot select an arbitrary fill recipient.
- Deployment and credential preflight were not completed for this change. Do not deploy until the contract owner,
  account keys, Testnet funding and explicit deployment authorization are available. No external transaction was
  attempted during this implementation.
- Changes remain local in the checkout. No GitHub push or Railway deployment was performed.

## Source locations

| Area | Files |
|---|---|
| NEP-245 contract and listing methods | `contracts/near/src/lib.rs`, `contracts/near/src/economy.rs` |
| Contract tests | `contracts/near/src/tests.rs` |
| Economy operations, wallet storage registration and reconciliation | `apps/api/src/economy/service.ts`, `apps/api/src/economy/gateway.ts` |
| Player exchange and autonomous NPC policy | `apps/api/src/economy/resourceMarket.ts`, `apps/api/src/town.ts`, `packages/sim/src/town/engine.ts` |
| Authenticated API routes | `apps/api/src/regionRoutes.ts`, `apps/api/src/routes.ts`, `apps/api/src/server.ts` |
| Durable schema | `database/migrations/016_resource_sales.sql`, `database/migrations/017_player_storage_and_listing_retry.sql` |
| Player interface | `apps/web/src/region/ui/Market.tsx`, `apps/web/src/region/api.ts`, `apps/web/src/region/region.css` |
| Fake-chain integration | `tests/integration/fakeChain.ts`, `tests/integration/resource-market.test.ts`, `tests/integration/economy.test.ts` |
| Key bootstrap and scopes | `scripts/near-economy-bootstrap.ts`, `scripts/near-economy-keys.ts` |

## Reproduce local verification

Run the source checks from the repository root:

```sh
pnpm typecheck
pnpm exec vitest run tests/integration/resource-market.test.ts tests/integration/economy.test.ts --maxWorkers=2 --minWorkers=1
cargo +1.95.0 test --manifest-path contracts/near/Cargo.toml
pnpm build:web
```

Results on 2026-11-13:

- `pnpm typecheck` — passed.
- Focused exchange and economy integration run — **22/22 passed**.
- `cargo +1.95.0 test --manifest-path contracts/near/Cargo.toml` — **56/56 passed**.
- `pnpm build:web` — passed. Vite reports the existing lazy `World3D` chunk at about 948 kB, above its 900 kB
  warning threshold.
- `pnpm exec vitest run --exclude tests/e2e/sse.test.ts` — **211/211 passed across 22 files**.
- `pnpm test` — the same 211 tests pass and 2 SSE tests skip, but the command exits nonzero because the
  `tests/e2e/sse.test.ts` suite cannot start its local listener in this environment (`listen EPERM 127.0.0.1`).

Fake-chain tests verify API orchestration and local reconciliation, not NEAR consensus or a deployed contract. Rust tests
verify contract logic in the NEAR SDK test environment, not a live Testnet deployment.

## Judge demonstration path

### Game loop

1. Start as a guest → see the outage and rescue objective.
2. Dispatch power, start the turbine and build reserve capacity → see reliability, demand and company cash change.
3. Open Market → see finite stock, current quotes and the price factors for each merchant.
4. Respond to a crisis → see the event change supply, demand, prices or reliability.
5. Watch a week → inspect a deterministic sandbox replay that uses the game rules without sending chain transactions.

### On-chain resource listing

This requires deployment of the latest contract and API source, a funded Testnet player-parent, configured operator
authorization and a registered player account. Those prerequisites have not been verified for this checkout.

1. Sign in and acquire a resource through the game market.
2. Open Market → Player exchange → list an owned quantity and choose an ask.
3. Observe an NPC's policy reason; if the offer fits its bid, stock room and cash, it buys.
4. Inspect the final `resource_listing_fill` transaction and both `mt_transfer` events in the protected operator audit
   and Testnet explorer.
5. Withdraw an open listing and inspect the final `resource_listing_cancel` transfer.

Do not present simulated market activity, fake-chain tests, wallet setup, grants or opening-balance batches as evidence
of a live player sale.

## Acceptance status

1. **Three NPC accounts with resources:** historic Testnet setup and balances are documented; independently identify a
   post-opening market trade before claiming autonomous resource trading as live.
2. **Registered player account:** account provisioning and sponsored NEP-245 storage registration are implemented;
   this checkout has no new live player registration evidence.
3. **Player-owned listing:** API, UI and contract logic are implemented locally; live deployment remains outstanding.
4. **NPC policy purchase:** local code and tests cover policy evaluation and purchase; live NPC purchase remains
   outstanding.
5. **Verifiable player sale hash:** outstanding; none is claimed.
6. **Safe retry/reconciliation:** deterministic IDs and contract-state reconciliation are covered locally; live RPC
   outcomes remain to verify.
7. **Economy evolves without patch:** continuous simulation and replay are implemented locally; no external patch is
   needed for routine event-driven change.
8. **Wallet-free player experience:** guest and Google source flows do not require an external wallet. Google must pass
   a real production consent-and-return check.
9. **Judge evidence without player interruption:** protected audit routes exist in source; current production behavior
   and access need to be checked after deployment.
