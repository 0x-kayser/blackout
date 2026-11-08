# Architecture

```
browser ──HTTP /api/* (actions, quotes)──▶ apps/api (Fastify) ──▶ packages/sim (pure engine)
   ▲      ◀──SSE /api/game/events────────┘       │  │                    ▲
   │        (state frames + economy events)      │  └─▶ SQLite (node:sqlite, WAL)
   │                                             │       players · identities · runs · snapshots
   │  Supabase Auth (PKCE) ──JWT──▶ verified     │       actions (idempotency) · events · ledger · chain_jobs
   │  locally against the project's JWKS         └─▶ chain worker ──▶ NEAR testnet (NEP-245 contract)
```

One repository, one deployable: the API serves the built web app (`dist/`) from the same origin, so cookies,
CORS and OAuth redirects are simple. In development Vite (5173) proxies `/api` to the API (8787).

## Packages
| Path | Role |
|---|---|
| `packages/shared` | Zod schemas + TS types for every DTO, the `PlayerAction` union, `EconomyEvent`, error codes, unit helpers. Imported by web, API, sim and tests. |
| `packages/sim` | The only economic engine. Pure, deterministic (`nextState`, `applyAction`, `tick`), seeded PRNG in state, double-entry ledger, customers, merchants (one pricing file `policies/merchantPricing.ts`), rival, regulator, solar/battery, replay + bots, CLI. Cached Brent dataset in `data/brent.json`. |
| `apps/api` | HTTP/SSE, auth, players & saves, real-time driver (1 tick/s), idempotent actions, checkpoints & recovery, Economy Lab replays, NEAR adapter + chain worker, static web serving. |
| `apps/web` | React 19 + Vite. `src/api/client.ts` is the single API boundary; `src/city/renderer.ts` is a Canvas-2D isometric renderer; `src/ui/*` panels. No game rules in the client. |
| `contracts/near` | NEP-245 resource contract (Rust, near-sdk 5.30.1) + unit tests. |
| `database/migrations` | Numbered SQL migrations applied at startup and by `pnpm db:migrate`. |
| `tests/` | API integration, auth, chain worker (fake RPC), SSE e2e, Playwright browser journeys. |

## Request lifecycle (every gameplay action)
1. UI sends `{action, idempotencyKey}` to `/api/game/actions` with the session (cookie or Supabase bearer).
2. API authenticates → resolves the player → loads that player's active run (never a client-supplied id).
3. Idempotency: if the key exists, the stored result (success **or** error) is returned (`replayed: true`).
4. `applyAction` runs on a clone; on `SimError` nothing changes and the error is stored under the key.
5. On success the new state, events, ledger rows, action row and a checkpoint commit in one SQLite transaction.
6. Events stream over SSE; the response also carries them and the new `GameStatePublic`.
7. Diesel purchases in chain mode leave the trade `pending`; the chain worker settles or compensates it exactly once
   from a verified RPC outcome (a recorded `SETTLE_TRADE` system action).

## Time
* Engine tick = 1 s = 6 game minutes; a game day = 240 ticks; days are environmental (daylight, solar, evening
  peak) and roll over without interrupting play.
* The driver advances only runs with a connected client; 15 s without one → paused. It never catches up more than
  5 s after a stall. Offline time therefore never burns fuel or bankrupts anyone.

## Persistence & recovery
Checkpoint (`snapshots.kind='latest'`) on every action, wave, day rollover and every 5 ticks; plus a per-day
snapshot. Restart → load checkpoint → re-apply logged actions at their original ticks → deterministically replay
forward to the last persisted event (INSERT OR IGNORE keeps the log duplicate-free). Tested.

## Observability
Structured JSON logs (pino via Fastify) with `authorization`/`cookie`/`set-cookie` redacted; every response carries
`x-request-id` (accepted from the caller when well-formed) for correlation; rejected actions are logged with run id,
action type and error code; unhandled errors log stack + request id and return `INTERNAL` with the id. `/api/health`
reports DB and chain health.
