# Integration report — 2026-11-08

What changed in the end-to-end pass, what was verified, and what is still blocked.

## Implemented
| Area | Result |
|---|---|
| Continuous world | No mandatory days, morning market or settlement screen. 24-game-hour day/night is environmental (light, solar, evening peak). Background settlement at each rollover. Market, upgrades, servicing, tariffs always available. Contracts cross midnight. Difficulty from progress (tutorial waves → 2 requests → heat + rival → up to 3 requests with ≥10 kW). |
| Auth | Guest sessions; Supabase Google/email via PKCE with local JWKS verification; one player per identity; guest → account upgrade without overwriting; logout; no X button (deferred with reason). |
| Saves | Player → one active city (`/api/game/start` resumes). Checkpoints every 5 s + on every action/wave/day; deterministic recovery; offline = paused (no fuel/bills/bankruptcy), "welcome back" banner. |
| Frontend | Mock transport deleted. Real client (`src/api/client.ts`), SSE with resume + dedupe, idempotent actions with per-control in-flight guard. Canvas isometric city: lit/dark windows, outage pings, animated cables (yours teal, rival red), generator smoke/heat, solar/battery/second diesel appear when bought, locked districts, day/night sky, street lamps, event effects (+credits, power bursts, failures), zoom/pan/pinch, tap targets. HUD, power plant dock, request/contract dock with counter slider, Market (quotes with expiry, reasons, sparklines, pending states), Equipment & tariffs, Expansion, Business (P&L, customers, rival, news), Economy Lab (seeded compare, 8 charts, 60 s playback, downloadable ledger), Verify on NEAR, Profile/settings (name, sound, reduced motion, upgrade, new city, logout), How to play. |
| Oil data | Cached weekly Brent 2026 (EIA via FRED) with provenance; 50% pass-through formula; illustrative scenarios kept and labelled. |
| Deployment | Single-origin container (Dockerfile), Render blueprint, health check, structured logs with request ids. |

## Verified in a real browser (against `pnpm dev`)
Welcome → Play now (guest) → Cold Room goes dark with a red ring → request card with server numbers → Accept →
generator glows → tap it in the city → "Power restored" toast from the server event → Cold Room lit "YOUR POWER",
cable pulses, fuel drains with reservation shown, credits rise per tick → Market: Lantern quote → confirm → stock
30 → 20 L, cash +₡104, price 10.40 → 12.40 → Economy Lab compare with charts → reload → "Continue your city" resumes →
390 px mobile layout (after fixing an overflow bug found here).

Bugs found and fixed during this verification: tap target too small on generators; history events re-toasted after
reload; tutorial outage expiring before the (untimed) player acted, then an over-correction that could bankrupt an
ignored shop (now bounded patience + lapse when the grid returns); oil-strip CSS; mobile horizontal overflow and camera
framing; Cold Room rent rebalanced so neglect alone does not close it within 3 days.

## Not done / blocked (external)
* Google/email sign-in against a real Supabase project — needs project credentials (code path tested with local JWKS).
* NEAR testnet deployment, NPC accounts and a real transfer — needs a funded testnet account (`pnpm chain:bootstrap`).
* Public URL — needs a host account.
* NEP-171 generator NFTs, hedging, LLM dialogue, residential district, multiplayer generator market — not built.
* `settle_day` on-chain batch is implemented in the contract but not called by the API.

## Next technical priority
Real NEAR testnet transfer (bootstrap + one confirmed purchase), then deploy the container with Supabase configured.
