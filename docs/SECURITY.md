# Security, custody and trust boundaries

## Trust boundary (what is simulated vs what is on-chain)
| System | Where it lives | Who is trusted |
|---|---|---|
| Electricity, heat, contracts, timers | game server (`packages/sim`) | the server; reproducible from seed + action log |
| Customer decisions, NPC prices, rival, regulator | deterministic engine, seeded | the server; anyone can replay `pnpm sim:replay` |
| Credits | off-chain game ledger (SQLite), **non-redeemable** | the server |
| Diesel purchased in the morning market | NEP-245 `DIESEL_100ML` transfer on NEAR testnet (when chain mode is configured) | the contract + the merchant's scoped key |
| Carbon permits | **simulation only in this build** | the server |
| Player identity | guest token, no PII | the server |

No contract verifies that electricity was produced. `settle_day` only checks a batch is internally consistent
(CO₂ = fuel × 2.68, permits retired ≥ CO₂) and is signed by the operator.

## Custody model
* Players have **no individual NEAR account** in this build. Diesel bought on-chain lands in a **custodial game vault** account
  (`NEAR_VAULT_ACCOUNT_ID`). The per-run split is the game DB. The UI must say "held by the game's vault", not
  "owned by you". Withdrawals are not implemented. Contract escrow methods can hold a listing on a player's behalf,
  but the API/UI currently do not expose them.
* The server can only move merchant tokens with that merchant's scoped key. A separate vault operator function-call key
  can list from vault custody, cancel a listing back to the vault, or deliver an active escrow listing to a registered
  NPC. It cannot call arbitrary contract methods or transfer NEAR.

## Keys
| Key | Type | Scope | Where |
|---|---|---|---|
| contract owner (deployer) | full access | deploy, `register_token`, `mt_mint`, `register_npc` | developer machine only; never on the game server |
| merchant NPC keys ×3 | **function-call**, receiver = resource contract, methods = `["npc_transfer"]`, gas allowance capped (e.g. 0.25 NEAR) | move that merchant's own diesel, ≤ per-call cap, once per `trade_id` | server env `NEAR_MERCHANT_*_PRIVATE_KEY` |
| vault / operator | function-call, receiver = resource contract, methods = `custodial_list`, `custodial_cancel_listing`, `custodial_fill_listing` | list vault-held resources, cancel active escrow, or deliver active escrow to a registered NPC; no credit payment is enforced on-chain | server env `NEAR_VAULT_OPERATOR_PRIVATE_KEY` |

Function-call keys cannot attach deposits, cannot transfer NEAR, cannot deploy and cannot call other contracts.
The contract's per-NPC `max_per_call` and per-trade idempotency bound the damage of a leaked merchant key to that
merchant's own inventory.

## Secrets hygiene
* Secrets only via environment variables; `.env.example` contains placeholders only; `.env*` and `*.key.json` are
  git-ignored.
* `/api/config/public` and `/api/chain/status` expose account **ids** only — tested to contain no key material.
* The server never logs request headers or bodies (Fastify logger off by default); chain errors are truncated to
  300–400 chars of RPC output.
* No secret, key or hidden RNG state is present in `GameStatePublic` (tested: no `rng`, no `balances`).

## Application security
* Auth: random 256-bit guest token; only `sha256(token)` stored; HTTP-only `SameSite=Lax` cookie (`Secure` when
  `COOKIE_SECURE=true`) or bearer header. SSE accepts `?token=` on GET `/events` only.
* Tenant isolation: every run route checks `run.owner_id === session.user_id` (403 otherwise; tested).
* Input validation: every body parsed with the shared Zod schemas; quantities and rates bounded; body limit 64 KB.
* Clients cannot send prices, outcomes or system actions (`SETTLE_TRADE` is rejected at validation; tested).
* Write routes: token-bucket rate limit (20/s, burst 40 per session) and `Origin` allow-list (`WEB_ORIGINS`).
* CORS restricted to `WEB_ORIGINS` with credentials.
* Idempotency keys make retries safe; failed actions are stored too so a retry cannot succeed against a later state.
* Text shown to players is generated server-side from templates; no user free text enters economics.

## Chain failure handling
* Chain unavailable or not configured → the API reports `mode: "disabled"` / `degraded`; guest runs keep working with a
  visible banner; no transfer is ever reported as confirmed.
* A trade is `confirmed` only from an RPC final execution outcome with no failed receipts. Unknown outcomes stay
  `submitted`/`timeout` and are reconciled; they are never compensated automatically because the tx might still land.

## Known security gaps
* Supabase Google/email login code exists, but provider credentials are absent and live login was not verified. Leaderboard is per-server and trivially farmable with new guests.
* The vault is custodial; a compromised vault operator key could escrow pooled vault resources and direct an active
  escrow to a registered NPC. It cannot transfer from a merchant or an external account, but the shared vault does
  not cryptographically isolate one player's allocation from another's.
* Marketplace listing escrow is only a contract primitive. There is no API/UI, NPC listing evaluation worker, off-chain credit reservation, or listing reconciliation path yet.
* Rate limiting is in-memory (single process).
