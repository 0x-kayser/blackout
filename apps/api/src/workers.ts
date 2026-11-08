/**
 * Background workers:
 *  - real-time driver: maps wall-clock seconds onto engine ticks for running runs;
 *  - chain worker: submits pending diesel trades to NEAR testnet, verifies the
 *    final RPC outcome, and settles/compensates the game trade exactly once via a
 *    recorded SETTLE_TRADE system action. Unknown outcomes are reconciled, never
 *    blindly re-broadcast.
 */
import type { ChainConfig } from "./chain.ts";
import { contractListing, contractTradeStatus, lookupTx, submitCancelListing, submitCustodialListing, submitMerchantSale, submitNpcListingPurchase } from "./chain.ts";
import { nowIso, type Db } from "./db.ts";
import type { RunService } from "./services.ts";
import { playerListingDecision, type MarketListingState } from "@blackout/sim";

export function startDriver(svc: RunService, intervalMs = 100): () => void {
  const t = setInterval(() => {
    try {
      svc.driverStep();
    } catch (e) {
      console.error("[driver] tick failed", e);
    }
  }, intervalMs);
  return () => clearInterval(t);
}

interface JobRow {
  trade_key: string;
  run_id: string;
  trade_id: string;
  merchant_id: string;
  token_id: string;
  amount: string;
  status: string;
  tx_hash: string | null;
  signer_id: string | null;
  attempts: number;
}

export interface ChainDeps {
  submit: typeof submitMerchantSale;
  lookup: typeof lookupTx;
  contractStatus: typeof contractTradeStatus;
}

interface MarketplaceJobRow {
  job_id: string;
  run_id: string;
  listing_id: string;
  kind: "list" | "cancel" | "fill";
  seller_id: string;
  merchant_id: string | null;
  token_id: string;
  amount: string;
  unit_price_cc: string;
  status: string;
  tx_hash: string | null;
  signer_id: string | null;
  attempts: number;
}

export interface MarketplaceDeps {
  submitList: typeof submitCustodialListing;
  submitCancel: typeof submitCancelListing;
  submitFill: typeof submitNpcListingPurchase;
  lookup: typeof lookupTx;
  listingStatus: typeof contractListing;
}

const defaultMarketplaceDeps: MarketplaceDeps = {
  submitList: submitCustodialListing,
  submitCancel: submitCancelListing,
  submitFill: submitNpcListingPurchase,
  lookup: lookupTx,
  listingStatus: contractListing,
};

const RECONCILE_LIMIT = 60; // ~2 minutes of 2 s polls before flagging for operator review

