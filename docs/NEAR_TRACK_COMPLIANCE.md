# NEAR Games With Real Economies — compliance status

**Audit date:** 2026-11-11
**Overall status:** The Railway game uses the root Testnet economy contract and power-company market. Read-only Testnet
queries verified NEP-245 balances on several existing merchant accounts. The older standalone commodity-listing adapter
remains disabled and has no live player listings. The source changes in this audit extend the root economy so a
registered player's assigned custodial account can hold bought resources and reconcile gameplay consumption. They
were pushed to `0x-kayser/blackout` as commit `bf3dd76` on 2026-11-11. The public Railway site returned HTTP 200 and
`/api/health` returned `ok` with a healthy database at verification time, but Railway deployment metadata was
unavailable, so the running release could not be tied to that commit. A real player resource transfer is still needed
before claiming the full flow is live.

The existing Testnet economy contract is `vesper-econ.blackout-kay.testnet`, owned by `blackout-kay.testnet`, with
`vesper-op.blackout-kay.testnet` as operator. Its registered market IDs include `fuel:natural-gas`, `fuel:diesel`,
`permit:carbon`, `certificate:renewable`, `material:steel`, and `part:turbine`. Resource amounts use market units from
`packages/sim/src/region/config.ts` (`TOWN_UNITS`).

The separate legacy adapter (`NEAR_CHAIN_ENABLED`, `NEAR_RESOURCE_CONTRACT_ID`, vault keys, and `DIESEL_100ML`-style
IDs) is not the root game's merchant or power market and must not be enabled against this contract. Its IDs and trust
model differ. `scripts/near-bootstrap.ts` provisions another standalone setup; do not run it as a shortcut. The root
market uses the existing `ECONOMY_*` configuration and contract IDs. Email sign-in remains unavailable in production;
Google sign-in is enabled, but a real consent-and-return flow still requires a user sign-in.

## Capability matrix

