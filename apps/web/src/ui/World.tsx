import { useEffect, useState } from 'react'
import type { EconomyEvent, GameStatePublic, OilResponse, WorldEventPublic } from '@blackout/shared'
import { Drawer } from './Panels'
import { fmtCredits, fmtLitres, sparkPath } from './format'

export const CATEGORY_ICON: Record<WorldEventPublic['category'], string> = {
  shipping: '🚢',
  production: '🛢',
  refinery: '🏭',
  inventory: '🛢',
  weather: '🌡',
  demand: '📉',
  policy: '🏛',
  renewables: '☀',
  recovery: '🌤',
}

const MODE_LABEL: Record<GameStatePublic['world']['eventMode'], { name: string; text: string }> = {
  historical: { name: 'HISTORICAL', text: 'Real 2026 Brent prices. Events shown only when an official source (EIA) supports them.' },
  living: { name: 'LIVING WORLD', text: 'Observed 2026 Brent prices with fictional local events. Local events affect Vesper City’s supply conditions; the crude series remains observed data.' },
  scenario: { name: 'SCENARIO', text: 'Fictional, seeded events for practice, challenges and the Economy Lab.' },
  calm: { name: 'CALM', text: 'No additional world events are active.' },
}

/** Rough positions on the stylized map (percent of width/height). */
const REGION_POS: Record<string, [number, number]> = {
  'Gulf shipping lanes': [61, 47],
  'Strait of Hormuz': [61, 47],
  'Strait of Hormuz / global demand': [61, 47],
  'Gulf supply routes': [60, 46],
  'Coastal refinery': [27, 40],
  'Global crude supply': [57, 40],
  'Vesper City fuel terminal': [25, 44],
  'Regional storage': [29, 46],
  'Vesper City': [24, 42],
  'Vesper City council': [24, 42],
  'Equipment suppliers': [80, 42],
  'Global shipping': [45, 56],
}

const ticksLeft = (s: GameStatePublic, e: WorldEventPublic) => Math.max(0, e.endTick - s.clock.tick)
const timeLeft = (t: number) => (t >= 240 ? `${(t / 240).toFixed(1)} game days` : `${Math.round(t / 10)} game hours`)

export function WorldChip({ s, onOpen }: { s: GameStatePublic; onOpen: () => void }) {
  const ev = s.world.activeEvents[0]
  if (!ev) return null
  return (
    <button className={`world-chip ${ev.verification}`} onClick={onOpen} aria-label={`World event: ${ev.headline}. Open World Events.`}>
      <span className="pulse" aria-hidden /> {CATEGORY_ICON[ev.category]} <b>{ev.headline.replace(/ \(fictional.*\)$/, '')}</b>
      {s.world.activeEvents.length > 1 && <em>+{s.world.activeEvents.length - 1}</em>}
      <small>{ev.verification === 'sourced' ? 'SOURCED' : 'FICTIONAL'} · {timeLeft(ticksLeft(s, ev))} left</small>
    </button>
  )
}

function WorldMap({ s }: { s: GameStatePublic }) {
  const markers = s.world.activeEvents.map((e) => ({ e, pos: REGION_POS[e.region] ?? [50, 50] }))
  return (
    <svg className="world-map" viewBox="0 0 100 60" role="img" aria-label={`Map: ${markers.length ? markers.map((m) => m.e.region).join(', ') : 'no active events'}`}>
      <defs>
        <radialGradient id="wmGlow"><stop offset="0" stopColor="#ffbf69" stopOpacity=".9" /><stop offset="1" stopColor="#ffbf69" stopOpacity="0" /></radialGradient>
      </defs>
      <rect width="100" height="60" rx="3" fill="#0d1830" />
      {/* stylised continents (not to scale) */}
      <path d="M8 18 Q14 10 24 12 Q32 14 30 22 Q34 30 26 34 Q18 38 14 32 Q6 28 8 18Z" fill="#1d3152" />
      <path d="M22 36 Q30 38 30 46 Q28 56 22 54 Q18 46 22 36Z" fill="#1d3152" />
      <path d="M40 12 Q52 8 62 12 Q76 10 88 16 Q92 24 84 28 Q74 30 66 34 Q60 30 54 30 Q46 26 40 22Z" fill="#1d3152" />
      <path d="M44 30 Q52 32 54 40 Q52 50 46 52 Q40 44 44 30Z" fill="#1d3152" />
      <path d="M78 40 Q86 40 88 46 Q82 50 76 46Z" fill="#1d3152" />
      {/* shipping lanes */}
      <path d="M61 47 Q50 54 40 52 Q30 50 25 44" fill="none" stroke="#3f5f8f" strokeDasharray="1.2 1.2" strokeWidth=".6" />
      <path d="M80 42 Q60 58 26 45" fill="none" stroke="#3f5f8f" strokeDasharray="1.2 1.2" strokeWidth=".4" />
      <circle cx="24" cy="42" r="1.6" fill="#47e4c2" />
      <text x="16" y="39" fontSize="2.6" fill="#c9d6ea">Vesper City</text>
      {markers.map(({ e, pos }) => (
        <g key={e.eventId}>
          <circle cx={pos[0]} cy={pos[1]} r="6" fill="url(#wmGlow)" className="wm-pulse" />
          <circle cx={pos[0]} cy={pos[1]} r="1.4" fill={e.verification === 'sourced' ? '#56b6ff' : '#ffbf69'} />
          <text x={pos[0] + 2.2} y={pos[1] - 2} fontSize="2.4" fill="#ffe3b8">{CATEGORY_ICON[e.category]} {e.region}</text>
        </g>
      ))}
    </svg>
  )
}

