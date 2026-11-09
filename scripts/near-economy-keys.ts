/**
 * Rotates the server's function-call keys (the operator and each power company) to keys with no gas allowance cap.
 *
 *   pnpm chain:keys            (reads .env.economy and the full-access keys in .near-credentials/economy/)
 *
 * A function-call key's allowance is charged for the gas each transaction reserves and never credited back, so a
 * capped key eventually stops working even though its account still has NEAR. The new keys keep exactly the same
 * limits that matter (only this contract, only the named methods); they can only spend their own account's NEAR.
 * Adds the new key, rewrites its line in .env.economy, then deletes the old one. Restart the API afterwards.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Account, JsonRpcProvider, KeyPair, KeyPairEd25519, type KeyPairString } from "near-api-js";

const envPath = ".env.economy";
if (!existsSync(envPath)) {
  console.error("No .env.economy: run pnpm chain:economy first.");
  process.exit(1);
}
const lines = readFileSync(envPath, "utf8").split("\n");
const env = Object.fromEntries(lines.filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL ?? "https://near-testnet.drpc.org" });
const contractId = env.NEAR_ECONOMY_CONTRACT_ID;

const KEYS: { accountVar: string; keyVar: string; methods: string[] }[] = [
  { accountVar: "NEAR_OPERATOR_ACCOUNT_ID", keyVar: "NEAR_OPERATOR_PRIVATE_KEY", methods: ["treasury_grant", "settle_batch", "settle_epoch", "settle_items", "power_order_confirm", "power_order_expire", "prune_closed_orders", "set_npc_paused", "set_npc_spending_paused", "plant_mint", "plant_transfer_for", "plant_buy_for", "plant_list", "plant_cancel_listing"] },
  ...Object.keys(env)
    .filter((k) => /^NEAR_NPC_[A-Z]+_PRIVATE_KEY$/.test(k))
    .map((k) => ({ accountVar: k.replace("_PRIVATE_KEY", "_ACCOUNT_ID"), keyVar: k, methods: ["power_order_place"] })),
];

for (const k of KEYS) {
  const accountId = env[k.accountVar];
  const cred = `.near-credentials/economy/${accountId}.json`;
  if (!accountId || !existsSync(cred)) {
    console.log(`skip ${k.accountVar}: no full-access key on this machine`);
    continue;
  }
  const full = new Account(accountId, provider, JSON.parse(readFileSync(cred, "utf8")).private_key as KeyPairString);
  const fresh = KeyPairEd25519.fromRandom();
  await full.addFunctionCallAccessKey({ publicKey: fresh.getPublicKey(), contractId, methodNames: k.methods });
  const old = env[k.keyVar];
  const i = lines.findIndex((l) => l.startsWith(`${k.keyVar}=`));
  lines[i] = `${k.keyVar}=${fresh.toString()}`;
  writeFileSync(envPath, lines.join("\n"), { mode: 0o600 });
  if (old) {
    try {
      await full.deleteKey(KeyPair.fromString(old as KeyPairString).getPublicKey());
    } catch (e) {
      console.log(`  (old key on ${accountId} not removed: ${(e as Error).message.slice(0, 80)})`);
    }
  }
  console.log(`rotated ${accountId}: ${k.methods.length} methods, no allowance cap`);
}
console.log("Done. Restart the API so it uses the new keys.");
