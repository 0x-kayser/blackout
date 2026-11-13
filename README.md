# BLACKOUT

## Product

BLACKOUT is a browser strategy game about keeping a regional electricity system running during fuel shortages,
equipment failures, changing demand and merchant cash constraints. Players dispatch generators, build capacity, buy
resources and respond to market events. The simulation runs continuously and uses the same economic rules in live play
and deterministic replay.

## Problem addressed

Many game economies rely on fixed prices, unlimited resource replenishment or developer-set changes. BLACKOUT makes
resource supply, inventory, demand, costs, outages and business finances affect the player's decisions as the game runs.
The world's starting resource endowment is finite; scheduled deposits are counted in that endowment, and the game does
not create replacement supply when resources are consumed.

## NEAR Hackathon track

**Primary track:** Games With Real Economies (`games`)

The track asks for NPCs with wallets, player-owned markets and economies that evolve without developer patches. BLACKOUT
uses NEAR Testnet for account-backed resource ownership and settlement while keeping the normal game loop free of wallet
popups, seed phrases and gas prompts.

| Track requirement | BLACKOUT implementation | Evidence and status |
|---|---|---|
| NPCs with wallets | Merchant and power-company policies make decisions from inventory, demand, cash reserves and market rules. Merchant accounts and the existing economy contract are documented in the Testnet demo. | Historical Testnet evidence is in [`docs/TESTNET_DEMO.md`](docs/TESTNET_DEMO.md). Local simulation/fake-chain tests do not prove a live trade. |
| Player-owned market | The current source includes player listings, inventory reservation, NEP-245 escrow, cancellation and autonomous NPC purchase. A successful fill transfers the resource to the NPC and non-redeemable game credits to the player in one contract call. | Source and fake-chain/contract tests are present in this checkout. This listing implementation has not been deployed or verified with a live transaction. |
| Economy evolves without a developer patch | Continuous world events, finite inventories, merchant balance sheets, NPC policies and deterministic seven-day replay change prices and reliability. | Simulation source is in `packages/sim`; replay is separate from chain settlement. |
| Social login | Guest play and Google Identity Services are implemented. Email magic-link sign-in is not enabled in production. | Production Google consent-and-return must be verified in a real browser before claiming end-to-end sign-in evidence. |
| Players do not need to notice the chain | Registered accounts are server-provisioned and custodially managed. The game UI does not require external wallet setup. Operators can inspect transaction records through protected audit endpoints. | Custody is server-managed; do not describe player accounts as self-custodial or assets as withdrawable. |
| NEP-245 | One multi-token contract represents resources and the Vesper credit unit. The new player listing path uses contract escrow and an atomic fill. | The deployed contract is `vesper-econ.blackout-kay.testnet`; the latest local listing methods still require deployment to that contract before live use. |
| NEAR Intents | Not used. Current flows do not need cross-chain conversion or solver-based settlement. | Deliberately excluded; see [`docs/NEAR_TRACK_COMPLIANCE.md`](docs/NEAR_TRACK_COMPLIANCE.md). |

## Try the game

