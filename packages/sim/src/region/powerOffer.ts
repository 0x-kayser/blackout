/**
 * What a player's company offers Vesper's NPC companies on the power desk: the capacity its working plants have
 * spare right now (beyond what the region's own market took and what it already sold), at an ask that covers its
 * running cost and beats selling into its own grid.
 *
 *   spare kW  =  Σ over the player's online gas, diesel and battery plants of (available − dispatched)
 *               − power already sold for the coming window
 *   ask       =  the higher of (the dearest marginal cost among those plants) and (the price at its node), plus the
 *               player's markup (default 15%)
 *
 * A player whose grid is short offers nothing: the desk never takes power the region needs.
 */
import { TECHS } from "./config.ts";
import { fuelMarketCc } from "./economy.ts";
import { marginalCost } from "./physics.ts";
import type { RegionState } from "./state.ts";

export function regionPowerOffer(s: RegionState, markupBps = 1_500): { kw: number; priceCcPerMWh: number; why: string } {
  if (s.pulse.shedKw > 0) return { kw: 0, priceCcPerMWh: 0, why: "Your own region is short of power." };
  let spare = 0;
  let mc = 0;
  let node: string | null = null;
  for (const p of s.plants) {
    if (p.ownerId !== "player" || p.status !== "online" || p.tech === "solar") continue;
    const free = Math.max(0, (p.lastAvailKw ?? 0) - p.outputKw);
    if (free <= 0) continue;
    spare += free;
    const t = TECHS[p.tech];
    mc = Math.max(mc, marginalCost(s, p, t.fuel ? fuelMarketCc(s, t.fuel) : 0).totalCc);
    node ??= p.nodeId;
  }
  const sold = (s.exports ?? []).filter((x) => x.untilInterval > s.interval).reduce((a, x) => a + x.kw, 0);
  const kw = Math.floor(Math.max(0, spare - sold) / 100) * 100;
  if (kw <= 0) return { kw: 0, priceCcPerMWh: 0, why: "No spare capacity right now." };
  const spot = node ? s.nodes[node as keyof typeof s.nodes].priceCc : 0;
  const base = Math.max(mc, spot);
  const price = Math.round(base * (1 + markupBps / 10_000));
  return { kw, priceCcPerMWh: price, why: `${Math.round(kw / 1000)} MW spare. ${base === spot ? "Your grid pays" : "It costs you"} ₡${Math.round(base / 100)}/MWh, plus ${Math.round(markupBps / 100)}%.` };
}
