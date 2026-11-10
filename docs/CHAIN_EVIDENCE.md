# Chain evidence

**Status (2026-11-10): the standalone power-economy Testnet demo is documented, but the separate NEP-245 resource
market adapter is not enabled in the current Railway configuration.** Do not use the standalone demo transactions as
proof that a live BLACKOUT resource-market trade settled on chain. The player interface has no chain or transaction
screen. When the server is configured, operators can inspect its actual state at `GET /api/admin/chain-audit` with
`ECONOMY_ADMIN_TOKEN` supplied as `x-admin-token` from a trusted environment. The endpoint accepts `limit` (1–200)
and `offset` parameters and returns a total count per record stream so operators can page through the retained history.

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
3. Copy `.env.chain` into `.env`, set `ECONOMY_ADMIN_TOKEN`, restart `pnpm dev`, then query the protected
   `/api/admin/chain-audit?limit=100&offset=0` endpoint and confirm the adapter status before presenting evidence.
   Advance `offset` by `limit` for each record stream until its page reaches its reported `total`.
4. Configure Supabase Google/email login, register three NPC Testnet accounts, and create a registered `play` city.
   Buy diesel and wait for final confirmation. The protected operator audit reports recorded transaction hashes;
   `GET /api/chain/transfers/<hash>` re-verifies a hash.
5. In Marketplace, list only the displayed confirmed fuel. The player market worker escrows it, explains each merchant's
   decision, reserves fictional game credits when an NPC qualifies, and settles the resource transfer. Inspect final
   list and fill hashes through the protected operator audit or `GET /api/chain/market-listings`; re-query each hash
   before presenting it as evidence.
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
