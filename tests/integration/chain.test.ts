import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../apps/api/src/server.ts";
import { interpretTxResult, loadChainConfig, type ChainConfig, type SubmitResult } from "../../apps/api/src/chain.ts";
import { processChainJobs, processMarketplaceJobs, type ChainDeps, type MarketplaceDeps } from "../../apps/api/src/workers.ts";

// A fully "configured" chain config pointing at a fake RPC: every RPC interaction
// in these tests goes through injected fakes, so no network and no real keys.
const fakeEnv = {
  NEAR_CHAIN_ENABLED: "true",
  NEAR_RPC_URL: "http://127.0.0.1:1/fake",
  NEAR_RESOURCE_CONTRACT_ID: "resources.blackout-test.testnet",
  NEAR_VAULT_ACCOUNT_ID: "vault.blackout-test.testnet",
  NEAR_VAULT_OPERATOR_PRIVATE_KEY: "ed25519:fake-vault-operator",
  NEAR_MERCHANT_EMBER_ACCOUNT_ID: "ember.blackout-test.testnet",
  NEAR_MERCHANT_EMBER_PRIVATE_KEY: "ed25519:fake",
  NEAR_MERCHANT_LANTERN_ACCOUNT_ID: "lantern.blackout-test.testnet",
  NEAR_MERCHANT_LANTERN_PRIVATE_KEY: "ed25519:fake",
  NEAR_MERCHANT_HARBOR_ACCOUNT_ID: "harbor.blackout-test.testnet",
  NEAR_MERCHANT_HARBOR_PRIVATE_KEY: "ed25519:fake",
  NEAR_CITY_PURCHASES_ON_CHAIN: "true",
};

type Built = Awaited<ReturnType<typeof buildServer>>;
let built: Built;
let cfg: ChainConfig;

beforeEach(async () => {
  cfg = loadChainConfig(fakeEnv as NodeJS.ProcessEnv);
  built = await buildServer({ dbPath: ":memory:", chain: cfg, allowedOrigins: [] });
});
afterEach(async () => {
  await built.app.close();
  built.db.close();
});

async function pendingTrade() {
  const s = await built.app.inject({ method: "POST", url: "/api/session/start", payload: {} });
  const token = s.json().token as string;
  const r = await built.app.inject({ method: "POST", url: "/api/runs", headers: { authorization: `Bearer ${token}` }, payload: { seed: 1, mode: "play", worldMode: "calm" } });
  const runId = r.json().state.run.runId as string;
  expect(r.json().state.chain.mode).toBe("testnet");
  const h = built.svc.get(runId);
  for (let i = 0; i < 255; i++) built.svc.advanceOne(h);
  const q = built.svc.act(h, { action: { type: "REQUEST_QUOTE", sellerId: "merchant:ember", item: "diesel", quantity: 5_000 }, idempotencyKey: "q-123456789" });
  const b = built.svc.act(h, { action: { type: "BUY", quoteId: q.result!.quoteId as string, quantity: 5_000 }, idempotencyKey: "b-123456789" });
  const tradeId = b.result!.tradeId as string;
  return { h, runId, tradeId, token, fuelBefore: h.state.balances.fuel_ml.player };
}

const HASH = "4ZbV4k1Tcv1oWy1hoxUo4o9b2cUqGgYyU6wF7pK2ZWwz";

