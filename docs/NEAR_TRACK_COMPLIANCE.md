# NEAR Games With Real Economies — compliance status

**Audit date:** 2026-11-11
**Overall status:** The Railway production audit confirms the root game's Testnet power-economy service is connected.
Its latest snapshot showed 38 settled operations and 28 submitted operations; submitted operations are in flight and
are not counted as successful transactions. The separate commodity-resource adapter remains disabled, with zero
production NEP-245 resource trades or player listings. The existing Testnet economy contract and standalone chain
evidence are documented in [`TESTNET_DEMO.md`](TESTNET_DEMO.md). The root game routes player electricity offers through
the power-company economy; the merchant fuel/permit/parts shop still uses the local simulation. Commit `63a33b1` was
pushed to the private `0x-kayser/blackout` repository. Railway is online at
https://blackout-production-c7fc.up.railway.app. A live browser check confirmed the welcome screen, four-step optional
product tour, guest and Google entry choices, and campaign route. Public config confirms Google is enabled; a real
Google consent-and-return flow still needs a player sign-in to verify.

## NEP-245 resource-market preflight and remaining integration work

The resource contract does not need to be created from scratch: the existing Testnet contract is
`vesper-econ.blackout-kay.testnet`, owned by `blackout-kay.testnet`, with `vesper-op.blackout-kay.testnet` as its
operator. Read-only contract queries confirmed registered IDs including `fuel:diesel`, `permit:carbon`,
`material:steel`, and `part:turbine`. The production power-economy service already uses this economy. No resource-token
transfer, new account/key creation, funding, or deployment was attempted during this audit.

The production commodity-resource adapter is a separate integration. It was missing:

- `NEAR_CHAIN_ENABLED`
- `NEAR_RESOURCE_CONTRACT_ID`, `NEAR_VAULT_ACCOUNT_ID`, `NEAR_VAULT_OPERATOR_PRIVATE_KEY`
- `NEAR_MERCHANT_{EMBER,LANTERN,HARBOR}_ACCOUNT_ID` and corresponding restricted keys

The existing contract's resource IDs also differ from the resource adapter's expected IDs (`DIESEL_100ML`,
`CARBON_PERMIT_10KG`, `REPAIR_PART`, `SOLAR_COMPONENT`, and `BATTERY_COMPONENT`). Pointing the adapter at the existing
contract alone would not enable working resource trades. The contract IDs, merchant permissions and balances, vault
escrow, and the root game's market flow must be aligned and verified before enabling this adapter. The larger
`scripts/near-bootstrap.ts` provisions a separate resource setup; do not run it as a shortcut. Google Identity Services
is enabled without Supabase; email login remains unavailable in production. Bootstrap code is not deployment evidence.

## Capability matrix

