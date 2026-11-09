# Wallets and the treasury

## The treasury

`init_economy` (contract, `economy.rs`) runs once. It mints the entire supply of `credit:vesper` to the treasury
account and records named buckets whose caps add up to exactly that supply. Before it runs the credit supply must be
zero; after it runs `mt_mint` refuses credits for good.

| Bucket | Cap | Per grant | Once per account | For |
|---|---:|---:|:---:|---|
| `city` | ₡1.2 billion | ₡50 million | | grid clearing float: pays players for the electricity their regions buy |
| `world` | ₡300 million | ₡20 million | | the outside world's float: importers and outside customers |
| `npc` | ₡6 million | ₡600,000 | ✓ | each merchant's and company's starting capital |
| `players` | ₡150 million | ₡300,000 | ✓ | each new company's starting capital (500 companies) |
| `reserve` | ₡344 million | — | | nothing, until governance moves it |

Total: **₡2,000,000,000** (200,000,000,000 cc). Lifetime issuance cap: ₡500 million. Source of these numbers:
`apps/api/src/economy/treasury.ts`, which asserts the caps add up.

**Issuance rules.** `treasury_grant` (operator or owner) pays from a bucket: a single-use grant id, within the
bucket's cap and per-grant limit, and once per account for `npc` and `players`. A grant from an exhausted bucket
**fails**; nothing is minted to cover it. `issue` is owner-only, names a bucket and a reason, and is capped for the
life of the contract. Every grant and issue emits an event and is readable (`grant`, `granted`, `economy_info`).

**Growth.** Player capital covers 500 companies; past that, the owner can `issue` into `players` within the lifetime
cap (a deliberate, logged decision). The grid and world floats are released in tranches when they fall under 30% of a
tranche (`EconomyService.topUpFloats`); if a bucket runs dry, settlement of player earnings waits and the Money tab
says so, rather than credits appearing from nowhere.

## Player wallets

When a **signed-in** player opens the game (`GET /api/economy` → `EconomyService.ensureWallet`):

1. If they have a wallet, it is returned: refreshes, retries and second tabs never create another.
2. Otherwise the server generates an ed25519 key, derives the account id `p<sha256(player id)[0..20]>.vesper-players…`
   (the same player always maps to the same account), stores the key **encrypted** (AES-256-GCM, `WALLET_KEY_SECRET`)
   and queues `account:<player>`: the player-parent account creates the account with that key and 0.02 NEAR.
3. Once the account exists, both ledgers close an epoch at that instant and the wallet opens:
   `treasury_grant(start:<player>, players, ₡300,000)` (refused on chain if this account was ever granted), then, if
   the company already earned or spent something (for example as a guest), one `settle_batch` moving the difference
   against the grid clearing account. The wallet then holds exactly what the company holds.
4. From then on, everything the company earns or spends settles to that wallet.

**Abuse limits.** Only signed-in players get wallets (Google or a verified email); at most `NEAR_WALLETS_PER_HOUR`
(default 60) wallets are created per hour across the server; the starting grant is once per account on chain and
once per player in the database (`account:<player>` and `grant:start:<player>` are unique op ids).

**Custody, authorization, recovery.** The wallet is custodial: the server holds its key, encrypted, and uses it only
for that player's own actions. The contract also lets the operator settle for player wallets while they are in game
custody, the same way a bank settles card payments; it cannot touch accounts outside that custody. Self-custody:
`release_to_owner` (contract, callable by the wallet itself, relayable gas-free through `POST /api/relay`) removes
the operator's power over that account forever. A key-export screen for that is not built yet.

## NPC wallets

Every merchant and power company has its own NEAR account (`vesper-<id>.<parent>`), created by the bootstrap and
registered with the contract (its consent to game settlement). Funding happens once, when the server first connects:
`grant:npc:<id>` from the `npc` bucket (once per account on chain), then one `open:town` batch that lines each NPC's
on-chain balance and stock up with the market as it is. A restart never funds anyone again: the grant ids are taken.

The three power companies sign their own escrow (`power_order_place`) with a **function-call key** limited to that one
method. Their spending is bounded by the contract (`set_npc_limits`): ₡30,000 per payment, ₡400,000 per UTC day.

**Kill switches.** Per NPC: `set_npc_paused` (owner or operator). All NPCs: `set_npc_spending_paused`. The server's
`POST /api/economy/admin/npc-spending` (needs `ECONOMY_ADMIN_TOKEN`) pulls both the contract switch and the server's
own (`NPC_SPENDING_ENABLED`), so NPCs stop placing orders at once.
