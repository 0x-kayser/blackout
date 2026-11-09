/** Name your power company: the name every other player sees in Vesper Market. */
import { useMemo, useState } from 'react'

const IDEAS = ['Eastside Power', 'Kestrel Energy', 'Vesper Light & Power', 'Northbelt Grid Co.', 'Harbor Volt', 'Lantern Power', 'Ridgeline Energy', 'Tidewater Electric', 'Ember & Co.', 'Brightline Utility']
const VALID = /^[\p{L}\p{N} ._'&-]{2,32}$/u

export function NameCompany({ current, onSave, onLater, title = 'Name your power company' }: { current?: string; onSave: (name: string) => Promise<{ ok: boolean; message: string }>; onLater?: () => void; title?: string }) {
  const ideas = useMemo(() => [...IDEAS].sort(() => Math.random() - 0.5).slice(0, 3), [])
  const [name, setName] = useState(current ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const trimmed = name.trim()
  const ok = VALID.test(trimmed)
  const save = async (n: string) => {
    setBusy(true)
    setErr(null)
    const r = await onSave(n.trim())
    setBusy(false)
    if (!r.ok) setErr(r.message)
  }
  return (
    <div className="name-company" role="dialog" aria-label={title}>
      <b>{title}</b>
      <p className="fine">Other companies see it on every trade you make and every shop you invest in.</p>
      <div className="row">
        {ideas.map((i) => (
          <button key={i} className="btn small" disabled={busy} onClick={() => void save(i)}>
            {i}
          </button>
        ))}
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          if (ok) void save(trimmed)
        }}
      >
        <input className="name-input" value={name} maxLength={32} placeholder="Or type your own" aria-label="Company name" onChange={(e) => setName(e.target.value)} />
        <button className="btn primary small" type="submit" disabled={busy || !ok}>
          That's us
        </button>
        {onLater && (
          <button className="btn ghost small" type="button" onClick={onLater}>
            Later
          </button>
        )}
      </form>
      {trimmed && !ok && <p className="warn-line">2–32 letters, numbers, spaces and . _ ' & -</p>}
      {err && <p className="warn-line">{err}</p>}
    </div>
  )
}