| Track capability | Current implementation | On-chain vs off-chain | Status |
|---|---|---|---|
| NPC economic agents | Deterministic merchant agents have finite stock, cash, reserve floors, replacement-cost pricing, demand response, restock lead times, rationing and readable pricing rules. The root game also has three Testnet power companies that decide whether to buy player electricity. | The live power-economy service records on-chain operations. That is separate from merchant commodity inventory: no production NEP-245 fuel, permit, or material trade was found. | Power-company economy is connected; live commodity NPC balances and transfers are not verified. |
| NEP-245 resources | `contracts/near/src/lib.rs` implements the multi-token contract, resource IDs, units, balance views, transfers, approvals, capped/idempotent NPC transfers, settlement checks, and listing escrow primitives. An existing Testnet economy contract is deployed and has registered resource IDs, including diesel, permits, steel, and turbine parts. | The root resource adapter expects token IDs that differ from those registered on the existing economy contract. Production resource mode is disabled, and no live resource trade or merchant balance was verified. | Contract deployed; resource adapter and market integration are not live. |
| NPC to game vault trade | `apps/api/src/chain.ts`, `apps/api/src/workers.ts`, and `apps/api/src/services.ts` provide a real-transfer path when the resource adapter is configured: a merchant function-call key submits NEP-245 diesel into a shared vault and the final RPC outcome is reconciled with the game trade. | Resource transfer would be on-chain; credits and each player's game allocation remain off-chain. The server manages the vault key. | Local code path exists; Railway lacks the resource-specific configuration and the expected token IDs do not match the existing contract. No live commodity transfer was verified. |
| Player ownership and listings | `packages/sim/src/marketplace.ts`, `apps/api/src/routes.ts`, `apps/api/src/services.ts`, `apps/api/src/workers.ts`, and `apps/web/src/ui/Panels.tsx` implement registered-player listings, chain-backed fuel reservation, cancellable seven-day listings, autonomous merchant evaluation, and off-chain game-credit settlement. Migration `004_marketplace_jobs.sql` stores durable jobs. | The server maps the authenticated player ID to a shared custodial vault allocation. The contract moves the resource from that vault into listing escrow, then to a registered NPC account. The listing price and payment are off-chain fictional credits. The separate player-account provisioning in the power-economy service does not establish ownership of these resource listings. | Local end-to-end path and fake-RPC behavior tested; production resource mode is disabled and there is no live listing or transfer evidence. |
| Social and email login | Guest sessions, Google Identity Services, Google-to-player mapping, and guest-to-account save migration are in `apps/api/src/auth.ts`, `apps/api/src/routes.ts`, and `apps/web/src/api/auth.ts`. The live welcome screen shows Google sign-in beside guest play. | Authentication is off-chain. Registered players can receive a server-managed Testnet account for the power economy. It is not currently attached to NEP-245 resource listings. | Production page and public config show guest and Google entry; email is disabled. Automated Google token-verification tests pass; the real Google consent-and-return flow remains unverified. |
| Invisible custody and judge audit | The player interface has no wallet or transaction-verification screen. Chain status and evidence are exposed only through `/api/admin/chain-audit`, `/api/economy/admin/audit`, and operator-only `/api/chain/*` routes. | The operator audit requires `ECONOMY_ADMIN_TOKEN` in an `x-admin-token` header. Configured server keys remain on the server; the player interface does not show them. | Deployed to Railway. The audit returned 403 without the token and 200 with the configured Railway token. |
| Progressive challenge loop | Before entry, an optional four-step tour explains the rescue, controls, merchant/resource decisions, player electricity offers and campaign. The in-game three-step rescue gives each action a direct button and matching city marker. After it, the HUD keeps a named campaign chapter, progress, unlock and recommended next action visible. The weekly crisis opens from the same card and applies its named opening condition; same-week players receive identical inputs. | Campaign goals use simulation rules. Challenge runs use deterministic, condition-specific opening inputs plus seeded incidents; the live company remains saved. | Deployed to Railway on 2026-11-11; the live welcome screen and tour were browser-verified. Local desktop/mobile browser checks cover the guided rescue and campaign loop. Weekly runs start past the tutorial so scores cover the challenge. Permit thresholds remain fixed, not calibrated from playtest telemetry. |
| Clear trading navigation | The commodity market opens on merchant stalls, shows an explicit shop action, then the player's holdings and owned listings. The Power Companies panel lets players offer spare electricity and inspect NPC budgets, weather, offers, decisions and deal status. | Commodity quotes and trades remain simulation-only in production. Power-company operations use the connected on-chain economy when configured and available. | Deployed to Railway on 2026-11-11. Desktop/mobile market and power-company navigation were checked locally; no production commodity trade was performed. |
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
  must be a registered NPC. The contract does not enforce off-chain credit payment; the application worker must
  authorize fills through the NPC policy and buyer-budget checks, then settle fictional credits exactly once.
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

- `pnpm typecheck` — **passed 2026-11-11** after the interface and API response changes.
- Final verification after the tour-copy and compliance update: `pnpm typecheck` — **passed**; `pnpm test -- --maxWorkers=2 --minWorkers=1` — **204 passed across 22 files**; `pnpm build:web` — **passed**; `git diff --check` — **passed**. The build retains the existing 948 kB lazy 3D scene warning.
- `pnpm build:contract` — produced `contracts/near/res/blackout_resources.wasm` using the plain Cargo fallback. `cargo-near`
  was not installed, so NEAR-specific WASM compatibility and Testnet loading are unverified.
