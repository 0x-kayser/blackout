/**
 * Deterministic market clearing (§6, §7). Pure: same input → same output, no clock, no randomness.
 *
 * Model: a welfare-maximising transport market over the region's corridors. Generation offers sell into their node,
 * load bids buy at theirs, corridors carry up to their limit in either direction. On BLACKOUT's radial (tree) network
 * this is exactly a DC power flow, so flows are physical, not a routing guess.
 *
 * Solve: successive shortest paths (Bellman-Ford) on a min-cost-flow graph, all in integer kW and cc/MWh:
 *   S → node      one arc per offer segment, cost = offer price (the committed minimum block is offered at 0)
 *   node ↔ node   one arc each way per corridor, cost 0, capacity = limit
 *   node → T      one arc per bid, cost = −willingness to pay
 * Augment while a path with negative cost exists (a trade that adds welfare).
 *
 * Nodal price = the cheapest way to serve one more kW at that node in the final residual graph: another kW from an
 * offer that still has room (through corridors that still have room), or a kW taken from the lowest-value load that is
 * being served (the scarcity price). Capped at the regulator's price cap. Ties break by input order, so results are
 * stable across runs.
 */
import type { GenerationOffer, LoadBid, PriorityClass } from "@blackout/shared";

export interface ClearingCorridor {
  corridorId: string;
  from: string;
  to: string;
  limitMW: number;
}

export interface ClearingInput {
  nodes: readonly string[];
  corridors: readonly ClearingCorridor[];
  offers: readonly GenerationOffer[];
  bids: readonly LoadBid[];
  priceCapPerMWh: number;
  referenceNode: string;
}

export interface MarginalUnit {
  kind: "plant" | "load" | "cap" | "none";
  id: string | null;
}

export interface ClearingResult {
  /** MW dispatched per plant. */
  dispatchMW: Record<string, number>;
  /** MW served per load bid. */
  servedMW: Record<string, number>;
  /** Signed MW per corridor, positive = from → to. */
  flowMW: Record<string, number>;
  congested: string[];
  priceByNode: Record<string, number>;
  marginalByNode: Record<string, MarginalUnit>;
  /** Unserved MW per node of bids that are not flexible (load shed = blackout). */
  shedMW: Record<string, number>;
  /** Unserved MW per node of flexible bids (customers chose not to buy at the price). */
  curtailedMW: Record<string, number>;
  systemPrice: number;
  welfare: number;
}

interface Arc {
  to: number;
  cap: number;
  cost: number;
  rev: number;
  /** Bookkeeping: what this arc represents. */
  tag: { kind: "offer"; i: number } | { kind: "bid"; i: number } | { kind: "line"; i: number; dir: 1 | -1 } | { kind: "rev" } | { kind: "curtail"; i: number };
}

const toKw = (mw: number) => Math.max(0, Math.round(mw * 1000));
const FLEXIBLE: ReadonlySet<PriorityClass> = new Set(["flexible", "storage"]);