Production URL: [blackout-production-c7fc.up.railway.app](https://blackout-production-c7fc.up.railway.app/)

1. Open the URL and choose **Continue with Google**. Guest play is available only when the server enables
   `ALLOW_GUEST_PLAY`; the local setup below enables it.
2. Follow the first-night guide: set the Eastside battery to **Auto**, start **Kestrel**, then build a diesel peaker in
   Residential East. Each prompt has a button for the next action and an option to skip the guide.
3. Open **Market**, select a merchant and inspect its stock, quote and price explanation before buying.
4. Watch market events affect supply, prices, generator use and customer reliability.
5. Choose **Watch 7 days · about 1 minute** in Market to replay the same economy rules over seven simulated days. The
   replay is a sandbox and does not submit NEAR transactions.

The production release revision has not been independently tied to this checkout. The player resource-listing feature
described above is available in this source tree only until the contract and Railway service are updated and a real
Testnet transaction is verified.

## Local setup

Requirements: Node.js 22.5 or newer and pnpm 10.

```sh
pnpm install
ALLOW_GUEST_PLAY=true AUTH_LOCAL_EMAIL=true AUTH_LOCAL_EMAIL_SHOW_CODE=true pnpm dev
```

Open [http://localhost:5173](http://localhost:5173). Local email codes are displayed in the development UI. Do not set
`AUTH_LOCAL_EMAIL_SHOW_CODE=true` in production. Google sign-in locally also needs `GOOGLE_CLIENT_ID` and
`http://localhost:5173` registered as an authorized JavaScript origin. The classic city game remains available at
`/city`.

This local command runs the game without NEAR unless a complete Testnet economy configuration is supplied. A simulated
listing in local mode is not an on-chain listing.

## Judge path

### Game loop

1. **Sign in with Google** → see the active outage and guided rescue objective. Guest entry works when enabled by the
   server configuration.
2. **Restore service** → see reliability and company finances change as generation meets demand.
3. **Buy fuel or equipment** → see a merchant's finite stock and current price change.
4. **Respond to a crisis** → see the incident's effect on generation, demand, prices or reliability.
5. **Advance the replay** → inspect the same economy rules over seven days with a fixed seed.

### Player resource exchange in this checkout

These steps require the updated API, deployed contract methods, a registered Testnet player account, and configured
operator authorization. They are not yet available on the public Railway release.

1. **List an owned resource** → the API checks the player's account balance, reserves that quantity in the game ledger,
   and calls `resource_listing_create` to escrow the NEP-245 units.
2. **Wait for NPC evaluation** → each eligible merchant checks its open status, current bid, warehouse room, available
   cash, daily reserve and on-chain credit balance. The offer explains its decision.
3. **Withdraw or complete a sale** → withdrawal returns escrow after final confirmation. An accepted sale calls
   `resource_listing_fill`, which transfers the resource to the NPC and Vesper credits from NPC to player atomically.
4. **Verify evidence** → inspect the protected operator audit and the final Testnet transaction. Do not use fake-chain
   results or opening-balance transfers as evidence of a player market trade.

## NEAR design and trust model

- **On chain:** NEP-245 token balances and transfers, player listing escrow, NPC purchase settlement, and other enabled
  Testnet economy operations.
- **Off chain:** electricity dispatch, world simulation, pricing decisions, NPC policy evaluation, account identity,
  and the continuously changing game state.
- **Custody:** the server creates and controls registered players' Testnet account keys. The server pays setup and
  transaction costs. The game does not claim self-custody or player withdrawals.
- **Game credits:** credits are fictional and non-redeemable. The `credit:vesper` token is used in Testnet settlement
  for auditability; it is not a real-money balance or a payout promise.
- **NEAR Intents:** not integrated because the game has no demonstrated supported cross-chain transaction that needs
  it.
- **Player UX:** normal play does not show wallet setup, gas prompts or blockchain terminology. Detailed chain evidence
  is reserved for operator/judge audit routes.

See [`docs/NEAR_TRACK_COMPLIANCE.md`](docs/NEAR_TRACK_COMPLIANCE.md) for capability status and limitations,
[`docs/TRANSACTION_FLOWS.md`](docs/TRANSACTION_FLOWS.md) for settlement sequences, and
[`docs/NEAR_ARCHITECTURE.md`](docs/NEAR_ARCHITECTURE.md) for system boundaries.

## Verification

Run the repository checks:

```sh
pnpm typecheck
pnpm test
pnpm build:web
cargo +1.95.0 test --manifest-path contracts/near/Cargo.toml
```

Focused coverage for the player resource exchange is in:

- `tests/integration/resource-market.test.ts` — local reservation, listing visibility, withdrawal and NPC policy.
- `tests/integration/economy.test.ts` — fake-chain account provisioning and on-chain-style settlement flow.
- `contracts/near/src/tests.rs` — contract escrow, atomic fill, cancellation and ownership checks.

Fake-chain tests verify application behavior against a test double; they are not live Testnet evidence. Record actual
transaction hashes only after independently checking final Testnet outcomes.

Latest local verification (2026-11-13): workspace type-check passed; focused resource-market/economy tests passed
22/22; NEAR contract tests passed 56/56; and the web build passed. All other Vitest tests passed 211/211 when the SSE
suite was excluded. The default full run cannot start that suite because the environment denies its local listener
(`listen EPERM 127.0.0.1`).

## Current limitations

- The new player resource listing methods, API, UI and database migration are implemented in this checkout and locally
  tested, but are not confirmed deployed to the public Railway service.
- The updated NEAR contract has not been deployed to the existing Testnet contract from this checkout. No live player
  listing, fill or cancellation transaction hash is claimed.
- The Testnet operator function-call key must allow `resource_listing_create`, `resource_listing_cancel` and
  `resource_listing_fill`; update/rotate it using the provided key workflow when deployment is authorized.
- Railway Testnet credentials and deployment configuration must be verified before any external deployment. Never
  commit account keys, operator keys, wallet encryption secrets or admin tokens.
- Google sign-in is configured in source and production settings; the real consent-and-return flow still needs browser
  verification. Email sign-in is disabled in production.
- NEAR Intents is not integrated.

## Project documentation

| Document | Contents |
|---|---|
| [`docs/GAME_LOOP.md`](docs/GAME_LOOP.md) | Core gameplay loop and progression |
| [`docs/GAME_DESIGN.md`](docs/GAME_DESIGN.md) | Game systems and player controls |
| [`docs/ECONOMY_MODEL.md`](docs/ECONOMY_MODEL.md) | Economic actors, resources and constraints |
| [`docs/TRANSACTION_FLOWS.md`](docs/TRANSACTION_FLOWS.md) | Chain settlement flows and failure handling |
| [`docs/NEAR_TRACK_COMPLIANCE.md`](docs/NEAR_TRACK_COMPLIANCE.md) | NEAR track evidence and known gaps |
| [`docs/TESTNET_DEMO.md`](docs/TESTNET_DEMO.md) | Historical Testnet demo transactions |
| [`docs/NEAR_TESTNET_SETUP.md`](docs/NEAR_TESTNET_SETUP.md) | Testnet configuration |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Hosting and deployment configuration |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Secrets and security boundaries |

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Run API and web client locally |
| `pnpm test` | Run Vitest unit and integration suite |
| `pnpm test:e2e` | Run Playwright browser journeys |
| `pnpm typecheck` | Type-check workspace packages |
| `pnpm build:web` | Build the web client |
| `pnpm build:contract` | Build NEAR contract WASM |
| `cargo +1.95.0 test --manifest-path contracts/near/Cargo.toml` | Run NEAR contract tests |

## License

MIT. See [`LICENSE`](LICENSE).