- `pnpm build:web` — **passed 2026-11-11**. The welcome/game controls build to about 120 kB; Vite still warns that the lazy-loaded 3D scene chunk is 948 kB. That scene loads after the player chooses how to enter.
- Focused Google and region API integration tests passed, including Google token validation, read-only trade quotes, and read-only investment quotes that match completed investment shares.
- Full `pnpm test` — **204 passed across 22 test files** on 2026-11-11.
- Playwright `tests/e2e/browser/region.spec.ts` previously passed **6 desktop/mobile checks** for the four-step tour, guest rescue/campaign/weekly crisis, email sign-in/out, primary navigation, local merchant purchase and replay, and mobile market/account access. A rerun after the latest tour-copy edit timed out waiting for the Playwright-managed local API healthcheck, although the same API command was started and its health endpoint answered when launched separately. The new copy is covered by the successful typecheck and web build, but this latest rerun did not verify it in Playwright. The earlier browser pass preceded this copy-only change. Google OAuth consent and live gameplay transactions were not performed against production.
- `git diff --check` — passed after the current local changes.
- The mobile HUD now keeps both city status and cash visible without horizontal scrolling in local browser checks. A real Google OAuth consent round-trip, mobile production gameplay, and live Testnet resource trade are not claimed from these checks.

Local tests and fake RPC fixtures do not constitute live Testnet evidence. Do not infer a deployment from a successful
build.

## Judge demo path and current availability

The guest game, electricity loop, campaign progression, weekly challenge and seven-day replay can be demonstrated
locally and in the production UI. TinyFish reached the production entry page and found the guest/Google choice, but its
SPA content extraction returned empty content; it did not verify every production screen. The production root game's
Power Companies panel is connected to the Testnet power economy. The separate commodity listings are not connected to
that panel or to the production resource adapter. To inspect chain evidence, use the protected operator audit route
from a trusted environment; the player UI intentionally hides transaction hashes. Fake-RPC fixtures must never be
shown as live settlement evidence.

The next chain step is to align the commodity adapter with an existing deployed contract: reconcile the adapter's
token IDs with the contract's registered IDs, verify merchant accounts and their resource balances, configure
restricted merchant and vault keys, and connect the root game's player-market flow to the adapter. Then run and
independently verify the NPC purchase and player-listing settlement path on Testnet before enabling it in production.
Do not run the separate resource bootstrap or claim that the Testnet owner balance covers any changes until the
incremental storage and gas requirements have been checked. Google login is enabled in production but its consent and
return to a saved company still need a real sign-in; email is not configured. Record transaction hashes only after
final outcomes are observed and independently re-queried.

## Known gaps against acceptance criteria

1. NEP-245 resource balances and transfers for three commodity merchants: **not live-verified in the root game**. The deployed contract and power-economy transactions do not prove commodity ownership or merchant transfers.
2. Registered-player Testnet identity: **server-managed account provisioning exists for the power economy; the commodity marketplace does not yet tie listings to that account or an on-chain escrow balance**.
3. Player-owned active commodity listing with actual balance reservation: **local flow implemented; production adapter disabled and live contract escrow unverified**.
4. Autonomous NPC evaluation and purchase of player commodity listings: **policy and worker implemented; live NPC resource transfer unverified**.
5. Real verifiable Testnet transaction hash for commodity settlement: **none recorded**. Power-economy transaction evidence exists in the protected audit and [`TESTNET_DEMO.md`](TESTNET_DEMO.md).
6. Exactly-once listing payment reconciliation/refund: **local idempotent flow implemented and fake-RPC tested; live RPC outcomes unverified**.
7. Economy evolves without a developer patch: **local continuous simulation and deterministic replay are implemented; the root power-company economy is connected to Testnet and has recorded operations, but live autonomous NEP-245 commodity trading is unverified**.
8. Wallet-free normal gameplay: **guest and Google login are enabled in production config; the separate server-managed Testnet account is not exposed in the normal game loop**.
9. Judge evidence: **protected operator audit routes are deployed; the production audit observed the commodity resource adapter disabled, zero resource trades/listings, and a connected power-economy service**.