function EventCard({ s, e, reactions }: { s: GameStatePublic; e: WorldEventPublic; reactions: EconomyEvent[] }) {
  const left = ticksLeft(s, e)
  const pct = e.phase === 'resolved' ? 100 : Math.min(100, ((s.clock.tick - e.startTick) / Math.max(1, e.endTick - e.startTick)) * 100)
  return (
    <article className={`event-card ${e.verification} ${e.phase}`}>
      <header>
        <span className="cat">{CATEGORY_ICON[e.category]}</span>
        <div>
          <span className={`badge ${e.verification}`}>{e.verification === 'sourced' ? `SOURCED · ${e.publishedAt}` : 'FICTIONAL SCENARIO'}</span>
          <h3>{e.headline}</h3>
          <small>{e.region} · {e.phase === 'resolved' ? 'resolved' : `${e.phase} · ${timeLeft(left)} left`}</small>
        </div>
      </header>
      {e.phase !== 'resolved' && <div className="event-progress"><span style={{ width: `${pct}%` }} /></div>}
      <p>{e.explanation}</p>
      {e.sourceUrl && <p className="fine">Source: <a href={e.sourceUrl} target="_blank" rel="noreferrer">{e.sourceTitle}</a></p>}
      <div className="effects">
        <p className="eyebrow">IN VESPER CITY</p>
        <ul>{e.effectNotes.map((n) => <li key={n}>{n}</li>)}</ul>
        <p className="fine">{e.assumption}</p>
      </div>
      {reactions.length > 0 && (
        <div className="reactions">
          <p className="eyebrow">WHO REACTED (from their own rules)</p>
          <ul>{reactions.slice(-5).map((r) => <li key={r.seq}><span>{r.clock}</span> {r.explanation.split('. Import cost')[0]}</li>)}</ul>
        </div>
      )}
    </article>
  )
}

function BrentChart({ s, oil }: { s: GameStatePublic; oil: OilResponse | null }) {
  const weeks = s.world.brentWeekly.length ? s.world.brentWeekly : (oil?.weekly2026 ?? [])
  if (!weeks.length) return null
  const values = weeks.map((w) => w.usdPerBarrel)
  const cur = s.world.observedBrent ? weeks.findIndex((w) => w.weekStart === s.world.observedBrent!.weekStart) : -1
  const min = Math.min(...values)
  const max = Math.max(...values)
  const x = (i: number) => (i / (values.length - 1)) * 300
  const y = (v: number) => 80 - ((v - min) / Math.max(1, max - min)) * 76
  return (
    <figure className="brent-chart">
      <figcaption>
        Brent crude. Weekly 2026 mean (USD/bbl), {weeks[0].weekStart} to {weeks[weeks.length - 1].weekStart}
        {oil && <span className={`fresh ${oil.source}`}> · {oil.freshness}</span>}
      </figcaption>
      <svg viewBox="0 0 300 84" role="img" aria-label={`Brent price chart, from $${min.toFixed(0)} to $${max.toFixed(0)}`}>
        <path d={sparkPath(values, 300, 80)} transform="translate(0,2)" />
        {cur >= 0 && (
          <g>
            <line x1={x(cur)} x2={x(cur)} y1="0" y2="84" stroke="#ffbf69" strokeDasharray="2 2" />
            <circle cx={x(cur)} cy={y(values[cur]) + 2} r="3" fill="#ffbf69" />
          </g>
        )}
      </svg>
      <p className="fine">
        {s.world.observedBrent ? <>This run follows the week of <b>{s.world.observedBrent.weekStart}</b> (${s.world.observedBrent.usdPerBarrel.toFixed(2)}). Each game day represents one observed week. </> : null}
        Source: <a href={oil?.sourceUrl ?? 'https://fred.stlouisfed.org/series/DCOILBRENTEU'} target="_blank" rel="noreferrer">{oil?.attribution ?? 'U.S. EIA via FRED'}</a>. The Brent series is observed; merchant diesel prices are simulated from inventory, demand, and pricing rules.
      </p>
    </figure>
  )
}

