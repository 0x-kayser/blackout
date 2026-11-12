/**
 * The story (§50): events as they happen, told by the people they happen to, with the chain that caused them.
 * New crises surface as toasts; the feed keeps the last forty.
 */
import { useEffect, useRef, useState } from 'react'
import type { RegionEvent, RegionView } from '@blackout/shared'
import type { Selection } from '../scene/World3D'

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

export function Feed({ v, onSelect, onClose }: { v: RegionView; onSelect: (s: Selection) => void; onClose: () => void }) {
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])
  const bySeq = new Map(v.events.map((e) => [e.seq, e]))
  const time = (interval: number) => {
    const total = 17 * 60 + 10 + interval * 5
    return `${String(Math.floor((total % 1440) / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  }
  return (
    <div className="sheet feed" role="dialog" aria-label="What happened">
      <button className="close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <h3>What happened</h3>
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
