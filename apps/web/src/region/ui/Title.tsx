/**
 * The first page. A skyline at dusk whose districts black out and come back, the name, one line of what you do, and
 * two ways in: play now as a guest, or sign in (Google or email) so the company follows you to any device.
 */
import { useMemo, useState } from 'react'
import type { PublicConfig } from '@blackout/shared'
import { SignInOptions } from '../../ui/SignIn'
import type { Game } from '../../game/useGame'

export interface TitleProps {
  config: PublicConfig | null
  music: boolean
  onMusic: (on: boolean) => void
  onGuest: () => Promise<void>
  onSignedIn: () => Promise<void>
}

/** A deterministic skyline: building heights and lit windows from a tiny hash, so it's the same every visit. */
function useSkyline() {
  return useMemo(() => {
    let x = 7
    const r = () => ((x = (x * 9301 + 49297) % 233280) / 233280)
    return Array.from({ length: 34 }, (_, i) => {
      const h = 70 + Math.round(r() * 190)
      const w = 26 + Math.round(r() * 30)
      const cols = Math.max(2, Math.floor(w / 7))
      const rows = Math.max(3, Math.floor(h / 9))
      const lit = Array.from({ length: cols * rows }, () => r() > 0.5)
      // neighbouring buildings share a district, and each district loses power on its own beat
      return { i, h, w, cols, lit, district: Math.floor(i / 6) }
    })
  }, [])
}

export function Title(p: TitleProps) {
  const skyline = useSkyline()
  const guestPlay = !!p.config?.auth.guestPlay
  // when everyone signs in first, the sign-in options are the first thing on the page
  const [mode, setMode] = useState<'start' | 'signin'>(guestPlay ? 'start' : 'signin')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const auth = p.config?.auth
  const canSignIn = !!(auth?.google || auth?.email)
  const host = { config: p.config, boot: p.onSignedIn, toast: () => undefined } as unknown as Game

  const guest = async () => {
    setBusy(true)
    setErr(null)
    try {
      await p.onGuest()
    } catch (e) {
      setErr((e as Error).message || 'Could not start a game. Try again.')
      setBusy(false)
    }
  }

  return (
    <div className="title-screen">
      <div className="title-sky" aria-hidden>
        <div className="title-glow" />
        <div className="title-skyline">
          {skyline.map((b) => (
            <div key={b.i} className={`tb d${b.district}`} style={{ height: b.h, width: b.w, gridTemplateColumns: `repeat(${b.cols}, 1fr)` }}>
              {b.lit.map((on, k) => (
                <i key={k} className={on ? 'on' : ''} />
              ))}
            </div>
          ))}
        </div>
        <div className="title-lines" />
      </div>

      <main className="title-card">
        <h1 className="title-logo">
          BLACK<span>OUT</span>
        </h1>
        <p className="title-tag">Run a power company. Keep a region’s lights on. Trade in a market that remembers what everyone did.</p>
        {!guestPlay && <p className="title-step">Sign in to start. Your company begins with ₡300,000 to build with.</p>}

        {mode === 'start' ? (
          <div className="title-actions">
            <button className="btn primary title-play" disabled={busy} onClick={() => void guest()}>
              {busy ? 'Opening the region…' : '▶ Play as guest'}
            </button>
            {canSignIn && (
              <button className="btn title-signin" disabled={busy} onClick={() => setMode('signin')}>
                Sign in to save your company
              </button>
            )}
            <p className="fine">Guests can sign in any time later and keep everything.</p>
          </div>
        ) : (
          <div className="title-actions">
            {canSignIn ? <SignInOptions g={host} onSignedIn={p.onSignedIn} /> : <p className="warn">Sign-in isn’t set up on this server yet.</p>}
            {guestPlay && (
              <button className="text-link" onClick={() => setMode('start')}>
                ← Back
              </button>
            )}
          </div>
        )}
        {err && <p className="warn">{err}</p>}

        <ul className="title-promises">
          <li>Start as a guest</li>
          <li>Save your company to your account</li>
          <li>No fee to play</li>
        </ul>
        <label className="title-music">
          <input type="checkbox" checked={p.music} onChange={(e) => p.onMusic(e.target.checked)} /> ♪ Music
        </label>
      </main>
    </div>
  )
}
