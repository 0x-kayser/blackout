/**
 * Hot Desk dilemma calls from Vesper's civic and industrial leaders.
 *
 * Design invariants:
 * 1. Pure & deterministic: triggered strictly from `s.interval`, `s.onboarding.done`, and `s.mode === "live"`.
 * 2. Double-entry conservation: every credit movement uses `rtransfer` / `rtransferUpTo` between `RACC.player`
 *    and existing region accounts (`RACC.actor(...)`, `RACC.treasury`). No raw items are conjured or destroyed.
 * 3. Weekly challenge fairness: disabled when `s.mode === "challenge"` so leaderboard runs remain identical.
 */
import type { HotDeskCallView, NodeId } from "@blackout/shared";
import { SimError } from "../state.ts";
import { cr, emit } from "./events.ts";
import { RACC, rbal, rtransfer, rtransferUpTo, type RCtx, type RegionState } from "./state.ts";

export interface HotDeskSpec {
  callId: string;
  minInterval: number;
  person: string;
  face: string;
  role: string;
  actorId: string | null;
  nodeId: NodeId;
  title: string;
  message: string;
  acceptLabel: string;
  acceptEffect: string;
  declineLabel: string;
  declineEffect: string;
  needPlayerCc: number;
  needActorCc?: { actorId: string; minCc: number };
}

export const HOT_DESK_TTL_INTERVALS = 36;

export const HOT_DESK_CALLS: readonly HotDeskSpec[] = [
  {
    callId: "petrov_stabilizer",
    minInterval: 18,
    person: "Dr. Nadia Petrov",
    face: "👩🏻‍⚕️",
    role: "Chief of Medicine, St. Aurelia General",
    actorId: "hospital",
    nodeId: "hospital",
    title: "St. Aurelia surgical wing voltage drop",
    message:
      "Hormuz diesel delays have our backup generators rationing fuel. Underwrite ₡15,000 for hospital voltage stabilizers today? The Regulator will credit your reliability record and clear one compliance warning.",
    acceptLabel: "Fund stabilizers (−₡15,000)",
    acceptEffect: "₡15,000 → St. Aurelia General · Hospital health +8% · Clears 1 Regulator warning",
    declineLabel: "Hold cash reserve",
    declineEffect: "No cash spent · St. Aurelia rations non-urgent clinic lighting (−2% health)",
    needPlayerCc: 1_500_000,
  },
  {
    callId: "marta_furnace_retainer",
    minInterval: 54,
    person: "Marta Ivanova",
    face: "👩🏻‍🏭",
    role: "Owner, Ivanova Steel Works",
    actorId: "steel",
    nodeId: "industrial_south",
    title: "Ivanova Steel night-shift retainer",
    message:
      "Cape-route freight surcharges have Pavel's steel yard backed up, and my arc furnaces cannot afford another mid-pour trip. Ivanova Steel will prepay ₡25,000 from our reserve right now if you commit to keeping Industrial South priority-lit.",
    acceptLabel: "Accept retainer (+₡25,000)",
    acceptEffect: "+₡25,000 from Ivanova Steel · Steel Works output +6% and health +4%",
    declineLabel: "Pass on retainer",
    declineEffect: "No cash transfer · Marta holds back flexible furnace load (−3% output)",
    needPlayerCc: 0,
    needActorCc: { actorId: "steel", minCc: 500_000 },
  },
  {
    callId: "delgado_cold_berth",
    minInterval: 96,
    person: "Rosa Delgado",
    face: "👩🏽‍✈️",
    role: "Harbour Master, Vesper Container Port",
    actorId: "port",
    nodeId: "port",
    title: "Rerouted Cape-convoy reefer surge",
    message:
      "Three rerouted Cape-route vessels just berthed at Vesper Port and Harbor Cold Chain's reefers are redlining. Co-fund ₡20,000 for dockside feeder cooling? The COP31 Transition Fund will reimburse ₡32,000 from the regional treasury.",
    acceptLabel: "Co-fund dock cooling (net +₡12,000)",
    acceptEffect: "₡20,000 → Port · ₡32,000 COP31 grant → You (net +₡12,000) · Port & Cold Chain health +6%",
    declineLabel: "Decline co-funding",
    declineEffect: "No cash spent · Port reefer queues clear slowly (−2.5% Cold Chain health)",
    needPlayerCc: 2_000_000,
  },
  {
    callId: "obi_night_market",
    minInterval: 144,
    person: "Amara Obi",
    face: "👩🏿‍💼",
    role: "Chair, Central City Chamber of Commerce",
    actorId: "commerce",
    nodeId: "central_city",
    title: "Central City evening market pact",
    message:
      "Shopkeepers from Market Quarter to Central City pooled ₡18,000 to keep evening street lights and cold rooms running instead of paying VoltLine's peak markup. Accept the Chamber's illumination retainer?",
    acceptLabel: "Sign market pact (+₡18,000)",
    acceptEffect: "+₡18,000 from Central City Commerce · Commerce & Household health +5%",
    declineLabel: "Decline pact",
    declineEffect: "No cash transfer · Evening stalls shutter early at dusk (−3% commerce output)",
    needPlayerCc: 0,
    needActorCc: { actorId: "commerce", minCc: 500_000 },
  },
];

