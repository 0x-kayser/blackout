> **Update 2026-11-08 (integration pass):** the mock transport described below has been removed. `apps/web` now runs
> only against the real API (`src/api/client.ts`), with a canvas city renderer (`src/city/`), real Google/email/guest
> auth (`src/api/auth.ts`) and panels in `src/ui/`. See docs/INTEGRATION_REPORT.md for the current state. The original
> notes are kept below for history.

# BLACKOUT frontend implementation

## What is included

`apps/web` is a React + TypeScript + Vite frontend containing the full first-time-player vertical slice and the surrounding P0 interface structure:

- Welcome, accessible guest-preview entry, and scenario picker.
- Market Quarter city map with five original CSS/SVG-style storefronts, cables, dark/lit states, and direct business inspection.
- The tutorial flow: accept Cold Room → tap or drag to the highlighted generator → cable/light transition → delayed simulated settlement.
- Request cards, a bounded counter-offer slide-over, generator capacity/fuel/heat/wear, active contracts, wave advance, and an event-derived shift report.
- Morning Market, assets placeholder, five-step help, reduced-motion and sound preferences, Economy Observatory shell, and an honest unavailable chain-transparency drawer.
- Responsive grid and touch/keyboard-operable alternatives for the main connection interaction.

## Run locally

```sh
pnpm install
pnpm dev:web
```

Create a production bundle with:

```sh
pnpm build:web
```

The production static bundle is emitted at `/dist` for the configured private Site deployment.

## Current transport status

This repository currently contains `packages/shared`, but does **not** contain an API service or the shared product specification document requested by the frontend brief. The frontend therefore starts an explicit `MockGameTransport` and shows the persistent orange `DESIGN PREVIEW — Simulated data` banner. It does not fall back to mock after a live-API failure and it never represents a mock trade, account, wallet, or chain confirmation as genuine.

`apps/web/src/api/client.ts` is the single client boundary. It exports the canonical `GameStatePublic`, `PlayerAction`, and `EconomyEvent` types from `@blackout/shared` alongside the temporary UI projection/preview transport. When `apps/api` is added, replace only that transport with `createApiClient(import.meta.env.VITE_API_BASE_URL)` from the shared package; do not duplicate rules in React components.

Expected non-secret configuration for that integration:

```sh
VITE_API_BASE_URL=http://localhost:3000
```

No `VITE_` variable may contain a bearer token, private key, or signing secret.

## Contract inventory discovered in `packages/shared`

The typed shared client defines these operations:

| UI area | API operation |
| --- | --- |
| Guest entry | `startSession`, `createRun`, `getState` |
| Game decisions | `act` with a versioned, idempotent `ActionEnvelope` |
| Live state | run-state SSE URL with last-event handling |
| Morning Market | `market`, `quote`, then `act(BUY)` |
| Observatory | `createReplay`, `getReplay`, `compare`, replay SSE |
| Transparency | `chainStatus`, `transfer` |
| Audit/history | `ledger` |

The UI event vocabulary must use the canonical shared types: `OUTAGE_STARTED`, `CUSTOMER_REQUESTED`, `CONTRACT_ACCEPTED`, `LOAD_ASSIGNED`, `SERVICE_STARTED`, `ENERGY_DELIVERED`, `FUEL_CONSUMED`, `CO2_EMITTED`, `TRADE_CONFIRMED`, `MERCHANT_REPRICED`, `BUSINESS_STATUS_CHANGED`, and `DAY_SETTLED` (among others). The preview only animates a small supported subset and labels it as simulated.

## Honest delivery matrix

| Status | Scope |
| --- | --- |
| MOCK ONLY | First-shift tutorial, City Map, request flow, market display, reports, Observatory preview shell |
| BLOCKED BY BACKEND | Session/run persistence, version conflicts, SSE catch-up, live quotes, confirmed trades, deterministic replay comparison, testnet proof and explorer links |
| DEFERRED / LOCKED | Fuel Squeeze, Grid Independent, battery/solar purchase, maintenance |

## Verification

- `pnpm build:web` compiles TypeScript and emits the static Vite bundle.
- No real-backend end-to-end test was run: this checkout has no `apps/api` implementation or runnable endpoint to target.
