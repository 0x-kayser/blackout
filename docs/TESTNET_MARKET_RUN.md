# Live Testnet player-market run

**Date:** 2026-11-14  
**Network:** NEAR Testnet  
**Contract:** [`vesper-econ.blackout-kay.testnet`](https://testnet.nearblocks.io/address/vesper-econ.blackout-kay.testnet)  
**Updated contract code hash:** `DFujhd1DVD1To1THS6KLyTLkxoD4aGW6s9rKphPg4YNb`

## What was demonstrated

The updated contract was deployed to the existing Testnet account without reinitializing it. The previous owner,
operator, token registry and resource balances remained intact. A new restricted operator function-call key was added
for the listing methods; its scope is limited to the economy contract and its allowlisted settlement methods.

An operator-created demo account under the custodial player parent received 1 L of `fuel:diesel`, listed it, and sold
it to the registered Halvard NPC. The resource and the NPC's 10 `credit:vesper` units moved atomically in the final
fill call.

## Finalized transactions

| Step | Transaction | Result |
|---|---|---|
| Fund existing contract's Testnet storage reserve | [6quAp4yr…](https://testnet.nearblocks.io/txns/6quAp4yrv6wrF9ysPhEWQCKPUxqviXyWrV3jHrAEZ9Zk) | 0.1 Testnet NEAR from the game operator |
| Deploy updated contract | [D7CBeNTN…](https://testnet.nearblocks.io/txns/D7CBeNTN8SAXU8vM2UGoPv5AXgBzPjCbvCvuNGYprdqW) | Final success; code hash above |
| Add restricted operator key | [GyXyrLLZ…](https://testnet.nearblocks.io/txns/GyXyrLLZrH3Lzh8bytuA6Zznw1qc5F7qEuABF4reNk1a) | Includes `resource_listing_create`, `resource_listing_cancel`, `resource_listing_fill` |
| Transfer 1 L diesel to demo player | [67Zmr7va…](https://testnet.nearblocks.io/txns/67Zmr7vaDrDw7pNqy3LpYUXqTJi9J97KzpdpUKmccXUu) | World account → demo player |
| Escrow player listing | [5Cno33Wy…](https://testnet.nearblocks.io/txns/5Cno33WyieyQTBZTnoKSkYoByd5AwBbunxmnm2jMpUoU) | 1 L `fuel:diesel`, ask 10 `credit:vesper` |
| Fill listing | [BKutAr1J…](https://testnet.nearblocks.io/txns/BKutAr1JchUCybRtcniG1LbwtJ5Mhn33sXJuAsCUD6QB) | Escrowed diesel → Halvard; 10 credits → seller |

All five feature transactions (deployment, restricted-key addition, resource transfer, listing creation and fill)
returned final success. The listing view reports `filled` with `vesper-halvard.blackout-kay.testnet` as buyer. Final
balances were independently queried from FastNear, dRPC and the NEAR Testnet RPC:

| Account | `fuel:diesel` | `credit:vesper` |
|---|---:|---:|
| `live-demo-261114-f51caf.vesper-players.blackout-kay.testnet` | 0 | 10 |
| `vesper-halvard.blackout-kay.testnet` | 1 | 5,056 |

The contract accounts for credits as fixed-supply, non-redeemable game units. They are not cash or a payout promise.

## Scope of this evidence

The demo wallet was created and registered directly for this Testnet check; it is not mapped to a signed-in game user
in the application database. The listing and fill were submitted directly using the restricted operator key. This
proves the deployed NEP-245 escrow and settlement methods, but does not prove that the in-game API, Railway release or
NPC decision policy initiated the purchase. Those require a separate end-to-end application run with the updated
service configuration.
