import { fmtClock, fmtCredits, fmtKg, fmtKw, fmtKwh, fmtLitres, fmtPct, fmtRate } from '@blackout/shared'
import type { GameStatePublic } from '@blackout/shared'

export { fmtClock, fmtCredits, fmtKg, fmtKw, fmtKwh, fmtLitres, fmtPct, fmtRate }

export const secondsLeft = (s: GameStatePublic, tick: number | null) => (tick === null ? null : Math.max(0, tick - s.clock.tick))

export const bizName = (s: GameStatePublic, id: string) => s.businesses.find((b) => b.businessId === id)?.name ?? id
export const genName = (s: GameStatePublic, id: string | null) => (id ? (s.generators.find((g) => g.generatorId === id)?.name ?? id) : '—')

export const MOOD_ICON = { happy: '😊', neutral: '😐', worried: '😟', angry: '😠' } as const

/** Presentation-only objectives derived from authoritative state (no rewards are granted client-side). */
export function objectives(s: GameStatePublic): { text: string; done: boolean }[] {
  const servedAny = s.contracts.some((c) => c.provider === 'player' && (c.status === 'active' || c.status === 'completed'))
  const hasBought = s.trades.some((t) => t.status === 'settled')
  const capacity = s.generators.reduce((a, g) => a + g.ratedW, 0)
  const list = [
    { text: 'Restore power to the Cold Room', done: servedAny },
    { text: 'Earn ₡1,100 total credits', done: s.player.creditsCc >= 110_000 },
    { text: 'Buy fuel or permits in the Market', done: hasBought },
    { text: 'Install solar or a battery', done: s.player.upgradesOwned.includes('solar_2kw') || s.player.upgradesOwned.includes('battery_10kwh') },
    { text: 'Reach 10 kW of capacity', done: capacity >= 10_000 },
    { text: 'Unlock Hospital Row', done: s.districts.some((d) => d.districtId === 'hospital_row' && d.unlocked) },
  ]
  const firstOpen = list.findIndex((o) => !o.done)
  return firstOpen < 0 ? list.slice(-3) : list.slice(Math.max(0, firstOpen - 1), firstOpen + 2)
}

export const sparkPath = (values: number[], w: number, h: number) => {
  if (values.length < 2) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = Math.max(1, max - min)
  return values.map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / (values.length - 1)) * w).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`).join(' ')
}
