/** Number formatting for the region game: tabular, short, always with units. */
export const credits = (cc: number) => {
  const c = cc / 100
  const a = Math.abs(c)
  const s = a >= 1_000_000 ? `${(a / 1_000_000).toFixed(a >= 10_000_000 ? 1 : 2)}M` : a >= 10_000 ? `${(a / 1_000).toFixed(a >= 100_000 ? 0 : 1)}k` : a >= 100 ? a.toFixed(0) : a.toFixed(2)
  return `${c < 0 ? '−' : ''}₡${s}`
}
export const price = (ccPerMWh: number) => `₡${(ccPerMWh / 100).toLocaleString('en-US', { maximumFractionDigits: ccPerMWh >= 10_000 ? 0 : 2 })}`
export const mw = (kw: number) => {
  const m = kw / 1000
  return Math.abs(m) >= 1000 ? `${(m / 1000).toFixed(2)} GW` : `${Math.round(m).toLocaleString('en-US')} MW`
}
export const mwh = (kwh: number) => `${Math.round(kwh / 1000).toLocaleString('en-US')} MWh`
export const pct = (bps: number) => `${Math.round(bps / 100)}%`
export const hours = (intervals: number) => {
  const m = intervals * 5
  return m < 60 ? `${m} min` : `${(m / 60).toFixed(m % 60 === 0 ? 0 : 1)} h`
}
export const signed = (cc: number) => `${cc >= 0 ? '+' : ''}${credits(cc)}`
