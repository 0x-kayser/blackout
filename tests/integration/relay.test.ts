import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyPair } from "near-api-js";
import { StartSessionResponseSchema } from "@blackout/shared";
import { buildServer } from "../../apps/api/src/server.ts";
import { loadChainConfig, type ChainConfig } from "../../apps/api/src/chain.ts";
import { checkDelegate, signDelegate, type DelegateRequest, type RelayConfig } from "../../apps/api/src/relayer.ts";
import { epochDeltas, processSettlement } from "../../apps/api/src/settlement.ts";
import { StaticWorldInputs } from "../../apps/api/src/world.ts";

const CONTRACT = "blackout-res.testnet";
const relayCfg: RelayConfig = { enabled: true, rpcUrl: "http://localhost:0", receiverId: CONTRACT, relayerAccountId: "relayer.testnet", relayerPrivateKey: KeyPair.fromRandom("ed25519").toString() };
const userKey = KeyPair.fromRandom("ed25519").toString();
const call = (methodName: string, deposit = "1") => ({ methodName, args: { token_id: "p00001", receiver_id: "bob.testnet" }, gas: "30000000000000", deposit });
const signed = (methods = ["nft_transfer"], receiver = CONTRACT, deposit = "1") => signDelegate("alice.testnet", userKey, receiver, methods.map((m) => call(m, deposit)), 7n, 10_000_000n);

describe("NEP-366 delegate checks", () => {
  it("accepts a correctly signed allowlisted call", () => {
    expect(checkDelegate(relayCfg, signed())).toBeNull();
  });
  it("refuses other contracts, other methods, deposits, bad signatures and expired requests", () => {
    expect(checkDelegate(relayCfg, signed(["nft_transfer"], "evil.testnet"))).toMatch(/Only calls to the BLACKOUT contract/);
    expect(checkDelegate(relayCfg, signed(["storage_withdraw"]))).toMatch(/not relayed/);
    expect(checkDelegate(relayCfg, signed(["nft_transfer"], CONTRACT, "1000000000000000000000000"))).toMatch(/1 yoctoNEAR/);
    const tampered: DelegateRequest = { ...signed(), actions: [{ ...call("nft_transfer"), args: { token_id: "p00002", receiver_id: "mallory.testnet" } }] };
    expect(checkDelegate(relayCfg, tampered)).toMatch(/Signature does not match/);
    expect(checkDelegate(relayCfg, signed(), 20_000_000n)).toMatch(/expired/);
  });
});

type Built = Awaited<ReturnType<typeof buildServer>>;
let built: Built;
let clock = 9_000_000;
let submitted: DelegateRequest[] = [];
beforeEach(async () => {
  submitted = [];
  built = await buildServer({
    dbPath: ":memory:",
    chain: loadChainConfig({}),
    now: () => clock,
    webDist: null,
    world: new StaticWorldInputs(),
    relay: { cfg: relayCfg, submit: async (_c, req) => (submitted.push(req), { txHash: `tx${submitted.length}`, ok: true, detail: "final" }) },
  });
});
afterEach(async () => {
  await built.app.close();
  built.db.close();
});
async function session() {
  const r = await built.app.inject({ method: "POST", url: "/api/session/start", payload: {} });
  return StartSessionResponseSchema.parse(r.json()).token;
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe("relayer API", () => {
  it("relays once per idempotency key, persists everything and rate-limits per player", async () => {
    const t = await session();
    const post = (key: string, delegate: DelegateRequest = signed()) => built.app.inject({ method: "POST", url: "/api/relay", headers: auth(t), payload: { idempotencyKey: key, delegate } });
    const a = await post("relay-key-001");
    expect(a.statusCode).toBe(200);
    expect(a.json().request.status).toBe("succeeded");
    const again = await post("relay-key-001");
    expect(again.json().request.replayed).toBe(true);
    expect(submitted).toHaveLength(1);
    const bad = await post("relay-key-002", signed(["storage_withdraw"]));
    expect(bad.statusCode).toBe(422);
    for (let i = 3; i <= 7; i++) expect((await post(`relay-key-00${i}`)).statusCode).toBe(200);
    const limited = await post("relay-key-008");
    expect(limited.statusCode).toBe(429);
    clock += 61_000;
    expect((await post("relay-key-009")).statusCode).toBe(200);
    const rows = built.db.prepare("SELECT status, COUNT(*) AS n FROM relay_requests GROUP BY status ORDER BY status").all();
    expect(rows).toEqual([{ status: "rejected", n: 2 }, { status: "succeeded", n: 7 }]);
  });

  it("describes the player as a GameIdentity", async () => {
    const t = await session();
    const r = (await built.app.inject({ method: "GET", url: "/api/identity", headers: auth(t) })).json().identity;
    expect(r).toMatchObject({ kind: "guest", providers: ["guest"], chainAccountId: null, gasless: true });
  });
});

describe("settlement worker", () => {
  const cfg = { ...loadChainConfig({}), enabled: true, vaultAccountId: "vault.testnet", vaultOperatorPrivateKey: "ed25519:x", resourceContractId: CONTRACT } as ChainConfig;

  it("maps identities to accounts, folding the unconfigured into the operator, zero-sum", () => {
    const d = epochDeltas(cfg, "guest_1", [{ account: "player", deltaCc: 500 }, { account: "voltline", deltaCc: 200 }, { account: "ingrid", deltaCc: -100 }, { account: "treasury", deltaCc: -600 }], { voltline: "voltline.testnet", ingrid: null } as Record<string, string | null>);
    expect(d.reduce((a, [, x]) => a + Number(x), 0)).toBe(0);
    expect(d.find(([a]) => a === "vault.testnet")![1]).toBe("-700");
    expect(d.find(([a]) => a === "voltline.testnet")![1]).toBe("200");
    expect(d.some(([a]) => a.endsWith(".vault.testnet") && a.startsWith("p"))).toBe(true);
  });

  it("submits pending epochs once and treats 'already settled' as confirmed", async () => {
    const t = await session();
    const v = (await built.app.inject({ method: "GET", url: "/api/region", headers: auth(t) })).json().view;
    const h = built.rsvc.get(v.regionId);
    for (let i = 0; i < 40; i++) built.rsvc.advance(h);
    built.db.prepare("UPDATE settlement_epochs SET status = 'pending'").run();
    const calls: { id: string; deltas: [string, string][] }[] = [];
    const n = await processSettlement(built.db, cfg, async (_c, id, _h, deltas) => {
      calls.push({ id, deltas });
      return { txHash: "abc", signerId: "vault.testnet", outcome: { status: "failed", txHash: "abc", signerId: "vault.testnet", receiverId: CONTRACT, detail: "Smart contract panicked: Epoch already settled" } };
    });
    expect(n).toBe(1);
    expect(calls[0].deltas.reduce((a, [, x]) => a + Number(x), 0)).toBe(0);
    const row = built.db.prepare("SELECT status, attempts FROM settlement_epochs").get() as { status: string; attempts: number };
    expect(row).toEqual({ status: "confirmed", attempts: 1 });
    expect(await processSettlement(built.db, cfg, async () => { throw new Error("should not resubmit"); })).toBe(0);
  });
});
