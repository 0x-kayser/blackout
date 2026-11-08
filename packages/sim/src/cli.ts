#!/usr/bin/env tsx
/**
 * pnpm sim:replay --seed 424242 --policy diesel --days 7 [--scenario starter|fuel_squeeze] [--out trace.json] [--ledger]
 * Prints a day-by-day table and the deterministic trace hash. Same args => same hash.
 */
import { writeFileSync } from "node:fs";
import { runReplay } from "./replay.ts";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return def;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const seed = Number(arg("seed", "424242"));
const policyId = (arg("policy", "diesel") as "diesel" | "diversified" | "gouger");
const days = Number(arg("days", "7"));
const scenarioId = (arg("scenario", "starter") as "starter" | "fuel_squeeze" | "oil_shock_2026");
const out = arg("out");

const trace = runReplay({ seed, policyId, days, scenarioId });
const s = trace.summary;
const c = (cc: number) => (cc / 100).toFixed(2).padStart(10);

console.log(`BLACKOUT fast-forward — ${s.label}`);
console.log(`seed=${s.seed} scenario=${s.scenarioId}@${s.scenarioVersion} policy=${s.policyId} days=${s.days}`);
console.log(`events=${s.eventCount} ledgerEntries=${trace.ledger.length} wall=${s.wallMs}ms`);
console.log("");
console.log("day |   cash(₡) | fuel(L) | permits(kg) | revenue(₡) | reliab | GDP(₡)    | oil    | ember  lantern harbor | rival₡/kWh | open | diesel kWh | solar kWh | batt kWh");
for (const d of s.daily) {
  console.log(
    `${String(d.day).padStart(3)} |${c(d.playerCashCc)} | ${(d.playerFuelMl / 1000).toFixed(1).padStart(7)} | ${(d.permitAllowanceMg / 1e6).toFixed(1).padStart(11)} |${c(d.revenueCc)}  | ${(d.reliabilityBps / 100).toFixed(0).padStart(5)}% |${c(d.gdpCc)} | ${(d.oilIndexCenti / 100).toFixed(1).padStart(6)} | ${(d.merchantPrices.ember / 100).toFixed(2).padStart(5)} ${(d.merchantPrices.lantern / 100).toFixed(2).padStart(7)} ${(d.merchantPrices.harbor / 100).toFixed(2).padStart(6)} | ${(d.rivalTariffCcPerKwh / 100).toFixed(2).padStart(10)} | ${String(d.openBusinesses).padStart(4)} | ${(d.generationMixWh.diesel / 1000).toFixed(1).padStart(10)} | ${(d.generationMixWh.solar / 1000).toFixed(1).padStart(9)} | ${(d.generationMixWh.battery / 1000).toFixed(1).padStart(8)}${d.closures.length ? "  closed: " + d.closures.join(",") : ""}`,
  );
}
console.log("");
console.log(`final: netWorth=₡${(s.final.netWorthCc / 100).toFixed(2)} reliability=${(s.final.reliabilityBps / 100).toFixed(1)}% cityGDP=₡${(s.final.cityGdpCc / 100).toFixed(2)} closures=${s.final.closures} score=${s.final.score}`);
console.log(`traceHash=${s.traceHash}`);
if (flag("ledger")) {
  for (const e of trace.events) console.log(`[d${e.day} ${e.clock.padStart(10)} #${e.seq}] ${e.type}: ${e.explanation}`);
}
if (out) {
  writeFileSync(out, JSON.stringify({ summary: s, events: trace.events, ledger: trace.ledger, actions: trace.actions }, null, 2));
  console.log(`trace written to ${out}`);
}
