/**
 * Upgrades the deployed economy contract in place and releases storage held by closed power orders.
 *
 *   NEAR_PARENT_ACCOUNT_ID=you.testnet NEAR_PARENT_PRIVATE_KEY=ed25519:... ECONOMY_DBS=data/a.sqlite,/tmp/b.sqlite \
 *   pnpm chain:upgrade
 *
 * 1. Deploys contracts/near/res/blackout_resources.wasm to the contract account (key from .near-credentials/economy/).
 *    The storage layout is unchanged, so every balance, grant and plant carries over.
 * 2. Reads the power-order ids from the given game databases and calls `prune_closed_orders` (as the owner) on those
 *    the contract still holds: it deletes only orders that are already closed, never an open one.
 */
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Account, JsonRpcProvider, teraToGas, type KeyPairString } from "near-api-js";

const parentId = process.env.NEAR_PARENT_ACCOUNT_ID;
const parentKey = process.env.NEAR_PARENT_PRIVATE_KEY as KeyPairString | undefined;
const P = process.env.NEAR_PREFIX ?? "vesper";
const rpcUrl = process.env.NEAR_RPC_URL ?? "https://near-testnet.drpc.org";
if (!parentId || !parentKey) {
  console.error("Set NEAR_PARENT_ACCOUNT_ID and NEAR_PARENT_PRIVATE_KEY (the contract owner).");
  process.exit(1);
}
const contractId = `${P}-econ.${parentId}`;
const credFile = `.near-credentials/economy/${contractId}.json`;
if (!existsSync(credFile)) {
  console.error(`No key for ${contractId} in ${credFile}`);
  process.exit(1);
}
const provider = new JsonRpcProvider({ url: rpcUrl });
const contract = new Account(contractId, provider, JSON.parse(readFileSync(credFile, "utf8")).private_key as KeyPairString);
const owner = new Account(parentId, provider, parentKey);

const wasm = new Uint8Array(readFileSync(process.env.WASM_PATH ?? "contracts/near/res/blackout_resources.wasm"));
await contract.deployContract(wasm);
console.log(`deployed ${wasm.length.toLocaleString("en-US")} bytes to ${contractId}`);

const ids = new Set<string>();
for (const path of (process.env.ECONOMY_DBS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
  if (!existsSync(path)) continue;
  const db = new DatabaseSync(path, { readOnly: true });
  for (const r of db.prepare("SELECT args_json FROM chain_ops WHERE kind = 'order' AND status = 'settled'").all() as { args_json: string }[]) ids.add((JSON.parse(r.args_json) as { order_id: string }).order_id);
  db.close();
}
let pruned = 0;
const all = [...ids];
for (let i = 0; i < all.length; i += 100) {
  const n = await owner.callFunction({ contractId, methodName: "prune_closed_orders", args: { order_ids: all.slice(i, i + 100) }, gas: teraToGas(300) });
  pruned += Number(n ?? 0);
}
console.log(`pruned ${pruned} closed orders (of ${all.length} known)`);
