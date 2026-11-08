/**
 * Static city layout (presentation only). Which buildings exist, are lit, owned or
 * locked always comes from GameStatePublic; this file only says where to draw them.
 */
export interface Lot {
  id: string
  kind: 'business' | 'generator' | 'solar' | 'battery' | 'rival' | 'decor' | 'depot'
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
  // Player infrastructure
  { id: 'gen_1', kind: 'generator', gx: 0, gy: -2, w: 1, d: 1, h: 30, roof: '#ffbf69', wall: '#5a4a32', label: 'Diesel set #1' },
  { id: 'gen_2', kind: 'generator', gx: 0, gy: 0, w: 1, d: 1, h: 30, roof: '#ffbf69', wall: '#5a4a32', label: 'Diesel set #2' },
  { id: 'solar_1', kind: 'solar', gx: -2, gy: -3, w: 2, d: 2, h: 6, roof: '#1d3b66', wall: '#203047', label: 'Rooftop solar' },
  { id: 'battery_1', kind: 'battery', gx: -2, gy: 0, w: 1, d: 1, h: 26, roof: '#47e4c2', wall: '#1e4740', label: 'Battery bank' },
  // Fuel depot (merchants' shared terminal): tanks show real merchant stock, trucks show import capacity
  { id: 'fuel_depot', kind: 'depot', gx: 3, gy: 6, w: 2, d: 1, h: 22, roof: '#8a95ab', wall: '#3a4256', label: 'Fuel depot' },
  // Rival
  { id: 'rival_plant', kind: 'rival', gx: 7, gy: 6, w: 2, d: 1, h: 58, roof: '#f26f6f', wall: '#5a2a33', label: 'VoltLine plant' },
  // Decor
  { id: 'tree1', kind: 'decor', gx: 1, gy: 3, w: 1, d: 1, h: 0, roof: '#2f7a55', wall: '#244', label: '' },
  { id: 'tree2', kind: 'decor', gx: 7, gy: 1, w: 1, d: 1, h: 0, roof: '#2f7a55', wall: '#244', label: '' },
  { id: 'tree3', kind: 'decor', gx: -3, gy: 2, w: 1, d: 1, h: 0, roof: '#2f7a55', wall: '#244', label: '' },
]

/** Roads as tile runs: [gx0, gy0, gx1, gy1] (axis aligned). */
export const ROADS: [number, number, number, number][] = [
  [-4, -1, 16, -1],
  [-4, 4, 16, 4],
  [2, -7, 2, 7],
  [10, -7, 10, 7],
]

export const DISTRICT_AREAS: Record<string, { gx0: number; gy0: number; gx1: number; gy1: number; name: string }> = {
  market_quarter: { gx0: 3, gy0: -3, gx1: 9, gy1: 2, name: 'Market Quarter' },
  hospital_row: { gx0: 11, gy0: -6, gx1: 15, gy1: -2, name: 'Hospital Row' },
  tech_hub: { gx0: 11, gy0: 1, gx1: 15, gy1: 3, name: 'Tech Hub' },
}
