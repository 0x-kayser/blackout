# NEAR testnet setup

Status: **not deployed**. No Testnet credentials or funded parent account were available during this pass. The contract,
player market API/UI, NPC policy worker, and reconciliation path have local tests; nothing here is a live contract id or
transaction hash. See [NEAR_TRACK_COMPLIANCE.md](NEAR_TRACK_COMPLIANCE.md) for the current gaps.

## Model
| Thing | Where | Notes |
|---|---|---|
| Resources (diesel, permits, parts) | one NEP-245 contract `bo-resources.<you>.testnet` | `DIESEL_100ML` = 100 mL, decimals 0 |
| Merchant NPC wallets | `bo-ember/lantern/harbor.<you>.testnet` | bootstrap would create real accounts; server receives only **function-call keys** scoped to `npc_transfer` on the resource contract (0.25 NEAR gas allowance), per-call cap enforced on-chain, idempotent `trade_id`. Not created yet. |
| Player resources | shared custodial game vault `bo-vault.<you>.testnet` plus NEP-245 listing escrow | players have no private key; their allocation is mapped to a signed-in player ID in the game DB and recorded as listing seller ID by the contract. This is custody, not player self-custody. |
| Credits | off-chain game ledger | non-redeemable; no exchange is claimed atomic |
| Rival, permits | game ledger only | documented gap |

Players never see a wallet, seed phrase or gas prompt. Per-player NEAR accounts are **not** provisioned (would need a
funded relayer/sponsor); the account model is honestly "custodial vault".

## Steps
1. Build: `pnpm build:contract` (prefer `cargo near build` if installed — handles NEAR wasm compatibility; the plain
   cargo fallback is unverified on-chain). Unit tests: `pnpm test:contract` (see current count in `NEAR_TRACK_COMPLIANCE.md`).
2. Bootstrap with **your own** funded testnet account (create one in a NEAR wallet or `near-cli-rs`, fund via the
   testnet faucet):
   ```bash
   NEAR_PARENT_ACCOUNT_ID=you.testnet NEAR_PARENT_PRIVATE_KEY=ed25519:... pnpm chain:bootstrap
   ```
   Creates the sub-accounts, deploys + initialises the contract, registers tokens and storage, mints a 5,000 L
   warehouse per merchant, registers NPCs, adds function-call keys, writes `.env.chain` (git-ignored). Full-access keys
   go to `.near-credentials/blackout/` (git-ignored) and never to the server.
3. Add the generated `NEAR_VAULT_OPERATOR_PRIVATE_KEY` as well as account and merchant fields to the API secret store,
   set `ECONOMY_ADMIN_TOKEN`, restart, and query `GET /api/admin/chain-audit` from a trusted operator environment.
   Chain status is not part of player-facing health or public configuration.
4. Smoke test: sign in, start a city, and buy diesel in Marketplace. The normal game says delivery is being confirmed
   while the city keeps running. After final RPC confirmation, inspect the transaction through the protected operator
   audit, re-verify with `GET /api/chain/transfers/<hash>`, and compare contract views `mt_balance_of`, `trade_status`.

## Purchase lifecycle (as implemented)
`REQUESTED → VALIDATED → RESERVED` (credits + stock into escrow, one DB transaction) `→ SUBMITTED` (signed; hash
persisted **before** broadcast) `→ CONFIRMED` (RPC final, no failed receipts) `→ APPLIED` (`SETTLE_TRADE`: fuel to
player, credits to merchant). Definitive failure → compensated once. Unknown/timeout → reconciled by hash, then by the
contract's `trade_status(trade_id)` view; never re-broadcast blindly and never auto-compensated while unknown.

## Player listing lifecycle
`custodial_list`, `custodial_cancel_listing` and `custodial_fill_listing` move NEP-245 resources into, out of, or
between the contract and registered NPC accounts. The bootstrap gives the vault a function-call key scoped to those
three methods. NPC keys are scoped only to `npc_transfer`. The API permits registered players to list confirmed,
chain-backed, unreserved fuel. The deterministic NPC policy checks inventory gap, recent demand, replacement cost, and
cash above its operating reserve. The API reserves the NPC's fictional credits before the contract call, pays the player
only after verified resource transfer, and refunds on a definitive failure. An unknown outcome stays reserved until
hash/contract reconciliation. Listing credits remain off-chain and are never represented as an atomic token payment.
The per-player allocation is trusted server state; the contract enforces the shared vault's aggregate available balance.

## Key rotation & recovery
Rotate an NPC key: add a new function-call key with the full-access key from `.near-credentials`, update the env
var, delete the old key. A leaked NPC key can only move that NPC's own diesel, at most the configured per-call cap,
once per trade id. Rotate the vault operator key the same way; it can list vault-held resources, cancel an active
listing, or fill an active listing to a registered NPC. Generator NFTs (NEP-171) are **deferred**.