| Track capability | Current implementation | On-chain vs off-chain | Status |
|---|---|---|---|
| NPC economic agents | Deterministic merchant agents have finite stock, cash, reserve floors, replacement-cost pricing, demand response, restock lead times, rationing and readable pricing rules. Three Testnet power companies decide whether to buy player electricity. | Merchant commodity and power operations use distinct NPC Testnet accounts when the root economy is live. The simulation's continuous decisions remain off-chain; settled market epochs reconcile their inventory and cash. | Read-only Testnet queries verified nonzero NEP-245 balances for multiple merchant accounts. Production audit evidence must still distinguish opening/resync batches from actual market trades. |
| NEP-245 resources | `contracts/near/src/lib.rs` implements resource IDs, units, balance views, transfers, settlement checks, and listing escrow primitives. `apps/api/src/economy/service.ts` aligns root TownEpoch items with the existing contract IDs and reconciles player balances. | NPC merchant stock and active players' whole market units settle in `settle_batch`. Simulation-only fractional units remain off-chain; consumed whole units return to world custody rather than being burned. | Contract and NPC balances are verified. Player inventory bootstrap and consumption settlement are pushed in `bf3dd76` and fake-chain tested. Commit-specific Railway rollout and a real player transfer are not yet verified. |
| NPC to player resource trade | `EconomyService.townEntries`, `bootstrapPlayerResources`, and `queueRegionEpochs` connect merchant buy/sell activity to active registered player accounts. A clean wallet boundary and on-chain balance read prevent replaying old trades. | NEP-245 items move between merchant accounts and the registered player's server-managed Testnet account. Settlement epochs are idempotent and reconciled by contract epoch ID. | Local fake-chain integration tests cover buying, selling, wallet bootstrap, and resource consumption. Commit `bf3dd76` is pushed; no post-change Railway transaction hash is claimed. |
| Player-owned markets | The live power desk lets a player offer spare electricity; NPC companies place and settle escrowed `power_order_place` trades. Plant NFTs also have a separate chain-backed listing flow. A separate fuel-listing adapter exists in code but is disabled. | Electricity trades settle on-chain in game credits; plants are NFTs. The legacy commodity-listing path uses a different shared-vault model and remains off in production. | Power and plant workflows have fake-chain coverage and historical Testnet evidence in [`TESTNET_DEMO.md`](TESTNET_DEMO.md). No live player-owned fuel listing is claimed. |
| Social and email login | Guest sessions, Google Identity Services, Google-to-player mapping, and guest-to-account save migration are in `apps/api/src/auth.ts`, `apps/api/src/routes.ts`, and `apps/web/src/api/auth.ts`. Registered players can receive a server-managed Testnet subaccount. | Authentication is off-chain. The server manages the subaccount key; it is custodial and does not imply self-custody or withdrawals. Players do not see a wallet or gas prompts. | Guest/Google entry and Google token-validation tests pass. The real Google consent-and-return flow still requires user sign-in; email is not enabled in production. |
| Invisible custody and judge audit | The player interface has no wallet or transaction-verification screen. Chain status and evidence are exposed only through `/api/admin/chain-audit`, `/api/economy/admin/audit`, and operator-only `/api/chain/*` routes. | The operator audit requires `ECONOMY_ADMIN_TOKEN` in an `x-admin-token` header. Configured server keys remain on the server; the player interface does not show them. | Deployed to Railway. The audit returned 403 without the token and 200 with the configured Railway token. |
| Progressive challenge loop | Before entry, an optional four-step tour explains the rescue, controls, merchant/resource decisions, player electricity offers and campaign. The in-game three-step rescue gives each action a direct button and matching city marker. After it, the HUD keeps a named campaign chapter, progress, unlock and recommended next action visible. The weekly crisis opens from the same card and applies its named opening condition; same-week players receive identical inputs. | Campaign goals use simulation rules. Challenge runs use deterministic, condition-specific opening inputs plus seeded incidents; the live company remains saved. | Deployed to Railway on 2026-11-11; the live welcome screen and tour were browser-verified. Local desktop/mobile browser checks cover the guided rescue and campaign loop. Weekly runs start past the tutorial so scores cover the challenge. Permit thresholds remain fixed, not calibrated from playtest telemetry. |
| Clear trading navigation | The commodity market opens on merchant stalls, shows an explicit shop action, then player holdings and owned listings. The Power Companies panel lets players offer spare electricity and inspect NPC budgets, weather, offers, decisions and deal status. | Quotes and NPC decisions are simulation state. After a player wallet's custody boundary, completed resource trades settle to that account; power orders use their own escrow flow. | UI was deployed and checked locally on desktop/mobile. No post-change production resource trade has been performed. |
| Financial-action clarity | Market orders show a current estimate, total, cash and inventory after the order, merchant constraints and separate fees. Investments show the projected profit share; loans show principal, per-day interest, and default risk. Plant purchases, offers and listings have review steps. | Credits and prices are fictional, non-redeemable game assets. The Testnet contract records game credit balances for auditability; a quote does not reserve a price and the server rechecks on confirmation. | Implemented in the market, investment, loan and plant-sale UI; API quote routes are read-only. |
| NEAR Intents | No integration. The root game has no supported cross-chain asset conversion or solver-assisted settlement path that improves its current resource or electricity flows. | Not applicable. | Deliberately not used; USDC is not needed for the current game flow. |
| Continuous economy and replay | `packages/sim` contains live continuous city play and deterministic economy rules. `packages/sim/src/replay.ts` reuses simulation rules for seven-day fast-forward; the Economy Lab shows replay data. | Simulation-only; replay does not submit chain transactions. | Implemented locally; deterministic behavior is covered by tests. |

## Resource ownership, custody and settlement limits

- Registered player accounts are server-provisioned Testnet subaccounts. The server manages their keys, pays transaction
  gas and controls in-game settlement. They are custodial accounts; do not call them self-custody wallets or promise
  withdrawals. Guest play remains simulation-only until account provisioning.