describe("chain worker", () => {
  it("is truthful: pending until RPC says final success, then settles exactly once with the real hash", async () => {
    const { h, tradeId, fuelBefore } = await pendingTrade();
    expect(h.state.trades[tradeId].chainStatus).toBe("pending");
    expect(h.state.trades[tradeId].tokenAmount).toBe("50"); // 5 L = 50 x DIESEL_100ML
    const job = built.db.prepare("SELECT * FROM chain_jobs").get() as { status: string; amount: string; token_id: string };
    expect(job).toMatchObject({ status: "pending", amount: "50", token_id: "DIESEL_100ML" });
    const deps: ChainDeps = {
      submit: vi.fn(async (_c, _m, _k, _t, _a, onSigned) => {
        onSigned!(HASH, "ember.blackout-test.testnet");
        return { txHash: HASH, signerId: "ember.blackout-test.testnet", outcome: { status: "confirmed", txHash: HASH, signerId: "ember.blackout-test.testnet", receiverId: cfg.resourceContractId!, detail: "FINAL" } } satisfies SubmitResult;
      }),
      lookup: vi.fn(),
      contractStatus: vi.fn(),
    };
    await processChainJobs(built.db, built.svc, cfg, deps);
    const t = h.state.trades[tradeId];
    expect(t.chainStatus).toBe("confirmed");
    expect(t.txHash).toBe(HASH);
    expect(h.state.balances.fuel_ml.player).toBe(fuelBefore + 5_000);
    const pub = built.svc.publicState(h);
    expect(pub.trades.find((x) => x.tradeId === tradeId)!.explorerUrl).toBe(`https://testnet.nearblocks.io/txns/${HASH}`);
    // second pass: nothing left to do, no double settlement
    await processChainJobs(built.db, built.svc, cfg, deps);
    expect(deps.submit).toHaveBeenCalledTimes(1);
    expect(h.state.balances.fuel_ml.player).toBe(fuelBefore + 5_000);
  });

  it("definitive on-chain failure compensates credits and stock once", async () => {
    const { h, tradeId } = await pendingTrade();
    const credits = h.state.balances.credits_cc.player + h.state.trades[tradeId].totalCc;
    const deps: ChainDeps = {
      submit: vi.fn(async (_c, _m, _k, _t, _a, onSigned) => {
        onSigned!(HASH, "ember.blackout-test.testnet");
        return { txHash: HASH, signerId: "ember.blackout-test.testnet", outcome: { status: "failed", txHash: HASH, signerId: "x", receiverId: "y", detail: "Smart contract panicked: insufficient balance" } } satisfies SubmitResult;
      }),
      lookup: vi.fn(),
      contractStatus: vi.fn(),
    };
    await processChainJobs(built.db, built.svc, cfg, deps);
    expect(h.state.trades[tradeId].chainStatus).toBe("failed");
    expect(h.state.balances.credits_cc.player).toBe(credits);
    expect(h.state.balances.fuel_ml["escrow:trades"] ?? 0).toBe(0);
  });

  it("unknown outcome is reconciled (never blindly re-broadcast, never auto-compensated)", async () => {
    const { h, tradeId } = await pendingTrade();
    let lookups = 0;
    const deps: ChainDeps = {
      submit: vi.fn(async (_c, _m, _k, _t, _a, onSigned) => {
        onSigned!(HASH, "ember.blackout-test.testnet");
        return { txHash: HASH, signerId: "ember.blackout-test.testnet", outcome: { status: "pending", txHash: HASH, detail: "broadcast error: socket hang up" } } satisfies SubmitResult;
      }),
      lookup: vi.fn(async () => (++lookups < 2 ? { status: "unknown" as const, txHash: HASH, detail: "UNKNOWN_TRANSACTION" } : { status: "confirmed" as const, txHash: HASH, signerId: "s", receiverId: "r", detail: "FINAL" })),
      contractStatus: vi.fn(async () => ({ settled: false, detail: "no record" })),
    };
    await processChainJobs(built.db, built.svc, cfg, deps);
    expect(h.state.trades[tradeId].chainStatus).toBe("pending");
    expect(h.state.trades[tradeId].txHash).toBeNull(); // no hash shown until verified
    await processChainJobs(built.db, built.svc, cfg, deps);
    expect(h.state.trades[tradeId].chainStatus).toBe("pending");
    await processChainJobs(built.db, built.svc, cfg, deps);
    expect(h.state.trades[tradeId].chainStatus).toBe("confirmed");
    expect(deps.submit).toHaveBeenCalledTimes(1);
  });

  it("a crash after signing resumes by reconciliation, not by re-signing", async () => {
    const { h, tradeId } = await pendingTrade();
    // simulate: hash persisted, process died before broadcast result was recorded
    built.db.prepare("UPDATE chain_jobs SET status='submitted', tx_hash=?, signer_id=?").run(HASH, "ember.blackout-test.testnet");
    const deps: ChainDeps = {
      submit: vi.fn(),
      lookup: vi.fn(async () => ({ status: "unknown" as const, txHash: HASH, detail: "UNKNOWN_TRANSACTION" })),
      contractStatus: vi.fn(async () => ({ settled: true, detail: "contract recorded trade" })),
    };
    await processChainJobs(built.db, built.svc, cfg, deps);
    expect(deps.submit).not.toHaveBeenCalled();
    expect(h.state.trades[tradeId].chainStatus).toBe("confirmed");
  });

  it("guest_demo runs never create chain jobs even when chain mode is configured", async () => {
    const s = await built.app.inject({ method: "POST", url: "/api/session/start", payload: {} });
    const r = await built.app.inject({ method: "POST", url: "/api/runs", headers: { authorization: `Bearer ${s.json().token}` }, payload: { mode: "guest_demo" } });
    expect(r.json().state.chain.mode).toBe("disabled");
    expect(r.json().state.merchants.every((m: { accountId: string | null }) => m.accountId === null)).toBe(true);
  });

  it("requires a registered player for listings, then settles an autonomous purchase and exposes private judge evidence", async () => {
    const { h, runId, token, tradeId } = await pendingTrade();
    const purchaseDeps: ChainDeps = {
      submit: vi.fn(async (_c, _m, _k, _t, _a, onSigned) => {
        onSigned!(HASH, "ember.blackout-test.testnet");
        return { txHash: HASH, signerId: "ember.blackout-test.testnet", outcome: { status: "confirmed", txHash: HASH, signerId: "ember.blackout-test.testnet", receiverId: cfg.resourceContractId!, detail: "FINAL" } } satisfies SubmitResult;
      }),
      lookup: vi.fn(),
      contractStatus: vi.fn(),
    };
    await processChainJobs(built.db, built.svc, cfg, purchaseDeps);
    expect(h.state.trades[tradeId].chainStatus).toBe("confirmed");

    const denied = await built.app.inject({
      method: "POST", url: `/api/runs/${runId}/actions`, headers: { authorization: `Bearer ${token}` },
      payload: { action: { type: "CREATE_PLAYER_LISTING", listingId: "guest-listing", quantityMl: 1_000, unitPriceCcPerL: 800 }, idempotencyKey: "guest-listing-key" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("FORBIDDEN");

    const guest = built.auth.guestFromToken(token)!;
    built.auth.linkGuest(guest, "supabase", "verified-test-subject", "email", "Tester");
    built.auth.setActiveRun(h.ownerId, runId);
    const created = await built.app.inject({
      method: "POST", url: `/api/runs/${runId}/actions`, headers: { authorization: `Bearer ${token}` },
      payload: { action: { type: "CREATE_PLAYER_LISTING", listingId: "registered-listing-1", quantityMl: 1_000, unitPriceCcPerL: 800 }, idempotencyKey: "registered-listing-key" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().state.marketListings[0].status).toBe("reserved");

    const listHash = "5BbV4k1Tcv1oWy1hoxUo4o9b2cUqGgYyU6wF7pK2ZWwz";
    const fillHash = "6CbV4k1Tcv1oWy1hoxUo4o9b2cUqGgYyU6wF7pK2ZWwz";
    const listingDeps: MarketplaceDeps = {
      submitList: vi.fn(async (_c, _seller, _listing, _token, _amount, _price, onSigned) => {
        onSigned!(listHash, cfg.vaultAccountId!);
        return { txHash: listHash, signerId: cfg.vaultAccountId!, outcome: { status: "confirmed", txHash: listHash, signerId: cfg.vaultAccountId!, receiverId: cfg.resourceContractId!, detail: "FINAL" } } satisfies SubmitResult;
      }),
      submitCancel: vi.fn(),
      submitFill: vi.fn(async (_c, _listing, _buyer, onSigned) => {
        onSigned!(fillHash, cfg.vaultAccountId!);
        return { txHash: fillHash, signerId: cfg.vaultAccountId!, outcome: { status: "confirmed", txHash: fillHash, signerId: cfg.vaultAccountId!, receiverId: cfg.resourceContractId!, detail: "FINAL" } } satisfies SubmitResult;
      }),
      lookup: vi.fn(),
      listingStatus: vi.fn(),
    };
    await processMarketplaceJobs(built.db, built.svc, cfg, listingDeps);
    expect(h.state.marketListings[0].status).toBe("purchase_pending");
    expect(h.state.marketListings[0].buyerMerchantId).toBe("ember");
    await processMarketplaceJobs(built.db, built.svc, cfg, listingDeps);
    expect(h.state.marketListings[0].status).toBe("filled");
    expect(listingDeps.submitList).toHaveBeenCalledTimes(1);
    expect(listingDeps.submitFill).toHaveBeenCalledTimes(1);

    const evidence = await built.app.inject({ method: "GET", url: "/api/chain/market-listings", headers: { authorization: `Bearer ${token}` } });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.json().listings).toEqual(expect.arrayContaining([
      expect.objectContaining({ listingId: "registered-listing-1", operation: "list", status: "confirmed", txHash: listHash }),
      expect.objectContaining({ listingId: "registered-listing-1", operation: "fill", status: "confirmed", txHash: fillHash }),
    ]));
  });

  it("does not re-submit or release a listing while its outcome is unknown", async () => {
    const { h, token } = await pendingTrade();
    const purchaseDeps: ChainDeps = {
      submit: vi.fn(async (_c, _m, _k, _t, _a, onSigned) => {
        onSigned!(HASH, "ember.blackout-test.testnet");
        return { txHash: HASH, signerId: "ember.blackout-test.testnet", outcome: { status: "confirmed", txHash: HASH, signerId: "ember.blackout-test.testnet", receiverId: cfg.resourceContractId!, detail: "FINAL" } } satisfies SubmitResult;
      }), lookup: vi.fn(), contractStatus: vi.fn(),
    };
    await processChainJobs(built.db, built.svc, cfg, purchaseDeps);
    const guest = built.auth.guestFromToken(token)!;
    built.auth.linkGuest(guest, "supabase", "unknown-outcome-subject", "email", "Tester");
    built.svc.act(h, { action: { type: "CREATE_PLAYER_LISTING", listingId: "unknown-listing", quantityMl: 1_000, unitPriceCcPerL: 800 }, idempotencyKey: "unknown-listing-key" });
    const before = h.state.balances.fuel_ml["escrow:listings"];
    let calls = 0;
    const deps: MarketplaceDeps = {
      submitList: vi.fn(async (_c, _seller, _listing, _token, _amount, _price, onSigned) => {
        calls += 1;
        onSigned!(HASH, cfg.vaultAccountId!);
        return { txHash: HASH, signerId: cfg.vaultAccountId!, outcome: { status: "pending" as const, txHash: HASH, detail: "RPC uncertain" } };
      }),
      submitCancel: vi.fn(), submitFill: vi.fn(),
      lookup: vi.fn(async () => ({ status: "unknown" as const, txHash: HASH, detail: "not indexed yet" })),
      listingStatus: vi.fn(async () => null),
    };
    await processMarketplaceJobs(built.db, built.svc, cfg, deps);
    expect(h.state.marketListings[0].status).toBe("reserved");
    expect(h.state.balances.fuel_ml["escrow:listings"]).toBe(before);
    await processMarketplaceJobs(built.db, built.svc, cfg, deps);
    expect(calls).toBe(1);
    expect(h.state.marketListings[0].status).toBe("reserved");
  });
});

describe("RPC outcome interpretation", () => {
  it("success, top-level failure and receipt failure", () => {
    const tx = { signer_id: "a", receiver_id: "b" };
    expect(interpretTxResult("h", { status: { SuccessValue: "" }, transaction: tx, receipts_outcome: [], final_execution_status: "FINAL" }).status).toBe("confirmed");
    expect(interpretTxResult("h", { status: { Failure: { ActionError: {} } }, transaction: tx }).status).toBe("failed");
    expect(
      interpretTxResult("h", { status: { SuccessValue: "" }, transaction: tx, receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: { FunctionCallError: {} } } } } } }], final_execution_status: "FINAL" }).status,
    ).toBe("failed");
    expect(interpretTxResult("h", { status: { SuccessValue: "" }, transaction: tx, receipts_outcome: [], final_execution_status: "INCLUDED" }).status).toBe("pending");
  });
});
