/**
 * One-time NEAR testnet bootstrap, run by the DEVELOPER with their own funded testnet account.
 * Nothing here runs automatically and no account ids are hard-coded.
 *
 *   NEAR_PARENT_ACCOUNT_ID=you.testnet NEAR_PARENT_PRIVATE_KEY=ed25519:... \
 *   pnpm chain:bootstrap
 *
 * Creates sub-accounts of the parent:
 *   bo-resources.<parent>  NEP-245 contract (owner)        bo-vault.<parent>  custodial game vault / operator
 *   bo-ember.<parent> / bo-lantern.<parent> / bo-harbor.<parent>  merchant NPCs
 * Deploys contracts/near/res/blackout_resources.wasm, registers tokens, registers storage, mints a shared on-chain
 * diesel warehouse to each merchant, registers merchants as NPCs with a per-call cap, adds FUNCTION-CALL keys
 * (npc_transfer only) and gives the vault a scoped listing escrow key.
 * Writes server env lines to .env.chain (git-ignored).
 * Full-access keys are written to .near-credentials/blackout/ (git-ignored) and never to the server env.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Account, JsonRpcProvider, KeyPairEd25519, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";

const parentId = process.env.NEAR_PARENT_ACCOUNT_ID;
const parentKey = process.env.NEAR_PARENT_PRIVATE_KEY as KeyPairString | undefined;
const rpcUrl = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
const wasmPath = process.env.WASM_PATH ?? "contracts/near/res/blackout_resources.wasm";
if (!parentId || !parentKey || !parentId.endsWith(".testnet")) {
  console.error("Set NEAR_PARENT_ACCOUNT_ID (a funded *.testnet account you own) and NEAR_PARENT_PRIVATE_KEY.");
  process.exit(1);
}

const provider = new JsonRpcProvider({ url: rpcUrl });
const parent = new Account(parentId, provider, parentKey);
mkdirSync(".near-credentials/blackout", { recursive: true });

async function sub(prefix: string, near: `${number}`): Promise<{ id: string; key: KeyPairString }> {
  const kp = KeyPairEd25519.fromRandom();
  const id = `${prefix}.${parentId}`;
  await parent.createSubAccount({ accountOrPrefix: prefix, publicKey: kp.getPublicKey(), nearToTransfer: nearToYocto(near) });
  writeFileSync(`.near-credentials/blackout/${id}.json`, JSON.stringify({ account_id: id, private_key: kp.toString() }, null, 2), { mode: 0o600 });
  console.log(`created ${id}`);
  return { id, key: kp.toString() };
}

const GAS = teraToGas(30);
const call = (acct: Account, contractId: string, methodName: string, args: Record<string, unknown>, deposit: bigint | string = 0n) =>
  acct.callFunction({ contractId, methodName, args, deposit, gas: GAS });

const resources = await sub("bo-resources", "6");
const vault = await sub("bo-vault", "1");
const merchants = { ember: await sub("bo-ember", "1"), lantern: await sub("bo-lantern", "1"), harbor: await sub("bo-harbor", "1") };

const contract = new Account(resources.id, provider, resources.key);
await contract.deployContract(new Uint8Array(readFileSync(wasmPath)));
await call(contract, resources.id, "new", { owner_id: resources.id, operator_id: vault.id });
for (const [t, d, u] of [
  ["DIESEL_100ML", "Diesel, 100 mL per unit", "100mL"],
  ["CARBON_PERMIT_10KG", "Carbon permit, 10 kg CO2 per unit", "permit"],
  ["REPAIR_PART", "Generator repair part", "item"],
  ["SOLAR_COMPONENT", "Solar panel component", "item"],
  ["BATTERY_COMPONENT", "Battery module", "item"],
]) await call(contract, resources.id, "register_token", { token_id: t, description: d, unit: u });

const storage = nearToYocto("0.01");
for (const m of Object.values(merchants)) await call(new Account(m.id, provider, m.key), resources.id, "storage_deposit", {}, storage);
// on-chain diesel warehouse shared by all runs (per-run market stock is simulated)
for (const m of Object.values(merchants)) {
  await call(contract, resources.id, "mt_mint", { owner_id: m.id, token_ids: ["DIESEL_100ML"], amounts: ["50000"], memo: "bootstrap warehouse: 5,000 L" });
  await call(contract, resources.id, "register_npc", { account_id: m.id, max_per_call: "600" }); // <= 60 L per trade
}

const env: string[] = [
  "NEAR_CHAIN_ENABLED=true",
  `NEAR_RPC_URL=${rpcUrl}`,
  `NEAR_RESOURCE_CONTRACT_ID=${resources.id}`,
  `NEAR_VAULT_ACCOUNT_ID=${vault.id}`,
];
const operatorFc = KeyPairEd25519.fromRandom();
await new Account(vault.id, provider, vault.key).addFunctionCallAccessKey({
  publicKey: operatorFc.getPublicKey(),
  contractId: resources.id,
  methodNames: ["custodial_list", "custodial_cancel_listing", "custodial_fill_listing"],
  allowance: nearToYocto("0.5"),
});
env.push(`NEAR_VAULT_OPERATOR_PRIVATE_KEY=${operatorFc.toString()}`);
for (const [name, m] of Object.entries(merchants)) {
  const fc = KeyPairEd25519.fromRandom();
  await new Account(m.id, provider, m.key).addFunctionCallAccessKey({ publicKey: fc.getPublicKey(), contractId: resources.id, methodNames: ["npc_transfer"], allowance: nearToYocto("0.25") });
  env.push(`NEAR_MERCHANT_${name.toUpperCase()}_ACCOUNT_ID=${m.id}`, `NEAR_MERCHANT_${name.toUpperCase()}_PRIVATE_KEY=${fc.toString()}`);
}
writeFileSync(".env.chain", env.join("\n") + "\n", { mode: 0o600 });
console.log("\nDone. Server env written to .env.chain (git-ignored). Copy its lines into .env, restart the API, then GET /api/chain/status.");
console.log(`Contract: ${resources.id}\nVault: ${vault.id}\nMerchants: ${Object.values(merchants).map((m) => m.id).join(", ")}`);