export function clearMarket(input: ClearingInput): ClearingResult {
  const nodeIndex = new Map<string, number>();
  input.nodes.forEach((n, i) => nodeIndex.set(n, i + 2));
  const S = 0;
  const T = 1;
  const V = input.nodes.length + 2;
  const g: Arc[][] = Array.from({ length: V }, () => []);
  const addArc = (from: number, to: number, cap: number, cost: number, tag: Arc["tag"]): void => {
    g[from].push({ to, cap, cost, rev: g[to].length, tag });
    g[to].push({ to: from, cap: 0, cost: -cost, rev: g[from].length - 1, tag: { kind: "rev" } });
  };
  const nodeOf = (id: string): number => {
    const n = nodeIndex.get(id);
    if (n === undefined) throw new Error(`unknown node ${id}`);
    return n;
  };

  // offer segments: committed minimum at 0 (must-run), the rest at the offer price
  const offerSeg: { offer: number; arcFrom: number; arcIdx: number; kw: number }[] = [];
  input.offers.forEach((o, i) => {
    const avail = toKw(o.availableMW);
    const min = Math.min(avail, toKw(o.minimumMW));
    const n = nodeOf(o.nodeId);
    const price = Math.round(o.offerPricePerMWh);
    if (min > 0) {
      offerSeg.push({ offer: i, arcFrom: S, arcIdx: g[S].length, kw: min });
      addArc(S, n, min, Math.min(0, price), { kind: "offer", i });
    }
    if (avail - min > 0) {
      offerSeg.push({ offer: i, arcFrom: S, arcIdx: g[S].length, kw: avail - min });
      addArc(S, n, avail - min, price, { kind: "offer", i });
    }
  });
  const bidArcs: { from: number; idx: number }[] = [];
  input.bids.forEach((b, i) => {
    const n = nodeOf(b.nodeId);
    bidArcs.push({ from: n, idx: g[n].length });
    addArc(n, T, toKw(b.requestedMW), -Math.round(b.willingnessToPayPerMWh), { kind: "bid", i });
  });
  const lineArcs: { fwd: { from: number; idx: number }; back: { from: number; idx: number } }[] = [];
  input.corridors.forEach((c, i) => {
    const a = nodeOf(c.from);
    const b = nodeOf(c.to);
    const lim = toKw(c.limitMW);
    const fwd = { from: a, idx: g[a].length };
    addArc(a, b, lim, 0, { kind: "line", i, dir: 1 });
    const back = { from: b, idx: g[b].length };
    addArc(b, a, lim, 0, { kind: "line", i, dir: -1 });
    lineArcs.push({ fwd, back });
  });

  const bellmanFord = (src: number, extra?: (relax: (from: number, to: number, cost: number, ref: PrevRef) => void) => void) => {
    const dist = new Array<number>(V).fill(Infinity);
    const prev: (PrevRef | null)[] = new Array(V).fill(null);
    dist[src] = 0;
    for (let iter = 0; iter < V; iter++) {
      let changed = false;
      for (let u = 0; u < V; u++) {
        if (dist[u] === Infinity) continue;
        const arcs = g[u];
        for (let k = 0; k < arcs.length; k++) {
          const a = arcs[k];
          if (a.cap <= 0) continue;
          const nd = dist[u] + a.cost;
          if (nd < dist[a.to]) {
            dist[a.to] = nd;
            prev[a.to] = { from: u, arc: k };
            changed = true;
          }
        }
      }
      if (extra) {
        extra((from, to, cost, ref) => {
          if (dist[from] === Infinity) return;
          const nd = dist[from] + cost;
          if (nd < dist[to]) {
            dist[to] = nd;
            prev[to] = ref;
            changed = true;
          }
        });
      }
      if (!changed) break;
    }
    return { dist, prev };
  };

  // successive shortest paths
  let welfareCcPerMWhKw = 0;
  for (let guard = 0; guard < 10_000; guard++) {
    const { dist, prev } = bellmanFord(S);
    if (!(dist[T] < 0)) break;
    let bottleneck = Infinity;
    for (let v = T; v !== S; ) {
      const p = prev[v]!;
      bottleneck = Math.min(bottleneck, g[p.from][p.arc].cap);
      v = p.from;
    }
    if (!(bottleneck > 0) || bottleneck === Infinity) break;
    for (let v = T; v !== S; ) {
      const p = prev[v]!;
      const a = g[p.from][p.arc];
      a.cap -= bottleneck;
      g[a.to][a.rev].cap += bottleneck;
      v = p.from;
    }
    welfareCcPerMWhKw += -dist[T] * bottleneck;
  }

  // read the solution
  const dispatchKw: Record<string, number> = {};
  for (const o of input.offers) dispatchKw[o.plantId] = 0;
  for (const seg of offerSeg) {
    const a = g[seg.arcFrom][seg.arcIdx];
    dispatchKw[input.offers[seg.offer].plantId] += seg.kw - a.cap;
  }
  const servedKw: number[] = input.bids.map((b, i) => toKw(b.requestedMW) - g[bidArcs[i].from][bidArcs[i].idx].cap);
  const flowKw: number[] = input.corridors.map((c, i) => {
    const lim = toKw(c.limitMW);
    const f = lim - g[lineArcs[i].fwd.from][lineArcs[i].fwd.idx].cap;
    const b = lim - g[lineArcs[i].back.from][lineArcs[i].back.idx].cap;
    return f - b;
  });

  // nodal prices: shortest residual path from S to each node, where S may also "free" a kW by curtailing a served
  // bid anywhere (cost = that bid's willingness to pay). The extra arcs are virtual and never carry flow.
  const served = input.bids.map((b, i) => ({ b, i, kw: servedKw[i] })).filter((x) => x.kw > 0);
  const { dist, prev } = bellmanFord(S, (relax) => {
    for (const x of served) relax(S, nodeOf(x.b.nodeId), Math.round(x.b.willingnessToPayPerMWh), { from: S, arc: -1, curtail: x.i });
  });
  const cap = Math.round(input.priceCapPerMWh);
  const priceByNode: Record<string, number> = {};
  const marginalByNode: Record<string, MarginalUnit> = {};
  for (const n of input.nodes) {
    const v = nodeOf(n);
    const d = dist[v];
    if (d === Infinity || d >= cap) {
      priceByNode[n] = cap;
      marginalByNode[n] = { kind: "cap", id: null };
      continue;
    }
    priceByNode[n] = Math.max(0, d);
    // walk back to the first arc out of S: that unit sets the price here
    let w = v;
    let first: PrevRef | null = null;
    for (let hops = 0; hops < V + 2 && w !== S; hops++) {
      const p = prev[w];
      if (!p) break;
      first = p;
      w = p.from;
    }
    if (first && first.curtail !== undefined) marginalByNode[n] = { kind: "load", id: input.bids[first.curtail].loadId };
    else if (first && first.arc >= 0) {
      const tag = g[S][first.arc].tag;
      marginalByNode[n] = tag.kind === "offer" ? { kind: "plant", id: input.offers[tag.i].plantId } : { kind: "none", id: null };
    } else marginalByNode[n] = { kind: "none", id: null };
  }

  const shedKw: Record<string, number> = {};
  const curtailedKw: Record<string, number> = {};
  for (const n of input.nodes) {
    shedKw[n] = 0;
    curtailedKw[n] = 0;
  }
  input.bids.forEach((b, i) => {
    const un = toKw(b.requestedMW) - servedKw[i];
    if (un <= 0) return;
    if (FLEXIBLE.has(b.priorityClass)) curtailedKw[b.nodeId] += un;
    else shedKw[b.nodeId] += un;
  });

  const kwToMw = (kw: number) => kw / 1000;
  const congested = input.corridors.filter((c, i) => Math.abs(flowKw[i]) >= toKw(c.limitMW) && toKw(c.limitMW) > 0).map((c) => c.corridorId);
  return {
    dispatchMW: Object.fromEntries(Object.entries(dispatchKw).map(([k, v]) => [k, kwToMw(v)])),
    servedMW: Object.fromEntries(input.bids.map((b, i) => [b.loadId, kwToMw(servedKw[i])])),
    flowMW: Object.fromEntries(input.corridors.map((c, i) => [c.corridorId, kwToMw(flowKw[i])])),
    congested,
    priceByNode,
    marginalByNode,
    shedMW: Object.fromEntries(Object.entries(shedKw).map(([k, v]) => [k, kwToMw(v)])),
    curtailedMW: Object.fromEntries(Object.entries(curtailedKw).map(([k, v]) => [k, kwToMw(v)])),
    systemPrice: priceByNode[input.referenceNode] ?? cap,
    welfare: welfareCcPerMWhKw / 1000,
  };
}

interface PrevRef {
  from: number;
  arc: number;
  curtail?: number;
}
