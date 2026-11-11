/**
 * Settlement epochs (§15, §28, §29). The simulation runs fast and off-chain; every EPOCH_INTERVALS it closes an
 * epoch: the net credit movement of every on-chain identity since the last epoch, each Plant Asset's owner and
 * lifetime record, and a SHA-256 over the canonical summary. Nets always sum to zero because the ledger is
 * double-entry; everything outside the chain identities (businesses, households, the outside economy) nets into the
 * treasury. The API stores each epoch once (unique epochId) and the contract rejects a settlement id it has seen.
 */
import { createHash } from "node:crypto";
import { BANKS, EPOCH_INTERVALS, SUPPLIERS, TOWN_UNITS } from "./config.ts";
import type { REpoch, RegionState } from "./state.ts";

const SUPPLIER_CHAIN = Object.fromEntries(SUPPLIERS.map((c) => [`supplier:${c.supplierId}`, c.chainName]));
const BANK_CHAIN = Object.fromEntries(BANKS.map((b) => [`bank:${b.bankId}`, b.chainName]));

/** Which on-chain identity holds a ledger account (§22). */
export function chainIdentity(acct: string): string {
  // trades at Vesper Market and payments for power sold to its companies settle on their own (market epochs and
  // NEAR escrow), so inside a region they count as the player's own money moving, never as a second payment
  if (acct === "player" || acct === "ext:town" || acct === "ext:contracts") return "player";
  if (acct === "owner:voltline") return "voltline";
  if (acct === "market" || acct === "grid") return "market";
  if (acct === "regulator") return "regulator";
  if (SUPPLIER_CHAIN[acct]) return SUPPLIER_CHAIN[acct];
  if (BANK_CHAIN[acct]) return BANK_CHAIN[acct];
  return "treasury";
}

function identityTotals(balances: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [acct, v] of Object.entries(balances)) {
    const id = chainIdentity(acct);
    out[id] = (out[id] ?? 0) + v;
  }
  return out;
}

/** Canonical JSON: sorted keys, no whitespace. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function maybeCloseEpoch(s: RegionState, force = false): REpoch | null {
  if (!force && s.interval - s.epochStart.interval < EPOCH_INTERVALS) return null;
  if (force && s.interval === s.epochStart.interval) return null;
  const before = identityTotals(s.epochStart.balances);
  const after = identityTotals(s.balances.cc);
  const ids = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const transfers = ids.map((account) => ({ account, deltaCc: (after[account] ?? 0) - (before[account] ?? 0) })).filter((t) => t.deltaCc !== 0);
  // A resource epoch records gameplay consumption separately from Vesper Market trades. Market buys and sells are
  // settled from TownEpoch; subtracting TOWN_SETTLE flows here prevents the same item movement settling twice.
  // The first epoch from a pre-upgrade snapshot has no resource baseline, so establish one without emitting a delta.
  const hasResourceBaseline = !!s.epochStart.resourceBalances && !!s.epochStart.townItemFlow;
  const resourceChanges = hasResourceBaseline
    ? Object.entries(TOWN_UNITS).map(([token, unit]) => {
        const start = Math.floor((s.epochStart.resourceBalances?.[token] ?? 0) / unit.per);
        const end = Math.floor((s.balances[unit.asset]?.player ?? 0) / unit.per);
        const market = (s.townItemFlow?.[token as keyof typeof s.townItemFlow] ?? 0) - (s.epochStart.townItemFlow?.[token as keyof typeof s.epochStart.townItemFlow] ?? 0);
        return { token, delta: end - start - market };
      }).filter((x) => x.delta !== 0)
    : [];
  const epochNo = (s.epochs.at(-1)?.epochNo ?? 0) + 1;
  const epochId = `${s.regionId}:${epochNo}`;
  const plants = s.plants
    .filter((p) => p.status !== "building")
    .map((p) => ({ assetId: `p${String(p.assetNo).padStart(5, "0")}`, ownerId: p.ownerId, lifetimeKwh: p.lifetimeKwh, lifetimeRevenueCc: p.lifetimeRevenueCc, status: p.status }));
  const stateDigest = sha256(canonical({ interval: s.interval, balances: s.balances, plants: s.plants.map((p) => [p.plantId, p.ownerId, p.status, p.socKwh]) }));
  const body = { epochId, fromInterval: s.epochStart.interval, toInterval: s.interval, transfers, resourceChanges, plants, stateDigest };
  const epoch: REpoch = { epochNo, ...body, hash: sha256(canonical(body)) };
  s.epochs.push(epoch);
  if (s.epochs.length > 24) s.epochs.splice(0, s.epochs.length - 24);
  s.epochStart = {
    interval: s.interval,
    balances: { ...s.balances.cc },
    resourceBalances: Object.fromEntries(Object.entries(TOWN_UNITS).map(([token, unit]) => [token, s.balances[unit.asset]?.player ?? 0])),
    townItemFlow: { ...(s.townItemFlow ?? {}) },
  };
  return epoch;
}

/** Closes an epoch now, so a wallet opening starts on a clean boundary. Returns the boundary interval. */
export function forceCloseEpoch(s: RegionState): number {
  maybeCloseEpoch(s, true);
  return s.epochStart.interval;
}

/** Recomputes an epoch's hash from its body: what Verify uses. */
export function verifyEpoch(e: REpoch): boolean {
  const { hash, epochNo, ...body } = e;
  void epochNo;
  return sha256(canonical(body)) === hash && e.transfers.reduce((a, t) => a + t.deltaCc, 0) === 0;
}
