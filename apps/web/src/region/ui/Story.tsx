/**
 * The story (§50): events as they happen, told by the people they happen to, with the chain that caused them.
 * New crises surface as toasts; the feed keeps the last forty.
 */
import { useEffect, useRef, useState } from 'react'
import type { RegionEvent, RegionView, TownView } from '@blackout/shared'
import type { Selection } from '../scene/World3D'
import { synthesizeBroadcast, synthesizeChronicle } from './VesperFm'

export function useNewEvents(v: RegionView | null, onEvent: (e: RegionEvent) => void) {
  const seen = useRef<number | null>(null)
  useEffect(() => {
    if (!v) return
    const last = v.events.at(-1)?.seq ?? 0
    if (seen.current === null) {
      seen.current = last // events that happened before we arrived are history, not news
      return
    }
    for (const e of v.events) if (e.seq > seen.current) onEvent(e)
    seen.current = Math.max(seen.current, last)
  }, [v?.events.at(-1)?.seq])
}

export function Toasts({ items, onOpen, onDismiss }: { items: RegionEvent[]; onOpen: (e: RegionEvent) => void; onDismiss: (seq: number) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {items.map((e) => (
        <div key={e.seq} className={`toast ${e.severity}`}>
          <button className="toast-body" onClick={() => onOpen(e)}>
            <b>{e.title}</b>
            {e.quote ? (
              <span className="toast-quote">
                {e.quote.face} “{e.quote.text}”
              </span>
            ) : (
              e.detail && <span>{e.detail}</span>
            )}
          </button>
          <button className="toast-x" onClick={() => onDismiss(e.seq)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

export function Feed({ v, town = null, companyName = null, onSelect, onClose }: { v: RegionView; town?: TownView | null; companyName?: string | null; onSelect: (s: Selection) => void; onClose: () => void }) {
  const [open, setOpen] = useState<number | null>(null)
  const [tab, setTab] = useState<'radio' | 'chronicle' | 'events'>('radio')
  const bySeq = new Map(v.events.map((e) => [e.seq, e]))
  const time = (interval: number) => {
    const total = 17 * 60 + 10 + interval * 5
    return `${String(Math.floor((total % 1440) / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  }
  const radio = synthesizeBroadcast(v, town, companyName)
  const paper = synthesizeChronicle(v, town, companyName)

  return (
    <div className="sheet feed" role="dialog" aria-label="What happened">
      <button className="close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <h3>Vesper FM & The Chronicle</h3>
      <div className="ops-tabs" role="tablist" aria-label="Broadcast and press" style={{ marginBottom: 12 }}>
        <button role="tab" aria-selected={tab === 'radio'} className={tab === 'radio' ? 'on' : ''} onClick={() => setTab('radio')}>
          📻 98.4 Vesper FM
        </button>
        <button role="tab" aria-selected={tab === 'chronicle'} className={tab === 'chronicle' ? 'on' : ''} onClick={() => setTab('chronicle')}>
          🗞️ The Chronicle
        </button>
        <button role="tab" aria-selected={tab === 'events'} className={tab === 'events' ? 'on' : ''} onClick={() => setTab('events')}>
          📜 Event log ({v.events.filter((e) => e.type !== 'DAY_STARTED').length})
        </button>
      </div>

      {tab === 'radio' && (
        <div className="vesper-fm-panel">
          <div className={`campaign-brief fm-studio ${radio.tone}`} style={{ marginBottom: 12 }}>
            <div className="campaign-brief-top">
              <span>🔴 ON AIR · {radio.station} · {radio.show.toUpperCase()}</span>
              <b>Host: {radio.host}</b>
            </div>
            <h4 style={{ margin: '6px 0 4px' }}>{radio.djHeadline}</h4>
            <p className="fine" style={{ margin: 0 }}>🎙️ “{radio.djCommentary}”</p>
          </div>
          <h4 className="route-list-title">LIVE CALL-INS FROM ACROSS THE LAGOON</h4>
          <ol className="feed-list">
            {radio.callers.map((c) => (
              <li key={c.id} className={c.tone}>
                <div style={{ padding: '8px 10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                    <b>{c.face} {c.person} <small className="fine">· {c.role}</small></b>
                    <small className="fine">{c.district}</small>
                  </div>
                  <p className="fine" style={{ margin: 0 }}>“{c.line}”</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {tab === 'chronicle' && (
        <div className="chronicle-panel">
          <div className="campaign-brief" style={{ marginBottom: 12 }}>
            <div className="campaign-brief-top">
              <span>{paper.masthead}</span>
              <b>{paper.dateline}</b>
            </div>
            <small className="fine" style={{ display: 'block', marginBottom: 8 }}>{paper.weatherStrip}</small>
            <p className="eyebrow" style={{ marginBottom: 4 }}>{paper.lead.kicker}</p>
            <h4 style={{ margin: '0 0 6px', lineHeight: 1.25 }}>{paper.lead.headline}</h4>
            <p style={{ margin: '0 0 8px', fontWeight: 600 }}>{paper.lead.subhead}</p>
            {paper.lead.body.map((p, idx) => (
              <p key={idx} className="fine" style={{ margin: '0 0 6px' }}>{p}</p>
            ))}
          </div>
          <div className="campaign-brief" style={{ marginBottom: 10 }}>
            <div className="campaign-brief-top">
              <span>MARITIME & FUEL DESK</span>
              <b>Strait of Hormuz Watch</b>
            </div>
            <p className="fine" style={{ marginBottom: 6 }}>{paper.hormuzDispatch.summary}</p>
            <ul className="fine" style={{ margin: 0, paddingLeft: 18 }}>
              {paper.hormuzDispatch.bullets.map((b, i) => <li key={i} style={{ marginBottom: 3 }}>{b}</li>)}
            </ul>
          </div>
          <div className="campaign-brief">
            <div className="campaign-brief-top">
              <span>CLIMATE & COMPLIANCE DESK</span>
              <b>COP31 Sovereign Grid Accord</b>
            </div>
            <p className="fine" style={{ marginBottom: 6 }}>{paper.cop31Dispatch.summary}</p>
            <ul className="fine" style={{ margin: 0, paddingLeft: 18 }}>
              {paper.cop31Dispatch.bullets.map((b, i) => <li key={i} style={{ marginBottom: 3 }}>{b}</li>)}
            </ul>
          </div>
        </div>
      )}

      {tab === 'events' && (
        <>
          <p className="fine">Every event links to what caused it. Tap one to follow the cause.</p>
          <ol className="feed-list">
            {[...v.events].reverse().filter((e) => e.type !== 'DAY_STARTED').map((e) => (
              <li key={e.seq} className={e.severity}>
                <button
                  onClick={() => {
                    setOpen(open === e.seq ? null : e.seq)
                    if (e.actorId) onSelect({ kind: 'actor', id: e.actorId })
                    else if (e.nodeId) onSelect({ kind: 'node', id: e.nodeId })
                  }}
                >
                  <time>{time(e.interval)}</time> <b>{e.title}</b>
                </button>
                {open === e.seq && (
                  <div className="feed-more">
                    {e.detail && <p>{e.detail}</p>}
                    {e.quote && (
                      <blockquote className="quote">
                        {e.quote.face} “{e.quote.text}” <cite>— {e.quote.person}</cite>
                      </blockquote>
                    )}
                    {e.causes.length > 0 && (
                      <p className="because">
                        Because:{' '}
                        {e.causes.map((c) => (
                          <span key={c} className="cause">
                            {bySeq.get(c)?.title ?? `an earlier event (#${c})`}
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  )
}

export function Coach({ v, onTarget }: { v: RegionView; onTarget: (target: string) => void }) {
  const [hidden, setHidden] = useState(false)
  if (v.onboarding.done || hidden) return null
  const step = v.onboarding.step
  return (
    <div className="coach" role="status">
      <p className="eyebrow">OPENING OPERATION · STEP {step + 1} OF 3</p>
      <b>{v.onboarding.title}</b>
      <p>{v.onboarding.hint}</p>
      <div className="row">
        {v.onboarding.target && (
          <button className="btn primary small" onClick={() => onTarget(v.onboarding.target!)}>
            Show me on the map
          </button>
        )}
        <button className="btn ghost small" onClick={() => setHidden(true)}>
          I’ll explore
        </button>
      </div>
    </div>
  )
}
