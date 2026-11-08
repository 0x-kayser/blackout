# NEAR testnet setup

Status: **not deployed**. No Testnet credentials or funded parent account were available during this pass. The contract
and escrow primitives have local tests, but the player exchange API/UI is not connected; nothing here is a live
contract id or transaction hash. See [NEAR_TRACK_COMPLIANCE.md](NEAR_TRACK_COMPLIANCE.md) for the current gap list.

## Model
| Thing | Where | Notes |
|---|---|---|
| Resources (diesel, permits, parts) | one NEP-245 contract `bo-resources.<you>.testnet` | `DIESEL_100ML` = 100 mL, decimals 0 |
| Merchant NPC wallets | `bo-ember/lantern/harbor.<you>.testnet` | bootstrap would create real accounts; server receives only **function-call keys** scoped to `npc_transfer` on the resource contract (0.25 NEAR gas allowance), per-call cap enforced on-chain, idempotent `trade_id`. Not created yet. |
| Player resources | custodial game vault `bo-vault.<you>.testnet` | players have no private key; the per-player split is the game DB. This is custody, not player self-custody. Listing escrow exists at contract level, but no player listing API/UI currently calls it. |
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
   restart, and check `GET /api/chain/status`
   (`rpcReachable: true`, `contractDeployed: true`).
4. Smoke test: sign in (any mode), start a city, Market → buy diesel. The trade shows "Settling on NEAR testnet…" until
   the worker sees a **final** RPC outcome; then fuel is delivered and "verified on NEAR" links to the explorer.
   Re-verify with `GET /api/chain/transfers/<hash>` and the contract views `mt_balance_of`, `trade_status`.

## Purchase lifecycle (as implemented)
`REQUESTED → VALIDATED → RESERVED` (credits + stock into escrow, one DB transaction) `→ SUBMITTED` (signed; hash
persisted **before** broadcast) `→ CONFIRMED` (RPC final, no failed receipts) `→ APPLIED` (`SETTLE_TRADE`: fuel to
player, credits to merchant). Definitive failure → compensated once. Unknown/timeout → reconciled by hash, then by the
contract's `trade_status(trade_id)` view; never re-broadcast blindly and never auto-compensated while unknown.

## Listing contract primitives
`custodial_list`, `custodial_cancel_listing` and `custodial_fill_listing` move NEP-245 resources into, out of, or
between the contract and registered NPC accounts. The bootstrap gives the vault a function-call key scoped to those
three methods. NPC keys are scoped only to `npc_transfer`. `unit_price_cc` is listing metadata for off-chain,
non-redeemable credits; the contract does not enforce a credit payment. The server would be trusted to evaluate and
settle the off-chain credit leg. No game route currently implements that flow, so do not use these methods as a live
player market yet.

## Key rotation & recovery
Rotate an NPC key: add a new function-call key with the full-access key from `.near-credentials`, update the env
var, delete the old key. A leaked NPC key can only move that NPC's own diesel, at most the configured per-call cap,
once per trade id. Rotate the vault operator key the same way; it can list vault-held resources, cancel an active
listing, or fill an active listing to a registered NPC. Generator NFTs (NEP-171) are **deferred**.
