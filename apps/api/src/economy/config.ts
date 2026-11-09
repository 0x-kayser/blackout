/**
 * The on-chain economy's configuration. It is ON only when every required value is present (written by
 * `pnpm chain:economy`); otherwise the game runs exactly as before and says, everywhere, that nothing is on NEAR.
 * Nothing here invents an account id or a key.
 */
import { NPC_IDENTITIES } from "./treasury.ts";

export interface EconomyConfig {
  enabled: boolean;
  network: "testnet";
  rpcUrl: string;
  /** Endpoints tried in order when one rate-limits or times out (the first is rpcUrl). */
  rpcUrls: string[];
  explorerTxBase: string;
  explorerAccountBase: string;
  contractId: string | null;
  /** Signs settlement, grants and delivery confirmations (function-call key limited to those methods). */
  operator: { accountId: string; privateKey: string } | null;
  /** Creates players' wallets as its sub-accounts (full-access key; holds only the NEAR to fund new wallets). */
  playerParent: { accountId: string; privateKey: string } | null;
  treasuryId: string | null;
  gridId: string | null;
  worldId: string | null;
  /** NPC accounts; companies also have a function-call key for `power_order_place`. */
  npcs: Record<string, { accountId: string; privateKey: string | null }>;
  /** 32-byte key that encrypts players' wallet keys at rest. */
  walletSecret: Buffer | null;
  /** NEAR each new player wallet is funded with (storage plus the 1 yoctoNEAR deposits its own calls need). */
  walletNear: string;
  /** Kill switch on the server side: NPCs place no orders while false (the contract has its own). */
  npcSpending: boolean;
  /** Most wallets created per hour, across the whole server (faucet-abuse limit). */
  walletsPerHour: number;
  adminToken: string | null;
  missing: string[];
}

export function loadEconomyConfig(env: NodeJS.ProcessEnv = process.env): EconomyConfig {
  const missing: string[] = [];
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) missing.push(k);
    return v || null;
  };
  const flag = (env.NEAR_ECONOMY_ENABLED ?? "false").toLowerCase() === "true";
  if (!flag) missing.unshift("NEAR_ECONOMY_ENABLED=true");
  const contractId = need("NEAR_ECONOMY_CONTRACT_ID");
  const opId = need("NEAR_OPERATOR_ACCOUNT_ID");
  const opKey = need("NEAR_OPERATOR_PRIVATE_KEY");
  const ppId = need("NEAR_PLAYER_PARENT_ACCOUNT_ID");
  const ppKey = need("NEAR_PLAYER_PARENT_PRIVATE_KEY");
  const treasuryId = need("NEAR_TREASURY_ACCOUNT_ID");
  const gridId = need("NEAR_GRID_ACCOUNT_ID");
  const worldId = need("NEAR_WORLD_ACCOUNT_ID");
  const secretHex = need("WALLET_KEY_SECRET");
  let walletSecret: Buffer | null = null;
  if (secretHex) {
    walletSecret = Buffer.from(secretHex, /^[0-9a-f]{64}$/i.test(secretHex) ? "hex" : "base64");
    if (walletSecret.length !== 32) {
      missing.push("WALLET_KEY_SECRET (must be 32 bytes, hex or base64)");
      walletSecret = null;
    }
  }
  const npcs: EconomyConfig["npcs"] = {};
  for (const n of NPC_IDENTITIES) {
    const up = n.id.toUpperCase();
    const accountId = need(`NEAR_NPC_${up}_ACCOUNT_ID`);
    const privateKey = n.signs ? need(`NEAR_NPC_${up}_PRIVATE_KEY`) : null;
    if (accountId) npcs[n.id] = { accountId, privateKey };
  }
  const enabled = flag && missing.length === 0;
  return {
    enabled,
    network: "testnet",
    rpcUrl: env.NEAR_RPC_URL?.trim() || "https://test.rpc.fastnear.com",
    rpcUrls: [...new Set([env.NEAR_RPC_URL?.trim() || "https://test.rpc.fastnear.com", ...(env.NEAR_RPC_FALLBACK_URLS ?? "https://near-testnet.drpc.org,https://rpc.testnet.fastnear.com").split(",").map((u) => u.trim()).filter(Boolean)])],
    explorerTxBase: env.NEAR_EXPLORER_TX_BASE?.trim() || "https://testnet.nearblocks.io/txns/",
    explorerAccountBase: env.NEAR_EXPLORER_ACCOUNT_BASE?.trim() || "https://testnet.nearblocks.io/address/",
    contractId,
    operator: opId && opKey ? { accountId: opId, privateKey: opKey } : null,
    playerParent: ppId && ppKey ? { accountId: ppId, privateKey: ppKey } : null,
    treasuryId,
    gridId,
    worldId,
    npcs,
    walletSecret,
    walletNear: env.NEAR_WALLET_FUNDING_NEAR?.trim() || "0.02",
    npcSpending: (env.NPC_SPENDING_ENABLED ?? "true").toLowerCase() !== "false",
    walletsPerHour: Number(env.NEAR_WALLETS_PER_HOUR ?? 60),
    adminToken: env.ECONOMY_ADMIN_TOKEN?.trim() || null,
    missing: enabled ? [] : missing,
  };
}