export function ensureHotDesk(s: RegionState): { activeCallId: string | null; activeSince: number; resolved: string[] } {
  s.hotDesk ??= { activeCallId: null, activeSince: 0, resolved: [] };
  return s.hotDesk;
}

export function hotDeskStep(s: RegionState, _ctx: RCtx): void {
  if (s.mode === "challenge" || !s.onboarding.done) return;
  const hd = ensureHotDesk(s);
  if (hd.activeCallId) {
    if (s.interval - hd.activeSince >= HOT_DESK_TTL_INTERVALS) {
      hd.resolved.push(hd.activeCallId);
      hd.activeCallId = null;
    }
    return;
  }
  const next = HOT_DESK_CALLS.find(
    (c) => !hd.resolved.includes(c.callId) && s.interval >= c.minInterval,
  );
  if (next) {
    hd.activeCallId = next.callId;
    hd.activeSince = s.interval;
  }
}

export function answerHotDesk(
  s: RegionState,
  ctx: RCtx,
  callId: string,
  choice: "accept" | "decline",
): { message: string } {
  if (s.mode === "challenge") {
    throw new SimError("INVALID_STATE", "Hot Desk calls are disabled during scored weekly crisis runs.");
  }
  const hd = ensureHotDesk(s);
  if (hd.activeCallId !== callId) {
    throw new SimError("NOT_FOUND", "That Hot Desk call is no longer on the line.");
  }
  const spec = HOT_DESK_CALLS.find((c) => c.callId === callId);
  if (!spec) {
    throw new SimError("NOT_FOUND", "Unknown Hot Desk call.");
  }

  if (choice === "accept") {
    if (spec.needPlayerCc > 0 && rbal(s, "cc", RACC.player) < spec.needPlayerCc) {
      throw new SimError(
        "INSUFFICIENT_CREDITS",
        `Needs ${cr(spec.needPlayerCc)} in company cash; you have ${cr(rbal(s, "cc", RACC.player))}.`,
      );
    }
    if (spec.needActorCc && rbal(s, "cc", RACC.actor(spec.needActorCc.actorId)) < spec.needActorCc.minCc) {
      throw new SimError("REQUIREMENT_NOT_MET", `${spec.person}'s reserve is too low to fund that retainer right now.`);
    }

    switch (spec.callId) {
      case "petrov_stabilizer": {
        const amt = 1_500_000;
        rtransfer(s, ctx, "cc", RACC.player, RACC.actor("hospital"), amt, "St. Aurelia voltage stabilizers");
        s.player.profitCcToday -= amt;
        s.player.profitCcTotal -= amt;
        if (s.actors.hospital) {
          s.actors.hospital.healthBps = Math.min(10_000, s.actors.hospital.healthBps + 800);
        }
        s.regulator.warnings = Math.max(0, s.regulator.warnings - 1);
        s.player.servedShareWindow.push(10_000);
        if (s.player.servedShareWindow.length > 48) s.player.servedShareWindow.shift();
        emit(s, ctx, {
          type: "HOT_DESK_RESOLVED",
          severity: "good",
          title: `You funded St. Aurelia General's voltage stabilizers (${cr(amt)})`,
          detail: "Surgical cold rooms are stabilised and the Regulator credited your reliability record.",
          nodeId: "hospital",
          actorId: "hospital",
          quote: { person: spec.person, face: spec.face, text: "Our incubators and theatre monitors are holding steady. Thank you." },
        });
        hd.resolved.push(callId);
        hd.activeCallId = null;
        return { message: `Funded St. Aurelia stabilizers (${cr(amt)}). Regulator warning cleared.` };
      }
      case "marta_furnace_retainer": {
        const paid = rtransferUpTo(s, ctx, "cc", RACC.actor("steel"), RACC.player, 2_500_000, "Ivanova Steel night-shift retainer");
        s.player.profitCcToday += paid;
        s.player.profitCcTotal += paid;
        s.player.revenueCcToday += paid;
        if (s.actors.steel) {
          s.actors.steel.productionBps = Math.min(10_000, s.actors.steel.productionBps + 600);
          s.actors.steel.healthBps = Math.min(10_000, s.actors.steel.healthBps + 400);
        }
        emit(s, ctx, {
          type: "HOT_DESK_RESOLVED",
          severity: "good",
          title: `Ivanova Steel paid a ${cr(paid)} priority dispatch retainer`,
          detail: "Marta's arc furnaces stay on full shift in Industrial South.",
          nodeId: "industrial_south",
          actorId: "steel",
          quote: { person: spec.person, face: spec.face, text: "The furnaces stay hot tonight. Keep the Southern Trunk flowing." },
        });
        hd.resolved.push(callId);
        hd.activeCallId = null;
        return { message: `Received ${cr(paid)} retainer from Marta Ivanova.` };
      }
      case "delgado_cold_berth": {
        const cost = 2_000_000;
        rtransfer(s, ctx, "cc", RACC.player, RACC.actor("port"), cost, "Port reefer feeder cooling");
        const grant = rtransferUpTo(s, ctx, "cc", RACC.treasury, RACC.player, 3_200_000, "COP31 Green Port resilience grant");
        const net = grant - cost;
        s.player.profitCcToday += net;
        s.player.profitCcTotal += net;
        if (grant > 0) s.player.revenueCcToday += grant;
        if (s.actors.port) s.actors.port.healthBps = Math.min(10_000, s.actors.port.healthBps + 600);
        if (s.actors.coldchain) s.actors.coldchain.healthBps = Math.min(10_000, s.actors.coldchain.healthBps + 600);
        emit(s, ctx, {
          type: "HOT_DESK_RESOLVED",
          severity: "good",
          title: `Port reefer cooling online · COP31 grant paid ${cr(grant)}`,
          detail: `You advanced ${cr(cost)} to Vesper Port and received ${cr(grant)} from the COP31 Transition Fund.`,
          nodeId: "port",
          actorId: "port",
          quote: { person: spec.person, face: spec.face, text: "The Cape-route reefer stacks are humming. Not a single crate spoiled." },
        });
        hd.resolved.push(callId);
        hd.activeCallId = null;
        return { message: `Port cooling funded: net +${cr(net)} after COP31 grant.` };
      }
      case "obi_night_market": {
        const paid = rtransferUpTo(s, ctx, "cc", RACC.actor("commerce"), RACC.player, 1_800_000, "Central City evening market pact");
        s.player.profitCcToday += paid;
        s.player.profitCcTotal += paid;
        s.player.revenueCcToday += paid;
        if (s.actors.commerce) s.actors.commerce.healthBps = Math.min(10_000, s.actors.commerce.healthBps + 600);
        if (s.actors.central_homes) s.actors.central_homes.healthBps = Math.min(10_000, s.actors.central_homes.healthBps + 400);
        emit(s, ctx, {
          type: "HOT_DESK_RESOLVED",
          severity: "good",
          title: `Central City Chamber signed a ${cr(paid)} evening illumination pact`,
          detail: "Market stalls and night clinics stay lit across the city centre.",
          nodeId: "central_city",
          actorId: "commerce",
          quote: { person: spec.person, face: spec.face, text: "Every stall in Central City is lit tonight, and VoltLine didn't get a cent of gouge money." },
        });
        hd.resolved.push(callId);
        hd.activeCallId = null;
        return { message: `Signed Central City pact (+${cr(paid)}).` };
      }
    }
  } else {
    switch (spec.callId) {
      case "petrov_stabilizer":
        if (s.actors.hospital) s.actors.hospital.healthBps = Math.max(2_000, s.actors.hospital.healthBps - 200);
        break;
      case "marta_furnace_retainer":
        if (s.actors.steel) s.actors.steel.productionBps = Math.max(5_000, s.actors.steel.productionBps - 300);
        break;
      case "delgado_cold_berth":
        if (s.actors.coldchain) s.actors.coldchain.healthBps = Math.max(2_000, s.actors.coldchain.healthBps - 250);
        break;
      case "obi_night_market":
        if (s.actors.commerce) s.actors.commerce.productionBps = Math.max(6_000, s.actors.commerce.productionBps - 300);
        break;
    }
    emit(s, ctx, {
      type: "HOT_DESK_RESOLVED",
      severity: "info",
      title: `You passed on ${spec.person}'s Hot Desk request`,
      detail: spec.declineEffect,
      nodeId: spec.nodeId,
      actorId: spec.actorId,
    });
    hd.resolved.push(callId);
    hd.activeCallId = null;
    return { message: `Declined ${spec.person}'s request.` };
  }
  return { message: "Call resolved." };
}

