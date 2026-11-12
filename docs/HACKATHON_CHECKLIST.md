# Hackathon checklist (deadline 2026-11-14 23:59 UTC)

Status refreshed 2026-11-11. Items marked *owner action* need the team lead.

Rules checked 2026-11-07 at nearhackathon.com/HACKATHON.md and the games track brief.

## Submission requirements
- [x] LICENSE (MIT)
- [x] README with reproducible "do X → see Y" steps, libraries used, no prior code
- [x] Public repository: `github.com/0x-kayser/blackout` clones without credentials (checked 2026-11-11)
- [ ] Public X post with video/screenshots, tagging @NEARProtocol and #NEARHackathon (owner action)
- [x] Hosted demo: `blackout-production-c7fc.up.railway.app` returns 200 and a healthy `/api/health` (2026-11-11). Keep it up through 2026-11-18.
- [ ] Submission form incl. mainnet payout account (owner action)

## Games track brief
- [~] Items are modeled as NEP-245 multi-tokens, one contract for every item type (`contracts/near`); the economy contract is deployed on Testnet (`vesper-econ.blackout-kay.testnet`, see TESTNET_DEMO.md); a verified player resource trade from the current build is still pending
- [~] Social/email login is live as guest + Google Identity Services; email sign-in is off in production; a real Google consent round-trip still needs checking in a browser. No seed phrases, wallet or gas prompts anywhere.
- [x] Merchant pricing rules in one readable file + tooltip reasons (`packages/sim/src/town/merchantPricing.ts` for the regional market; `policies/merchantPricing.ts` for city mode)
- [x] Fast-forward simulates a week (Economy Lab: 7 days in ~0.5–3 s; SSE playback over 60 s; downloadable ledger)
- [x] Player-owned diesel listings, NPC economic evaluation, and two-phase off-chain credit settlement are integrated locally; the legacy listing adapter is disabled in production, so do not claim live player listings
- [x] Game loop designed on paper (30 s / 5 min / session) — `docs/GAME_DESIGN.md`, `docs/GAME_LOOP.md`

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
| NEP-245 / NEP-171 contract | done, 54 Rust tests in the source (not run in the 2026-11-11 pass); deployed on Testnet |
| NPC Testnet accounts + real transfers | provisioned for the standalone demo; 40 final transactions recorded in TESTNET_DEMO.md (2026-11-09) |
| Player listing escrow + autonomous NPC fill | local API/UI/worker path implemented and fake-RPC tested; **no live transaction yet** |
| Verified player resource trade from the current build | **not done**; needs a real player action after the Railway release is tied to the commit |
| Frontend integrated with live API | done; 14 Playwright tests (see TEST_REPORT.md) |
| Continuous world + saves + offline pause | done, tested |
| Public deployment | live on Railway (health 200); release-to-commit link unconfirmed |

## Kill-switch check
First 30 s playable on the server: yes. Market has non-scripted responses: yes. Testnet transfer: present for the standalone demo (see TESTNET_DEMO.md); player-resource flow unverified.

## Still to do before 2026-11-14 23:59 UTC
- [ ] Commit and push the story, README and doc updates; redeploy Railway and smoke-test as a guest
- [ ] One real player resource purchase on the deployed build, with the transaction recorded (owner action)
- [ ] Check Google sign-in end to end in a browser (owner action)
- [ ] Record the 3-minute demo (script in README) and post on X with `#NEARHackathon` and @NEARProtocol (owner action)
- [ ] Submission form: description, team size, NEAR wallet for prizes (owner action)