export function WorldPanel({ s, events, onClose }: { s: GameStatePublic; events: EconomyEvent[]; onClose: () => void }) {
  const [oil, setOil] = useState<OilResponse | null>(null)
  useEffect(() => {
    fetch('/api/world/oil').then((r) => r.json()).then((j) => j.ok && setOil(j)).catch(() => null)
  }, [])
  const mode = MODE_LABEL[s.world.eventMode]
  const m = s.world.modifiers
  const reactionsFor = (e: WorldEventPublic) =>
    events.filter((x) => x.tick >= e.startTick && (e.phase === 'resolved' || x.tick <= s.clock.tick) && (e.phase !== 'resolved' || x.tick <= e.endTick) && ['MERCHANT_REPRICED', 'RIVAL_REPRICED', 'RIVAL_STRATEGY_CHANGED', 'MERCHANT_RESTOCK_ORDERED', 'RIVAL_PURCHASED'].includes(x.type))
  return (
    <Drawer title="World events" eyebrow={`${mode.name} MODE`} onClose={onClose} wide>
      <p className="fine mode-note">{mode.text}</p>
      <WorldMap s={s} />
      <section className="conditions">
        <div><small>Fuel imports</small><b className={m.importCapacityBps < 0 ? 'neg' : m.importCapacityBps > 0 ? 'pos' : ''}>{m.importCapacityBps ? `${m.importCapacityBps > 0 ? '+' : ''}${m.importCapacityBps / 100}%` : 'normal'}</b></div>
        <div><small>Delivery time</small><b className={m.leadTimeDays ? 'neg' : ''}>{m.leadTimeDays ? `+${m.leadTimeDays} day` : 'normal'}</b></div>
        <div><small>Shopper demand</small><b>{m.demandBps ? `${m.demandBps > 0 ? '+' : ''}${m.demandBps / 100}%` : 'normal'}</b></div>
        <div><small>Solar & battery prices</small><b>{m.solarCostBps ? `${m.solarCostBps > 0 ? '+' : ''}${m.solarCostBps / 100}%` : 'normal'}</b></div>
        <div><small>Permit supply</small><b>{m.permitSupplyBps ? `${m.permitSupplyBps > 0 ? '+' : ''}${m.permitSupplyBps / 100}%` : 'normal'}</b></div>
        <div><small>Diesel shelves</small><b>{s.merchants.map((x) => fmtLitres(x.stockMl)).join(' / ')}</b></div>
        <div><small>Cheapest diesel</small><b>{fmtCredits(Math.min(...s.merchants.filter((x) => x.status === 'open').map((x) => x.quoteCcPerL)))}/L</b></div>
        <div><small>Rival</small><b>{(s.rival.tariffCcPerKwh / 100).toFixed(2)} ₡/kWh{s.rival.solarW ? ' · solar' : ''}{s.rival.stockpileDays ? ' · stockpiling' : ''}</b></div>
      </section>
      {s.world.activeEvents.length ? (
        s.world.activeEvents.map((e) => <EventCard key={e.eventId} s={s} e={e} reactions={reactionsFor(e)} />)
      ) : (
        <p className="empty">Markets are quiet right now. {s.world.eventMode === 'calm' ? '' : 'New events can begin at 06:00 and 18:00 game time.'}</p>
      )}
      <BrentChart s={s} oil={oil} />
      {s.world.eventHistory.length > 0 && (
        <section>
          <p className="eyebrow">EARLIER EVENTS</p>
          {s.world.eventHistory.slice().reverse().map((e) => <EventCard key={e.eventId} s={s} e={e} reactions={reactionsFor(e)} />)}
        </section>
      )}
    </Drawer>
  )
}
