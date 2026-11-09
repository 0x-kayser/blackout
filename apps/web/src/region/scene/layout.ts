/**
 * Deterministic world layout: every client draws the same region. Positions are world units (x east, z south);
 * node centres come from the server's NodeView.
 */
import type { NodeId } from '@blackout/shared'

export type Vec2 = [number, number]

/** Tiny seeded RNG so layouts never change between reloads. */
export function rng(seedText: string) {
  let h = 2166136261
  for (const ch of seedText) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
  return () => {
    h = (h + 0x6d2b79f5) >>> 0
    let t = h
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Building {
  x: number
  z: number
  w: number
  d: number
  h: number
  rot: number
  tint: number
}

export interface DistrictStyle {
  ground: string
  radius: number
  kind: 'towers' | 'houses' | 'industry' | 'port' | 'campus' | 'hospital' | 'farms'
  count: number
}

export const DISTRICT: Record<NodeId, DistrictStyle> = {
  north_solar: { ground: '#6f7f45', radius: 30, kind: 'farms', count: 18 },
  central_city: { ground: '#4a4f5a', radius: 26, kind: 'towers', count: 46 },
  industrial_south: { ground: '#5d5246', radius: 26, kind: 'industry', count: 14 },
  port: { ground: '#5b6068', radius: 24, kind: 'port', count: 70 },
  tech_corridor: { ground: '#3f5a5c', radius: 24, kind: 'campus', count: 12 },
  hospital: { ground: '#5c6470', radius: 18, kind: 'hospital', count: 22 },
  residential_east: { ground: '#4f6a45', radius: 26, kind: 'houses', count: 110 },
}

/** Buildings scattered in a disc around the node, keeping the plant ring clear. */
export function districtBuildings(nodeId: NodeId, cx: number, cz: number): Building[] {
  const st = DISTRICT[nodeId]
  const r = rng(`district:${nodeId}`)
  const out: Building[] = []
  let guard = 0
  while (out.length < st.count && guard++ < st.count * 40) {
    const a = r() * Math.PI * 2
    const dist = Math.sqrt(r()) * st.radius * (st.kind === 'towers' ? 0.85 : 1)
    const x = cx + Math.cos(a) * dist
    const z = cz + Math.sin(a) * dist
    let b: Building
    switch (st.kind) {
      case 'towers': {
        const central = 1 - dist / st.radius
        b = { x, z, w: 3 + r() * 3, d: 3 + r() * 3, h: 6 + central * 26 + r() * 10, rot: 0, tint: r() }
        break
      }
      case 'houses':
        b = { x, z, w: 1.8 + r() * 0.8, d: 1.8 + r() * 0.8, h: 1.4 + r() * 0.8, rot: Math.round(r() * 3) * (Math.PI / 2), tint: r() }
        break
      case 'industry':
        b = { x, z, w: 6 + r() * 6, d: 4 + r() * 4, h: 3 + r() * 4, rot: r() < 0.5 ? 0 : Math.PI / 2, tint: r() }
        break
      case 'port':
        b = { x, z, w: 2.6, d: 1.1, h: 1.1 + Math.floor(r() * 3) * 1.1, rot: r() < 0.6 ? 0 : Math.PI / 2, tint: r() }
        break
      case 'campus':
        b = { x, z, w: 6 + r() * 5, d: 4 + r() * 4, h: 2.5 + r() * 5, rot: r() * Math.PI, tint: r() }
        break
      case 'hospital':
        b = { x, z, w: 2.5 + r() * 2, d: 2.5 + r() * 2, h: 2 + r() * 3, rot: 0, tint: r() }
        break
      case 'farms':
        b = { x, z, w: 2 + r(), d: 2 + r(), h: 1.5 + r(), rot: r() * Math.PI, tint: r() }
        break
    }
    if (out.some((o) => Math.hypot(o.x - b.x, o.z - b.z) < (Math.max(o.w, o.d) + Math.max(b.w, b.d)) * 0.55)) continue
    // keep the landmark spot in the middle free for the headline business
    if (Math.hypot(x - cx, z - cz) < (st.kind === 'houses' ? 3 : 6)) continue
    out.push(b)
  }
  return out
}

/** Where plant `index` of `count` at a node sits: on a ring outside the district. */
export function plantPad(cx: number, cz: number, nodeId: NodeId, index: number): Vec2 {
  const st = DISTRICT[nodeId]
  const base = { north_solar: -0.4, central_city: 2.2, industrial_south: 3.6, port: 5.2, tech_corridor: 0.9, hospital: 4.3, residential_east: 0.2 }[nodeId]
  const ring = st.radius + 10 + Math.floor(index / 5) * 12
  const a = base + (index % 5) * 0.62
  return [cx + Math.cos(a) * ring, cz + Math.sin(a) * ring]
}

/** Empty build pads at a node (for BUILD mode), after the existing plants. */
export function buildPads(cx: number, cz: number, nodeId: NodeId, used: number): Vec2[] {
  return [0, 1, 2].map((i) => plantPad(cx, cz, nodeId, used + i))
}

/** Line route between two nodes: a gentle arc with tower positions. */
export function lineRoute(a: Vec2, b: Vec2, id: string): { points: [number, number, number][]; towers: Vec2[] } {
  const r = rng(`line:${id}`)
  const mx = (a[0] + b[0]) / 2
  const mz = (a[1] + b[1]) / 2
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const len = Math.hypot(dx, dz)
  const bend = (r() - 0.5) * len * 0.18
  const cx = mx + (-dz / len) * bend
  const cz = mz + (dx / len) * bend
  const n = Math.max(4, Math.round(len / 11))
  const towers: Vec2[] = []
  const points: [number, number, number][] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const x = (1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * cx + t * t * b[0]
    const z = (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * cz + t * t * b[1]
    towers.push([x, z])
  }
  // wires sag between towers
  for (let i = 0; i < towers.length - 1; i++) {
    const [x0, z0] = towers[i]
    const [x1, z1] = towers[i + 1]
    for (let k = 0; k < 6; k++) {
      const t = k / 6
      points.push([x0 + (x1 - x0) * t, 7 - Math.sin(Math.PI * t) * 1.4, z0 + (z1 - z0) * t])
    }
  }
  const last = towers[towers.length - 1]
  points.push([last[0], 7, last[1]])
  return { points, towers }
}

export const ACTOR_SPOT: Record<string, { dx: number; dz: number }> = {
  steel: { dx: 0, dz: 0 },
  delta: { dx: 9, dz: -8 },
  port: { dx: 0, dz: 0 },
  coldchain: { dx: 8, dz: -9 },
  datacenter: { dx: 0, dz: 0 },
  campuses: { dx: -9, dz: 7 },
  commerce: { dx: 0, dz: 0 },
  central_homes: { dx: -11, dz: 10 },
  hospital: { dx: 0, dz: 0 },
  hosp_homes: { dx: 9, dz: 7 },
  res_east: { dx: 0, dz: 0 },
  farms: { dx: -8, dz: 6 },
}