export async function processChainJobs(db: Db, svc: RunService, cfg: ChainConfig, deps: ChainDeps = { submit: submitMerchantSale, lookup: lookupTx, contractStatus: contractTradeStatus }): Promise<number> {
  if (!cfg.enabled) return 0;
  const jobs = db.prepare("SELECT * FROM chain_jobs WHERE status IN ('pending','submitted','timeout') ORDER BY updated_at LIMIT 5").all() as unknown as JobRow[];
  let done = 0;
  const upd = db.prepare("UPDATE chain_jobs SET status = ?, tx_hash = COALESCE(?, tx_hash), signer_id = COALESCE(?, signer_id), attempts = attempts + 1, last_error = ?, updated_at = ? WHERE trade_key = ?");
  const settle = (job: JobRow, outcome: "confirmed" | "failed", txHash: string | null, error: string | null) => {
    const h = svc.get(job.run_id);
    const r = svc.act(h, { action: { type: "SETTLE_TRADE", tradeId: job.trade_id, outcome, txHash, error }, idempotencyKey: `settle:${job.trade_key}` }, "chain_worker");
    if (!r.ok && r.error?.code !== "ALREADY_PROCESSED") console.error("[chain] settle failed", job.trade_key, r.error);
    done += 1;
  };
  for (const job of jobs) {
    try {
      if (!job.tx_hash) {
        // Nothing was ever signed for this job, so signing now cannot double-spend.
        // The hash is persisted (status=submitted) BEFORE broadcast; after that we only reconcile.
        const res = await deps.submit(cfg, job.merchant_id, job.trade_key, job.token_id, job.amount, (hash, signer) =>
          upd.run("submitted", hash, signer, "signed; broadcasting", nowIso(), job.trade_key),
        );
        upd.run(res.outcome.status === "confirmed" ? "confirmed" : res.outcome.status === "failed" ? "failed" : "submitted", res.txHash, res.signerId, res.outcome.detail, nowIso(), job.trade_key);
        if (res.outcome.status === "confirmed") settle(job, "confirmed", res.txHash, null);
        else if (res.outcome.status === "failed") settle(job, "failed", res.txHash, `TX_FAILED: ${res.outcome.detail}`);
        continue;
      }
      // submitted / timeout: reconcile by hash, then by contract view
      if (job.tx_hash && job.signer_id) {
        const r = await deps.lookup(cfg, job.tx_hash, job.signer_id);
        if (r.status === "confirmed") {
          upd.run("confirmed", null, null, r.detail, nowIso(), job.trade_key);
          settle(job, "confirmed", job.tx_hash, null);
          continue;
        }
        if (r.status === "failed") {
          upd.run("failed", null, null, r.detail, nowIso(), job.trade_key);
          settle(job, "failed", job.tx_hash, `TX_FAILED: ${r.detail}`);
          continue;
        }
      }
      const cs = await deps.contractStatus(cfg, job.trade_key).catch((e: Error) => ({ settled: false, detail: e.message }));
      if (cs.settled && job.tx_hash) {
        upd.run("confirmed", null, null, cs.detail, nowIso(), job.trade_key);
        settle(job, "confirmed", job.tx_hash, null);
        continue;
      }
      // still unknown: keep reconciling; never auto-compensate an outcome we cannot see
      upd.run(job.attempts + 1 >= RECONCILE_LIMIT ? "timeout" : "submitted", null, null, cs.detail, nowIso(), job.trade_key);
    } catch (e) {
      upd.run("submitted", null, null, (e as Error).message.slice(0, 300), nowIso(), job.trade_key);
    }
  }
  return done;
}

