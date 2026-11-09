/**
 * One-time NEAR testnet setup for the economy, run by the DEVELOPER with their own funded testnet account
 * (about 9 testnet NEAR, so one faucet-funded account is enough; the contract's storage is most of it). Nothing here runs automatically and no account ids are
 * hard-coded.
 *
 *   NEAR_PARENT_ACCOUNT_ID=you.testnet NEAR_PARENT_PRIVATE_KEY=ed25519:... pnpm chain:economy
 *
 * Creates, under the parent (prefix NEAR_PREFIX, default "vesper"):
 *   vesper-econ       the contract: NEP-245 credits and items, Plant Assets, treasury, escrow (owner = the parent)
 *   vesper-op         the game operator: settles, pays grants, confirms deliveries (server gets a FUNCTION-CALL key)
 *   vesper-treasury   holds the supply; never signs anything (grants move its balance inside the contract)
 *   vesper-grid       clearing account for what happens inside players' regions
 *   vesper-world      the outside world: importers and outside customers (also holds the market's item stock)
 *   vesper-players    parent of every player wallet (server gets its key; it only holds NEAR to fund new wallets)
 *   vesper-<npc>      each merchant and power company; the companies get a FUNCTION-CALL key for power_order_place
 * Then: deploys and initialises the contract, registers tokens, mints the market's item stock, calls init_economy
 * with the treasury plan (apps/api/src/economy/treasury.ts), registers every NPC (consent to settlement) and sets the
 * companies' spending limits. Writes the server's env to .env.economy (git-ignored, mode 600) and every full-access key
 * to .near-credentials/economy/ (git-ignored). The owner key (the parent's) never goes to the server.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Account, JsonRpcProvider, KeyPairEd25519, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import { NPC_IDENTITIES, NPC_LIMITS, TREASURY_PLAN } from "../apps/api/src/economy/treasury.ts";

const parentId = process.env.NEAR_PARENT_ACCOUNT_ID;
const parentKey = process.env.NEAR_PARENT_PRIVATE_KEY as KeyPairString | undefined;
// rpc.testnet.near.org is deprecated and rate-limited; NEAR's docs point to providers like FastNear
const rpcUrl = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
const wasmPath = process.env.WASM_PATH ?? "contracts/near/res/blackout_resources.wasm";
const P = process.env.NEAR_PREFIX ?? "vesper";
if (!parentId || !parentKey || !parentId.endsWith(".testnet")) {
  console.error("Set NEAR_PARENT_ACCOUNT_ID (a funded *.testnet account you own) and NEAR_PARENT_PRIVATE_KEY.");
  process.exit(1);
}
if (!existsSync(wasmPath)) {
  console.error(`Build the contract first: pnpm build:contract (expected ${wasmPath})`);
  process.exit(1);
}

const provider = new JsonRpcProvider({ url: rpcUrl });
const parent = new Account(parentId, provider, parentKey);
mkdirSync(".near-credentials/economy", { recursive: true });
const GAS = teraToGas(100);
const log = (s: string) => console.log(s);

async function sub(name: string, near: `${number}`): Promise<{ id: string; key: KeyPairString }> {
  const id = `${P}-${name}.${parentId}`;
  const file = `.near-credentials/economy/${id}.json`;
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { private_key: KeyPairString };
    log(`exists  ${id}`);
    return { id, key: saved.private_key };
  }
  const kp = KeyPairEd25519.fromRandom();
  await parent.createSubAccount({ accountOrPrefix: `${P}-${name}`, publicKey: kp.getPublicKey(), nearToTransfer: nearToYocto(near) });
  writeFileSync(file, JSON.stringify({ account_id: id, private_key: kp.toString() }, null, 2), { mode: 0o600 });
  log(`created ${id} (${near} NEAR)`);
  return { id, key: kp.toString() };
}
const as = (a: { id: string; key: KeyPairString }) => new Account(a.id, provider, a.key);
const call = (acct: Account, contractId: string, methodName: string, args: Record<string, unknown>, deposit: bigint = 0n) => acct.callFunction({ contractId, methodName, args, deposit, gas: GAS });

const contract = await sub("econ", (process.env.NEAR_CONTRACT_NEAR as `${number}`) ?? "6.6");
const operator = await sub("op", "0.3");
const treasury = await sub("treasury", "0.05");
const grid = await sub("grid", "0.05");
const world = await sub("world", "0.05");
const players = await sub("players", (process.env.NEAR_PLAYERS_NEAR as `${number}`) ?? "0.6");
const npcs: Record<string, { id: string; key: KeyPairString }> = {};
for (const n of NPC_IDENTITIES) npcs[n.id] = await sub(n.id, n.signs ? "0.25" : "0.02");

// every step checks the chain first, so a re-run (after a timeout, say) never repeats one that already happened
async function view<T>(method: string, args: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: contract.id, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }) });
    const j = (await res.json()) as { result?: { result: number[] } };
    return j.result ? (JSON.parse(Buffer.from(j.result.result).toString("utf8")) as T) : null;
  } catch {
    return null;
  }
}
const info = await view<{ owner_id: string }>("contract_info", {});
if (!info) {
  log("deploying the contract…");
  await as(contract).deployContract(new Uint8Array(readFileSync(wasmPath)));
  // the parent (the developer) owns the contract; the operator runs the game
  await call(as(contract), contract.id, "new", { owner_id: parentId, operator_id: operator.id });
} else log(`contract already deployed and initialised (owner ${info.owner_id})`);
const registered = new Set(((await view<{ token_id: string }[]>("mt_tokens_info", {})) ?? []).map((t) => t.token_id));
for (const [t, d, u] of [
  ["credit:vesper", "Vesper credit: the game's money. 1 unit = ₡0.01. Fixed supply, testnet only, no real value.", "cc"],
  ["fuel:natural-gas", "Natural gas, 1 MMBtu per unit", "MMBtu"],
  ["fuel:diesel", "Diesel, 1 litre per unit", "L"],
  ["permit:carbon", "Carbon permit, 1 tonne CO2 per unit", "t"],
  ["certificate:renewable", "Renewable energy certificate, 1 MWh per unit", "MWh"],
  ["material:steel", "Steel, 1 tonne per unit", "t"],
  ["part:turbine", "Turbine repair kit", "kit"],
]) if (!registered.has(t)) await call(parent, contract.id, "register_token", { token_id: t, description: d, unit: u });

// every account that will hold balances pays its own storage registration (0.01 NEAR each, from the parent)
const storage = nearToYocto("0.01");
for (const a of [treasury, grid, world, ...Object.values(npcs)]) await call(parent, contract.id, "storage_deposit", { account_id: a.id }, storage);

// Vesper Market's items live in the outside world's custody until merchants hold them (minted once)
const stock = await view<string>("mt_balance_of", { account_id: world.id, token_id: "fuel:natural-gas" });
if (!stock || stock === "0") await call(parent, contract.id, "mt_mint", { owner_id: world.id, token_ids: ["fuel:natural-gas", "fuel:diesel", "permit:carbon", "certificate:renewable", "material:steel", "part:turbine"], amounts: ["1000000000000", "1000000000000", "1000000000", "1000000000", "100000000", "1000000"], memo: "market item custody" });

// the money: minted once, split into capped buckets
const eco = await view<{ initialized: boolean }>("economy_info", {});
if (!eco?.initialized) await call(parent, contract.id, "init_economy", {
  treasury_id: treasury.id,
  player_parent_id: players.id,
  total_supply: String(TREASURY_PLAN.totalSupply),
  buckets: TREASURY_PLAN.buckets.map((b) => ({ name: b.name, cap: String(b.cap), max_per_grant: String(b.maxPerGrant), once_per_account: b.oncePerAccount })),
  issue_cap: String(TREASURY_PLAN.issueCap),
});
log(`economy initialised: ${TREASURY_PLAN.totalSupply} cc in the treasury`);

// consent to settlement (register_npc) for every NPC and the grid/world accounts; spending limits for the companies
for (const a of [grid, world, ...Object.values(npcs)]) await call(parent, contract.id, "register_npc", { account_id: a.id, max_per_call: "0" });
for (const n of NPC_IDENTITIES.filter((x) => x.signs)) await call(parent, contract.id, "set_npc_limits", { account_id: npcs[n.id].id, max_per_payment: String(NPC_LIMITS.maxPerPaymentCc), max_per_day: String(NPC_LIMITS.maxPerDayCc) });

// keys the server gets: function-call keys only, except the player parent (it must create accounts)
const env: string[] = ["NEAR_ECONOMY_ENABLED=true", `NEAR_RPC_URL=${rpcUrl}`, `NEAR_ECONOMY_CONTRACT_ID=${contract.id}`];
const opFc = KeyPairEd25519.fromRandom();
await as(operator).addFunctionCallAccessKey({ publicKey: opFc.getPublicKey(), contractId: contract.id, methodNames: ["treasury_grant", "settle_batch", "settle_epoch", "settle_items", "power_order_confirm", "power_order_expire", "set_npc_paused", "set_npc_spending_paused", "plant_mint", "plant_transfer_for", "plant_buy_for"] }); // no allowance cap: reserved gas is never credited back to one
env.push(`NEAR_OPERATOR_ACCOUNT_ID=${operator.id}`, `NEAR_OPERATOR_PRIVATE_KEY=${opFc.toString()}`);
env.push(`NEAR_PLAYER_PARENT_ACCOUNT_ID=${players.id}`, `NEAR_PLAYER_PARENT_PRIVATE_KEY=${players.key}`);
env.push(`NEAR_TREASURY_ACCOUNT_ID=${treasury.id}`, `NEAR_GRID_ACCOUNT_ID=${grid.id}`, `NEAR_WORLD_ACCOUNT_ID=${world.id}`);
for (const n of NPC_IDENTITIES) {
  const up = n.id.toUpperCase();
  env.push(`NEAR_NPC_${up}_ACCOUNT_ID=${npcs[n.id].id}`);
  if (n.signs) {
    const fc = KeyPairEd25519.fromRandom();
    await as(npcs[n.id]).addFunctionCallAccessKey({ publicKey: fc.getPublicKey(), contractId: contract.id, methodNames: ["power_order_place"] });
    env.push(`NEAR_NPC_${up}_PRIVATE_KEY=${fc.toString()}`);
  }
}
env.push(`WALLET_KEY_SECRET=${randomBytes(32).toString("hex")}`, `ECONOMY_ADMIN_TOKEN=${randomBytes(18).toString("base64url")}`);
writeFileSync(".env.economy", env.join("\n") + "\n", { mode: 0o600 });
log("\nDone. Server env written to .env.economy (git-ignored). Add its lines to the API's environment and restart.");
log(`Contract:  https://testnet.nearblocks.io/address/${contract.id}`);
log(`Treasury:  ${treasury.id}   Grid: ${grid.id}   World: ${world.id}   Players under: ${players.id}`);
log(`NPCs:      ${Object.values(npcs).map((a) => a.id).join(", ")}`);
log("Next: pnpm chain:demo   (runs the real economy against testnet and prints every transaction)");
