/**
 * Settlement worker (§28–29): pending epochs → `settle_epoch` on the resource contract.
 *
 * Each epoch's identities map to NEAR accounts: the player to their namespaced id under the game operator, each NPC
 * to its configured account (NEAR_NPC_<NAME>_ACCOUNT_ID), and anything without an account (treasury, market,
 * unconfigured NPCs) to the operator itself. Folding keeps every epoch zero-sum. The contract refuses an epoch id
 * it has seen, so a retry after an unknown outcome is safe: "already settled" counts as confirmed.
 */
import { region } from "@blackout/sim";
import { playerChainId, submitSettleEpoch, submitSettleItems, type ChainConfig, type SubmitResult } from "./chain.ts";
import { town } from "@blackout/sim";
import { nowIso, type Db } from "./db.ts";

export type SettleSubmit = (cfg: ChainConfig, epochId: string, hash: string, deltas: [string, string][]) => Promise<SubmitResult>;

export const NPC_IDENTITIES = ["voltline", "ingrid", "bayo", "lena", "kettle", "dayo", "chioma", "ruth", "pavel", "nkechi", "vesper-bank", "meridian", "regulator", "market"] as const;

export function npcAccounts(env: NodeJS.ProcessEnv = process.env): Record<string, string | null> {
  return Object.fromEntries(NPC_IDENTITIES.map((n) => [n, env[`NEAR_NPC_${n.replace("-", "_").toUpperCase()}_ACCOUNT_ID`] ?? null]));
}

/** Identity deltas → account deltas (folded, zero-sum, sorted). */
export function epochDeltas(cfg: ChainConfig, ownerId: string, transfers: { account: string; deltaCc: number }[], npcs = npcAccounts()): [string, string][] {
  const operator = cfg.vaultAccountId!;
  const out = new Map<string, number>();
  for (const t of transfers) {
    const acct = t.account === "player" ? playerChainId(cfg, ownerId) : (npcs[t.account] ?? operator);
    out.set(acct, (out.get(acct) ?? 0) + t.deltaCc);
  }
  return [...out.entries()].filter(([, d]) => d !== 0).sort(([a], [b]) => a.localeCompare(b)).map(([a, d]) => [a, String(d)]);
}

export async function processSettlement(db: Db, cfg: ChainConfig, submit: SettleSubmit = submitSettleEpoch, limit = 5): Promise<number> {
  if (!cfg.enabled || !cfg.vaultAccountId) return 0;
  const rows = db
    .prepare("SELECT e.epoch_id, e.region_id, e.body_json, e.hash, e.attempts, r.owner_id FROM settlement_epochs e JOIN regions r ON r.region_id = e.region_id WHERE e.status IN ('pending', 'failed') AND e.attempts < 5 ORDER BY e.created_at LIMIT ?")
    .all(limit) as { epoch_id: string; region_id: string; body_json: string; hash: string; attempts: number; owner_id: string }[];
  let n = 0;
  for (const row of rows) {
    const epoch = JSON.parse(row.body_json) as region.REpoch;
    if (!region.verifyEpoch(epoch)) {
      db.prepare("UPDATE settlement_epochs SET status = 'failed', attempts = 99, last_error = ?, updated_at = ? WHERE epoch_id = ?").run("hash does not match body", nowIso(), row.epoch_id);
      continue;
    }
    const deltas = epochDeltas(cfg, row.owner_id, epoch.transfers);
    db.prepare("UPDATE settlement_epochs SET attempts = attempts + 1, updated_at = ? WHERE epoch_id = ?").run(nowIso(), row.epoch_id);
    try {
      const r = await submit(cfg, row.epoch_id, row.hash, deltas);
      const o = r.outcome;
      const already = o.status === "failed" && /already settled/i.test(o.detail ?? "");
      const status = o.status === "confirmed" || already ? "confirmed" : o.status === "pending" || o.status === "unknown" ? "submitted" : "failed";
      db.prepare("UPDATE settlement_epochs SET status = ?, tx_hash = COALESCE(?, tx_hash), last_error = ?, updated_at = ? WHERE epoch_id = ?").run(status, r.txHash, status === "failed" ? (o.detail ?? "failed") : null, nowIso(), row.epoch_id);
      n++;
    } catch (e) {
      db.prepare("UPDATE settlement_epochs SET status = 'failed', last_error = ?, updated_at = ? WHERE epoch_id = ?").run((e as Error).message, nowIso(), row.epoch_id);
    }
  }
  return n;
}

export type ItemsSubmit = (cfg: ChainConfig, epochId: string, hash: string, tokenId: string, deltas: [string, string][]) => Promise<SubmitResult>;

/** Vesper Market epochs: one `settle_items` per token. Merchants map to their accounts, everything else to the operator. */
export async function processTownSettlement(db: Db, cfg: ChainConfig, submit: ItemsSubmit = submitSettleItems, npcs = npcAccounts(), limit = 3): Promise<number> {
  if (!cfg.enabled || !cfg.vaultAccountId) return 0;
  const rows = db.prepare("SELECT epoch_id, body_json, hash FROM settlement_epochs WHERE region_id = 'town' AND status IN ('pending', 'failed') AND attempts < 5 ORDER BY epoch_no LIMIT ?").all(limit) as { epoch_id: string; body_json: string; hash: string }[];
  let n = 0;
  for (const row of rows) {
    const epoch = JSON.parse(row.body_json) as town.TownEpoch;
    db.prepare("UPDATE settlement_epochs SET attempts = attempts + 1, updated_at = ? WHERE epoch_id = ?").run(nowIso(), row.epoch_id);
    if (!town.verifyTownEpoch(epoch)) {
      db.prepare("UPDATE settlement_epochs SET status = 'failed', attempts = 99, last_error = ?, updated_at = ? WHERE epoch_id = ?").run("hash does not match body", nowIso(), row.epoch_id);
      continue;
    }
    let status: "confirmed" | "submitted" | "failed" = "confirmed";
    let lastTx: string | null = null;
    let err: string | null = null;
    for (const tk of epoch.tokens) {
      const folded = new Map<string, number>();
      for (const t of tk.transfers) {
        const acct = t.account === "operator" ? cfg.vaultAccountId : (npcs[t.account] ?? cfg.vaultAccountId);
        folded.set(acct, (folded.get(acct) ?? 0) + t.delta);
      }
      const deltas = [...folded.entries()].filter(([, d]) => d !== 0).sort(([a], [b]) => a.localeCompare(b)).map(([a, d]) => [a, String(d)] as [string, string]);
      if (!deltas.length) continue;
      try {
        const r = await submit(cfg, row.epoch_id, row.hash, tk.token, deltas);
        lastTx = r.txHash;
        const o = r.outcome;
        const already = o.status === "failed" && /already settled/i.test(o.detail ?? "");
        if (o.status === "failed" && !already) {
          status = "failed";
          err = `${tk.token}: ${o.detail}`;
          break;
        }
        if (o.status === "pending" || o.status === "unknown") status = "submitted";
      } catch (e) {
        status = "failed";
        err = (e as Error).message;
        break;
      }
    }
    db.prepare("UPDATE settlement_epochs SET status = ?, tx_hash = COALESCE(?, tx_hash), last_error = ?, updated_at = ? WHERE epoch_id = ?").run(status, lastTx, err, nowIso(), row.epoch_id);
    n++;
  }
  return n;
}

export function startSettlementWorker(db: Db, cfg: ChainConfig, ms = 10_000): () => void {
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await processSettlement(db, cfg);
      await processTownSettlement(db, cfg);
    } finally {
      busy = false;
    }
  }, ms);
  return () => clearInterval(t);
}
