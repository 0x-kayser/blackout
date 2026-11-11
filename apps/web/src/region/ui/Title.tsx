/** The welcome gate: choose a saved company, start as a guest, or sign in before the region opens. */
import { useMemo, useState } from 'react'
import type { PublicConfig } from '@blackout/shared'
import { SignInOptions } from '../../ui/SignIn'
import type { Game } from '../../game/useGame'

export interface TitleProps {
  config: PublicConfig | null
  player: { displayName: string; kind: string; companyNamed: boolean } | null
  ready: boolean
  music: boolean
  onMusic: (on: boolean) => void
  onContinue: () => Promise<void>
  onSignOut: () => Promise<void>
  onGuest: () => Promise<void>
  onSignedIn: () => Promise<void>
}

/** A deterministic skyline: building heights and lit windows stay the same each visit. */
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
      return { i, h, w, cols, lit, district: Math.floor(i / 6) }
    })
  }, [])
}

const ROUTE = [
  { number: '01', title: 'Restore Eastside', detail: 'Three hands-on moves get the first district through the blackout.' },
  { number: '02', title: 'Deliver 3,000 MWh', detail: 'Earn Regional Producer and open larger plant builds.' },
  { number: '03', title: 'Hold 97% reliability', detail: 'Deliver 15,000 MWh to earn System Partner.' },
  { number: '04', title: 'Reach Grid Anchor', detail: 'Deliver 45,000 MWh and hold 98% reliability.' },
]

export function Title(p: TitleProps) {
  const skyline = useSkyline()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const auth = p.config?.auth
  const guestPlay = !!auth?.guestPlay
  const canSignIn = !!(auth?.google || auth?.email)
  const host = { config: p.config, boot: p.onSignedIn, toast: () => undefined } as unknown as Game
  const signedIn = p.player?.kind === 'registered'
  const returningGuest = p.player?.kind === 'guest'

  const go = async (fn: () => Promise<void>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
    } catch (e) {
      setErr((e as Error).message || 'Could not open your company. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const enterAsGuest = () => go(returningGuest ? p.onContinue : p.onGuest)

  return (
    <div className="title-screen">
      <div className="title-sky" aria-hidden>
        <div className="title-glow" />
        <div className="title-skyline">
          {skyline.map((b) => (
            <div key={b.i} className={`tb d${b.district}`} style={{ height: b.h, width: b.w, gridTemplateColumns: `repeat(${b.cols}, 1fr)` }}>
              {b.lit.map((on, k) => <i key={k} className={on ? 'on' : ''} />)}
            </div>
          ))}
        </div>
        <div className="title-lines" />
      </div>

      <main className="title-card">
        <p className="title-overline">VESPER REGION · POWER COMPANY SIMULATION</p>
        <h1 className="title-logo">BLACK<span>OUT</span></h1>
        <p className="title-tag">Build a power company from emergency dispatch to regional grid operator. Keep Vesper lit, grow through earned permits, and trade in a market that reacts to every choice.</p>

        <div className="title-actions">
          {!p.ready && <p className="title-loading" role="status">Checking sign-in and saved company…</p>}

          {p.ready && p.player && (
            <div className="title-return">
              <p className="title-return-label">{signedIn ? 'YOUR SAVED COMPANY' : 'GUEST COMPANY'}</p>
              <b>{p.player.companyNamed ? p.player.displayName : 'Your company is ready'}</b>
              <small>{signedIn ? 'Saved to your account · available on your other devices' : 'Saved in this browser · sign in to carry it to another device'}</small>
              {(signedIn || guestPlay) && (
                <button className="btn primary title-play" disabled={busy} onClick={() => void go(p.onContinue)}>
                  {busy ? 'Opening Vesper…' : '▶ Continue to your company'}
                </button>
              )}
              {signedIn && <button className="title-switch" disabled={busy} onClick={() => void go(p.onSignOut)}>Use another account</button>}
            </div>
          )}

          {p.ready && canSignIn && !signedIn && (
            <div className="title-auth">
              <p className="title-signin-label">{returningGuest ? 'SAVE THIS COMPANY TO YOUR ACCOUNT' : 'CHOOSE HOW TO ENTER'}</p>
              <SignInOptions g={host} compact onSignedIn={p.onSignedIn} />
            </div>
          )}

          {p.ready && guestPlay && !signedIn && !returningGuest && (
            <>
              {canSignIn && <p className="title-or">or</p>}
              <button className="btn title-guest" disabled={busy} onClick={() => void enterAsGuest()}>
                {busy ? 'Opening Vesper…' : returningGuest ? 'Continue as guest' : '▶ Play as guest'}
              </button>
              {!returningGuest && <small className="fine">Guest play starts immediately. Link Google later to keep this company across devices.</small>}
            </>
          )}

          {p.ready && !canSignIn && !guestPlay && <p className="warn">Sign-in isn’t available right now. Please try again later.</p>}
          {err && <p className="warn" role="alert">{err}</p>}
        </div>

        <section className="route-preview" aria-label="Campaign route">
          <div className="route-heading">
            <span>THE VESPER CAMPAIGN</span>
            <small>Build your way up the grid</small>
          </div>
          <ol>
            {ROUTE.map((step) => (
              <li key={step.number}>
                <span className="route-number">{step.number}</span>
                <div><b>{step.title}</b><small>{step.detail}</small></div>
              </li>
            ))}
          </ol>
          <p className="route-weekly"><span aria-hidden>↻</span> Each week brings a shared regional crisis to solve and score.</p>
        </section>

        <p className="title-loop">Your city is saved between visits. The weekly crisis drill is optional; there are no login streak penalties.</p>
        <label className="title-music">
          <input type="checkbox" checked={p.music} onChange={(e) => p.onMusic(e.target.checked)} /> ♪ Music
        </label>
      </main>
    </div>
  )
}
