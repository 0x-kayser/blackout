/**
 * Static city layout (presentation only). Which buildings exist, are lit, owned or
 * locked always comes from GameStatePublic; this file only says where to draw them.
 */
export interface Lot {
  id: string
  kind: 'business' | 'generator' | 'solar' | 'battery' | 'rival' | 'decor' | 'depot' | 'exchange'
  gx: number
  gy: number
  w: number // footprint in tiles (x)
  d: number // footprint in tiles (y)
  h: number // height in px at zoom 1
  roof: string
  wall: string
  label: string
  district?: string
  icon?: string
}

export const TILE_W = 64
export const TILE_H = 32

export const LOTS: Lot[] = [
  // Market Quarter
  { id: 'cold_room', kind: 'business', gx: 3, gy: -2, w: 2, d: 1, h: 44, roof: '#5ec2e6', wall: '#2c5a73', label: 'Cold Room', district: 'market_quarter', icon: '❄' },
  { id: 'bakery', kind: 'business', gx: 6, gy: -2, w: 1, d: 1, h: 52, roof: '#e7a35c', wall: '#7a4a2c', label: 'Sunrise Bakery', district: 'market_quarter', icon: '🥐' },
  { id: 'cyber_cafe', kind: 'business', gx: 8, gy: -2, w: 1, d: 2, h: 60, roof: '#9b7cf2', wall: '#3f3376', label: 'Byte Cyber Café', district: 'market_quarter', icon: '⌨' },
  { id: 'pharmacy', kind: 'business', gx: 3, gy: 1, w: 1, d: 1, h: 48, roof: '#5fd59a', wall: '#2a6a50', label: 'Corner Pharmacy', district: 'market_quarter', icon: '✚' },
  { id: 'corner_shop', kind: 'business', gx: 5, gy: 1, w: 1, d: 1, h: 38, roof: '#f2c94c', wall: '#7a6224', label: "Mama Ade's Shop", district: 'market_quarter', icon: '▦' },
  // Hospital Row
  { id: 'night_clinic', kind: 'business', gx: 11, gy: -5, w: 2, d: 2, h: 86, roof: '#e9edf3', wall: '#5c6c85', label: 'Night Clinic', district: 'hospital_row', icon: '✚' },
  { id: 'medical_lab', kind: 'business', gx: 14, gy: -5, w: 1, d: 2, h: 70, roof: '#cfe3ff', wall: '#46607f', label: 'Medical Lab', district: 'hospital_row', icon: '⚗' },
  // Tech Hub
  { id: 'cowork', kind: 'business', gx: 11, gy: 2, w: 2, d: 2, h: 110, roof: '#56b6ff', wall: '#1f4569', label: 'Hive Co-working', district: 'tech_hub', icon: '◈' },
  { id: 'server_closet', kind: 'business', gx: 14, gy: 2, w: 1, d: 1, h: 64, roof: '#47e4c2', wall: '#1d5a52', label: 'Server Closet', district: 'tech_hub', icon: '▤' },
  // Riverside Homes
  { id: 'riverside_flats', kind: 'business', gx: 3, gy: -11, w: 2, d: 2, h: 76, roof: '#c9a27a', wall: '#6b4f3a', label: 'Riverside Flats', district: 'riverside', icon: '🏠' },
  { id: 'garden_school', kind: 'business', gx: 6, gy: -10, w: 2, d: 1, h: 40, roof: '#f2c94c', wall: '#7a6224', label: 'Garden Street School', district: 'riverside', icon: '✎' },
  { id: 'laundromat', kind: 'business', gx: 8, gy: -11, w: 1, d: 1, h: 34, roof: '#8fd3f4', wall: '#355f73', label: 'Suds Laundromat', district: 'riverside', icon: '◌' },
  // Port District
  { id: 'cold_chain', kind: 'business', gx: 3, gy: 9, w: 2, d: 2, h: 42, roof: '#9fd8e8', wall: '#2f5866', label: 'Harbour Cold Chain', district: 'port_district', icon: '❄' },
  { id: 'shipyard', kind: 'business', gx: 6, gy: 9, w: 2, d: 2, h: 32, roof: '#d07a4a', wall: '#5e3420', label: 'Dry Dock Workshop', district: 'port_district', icon: '⚓' },
  { id: 'fish_market', kind: 'business', gx: 8, gy: 11, w: 1, d: 1, h: 26, roof: '#7cc7a5', wall: '#2c5a46', label: 'Dawn Fish Market', district: 'port_district', icon: '🐟' },
  // Industrial Park
  { id: 'textile_mill', kind: 'business', gx: 11, gy: 5, w: 2, d: 2, h: 48, roof: '#b9a8e8', wall: '#4b3f78', label: 'Loomline Textiles', district: 'industrial_park', icon: '⚙' },
  { id: 'recycler', kind: 'business', gx: 14, gy: 5, w: 2, d: 2, h: 40, roof: '#8bc34a', wall: '#3d5a1e', label: 'ReForm Recycling', district: 'industrial_park', icon: '♻' },
  { id: 'bottling', kind: 'business', gx: 14, gy: 7, w: 2, d: 1, h: 36, roof: '#56b6ff', wall: '#1f4569', label: 'Clearwater Bottling', district: 'industrial_park', icon: '◍' },
  // Downtown
  { id: 'office_tower', kind: 'business', gx: 18, gy: -5, w: 2, d: 2, h: 150, roof: '#a7c4e5', wall: '#2e4c70', label: 'Meridian Tower', district: 'downtown', icon: '▥' },
  { id: 'mall', kind: 'business', gx: 21, gy: -4, w: 2, d: 2, h: 60, roof: '#f28ab2', wall: '#6e2e4a', label: 'Vesper Mall', district: 'downtown', icon: '🛍' },
  { id: 'arena', kind: 'business', gx: 19, gy: -1, w: 3, d: 2, h: 34, roof: '#e6ebf4', wall: '#55627c', label: 'Vesper Arena', district: 'downtown', icon: '🏟' },
  // Player infrastructure
  { id: 'gen_3', kind: 'generator', gx: -3, gy: 2, w: 2, d: 2, h: 40, roof: '#ffbf69', wall: '#5a4a32', label: 'Diesel plant 20 kW' },
  { id: 'solar_2', kind: 'solar', gx: -6, gy: -6, w: 3, d: 3, h: 4, roof: '#1d3b66', wall: '#203047', label: 'Solar farm' },
  { id: 'gen_1', kind: 'generator', gx: 0, gy: -2, w: 1, d: 1, h: 30, roof: '#ffbf69', wall: '#5a4a32', label: 'Diesel set #1' },
  { id: 'gen_2', kind: 'generator', gx: 0, gy: 0, w: 1, d: 1, h: 30, roof: '#ffbf69', wall: '#5a4a32', label: 'Diesel set #2' },
  { id: 'solar_1', kind: 'solar', gx: -2, gy: -3, w: 2, d: 2, h: 6, roof: '#1d3b66', wall: '#203047', label: 'Rooftop solar' },
  { id: 'battery_1', kind: 'battery', gx: -2, gy: 0, w: 1, d: 1, h: 26, roof: '#47e4c2', wall: '#1e4740', label: 'Battery bank' },
  // Fuel depot (merchants' shared terminal): tanks show real merchant stock, trucks show import capacity
  // the shared Vesper Fuel Exchange: every player's city trades here
  { id: 'exchange_port', kind: 'exchange', gx: 0, gy: 5, w: 2, d: 2, h: 34, roof: '#2a8f7c', wall: '#1d4a44', label: 'Vesper Exchange' },
  { id: 'fuel_depot', kind: 'depot', gx: 3, gy: 6, w: 2, d: 1, h: 22, roof: '#8a95ab', wall: '#3a4256', label: 'Fuel depot' },
  // Rival
  { id: 'rival_plant', kind: 'rival', gx: 7, gy: 6, w: 2, d: 1, h: 58, roof: '#f26f6f', wall: '#5a2a33', label: 'VoltLine plant' },
  // Decor
  { id: 'tree1', kind: 'decor', gx: 1, gy: 3, w: 1, d: 1, h: 0, roof: '#2f7a55', wall: '#244', label: '' },
  { id: 'tree2', kind: 'decor', gx: 7, gy: 1, w: 1, d: 1, h: 0, roof: '#2f7a55', wall: '#244', label: '' },
  { id: 'tree3', kind: 'decor', gx: -5, gy: 4, w: 1, d: 1, h: 0, roof: '#2f7a55', wall: '#244', label: '' },
  { id: 'tree4', kind: 'decor', gx: 12, gy: -9, w: 1, d: 1, h: 0, roof: '#2f7a55', wall: '#244', label: '' },
  { id: 'tree5', kind: 'decor', gx: 22, gy: 4, w: 1, d: 1, h: 0, roof: '#2f7a55', wall: '#244', label: '' },
]

