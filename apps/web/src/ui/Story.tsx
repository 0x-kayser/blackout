import { useEffect, useState } from 'react'
import type { BusinessPublic, EconomyEvent, GameStatePublic } from '@blackout/shared'
import { Drawer } from './Panels'

/** Presentation-only character voices. Lines are chosen from the shop's REAL state (cash, loyalty, power). */
export const VOICES: Record<string, { name: string; face: string }> = {
  cold_room: { name: 'Tunde', face: '🧔🏾' },
  bakery: { name: 'Rosa', face: '👩🏽‍🍳' },
  pharmacy: { name: 'Dr. Imani', face: '👩🏾‍⚕️' },
  cyber_cafe: { name: 'Kai', face: '🧑🏻‍💻' },
  corner_shop: { name: 'Mama Ade', face: '👵🏿' },
  night_clinic: { name: 'Nurse Bello', face: '🧑🏾‍⚕️' },
  medical_lab: { name: 'Dr. Okafor', face: '👨🏿‍🔬' },
  cowork: { name: 'Priya', face: '👩🏽‍💼' },
  server_closet: { name: 'Sam', face: '🧑🏼‍🔧' },
}

export function voiceLine(b: BusinessPublic): string {
  if (b.status === 'closed') return 'We closed the doors. Bring the street back to life and we may reopen.'
  if (b.powerSource === 'none') return b.cashCc < b.fixedCostCcPerDay ? 'The lights are out and rent is due. I cannot keep absorbing the loss.' : 'The outage is costing me customers every minute.'
  if (b.provider === 'rival') return 'VoltLine has my contract right now. Give me a reason to come back.'
  if (b.status === 'struggling') return 'Sales are thin. I need a rate this shop can carry.'
  if (b.powerSource === 'player') return b.loyaltyBps > 6500 ? 'Reliable power at a fair rate. You are my first call.' : 'Power is back. Keep it steady.'
  return b.loyaltyBps > 6500 ? 'The grid is holding for now. If it drops, I know who to call.' : 'Grid power for now. I am watching it closely.'
}

const INTRO = [
  { art: '🌃', title: 'Vesper City', text: 'The grid has been failing for months. When a street loses power, freezers warm, ovens stop, and shops lose customers.' },
  { art: '🛖', title: "Mama Ade's shed", text: 'Mama Ade lent you a shed, a 5 kW diesel generator, and twenty litres of fuel. “Keep this street lit,” she says. “The shops will pay for power they can afford.”' },
  { art: '⚡', title: 'Your power company', text: 'When the grid drops, shops ask for power. Set a fair rate, assign a generator, and watch the fuel market. VoltLine is competing for the same customers.' },
]

export function IntroOverlay({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0)
  const slide = INTRO[i]
  return (
    <div className="intro-backdrop" role="dialog" aria-modal="true" aria-labelledby="intro-title">
      <section className="intro-card">
        <div className="intro-art" aria-hidden>{slide.art}</div>
        <p className="eyebrow amber">CHAPTER 0 · {i + 1} / {INTRO.length}</p>
        <h1 id="intro-title">{slide.title}</h1>
        <p>{slide.text}</p>
        <div className="intro-actions">
          <button className="text-link" onClick={onDone}>Skip</button>
          <button className="button primary" autoFocus onClick={() => (i + 1 < INTRO.length ? setI(i + 1) : onDone())}>{i + 1 < INTRO.length ? 'Next' : 'Light up the street'} <b>→</b></button>
        </div>
        <div className="intro-dots" aria-hidden>{INTRO.map((_, k) => <i key={k} className={k === i ? 'on' : ''} />)}</div>
      </section>
    </div>
  )
}

export function JournalPanel({ s, onClose }: { s: GameStatePublic; onClose: () => void }) {
  const done = s.story.chapters.filter((c) => c.done).length
  return (
    <Drawer title="Journal" eyebrow={`VESPER CITY · ${done} OF ${s.story.chapters.length} CHAPTERS`} onClose={onClose}>
      <div className="journal-progress"><span style={{ width: `${(done / s.story.chapters.length) * 100}%` }} /></div>
      <ol className="chapters">
        {s.story.chapters.map((c) => {
          const current = c.id === s.story.currentChapterId
          return (
            <li key={c.id} className={c.done ? 'done' : current ? 'current' : 'locked'}>
              <span className="ch-mark">{c.done ? '✓' : current ? '▶' : '·'}</span>
              <div>
                <b>{c.title}</b>
                <small>{c.goal}</small>
                {c.done ? <p className="beat">{c.beat}</p> : current ? <p className="fine">{c.character}: {c.characterRole}</p> : null}
              </div>
            </li>
          )
        })}
      </ol>
      <p className="fine">Chapters complete from events in your city. Each one earns reputation and, where relevant, loyalty from the person involved. They do not add credits or resources.</p>
    </Drawer>
  )
}

export function ChapterBanner({ ev, onDone }: { ev: EconomyEvent; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 9000)
    return () => clearTimeout(t)
  }, [onDone])
  return (
    <div className="chapter-banner" role="status">
      <p className="eyebrow amber">CHAPTER COMPLETE</p>
      <h2>{String(ev.data.title)}</h2>
      <p>{String(ev.data.beat)}</p>
      <small>{String(ev.data.reward)}</small>
      <button className="icon-button close" aria-label="Dismiss" onClick={onDone}>×</button>
    </div>
  )
}

const TICKER_TYPES = new Set(['WORLD_EVENT_STARTED', 'WORLD_EVENT_ENDED', 'MERCHANT_REPRICED', 'RIVAL_REPRICED', 'RIVAL_STRATEGY_CHANGED', 'RIVAL_WON_CONTRACT', 'BUSINESS_STATUS_CHANGED', 'MERCHANT_RESTOCK_ORDERED', 'OIL_INDEX_UPDATED', 'REGULATOR_NOTICE', 'CUSTOMER_SWITCHED_PROVIDER', 'CHAPTER_COMPLETED'])

/** Abbreviations that end in a period but do not end a sentence (e.g. "VoltLine Power Co."). */
const ABBREVIATION_END = /\b(?:Co|Inc|Ltd|Corp|St|Dr|Mr|Mrs|Ms|vs|approx|No)\.$/

/** First sentence of an event explanation, without splitting inside abbreviations or decimals. */
export function headline(text: string): string {
  const end = /[.!?](?=\s|$)/g
  for (let m = end.exec(text); m; m = end.exec(text)) {
    const head = text.slice(0, m.index + 1)
    if (!ABBREVIATION_END.test(head)) return head
  }
  return text
}

export function NewsTicker({ events }: { events: EconomyEvent[] }) {
  const items = events.filter((e) => TICKER_TYPES.has(e.type)).slice(-8).reverse()
  if (!items.length) return null
  return (
    <div className="ticker" aria-label="City news">
      <span className="ticker-label">VESPER NEWS</span>
      <div className="ticker-track">
        <div className="ticker-move">
          {[...items, ...items].map((e, i) => <span key={`${e.seq}-${i}`}>{headline(e.explanation)}</span>)}
        </div>
      </div>
    </div>
  )
}
