/**
 * One-time NEAR testnet bootstrap, run by the DEVELOPER with their own funded testnet account.
 * Nothing here runs automatically and no account ids are hard-coded.
 *
 *   NEAR_PARENT_ACCOUNT_ID=you.testnet NEAR_PARENT_PRIVATE_KEY=ed25519:... \
 *   pnpm chain:bootstrap
 *
 * Creates sub-accounts of the parent:
 *   bo-resources.<parent>  NEP-245 contract (owner)        bo-vault.<parent>  game vault / operator of player ids
 *   bo-harbor-terminal / bo-northline / bo-kettle.<parent>  shared-exchange traders (NPCs with their own keys)
 *   bo-ember / bo-lantern / bo-harbor.<parent>            legacy city merchants (only used with NEAR_CITY_PURCHASES_ON_CHAIN=true)
 * Deploys contracts/near/res/blackout_resources.wasm, registers tokens and storage, mints each trader exactly the
 * starting stock the exchange engine expects, registers traders with a daily import cap, and adds FUNCTION-CALL
 * keys scoped to the exact methods each actor may call:
 *   vault operator: exchange_deposit / exchange_redeem / exchange_ask / exchange_cancel / exchange_fill (+ legacy custodial_*)
 *   each trader:    npc_import / exchange_ask / exchange_cancel / exchange_fill (the contract only lets it act for itself)
 *   each merchant:  npc_transfer (legacy)
 * Writes server env lines to .env.chain (git-ignored).
 * Full-access keys are written to .near-credentials/blackout/ (git-ignored) and never to the server env.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Account, JsonRpcProvider, KeyPairEd25519, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import { EXCHANGE_TRADERS } from "../packages/sim/src/policies/exchangeTraders.ts";
import { DEFAULT_EXCHANGE_CONFIG } from "../packages/sim/src/exchange/engine.ts";

const parentId = process.env.NEAR_PARENT_ACCOUNT_ID;
const parentKey = process.env.NEAR_PARENT_PRIVATE_KEY as KeyPairString | undefined;
const rpcUrl = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
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

// the contract pays storage for player ids, offers and receipts it creates, so it gets the larger balance
const resources = await sub("bo-resources", "10");
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
// regional power game tokens (§16): fuel, permits, certificates and the non-speculative settlement unit
for (const [t, d, u] of [
  ["fuel:diesel", "Diesel, 1 litre per unit", "L"],
  ["fuel:natural-gas", "Natural gas, 1 MMBtu per unit", "MMBtu"],
  ["permit:carbon", "Carbon permit, 1 tonne CO2 per unit", "t"],
  ["certificate:renewable", "Renewable energy certificate, 1 MWh per unit", "MWh"],
  ["credit:vesper", "Vesper Credit: in-game settlement unit, 0.01 credit per unit, not redeemable", "cc"],
  ["material:steel", "Steel, 1 tonne per unit", "t"],
  ["part:turbine", "Turbine repair kit", "kit"],
]) await call(contract, resources.id, "register_token", { token_id: t, description: d, unit: u });
// Vesper Market's clearing stock: every market epoch moves items between the merchants and this custody account
await call(contract, resources.id, "mt_mint", { owner_id: vault.id, token_ids: ["fuel:natural-gas", "fuel:diesel", "permit:carbon", "certificate:renewable", "material:steel", "part:turbine"], amounts: ["1000000000000", "1000000000000", "1000000000", "1000000000", "100000000", "1000000"], memo: "market clearing stock" });
// the genesis treasury: every region's first settlement epoch distributes from here (§13)
await call(contract, resources.id, "mt_mint", { owner_id: vault.id, token_ids: ["credit:vesper"], amounts: ["1000000000000000"], memo: "genesis treasury" });

const storage = nearToYocto("0.01");
for (const m of Object.values(merchants)) await call(new Account(m.id, provider, m.key), resources.id, "storage_deposit", {}, storage);
// on-chain diesel warehouse shared by all runs (per-run market stock is simulated)
for (const m of Object.values(merchants)) {
  await call(contract, resources.id, "mt_mint", { owner_id: m.id, token_ids: ["DIESEL_100ML"], amounts: ["50000"], memo: "bootstrap warehouse: 5,000 L" });
  await call(contract, resources.id, "register_npc", { account_id: m.id, max_per_call: "600" }); // <= 60 L per trade
}

// shared-exchange traders: same ids, names and starting stock as packages/sim/src/policies/exchangeTraders.ts
const traders: Record<string, { id: string; key: KeyPairString }> = {};
for (const t of EXCHANGE_TRADERS) traders[t.traderId] = await sub(`bo-${t.traderId.replace(/_/g, "-")}`, "3");
for (const t of Object.values(traders)) await call(new Account(t.id, provider, t.key), resources.id, "storage_deposit", {}, storage);
// The engine caps imports per 4-minute exchange day; the contract counts per UTC day (360 exchange days).
const exchangeDaysPerUtcDay = Math.floor((24 * 3600) / ((DEFAULT_EXCHANGE_CONFIG.ticksPerDay * 5_000) / 1000));
for (const t of EXCHANGE_TRADERS) {
  const acct = traders[t.traderId];
  await call(contract, resources.id, "mt_mint", { owner_id: acct.id, token_ids: ["DIESEL_100ML"], amounts: [String(t.startStockMl / 100)], memo: `starting stock: ${t.name}` });
  await call(contract, resources.id, "register_trader", { account_id: acct.id, max_import_per_day: String((t.maxImportPerDayMl / 100) * exchangeDaysPerUtcDay) });
}

// regional NPCs with their own accounts (§22): VoltLine, the regulator and the banks. Suppliers reuse the trader accounts.
const regionNpcs: Record<string, { id: string; key: KeyPairString }> = {};
for (const n of ["voltline", "regulator", "vesper-bank", "meridian", "ruth", "pavel", "nkechi"]) {
  regionNpcs[n] = await sub(`bo-${n}`, "1");
  await call(new Account(regionNpcs[n].id, provider, regionNpcs[n].key), resources.id, "storage_deposit", {}, storage);
  await call(contract, resources.id, "register_npc", { account_id: regionNpcs[n].id, max_per_call: "0" }); // consents to game settlement; can't npc_transfer
}
// the gas-paying relayer for NEP-366 meta-transactions needs a full-access key on its own, separately funded account
const relayer = await sub("bo-relayer", "3");

const env: string[] = [
  "NEAR_CHAIN_ENABLED=true",
  "NEAR_CITY_PURCHASES_ON_CHAIN=false",
  `NEAR_RPC_URL=${rpcUrl}`,
  `NEAR_RESOURCE_CONTRACT_ID=${resources.id}`,
  `NEAR_VAULT_ACCOUNT_ID=${vault.id}`,
];
const operatorFc = KeyPairEd25519.fromRandom();
await new Account(vault.id, provider, vault.key).addFunctionCallAccessKey({
  publicKey: operatorFc.getPublicKey(),
  contractId: resources.id,
  methodNames: ["exchange_deposit", "exchange_redeem", "exchange_ask", "exchange_cancel", "exchange_fill", "custodial_list", "custodial_cancel_listing", "custodial_fill_listing", "settle_epoch", "settle_items", "plant_transfer_for", "plant_buy_for", "plant_withdraw", "plant_list", "plant_cancel_listing"],
  allowance: nearToYocto("2"),
});
env.push(`NEAR_VAULT_OPERATOR_PRIVATE_KEY=${operatorFc.toString()}`);
for (const [name, m] of Object.entries(merchants)) {
  const fc = KeyPairEd25519.fromRandom();
  await new Account(m.id, provider, m.key).addFunctionCallAccessKey({ publicKey: fc.getPublicKey(), contractId: resources.id, methodNames: ["npc_transfer"], allowance: nearToYocto("0.25") });
  env.push(`NEAR_MERCHANT_${name.toUpperCase()}_ACCOUNT_ID=${m.id}`, `NEAR_MERCHANT_${name.toUpperCase()}_PRIVATE_KEY=${fc.toString()}`);
}
for (const t of EXCHANGE_TRADERS) {
  const acct = traders[t.traderId];
  const fc = KeyPairEd25519.fromRandom();
  await new Account(acct.id, provider, acct.key).addFunctionCallAccessKey({ publicKey: fc.getPublicKey(), contractId: resources.id, methodNames: ["npc_import", "npc_supply_city", "exchange_ask", "exchange_cancel", "exchange_fill"], allowance: nearToYocto("2.5") });
  const pre = `NEAR_TRADER_${t.traderId.toUpperCase()}`;
  env.push(`${pre}_ACCOUNT_ID=${acct.id}`, `${pre}_PRIVATE_KEY=${fc.toString()}`);
}
const SUPPLIER_TRADER: Record<string, string> = { ingrid: "harbor_terminal", bayo: "northline", kettle: "kettle", dayo: "swift_tankers", chioma: "okafor_daughters", lena: "greenline_fund" };
for (const [npc, traderId] of Object.entries(SUPPLIER_TRADER)) if (traders[traderId]) env.push(`NEAR_NPC_${npc.toUpperCase()}_ACCOUNT_ID=${traders[traderId].id}`);
for (const [n, a] of Object.entries(regionNpcs)) env.push(`NEAR_NPC_${n.replace("-", "_").toUpperCase()}_ACCOUNT_ID=${a.id}`);
env.push("NEAR_SETTLEMENT_ENABLED=true", `NEAR_RELAYER_ACCOUNT_ID=${relayer.id}`, `NEAR_RELAYER_PRIVATE_KEY=${relayer.key}`);
writeFileSync(".env.chain", env.join("\n") + "\n", { mode: 0o600 });
console.log("\nDone. Server env written to .env.chain (git-ignored). Copy its lines into .env, restart the API, then GET /api/chain/status.");
console.log(`Contract: ${resources.id}\nVault: ${vault.id}\nTraders: ${Object.values(traders).map((t) => t.id).join(", ")}\nMerchants (legacy): ${Object.values(merchants).map((m) => m.id).join(", ")}`);
console.log("Start the API with an EMPTY database (or delete the exchange_state row) so the exchange begins in testnet mode with these traders' stock.");