/** Roads as tile runs: [gx0, gy0, gx1, gy1] (axis aligned). */
export const ROADS: [number, number, number, number][] = [
  [-4, -1, 17, -1],
  [-4, 4, 17, 4],
  [2, -12, 2, 13],
  [10, -12, 10, 13],
  [-6, -7, 25, -7],
  [-6, 8, 25, 8],
  [17, -12, 17, 13],
]

export const DISTRICT_AREAS: Record<string, { gx0: number; gy0: number; gx1: number; gy1: number; name: string }> = {
  market_quarter: { gx0: 3, gy0: -3, gx1: 9, gy1: 2, name: 'Market Quarter' },
  riverside: { gx0: 3, gy0: -12, gx1: 10, gy1: -8, name: 'Riverside Homes' },
  hospital_row: { gx0: 11, gy0: -6, gx1: 17, gy1: -1, name: 'Hospital Row' },
  tech_hub: { gx0: 11, gy0: 0, gx1: 17, gy1: 4, name: 'Tech Hub' },
  port_district: { gx0: 3, gy0: 9, gx1: 10, gy1: 12, name: 'Port District' },
  industrial_park: { gx0: 11, gy0: 5, gx1: 17, gy1: 8, name: 'Industrial Park' },
  downtown: { gx0: 18, gy0: -6, gx1: 25, gy1: 4, name: 'Downtown' },
}