- On first account activation, the server reads current NEP-245 balances and reconciles the player's whole market-unit
  inventory from world custody to the assigned account. It stores Town and Region boundaries so pre-opening epochs are
  not replayed. New market trades after the boundary go to or from the player's account.
- Resource epochs distinguish Town market transfers from simulation changes. Whole NEP-245 units consumed by gameplay
  move back to the world custody account in batched settlement. Fractional simulation units are tracked off-chain until
  the player's integer token balance changes. This is a custody-pool return, not a token burn.
- Town/Region settlement is zero-sum and uses unique contract epoch IDs. The server waits for a balance read before
  bootstrapping, defers region debits until prerequisite market item credits settle, and reconciles unknown outcomes by
  reading the contract. A transaction is not considered settled until final success is observed.
- Game credits are fictional and non-redeemable. They are a separate in-game asset even where the Testnet contract
  records their balances for auditability. The player electricity market's escrow and resource transfers use real
  Testnet state; they have no real-world monetary value.
- The legacy fuel-listing adapter's two-phase credit reservation and shared-vault flow is separate from this root
  market. It remains disabled; fake-RPC tests for that adapter are not live Testnet evidence.

## Restricted authorization model in bootstrap

If run by an authorized developer using a funded Testnet parent account, `scripts/near-bootstrap.ts` creates a
resource-contract owner, custodial vault and three merchant accounts. It writes full-access account keys only to the
local git-ignored `.near-credentials/blackout/` directory. Server-facing keys are function-call keys:

- Each merchant key: receiver is the resource contract; method is `npc_transfer`; the contract caps the merchant's
  transfer per call and rejects duplicate trade IDs. It cannot transfer another account's assets.
- Vault operator key: receiver is the resource contract; methods are `custodial_list`, `custodial_cancel_listing`, and
  `custodial_fill_listing`. It can move only resources already held by the vault or listing escrow, and a fill target
  must be a registered NPC. The contract does not enforce off-chain credit payment; the application worker must
  authorize fills through the NPC policy and buyer-budget checks, then settle fictional credits exactly once.
- The contract owner's full-access key stays on the developer machine and is not emitted in server environment lines.

These are properties of the bootstrap and contract code, not keys/accounts currently created on Testnet.

## Local verification and reproduction

Source locations:

- Simulation, merchant policy, customer/rival rules and replay: `packages/sim/src/`
- Region resource-unit mapping and epoch reconciliation: `packages/sim/src/region/config.ts`, `packages/sim/src/region/state.ts`, `packages/sim/src/region/settlement.ts`, `packages/sim/src/region/engine.ts`
- Root Testnet market settlement and player resource custody: `apps/api/src/economy/service.ts`, migration `database/migrations/015_player_resource_custody.sql`
- NEP-245 resource contract and tests: `contracts/near/src/lib.rs`, `contracts/near/src/tests.rs`
- Legacy standalone resource adapter (disabled): `apps/api/src/chain.ts`, `apps/api/src/workers.ts`, `apps/api/src/services.ts`
- Listing economy, player-market policy and durable operations: `packages/sim/src/marketplace.ts`,
  `packages/sim/src/policies/playerMarket.ts`, `database/migrations/004_marketplace_jobs.sql`
- Player market: `apps/web/src/ui/Panels.tsx`; operator evidence: `GET /api/admin/chain-audit`, `GET /api/economy/admin/audit`
- Auth and ownership description: `apps/api/src/auth.ts`, `apps/api/src/routes.ts`, `apps/web/src/api/auth.ts`
- Bootstrap and key scopes: `scripts/near-bootstrap.ts`

Verification run for this audit:

- `pnpm typecheck` — **passed** after the resource accounting and settlement changes.
- `pnpm exec vitest run tests/integration/economy.test.ts tests/integration/region.test.ts --maxWorkers=2 --minWorkers=1` — **37/37 passed**. This includes player wallet bootstrapping, market buy/sell transfers, consumption reconciliation, settlement ordering, and region epoch verification on the fake chain.
- Full suite: an earlier attempt ran 203 tests with one failure (before the settlement-ordering fix), and the SSE suite was blocked by the sandbox's `listen EPERM` restriction. Rerun on 2026-11-11 against upstream `9b29530` on a normal machine: **206/206 passed** (see [TEST_REPORT.md](TEST_REPORT.md)).
- `pnpm build:web` — **passed**; Vite still warns that the lazy 3D chunk is 948 kB. The focused server/simulation changes do not alter that chunk.
- `git diff --check` — **passed** after the source and documentation edits.
- A previous Playwright `tests/e2e/browser/region.spec.ts` run passed **6 desktop/mobile checks**. A later rerun timed out waiting for Playwright's managed API healthcheck. That previous pass did not verify the latest tour copy or this NEP-245 accounting change.
- No live Testnet player resource purchase/consumption transaction has been performed from this code revision. The real Google consent-and-return flow still requires the user to sign in.
- The public Railway site returned HTTP 200 and `/api/health` returned `{"ok":true,"db":"ok",...}` on 2026-11-11. Railway deployment metadata could not be retrieved, so this does not prove that commit `bf3dd76` is the running release.

Local tests and fake RPC fixtures do not constitute live Testnet evidence. A healthy public endpoint also does not
identify its source commit. Confirm the Railway release for `bf3dd76` before treating the new player-resource code as
deployed.

## Judge demo path and current availability

The guest game, electricity loop, campaign progression, weekly challenge and seven-day replay can be demonstrated in
the UI. The player electricity offer is the on-chain player-owned market; resource trades use NEP-245 after the updated
root economy release is confirmed. To inspect chain evidence, use the protected operator audit route from a trusted environment;
the player UI intentionally hides transaction hashes. Fake-RPC fixtures and opening balance corrections must not be
presented as completed player market trades.

After confirming the `bf3dd76` release, create one registered player, buy a resource, wait for its `settle_batch` to reach final success,
verify the player's NEP-245 balance and transaction hash, then advance the game until a whole resource unit is
consumed and verify its return to world custody. Also verify the NPC and player market decision in the operator audit.
Google login is enabled in production but its real consent-and-return flow still needs the user to sign in; email is not
configured. Record transaction hashes only after final outcomes are observed and independently re-queried.

## Known gaps against acceptance criteria

1. Three merchant wallets and inventory: **NEP-245 balances were read from Testnet for several merchant accounts; a recent post-opening merchant trade still needs to be independently identified in production audit data.**
2. Registered-player Testnet ownership: **server-managed account provisioning exists; the new resource baseline and market settlement are in pushed commit `bf3dd76`, but the Railway rollout and a real player transaction remain unverified. Custody remains server-managed.**
3. Player-owned market: **player electricity offers settle through the power-company escrow path. A player-owned commodity listing and NEP-245 escrow remain in the disabled legacy adapter and are not claimed for this root market.**
4. Autonomous NPC decisions: **continuous merchant and power-company policies are implemented; a live player commodity-listing purchase by an NPC is not demonstrated.**
5. Real resource transaction evidence: **no post-change player resource hash recorded.** Existing power and plant transaction evidence is in the protected audit and [`TESTNET_DEMO.md`](TESTNET_DEMO.md).
6. Exactly-once resource accounting: **fake-chain tests cover bootstrap, buy, sell, and consumption batches; a live Testnet run after confirming the release is pending.**
7. Economy evolution and replay: **continuous simulation and deterministic seven-day replay are implemented; live power operations exist, while a live resource buy-and-consume trace remains to verify.**
8. Wallet-free gameplay: **guest and Google entry are available; the server-managed Testnet account is hidden from the normal game loop. Real Google consent still needs a user sign-in.**
9. Judge evidence: **protected operator audit routes exist. After confirming the release, verify and record the player resource settlement separately from grants, account creation, opening batches, or resync batches.**