/** Submits/reconciles player listing transactions and runs autonomous NPC discovery. */
export async function processMarketplaceJobs(db: Db, svc: RunService, cfg: ChainConfig, deps: MarketplaceDeps = defaultMarketplaceDeps): Promise<number> {
  if (!cfg.enabled) return 0;
  const jobs = db.prepare("SELECT * FROM marketplace_jobs WHERE status IN ('pending','submitted','timeout') ORDER BY updated_at LIMIT 5").all() as unknown as MarketplaceJobRow[];
  const update = db.prepare("UPDATE marketplace_jobs SET status = ?, tx_hash = COALESCE(?, tx_hash), signer_id = COALESCE(?, signer_id), attempts = attempts + 1, last_error = ?, updated_at = ? WHERE job_id = ?");
  let settled = 0;

  const applyOutcome = (job: MarketplaceJobRow, outcome: "confirmed" | "failed", txHash: string | null, error: string | null) => {
    const h = svc.get(job.run_id);
    const r = svc.act(h, {
      action: { type: "MARKET_LISTING_RESULT", listingId: job.listing_id, operation: job.kind, outcome, merchantId: job.merchant_id, txHash, error },
      idempotencyKey: `market-result:${job.job_id}:${outcome}`,
    }, "chain_worker");
    if (!r.ok && r.error?.code !== "ALREADY_PROCESSED") {
      console.error("[marketplace] listing settlement failed", job.job_id, r.error);
      return false;
    }
    update.run(outcome, null, null, error, nowIso(), job.job_id);
    settled += 1;
    return true;
  };

  for (const job of jobs) {
    try {
      if (!job.tx_hash) {
        const onSigned = (hash: string, signer: string) => update.run("submitted", hash, signer, "signed; broadcasting", nowIso(), job.job_id);
        const res = job.kind === "list"
          ? await deps.submitList(cfg, job.seller_id, job.listing_id, job.token_id, job.amount, job.unit_price_cc, onSigned)
          : job.kind === "cancel"
            ? await deps.submitCancel(cfg, job.listing_id, onSigned)
            : await deps.submitFill(cfg, job.listing_id, cfg.merchants[job.merchant_id ?? ""]?.accountId ?? "", onSigned);
        if (res.outcome.status === "confirmed") applyOutcome(job, "confirmed", res.txHash, null);
        else if (res.outcome.status === "failed") applyOutcome(job, "failed", res.txHash, `TX_FAILED: ${res.outcome.detail}`);
        else update.run("submitted", res.txHash, res.signerId, res.outcome.detail, nowIso(), job.job_id);
        continue;
      }

      if (!job.signer_id) {
        update.run("timeout", null, null, "Submitted transaction has no signer id; operator reconciliation required.", nowIso(), job.job_id);
        continue;
      }
      const tx = await deps.lookup(cfg, job.tx_hash, job.signer_id);
      if (tx.status === "confirmed") {
        if ("receiverId" in tx && cfg.resourceContractId && tx.receiverId !== cfg.resourceContractId) {
          update.run("timeout", null, null, "Receipt receiver did not match the resource contract.", nowIso(), job.job_id);
          continue;
        }
        applyOutcome(job, "confirmed", job.tx_hash, null);
        continue;
      }
      if (tx.status === "failed") {
        applyOutcome(job, "failed", job.tx_hash, `TX_FAILED: ${tx.detail}`);
        continue;
      }

      const view = await deps.listingStatus(cfg, job.listing_id).catch(() => null);
      const expectedStatus = job.kind === "list" ? "active" : job.kind === "cancel" ? "cancelled" : "filled";
      const expectedBuyer = job.kind === "fill" ? cfg.merchants[job.merchant_id ?? ""]?.accountId : null;
      if (view?.status === expectedStatus && view.sellerId === job.seller_id && (job.kind !== "fill" || view.buyerId === expectedBuyer)) {
        applyOutcome(job, "confirmed", job.tx_hash, null);
        continue;
      }
      // An unknown outcome keeps all reservations locked. Never broadcast again or refund on a view mismatch.
      update.run(job.attempts + 1 >= RECONCILE_LIMIT ? "timeout" : "submitted", null, null, view?.detail ?? tx.detail, nowIso(), job.job_id);
    } catch (e) {
      // If the signed hash was persisted, preserve submitted state and reconcile only. If no hash exists,
      // the call failed before signing/broadcast and may be retried safely.
      update.run(job.tx_hash ? "submitted" : "pending", null, null, (e as Error).message.slice(0, 300), nowIso(), job.job_id);
    }
  }

  // Discover listings autonomously from the same merchant policy used to explain decisions to players.
  const runs = db.prepare("SELECT run_id FROM runs WHERE chain_mode = 'testnet' AND finished = 0 ORDER BY created_at").all() as { run_id: string }[];
  for (const row of runs) {
    try {
      const h = svc.get(row.run_id);
      for (const raw of h.state.marketListings ?? []) {
        const listing = raw as MarketListingState;
        if (listing.status !== "active") continue;
        if (h.state.tick >= listing.expiresTick) {
          svc.act(h, { action: { type: "EXPIRE_MARKET_LISTING", listingId: listing.listingId }, idempotencyKey: `auto-expire:${listing.listingId}` }, "chain_worker");
          continue;
        }
        const decision = playerListingDecision(h.state, listing);
        if (decision.merchantId) {
          svc.act(h, { action: { type: "RESERVE_MARKET_PURCHASE", listingId: listing.listingId, merchantId: decision.merchantId }, idempotencyKey: `auto-fill:${listing.listingId}:${listing.fillAttempts + 1}` }, "chain_worker");
        }
      }
    } catch (e) {
      console.error("[marketplace] NPC discovery failed", row.run_id, e);
    }
  }
  return settled;
}

export function startChainWorker(db: Db, svc: RunService, cfg: ChainConfig, intervalMs = 2_000): () => void {
  if (!cfg.enabled) return () => {};
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await processChainJobs(db, svc, cfg);
      await processMarketplaceJobs(db, svc, cfg);
    } catch (e) {
      console.error("[chain] worker error", e);
    } finally {
      busy = false;
    }
  }, intervalMs);
  return () => clearInterval(t);
}
