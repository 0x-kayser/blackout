/**
 * Optional self-custody (phase 6), run by the OPERATOR on request, never by the game server.
 *
 *   NEAR_VAULT_ACCOUNT_ID=bo-vault.you.testnet DATABASE_PATH=data/blackout.sqlite \
 *   pnpm tsx scripts/claim-warehouse.ts <playerId> <playerPublicKey ed25519:...>
 *
 * 1. Refuses if the player still has open offers or settling exchange operations.
 * 2. Creates the player's namespaced account p<hash>.<vault> with the PLAYER'S public key (full access),
 *    signed by the vault's full-access key from .near-credentials/blackout/<vault>.json (not the server env).
 * 3. Marks the player self-custodied so the server stops acting for them.
 * The player then calls `release_to_owner` on the resource contract from their own wallet; from that moment the
 * operator can never move their tokens again, and they hold them like any NEP-245 balance.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Account, JsonRpcProvider, nearToYocto, type KeyPairString } from "near-api-js";

const [playerId, publicKey] = process.argv.slice(2);
const vaultId = process.env.NEAR_VAULT_ACCOUNT_ID;
const dbPath = process.env.DATABASE_PATH ?? "data/blackout.sqlite";
if (!playerId || !publicKey?.startsWith("ed25519:") || !vaultId) {
  console.error("usage: NEAR_VAULT_ACCOUNT_ID=... pnpm tsx scripts/claim-warehouse.ts <playerId> <ed25519:publicKey>");
  process.exit(1);
}
const prefix = `p${createHash("sha256").update(playerId).digest("hex").slice(0, 24)}`;
const chainId = `${prefix}.${vaultId}`;

const db = new DatabaseSync(dbPath);
const row = db.prepare("SELECT state_json, mode FROM exchange_state WHERE id = 1").get() as { state_json: string; mode: string } | undefined;
if (!row || row.mode !== "testnet") {
  console.error("This server's exchange is not on Testnet; there is nothing on-chain to claim.");
  process.exit(1);
}
const state = JSON.parse(row.state_json) as { orders: Record<string, { owner: { kind: string; id: string }; status: string }>; ops: Record<string, { owner: { id: string }; status: string }> };
const open = Object.values(state.orders).filter((o) => o.owner.kind === "player" && o.owner.id === playerId && ["placing", "open", "cancelling"].includes(o.status));
const settling = Object.values(state.ops).filter((o) => o.owner.id === playerId && o.status === "pending");
if (open.length || settling.length) {
  console.error(`Player has ${open.length} open offer(s) and ${settling.length} settling operation(s). Ask them to cancel and wait, then retry.`);
  process.exit(1);
}

const creds = JSON.parse(readFileSync(`.near-credentials/blackout/${vaultId}.json`, "utf8")) as { private_key: KeyPairString };
const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org" });
const vault = new Account(vaultId, provider, creds.private_key);
await vault.createSubAccount({ accountOrPrefix: prefix, publicKey, nearToTransfer: nearToYocto("0.05") });
db.prepare("INSERT INTO player_chain_ids (player_id, chain_id, created_at, self_custody) VALUES (?, ?, ?, 1) ON CONFLICT(player_id) DO UPDATE SET self_custody = 1").run(playerId, chainId, new Date().toISOString());
console.log(`Created ${chainId} with the player's key and marked the player self-custodied.`);
console.log(`Next, the player signs: near call <resource contract> release_to_owner '{}' --accountId ${chainId}`);
