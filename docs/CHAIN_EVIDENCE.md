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
* API chain worker — 6 tests with a fake RPC: confirmed → settle once with hash; failed → compensate once;
  unknown → reconcile without re-broadcast; crash after signing → reconcile, no re-sign; guest runs never create jobs;
  RPC outcome parsing incl. failed receipts.

## Steps to produce real evidence (developer)
1. `pnpm build:contract` → `contracts/near/res/blackout_resources.wasm` (prefer `cargo near` if installed).
2. With your own funded testnet account:
   `NEAR_PARENT_ACCOUNT_ID=you.testnet NEAR_PARENT_PRIVATE_KEY=ed25519:… pnpm chain:bootstrap`
3. Copy `.env.chain` into `.env`, restart `pnpm dev`, check `GET /api/chain/status` → `rpcReachable: true`, `contractDeployed: true`.
4. Create a run with `mode: "play"`, play to day 2 morning, buy diesel. The trade shows `pending` → `submitted` →
   `confirmed` with a hash once the RPC reports a final outcome. `GET /api/chain/transfers/<hash>` re-verifies it.
5. The player listing API/UI and NPC purchase worker are not implemented yet, so the end-to-end listing demo cannot be
   produced from this build. Record actual chain evidence only after those paths exist and have been exercised.

## Evidence table (fill only with real, verified values)
| Item | Value | Verified how |
|---|---|---|
| Resource contract | _not deployed_ | |
| Vault account | _not created_ | |
| Merchant accounts | _not created_ | |
| Example diesel transfer tx | _none_ | |
