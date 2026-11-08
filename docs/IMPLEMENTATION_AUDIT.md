# Implementation audit — 2026-11-08

Scope: the whole repository at the start of the "master end-to-end" pass. Sources: code, `git log`
(two "Update Site source" commits by the frontend workstream), docs/, a production build of `apps/web`.

## 1. Stack found
| Area | Found |
|---|---|
| Package manager | pnpm 10 workspace (`apps/*`, `packages/*`) |
| Frontend | React 19 + Vite 7, one 301-line `App.tsx`, 1 CSS file, no canvas/game library |
| Shared types | `packages/shared` (Zod 4 schemas, PlayerAction union, events, error codes, typed client) |
| Simulation | `packages/sim` pure deterministic engine, seeded PRNG, double-entry ledger, NPC agents, replay bots, CLI |
| Backend | `apps/api` Fastify 5 + `node:sqlite`, guest auth, SSE, idempotent actions, snapshots, replays, chain worker |
| Database | SQLite (WAL) with in-code migrations; no migration directory |
| NEAR | `contracts/near` NEP-245 contract (16 unit tests), testnet adapter in API; **nothing deployed** |
| Tests | 53 TS (vitest) + 16 Rust; no browser e2e |
| Hosting | `.openai/hosting.json` deploys `dist/` as a static site (frontend only) |

## 2. Working
* Engine: Cold Room tutorial, exact fuel/CO₂/billing math, capacity across overlapping contracts, fuel/permit
  reservation, customer P&L and closures, three merchants (one pricing file), rival, regulator, solar/battery,
  deterministic 7-day replay with three policies. All tested.
* API: guest sessions, owner-scoped runs, idempotent actions, SSE with resume, crash recovery, replays/compare,
  honest chain status. Tested, and verified against a live server with curl.
* Frontend build succeeds; visual language (palette, typography, welcome screen) is good.

## 3. Incomplete / broken / disconnected
| # | Finding | Severity |
|---|---|---|
| A1 | **Frontend never talks to the API.** `apps/web/src/api/client.ts` is a `MockGameTransport` with hard-coded businesses, prices (`EmberFuel ₡8.00`), a fake 800 ms "settlement", a hand-made uptime chart. Its action names (`ASSIGN_LOAD`, `BUY_FUEL`, `ADVANCE_WAVE`) do not exist in the shared contract. | critical |
| A2 | **Game structure contradicts the new spec**: engine has mandatory morning market, nightly settlement, Day 1–3 campaign end. Must become continuous. | critical |
| A3 | **No real authentication.** Guest tokens only; no Google/email; no player profile separate from a run; one-run-per-request model, no "my game". | critical |
| A4 | City is DOM buttons on a CSS gradient; no zoom/pan, no infrastructure growth, no day/night. | high |
| A5 | No NEAR testnet deployment, no NPC accounts, no transaction evidence (needs developer-created testnet accounts). | high (external) |
| A6 | Oil index is an illustrative hard-coded series, not a cached historical dataset with provenance. | medium |
| A7 | No browser e2e tests. | medium |
| A8 | Hosting serves the frontend only; the API has no deployment target, and cross-origin cookies would need extra config. | medium |
| A9 | Upgrades/expansion exist in the engine but have no UI; Hospital Row / Tech Hub unlock is untested in play. | medium |

## 4. Duplicate systems
* Two game models: the mock UI model (`GameSnapshot`, km floats, `day/wave/gameTime` strings) vs the canonical
  `GameStatePublic`. **Resolution:** delete the mock model; the UI renders `GameStatePublic` only.
* Two "sessions": run-scoped guest token vs the new player identity. **Resolution:** players own one active save;
  guest and Supabase identities both map to players.

## 5. Visual weaknesses
Main screen reads as three dashboards around a small map; cables are static SVG; building states are coloured
rectangles; no growth when you buy equipment; HUD shows hard-coded values ("District trust 48").

## 6. Security concerns
* Mock UI could have been shipped as if real (banner mitigates, but no live path existed).
* `dist/` static deployment + API on another origin would need `SameSite=None; Secure` cookies → prefer serving
  both from one origin.
* No auth provider token verification existed (nothing to verify yet).

## 7. Deployment blockers (external)
| Blocker | Needed from the owner |
|---|---|
| Google sign-in | Supabase project + Google OAuth client (client id/secret, redirect URL) |
| Email sign-in | Supabase project (built-in email works for testing; custom SMTP for volume) |
| NEAR testnet | a funded testnet account to run `pnpm chain:bootstrap` |
| Public URL | a host account (Render/Railway/Fly) or reuse of the existing `.openai` static host for the frontend only |
| X sign-in | deferred: X API free tier closed to new developers (Feb 2026, per third-party reports); no paid access bought |

## 8. Plan executed after this audit
1. Engine → continuous world (day/night environmental; background rollover; market/upgrades always open).
2. Players + identities + Supabase JWT verification (JWKS) + guest upgrade; `/api/me`, `/api/game/*`.
3. Replace the mock frontend with a canvas isometric city on the real API (keeping the existing visual language).
4. Historical Brent dataset (cached, with provenance) feeding the oil index.
5. Playwright journeys; single-origin deployment (API serves the built web app).
