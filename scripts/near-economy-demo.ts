/**
 * Runs the real economy against NEAR testnet and reports what happened, with every transaction hash.
 *
 *   pnpm chain:demo            (reads .env.economy written by `pnpm chain:economy`)
 *
 * It uses the game's own server code and engine, nothing scripted: a signed-in demo company gets its wallet and its
 * starting capital, starts its gas turbine, and offers its spare power on the desk. Then the market runs (faster than
 * real time) for three power windows, with a storm parked over Vesper so Solara's panels fall short. Every decision
 * is the NPC companies' own (firmPolicy.ts); every payment is a real testnet transaction, confirmed FINAL before it
 * counts. The report is written to docs/TESTNET_RUN.md only from confirmed transactions.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { StartSessionResponseSchema } from "@blackout/shared";
import { region } from "@blackout/sim";

if (existsSync(".env.economy")) for (const line of readFileSync(".env.economy", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const { buildServer } = await import("../apps/api/src/server.ts");
const { StaticWorldInputs } = await import("../apps/api/src/world.ts");
const { loadChainConfig } = await import("../apps/api/src/chain.ts");

const built = await buildServer({ dbPath: `data/testnet-demo-${Date.now()}.sqlite`, chain: loadChainConfig({}), webDist: null, world: new StaticWorldInputs() });
const { app, db, rsvc, tsvc, economy } = built;
if (!economy.live) {
  console.error(`Not connected to NEAR. Missing: ${economy.cfg.missing.join(", ")}\nRun pnpm chain:economy first.`);
  process.exit(1);
}
const say = (s: string) => console.log(s);
const tx = (h: string | null) => (h ? `${economy.cfg.explorerTxBase}${h}` : "(no hash)");
const acct = (id: string) => `${economy.cfg.explorerAccountBase}${id}`;
const cr = (cc: number) => `₡${(cc / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await economy.ensureTownOpen();
    economy.queueSettlement();
    economy.syncPlants();
    await economy.processOps(40);
  }
}

// 1. a player joins and signs in
const s = await app.inject({ method: "POST", url: "/api/session/start", payload: {} });
const token = StartSessionResponseSchema.parse(s.json()).token;
const me = (await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } })).json();
const userId = me.player.playerId as string;
db.prepare("UPDATE players SET kind = 'registered', display_name = 'Judge Demo Power Co', company_named = 1 WHERE player_id = ?").run(userId);
say(`\n1. A player joins: ${userId}`);
const h = rsvc.liveFor(userId);
h.state.onboarding.done = true;
economy.ensureWallet(userId);
for (let i = 0; i < 20 && economy.wallet(userId)?.status !== "active"; i++) await settle(1);
const w = economy.wallet(userId)!;
say(`   wallet ${w.account_id} — ${w.status}  ${acct(w.account_id)}`);
say(`   on chain: ${cr((await economy.onChain(w.account_id, true)) ?? 0)}`);

// 2. the company starts its turbine and the region runs past its opening crisis
rsvc.act(h, { type: "SET_PLANT_ONLINE", plantId: "kestrel", online: true }, "demo-start-kestrel");
for (let i = 0; i < 80; i++) rsvc.advance(h);
say(`\n2. Kestrel is running. Spare power on offer: ${JSON.stringify(region.regionPowerOffer(h.state))}`);

// 3. the market opens on chain (NPC capital, floats), and a storm parks over Vesper
await settle(4);
tsvc.state.news = [...(tsvc.state.news ?? []), { seq: 999_999, storyId: "storm-front", from: tsvc.state.tick, until: tsvc.state.tick + 400 }];
say(`\n3. Storm front over Vesper. NPC companies open with their own capital.`);

// 4. three power windows, the NPCs deciding for themselves
for (let i = 0; i < 36 * 3 + 2; i++) {
  h.lastClientAt = Date.now();
  tsvc.tick();
  rsvc.advance(h);
  if (i % 4 === 0) await settle(1);
}
for (let i = 0; i < 12; i++) await settle(1);

// report
const ops = db.prepare("SELECT * FROM chain_ops ORDER BY rowid").all() as { op_id: string; kind: string; signer: string; method: string; args_json: string; status: string; tx_hash: string | null; detail: string | null }[];
const orders = tsvc.state.power?.orders ?? [];
const lines: string[] = ["# Testnet run", "", `Contract: [${economy.cfg.contractId}](${acct(economy.cfg.contractId!)}) · run ${new Date().toISOString()}`, "", "Only transactions NEAR reported as FINAL and successful are listed as settled.", ""];
lines.push("| What | Signed by | Status | Transaction |", "|---|---|---|---|");
for (const o of ops) lines.push(`| ${o.op_id} | ${o.signer} | ${o.status} | ${o.tx_hash ? `[${o.tx_hash.slice(0, 10)}…](${tx(o.tx_hash)})` : "—"} |`);
lines.push("", "## Decisions the NPC companies made", "");
for (const o of orders) lines.push(`- **${o.buyerName}** bought ${o.kw / 1000} MW from **${o.sellerName}** at ${cr(o.priceCcPerMWh)}/MWh → ${o.status}${o.status === "settled" ? `, delivered ${o.deliveredKwh} kWh, paid ${cr(o.paidCc)}` : ""}. Why: “${o.why}”`);
lines.push("", "## Balances on chain after the run", "");
for (const [label, id] of [["Your wallet", w.account_id], ["Grid clearing", economy.cfg.gridId!], ["Outside world", economy.cfg.worldId!], ...Object.entries(economy.cfg.npcs).map(([k, v]) => [k, v.accountId])] as [string, string][]) lines.push(`- ${label}: [${id}](${acct(id)}) — ${cr((await economy.onChain(id, true)) ?? 0)}`);
writeFileSync("docs/TESTNET_RUN.md", lines.join("\n") + "\n");
say("\n4. What happened on NEAR:");
for (const o of ops.filter((x) => x.status === "settled")) say(`   ✓ ${o.op_id.padEnd(40)} ${tx(o.tx_hash)}`);
for (const o of ops.filter((x) => x.status !== "settled")) say(`   … ${o.op_id.padEnd(40)} ${o.status} ${o.detail ?? ""}`);
const toPlayer = orders.filter((o) => o.sellerKey === `player:${userId}` && o.status === "settled");
const npcToNpc = orders.filter((o) => !o.sellerKey.startsWith("player:") && o.status === "settled");
say(`\nNPC → player settled: ${toPlayer.length}   NPC → NPC settled: ${npcToNpc.length}`);
say(`Your wallet now holds ${cr((await economy.onChain(w.account_id, true)) ?? 0)} on chain; the game says ${cr(region.rbal(h.state, "cc", "player"))}.`);
say("Report written to docs/TESTNET_RUN.md");
await app.close();
db.close();