/** Where each district's substation stands (its feeder from your plants lands here). */
export const SUBSTATIONS: Record<string, { gx: number; gy: number }> = {
  market_quarter: { gx: 2.6, gy: -2.6 },
  riverside: { gx: 2.6, gy: -8.6 },
  hospital_row: { gx: 10.6, gy: -5.6 },
  tech_hub: { gx: 10.6, gy: 1.4 },
  port_district: { gx: 2.6, gy: 9.4 },
  industrial_park: { gx: 10.6, gy: 5.4 },
  downtown: { gx: 17.6, gy: -5.6 },
}

// ---------------------------------------------------------------- automatic placement for the rest of the city
const PALETTE: [string, string][] = [
  ['#e7a35c', '#7a4a2c'], ['#5ec2e6', '#2c5a73'], ['#9b7cf2', '#3f3376'], ['#5fd59a', '#2a6a50'], ['#f2c94c', '#7a6224'],
  ['#f28ab2', '#6e2e4a'], ['#a7c4e5', '#2e4c70'], ['#d07a4a', '#5e3420'], ['#8bc34a', '#3d5a1e'], ['#c9a27a', '#6b4f3a'],
]
const KIND_ICON: Record<string, string> = {
  apartments: '🏠', grocery: '🛒', library: '📚', daycare: '🧸', clinic: '✚', warehouse: '📦', emergency: '🚑', data_centre: '▤',
  gaming: '🎮', startup: '🚀', terminal: '🏗', ice_plant: '🧊', cannery: '🥫', steel: '🔥', factory: '⚙', civic: '🏛', hotel: '🛎',
  cinema: '🎬', tailor: '🧵', repair: '🔧', barber: '💈',
}
const hashOf = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)

/**
 * Places every business that has no hand-drawn lot inside its district: biggest loads first, row by row, never on a
 * road or another building. Deterministic for a given set of businesses, so the city looks the same every visit.
 */
export function autoLots(businesses: { businessId: string; districtId: string; demandW: number; name: string; kind: string }[]): Lot[] {
  const taken = new Set<string>()
  const mark = (gx: number, gy: number) => taken.add(`${gx},${gy}`)
  for (const l of LOTS) for (let x = 0; x < l.w; x++) for (let y = 0; y < l.d; y++) mark(Math.floor(l.gx) + x, Math.floor(l.gy) + y)
  for (const [x0, y0, x1, y1] of ROADS) {
    if (y0 === y1) for (let x = x0; x < x1; x++) mark(x, y0)
    else for (let y = y0; y < y1; y++) mark(x0, y)
  }
  const placed: Lot[] = []
  const missing = businesses.filter((b) => !LOTS.some((l) => l.id === b.businessId)).sort((a, b) => b.demandW - a.demandW || a.businessId.localeCompare(b.businessId))
  for (const b of missing) {
    const area = DISTRICT_AREAS[b.districtId]
    if (!area) continue
    const w = b.demandW >= 3_500 ? 2 : 1
    const d = b.demandW >= 7_000 ? 2 : 1
    let spot: { gx: number; gy: number } | null = null
    for (let gy = area.gy0; gy <= area.gy1 - d && !spot; gy++) {
      for (let gx = area.gx0; gx <= area.gx1 - w && !spot; gx++) {
        let free = true
        for (let x = 0; x < w && free; x++) for (let y = 0; y < d && free; y++) if (taken.has(`${gx + x},${gy + y}`)) free = false
        if (free) spot = { gx, gy }
      }
    }
    if (!spot) continue
    for (let x = 0; x < w; x++) for (let y = 0; y < d; y++) mark(spot.gx + x, spot.gy + y)
    const [roof, wall] = PALETTE[hashOf(b.businessId) % PALETTE.length]
    placed.push({ id: b.businessId, kind: 'business', gx: spot.gx, gy: spot.gy, w, d, h: Math.max(26, Math.min(140, Math.round(26 + b.demandW / 80))), roof, wall, label: b.name, district: b.districtId, icon: KIND_ICON[b.kind] ?? '▣' })
  }
  return placed
}