export function toHotDeskView(s: RegionState): HotDeskCallView | null {
  if (s.mode === "challenge" || !s.onboarding.done || !s.hotDesk?.activeCallId) return null;
  const spec = HOT_DESK_CALLS.find((c) => c.callId === s.hotDesk!.activeCallId);
  if (!spec) return null;
  const playerCash = rbal(s, "cc", RACC.player);
  let canAccept = true;
  let cannotAcceptReason: string | null = null;
  if (spec.needPlayerCc > 0 && playerCash < spec.needPlayerCc) {
    canAccept = false;
    cannotAcceptReason = `Needs ${cr(spec.needPlayerCc)} cash (you have ${cr(playerCash)}).`;
  } else if (spec.needActorCc && rbal(s, "cc", RACC.actor(spec.needActorCc.actorId)) < spec.needActorCc.minCc) {
    canAccept = false;
    cannotAcceptReason = `${spec.person}'s cash reserve is currently too low.`;
  }
  return {
    callId: spec.callId,
    person: spec.person,
    face: spec.face,
    role: spec.role,
    actorId: spec.actorId,
    nodeId: spec.nodeId,
    title: spec.title,
    message: spec.message,
    acceptLabel: spec.acceptLabel,
    acceptEffect: spec.acceptEffect,
    declineLabel: spec.declineLabel,
    declineEffect: spec.declineEffect,
    canAccept,
    cannotAcceptReason,
    expiresAtInterval: s.hotDesk.activeSince + HOT_DESK_TTL_INTERVALS,
  };
}
