/** What the game shows about money on NEAR: your wallet, the treasury, the NPC wallets and every transaction. */

export interface ChainOpView {
  opId: string;
  kind: "account" | "grant" | "order" | "confirm" | "batch" | "plant" | "market" | "expire" | "fund" | "release" | "admin";
  /** Plain words: "Starting capital: ₡300,000 from the treasury". */
  label: string;
  status: "created" | "submitted" | "settled" | "failed" | "local";
  signer: string;
  txHash: string | null;
  txUrl: string | null;
  detail: string | null;
  at: string;
}

export interface WalletView {
  accountId: string;
  explorerUrl: string | null;
  status: "creating" | "opening" | "active" | "leaving" | "released" | "failed";
  /** Credits the contract says this account holds (null until read). */
  onChainCc: number | null;
  /** Credits your company holds in the game right now. */
  gameCashCc: number;
  /** Earned or spent in the game but not yet settled on NEAR (game − chain, while the wallet is active). */
  unsettledCc: number | null;
  startingGrantCc: number;
  detail: string | null;
}

export interface NpcWalletView {
  id: string;
  name: string;
  kind: "merchant" | "company";
  accountId: string;
  explorerUrl: string;
  onChainCc: number | null;
  gameCashCc: number;
}

export interface TreasuryView {
  treasuryId: string;
  initialSupplyCc: number;
  totalSupplyCc: number;
  treasuryBalanceCc: number;
  issuedCc: number;
  issueCapCc: number;
  buckets: { name: string; capCc: number; grantedCc: number }[];
  npcSpendingPaused: boolean;
}

export interface EconomyView {
  /** "near": connected to NEAR testnet; "local": nothing is on chain, and the game says so. */
  mode: "near" | "local";
  network: "testnet";
  contractId: string | null;
  contractUrl: string | null;
  treasury: TreasuryView | null;
  grid: { accountId: string; explorerUrl: string; onChainCc: number | null } | null;
  world: { accountId: string; explorerUrl: string; onChainCc: number | null } | null;
  wallet: WalletView | null;
  /** Why you have no wallet (guest, not configured, rate limit). */
  walletNote: string | null;
  npcs: NpcWalletView[];
  ops: ChainOpView[];
  desk: { sell: boolean; markupBps: number };
  /** Your plants as NEP-171 Plant Assets: minted to your wallet, moved out when you sell them. */
  plants: { name: string; tokenId: string; status: "minting" | "yours" | "sold" | "failed"; url: string | null; txUrl: string | null }[];
  missing: string[];
}
