# Hackathon checklist (deadline 2026-11-14 23:59 UTC)

Rules checked 2026-11-07 at nearhackathon.com/HACKATHON.md and the games track brief.

## Submission requirements
- [x] LICENSE (MIT)
- [x] README with reproducible "do X → see Y" steps, libraries used, no prior code
- [ ] Public repository (owner action)
- [ ] Public X post with video/screenshots, tagging @NEARProtocol and #NEARHackathon (owner action)
- [ ] Hosted demo (optional, plus) kept up through 2026-11-18
- [ ] Submission form incl. mainnet payout account (owner action)

## Games track brief
- [~] Items are modeled as NEP-245 multi-tokens, one contract for every item type (`contracts/near`); contract is locally tested, **not deployed**
- [~] Social/email login (Supabase Google + email) implemented and tested against a local JWKS; **needs a Supabase project to go live**. No seed phrases, wallet or gas prompts anywhere.
- [x] Merchant pricing rules in one readable file + tooltip reasons (`policies/merchantPricing.ts`, `reasons`)
- [x] Fast-forward simulates a week (Economy Lab: 7 days in ~0.5–3 s; SSE playback over 60 s; downloadable ledger)
- [x] Player-owned diesel listings, NPC economic evaluation, and two-phase off-chain credit settlement are integrated locally; **live Testnet escrow awaits deployment**
- [x] Game loop designed on paper (30 s / 5 min / session) — `docs/GAME_DESIGN.md`

## P0 backend features
| Feature | Status |
|---|---|
| Deterministic engine, seed + actions ⇒ same trace | done, tested |
| Cold Room first 30 s (1.5 kW × 2 h @ 8) with exact fuel/CO₂/cash | done, tested (engine, HTTP, live server) |
| Continuous clock: 240 s game day, 8 waves 30 s apart, background rollover | done, tested |
| Capacity across overlapping contracts, `CAPACITY_EXCEEDED`, no fuel burned | done, tested |
| Permit hard cap; fuel/permit reservation | done, tested |
| Customer P&L, escrow, refunds of unearned amounts, closures/reopening | done, tested |
| Three merchants: finite stock, cash, restock w/ lead time, insolvency/recovery | done, tested |
| Rival with real constraints; regulator permit market | done, tested |
| Quotes, reservation, single-use, expiry, last-unit race | done, tested |
| API + SSE + idempotency + owner scoping + restart recovery | done, tested |
| 7-day replay, 3 policies, compare endpoint, CLI | done, tested |
| NEP-245 contract | done, 19 unit tests; **not deployed** |
| Three NPC Testnet accounts + real transfers | **not provisioned** (requires funded parent account and bootstrap) |
| Player listing escrow + autonomous NPC fill | local API/UI/worker path implemented and fake-RPC tested; **no live transaction yet** |
| Real testnet transfer with verified hash | **not done** (needs developer-created accounts) |
| Frontend integrated with live API | done; 7 Playwright journeys pass |
| Continuous world + saves + offline pause | done, tested |
| Public deployment | container built and smoke-tested; **no host account yet** |

## Kill-switch check
First 30 s playable on the server: yes. Market has non-scripted responses: yes. Testnet transfer: **absent** →
per the plan, do not start NFT / live-oil work until a real transfer exists.
