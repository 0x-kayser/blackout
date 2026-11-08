# Chain evidence

**Status (2026-11-08): no Testnet deployment exists.**
There is no contract id, account id or transaction hash to show, and none is invented anywhere in this repository,
its tests or its docs. `GET /api/chain/status` returns `mode: "disabled"` until the steps below are done.

## What is verified locally
* `contracts/near` — NEP-245 resource contract and listing escrow primitives. Run `pnpm test:contract` for the current
  count. Tests cover mint events,
  NPC transfer cap + idempotency, non-NPC rejection, attacker cannot move others' tokens, approvals bounded by amount,
  1-yocto enforcement, batch length checks, storage registration required, `settle_day` consistency and operator-only,
  listing escrow/cancel/fill authorization and duplicate-fill rejection. These are local contract tests only; they do not
  verify a deployment or live transaction.
* API chain worker — fake-RPC tests cover confirmed and failed outcomes, no duplicate submission on unknown results,
  recovery after signing, registered-player gating, player listing escrow, autonomous NPC purchase, evidence lookup,
  and RPC outcome parsing. `packages/sim/test/marketplace.test.ts` covers backed-fuel eligibility, policy decisions,
  credit reservation/refund, cancellation, and exactly-once settlement.

## Steps to produce real evidence (developer)
1. `pnpm build:contract` → `contracts/near/res/blackout_resources.wasm` (prefer `cargo near` if installed).
2. With your own funded testnet account:
   `NEAR_PARENT_ACCOUNT_ID=you.testnet NEAR_PARENT_PRIVATE_KEY=ed25519:… pnpm chain:bootstrap`
3. Copy `.env.chain` into `.env`, restart `pnpm dev`, check `GET /api/chain/status` → `rpcReachable: true`, `contractDeployed: true`.
4. Configure Supabase Google/email login, register three NPC Testnet accounts, and create a registered `play` city.
   Buy diesel and wait for final confirmation. The transaction hash is available in the Verify panel and
   `GET /api/chain/transfers/<hash>` re-verifies it.
5. In Marketplace, list only the displayed confirmed fuel. The player market worker escrows it, explains each merchant's
   decision, reserves fictional game credits when an NPC qualifies, and settles the resource transfer. Inspect final
   list and fill hashes in Verify or `GET /api/chain/market-listings`; re-query each hash before presenting it as evidence.
6. No live listing transaction can be demonstrated until bootstrap succeeds with a funded Testnet parent account. The
   current fake-RPC integration path is for local verification only and must not be presented as a chain transaction.

## Evidence table (fill only with real, verified values)
| Item | Value | Verified how |
|---|---|---|
| Resource contract | _not deployed_ | |
| Vault account | _not created_ | |
| Merchant accounts | _not created_ | |
| Example diesel transfer tx | _none_ | |
| Player listing escrow tx | _none_ | |
| NPC listing fill tx | _none_ | |
