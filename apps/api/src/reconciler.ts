/**
 * Exchange reconciler: compares what the exchange engine says every exchange account should hold on the
 * NEP-245 contract with what the contract actually reports. Read-only (view calls only). A check is skipped
 * while operations are still settling, because an in-flight transaction legitimately makes them differ.
 */
import { exchange as X } from "@blackout/sim";
import { playerChainId, viewCall, type ChainConfig } from "./chain.ts";
import type { Db } from "./db.ts";
import type { ExchangeService } from "./exchange.ts";

export interface ReconcileReport {
  checkedAt: string;
  /** true = every account matched, false = at least one mismatch, null = not checked (see note). */
  inBalance: boolean | null;
  accountsChecked: number;
  mismatches: { label: string; accountId: string; expectedMl: number; onChainMl: number }[];
  note: string;
}

export type BalanceView = (cfg: ChainConfig, accountId: string) => Promise<number>;

/** On-chain DIESEL_100ML balance in mL. */
export const contractBalanceMl: BalanceView = async (cfg, accountId) => {
  const units = await viewCall<string>(cfg, cfg.resourceContractId!, "mt_balance_of", { account_id: accountId, token_id: "DIESEL_100ML" });
  return Number(units) * 100;
};

export async function reconcileExchange(db: Db, xsvc: ExchangeService, cfg: ChainConfig, balance: BalanceView = contractBalanceMl, maxAccounts = 200): Promise<ReconcileReport> {
  const checkedAt = new Date().toISOString();
  if (xsvc.sandbox || !cfg.resourceContractId) {
    return { checkedAt, inBalance: null, accountsChecked: 0, mismatches: [], note: "Sandbox exchange: balances live on this server's ledger only, so there is nothing on-chain to compare." };
  }
  const settling = (db.prepare("SELECT COUNT(*) AS c FROM exchange_jobs WHERE status IN ('pending','submitted','timeout')").get() as { c: number }).c;
  if (settling > 0) {
    return { checkedAt, inBalance: null, accountsChecked: 0, mismatches: [], note: `${settling} exchange operation${settling === 1 ? " is" : "s are"} still settling; check skipped.` };
  }
  const exp = X.expectedChainBalances(xsvc.state);
  const checks: { label: string; accountId: string; expectedMl: number }[] = [];
  for (const [traderId, ml] of Object.entries(exp.traders)) {
    const accountId = cfg.traders[traderId]?.accountId;
    if (accountId) checks.push({ label: xsvc.state.traders[traderId]?.params.name ?? traderId, accountId, expectedMl: ml });
  }
  checks.push({ label: "Exchange escrow (contract)", accountId: cfg.resourceContractId, expectedMl: exp.escrowMl });
  for (const [playerId, ml] of Object.entries(exp.players).filter(([id]) => !xsvc.isSelfCustodied(id)).sort(([a], [b]) => a.localeCompare(b)).slice(0, maxAccounts)) {
    checks.push({ label: "player warehouse", accountId: playerChainId(cfg, playerId), expectedMl: ml });
  }
  const mismatches: ReconcileReport["mismatches"] = [];
  for (const c of checks) {
    const onChainMl = await balance(cfg, c.accountId);
    if (onChainMl !== c.expectedMl) mismatches.push({ ...c, onChainMl });
  }
  return {
    checkedAt,
    inBalance: mismatches.length === 0,
    accountsChecked: checks.length,
    mismatches,
    note: mismatches.length === 0 ? `All ${checks.length} exchange accounts match the contract.` : `${mismatches.length} of ${checks.length} accounts differ from the contract; trading continues, operator review needed.`,
  };
}
