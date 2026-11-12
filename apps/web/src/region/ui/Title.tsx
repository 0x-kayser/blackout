/** The welcome gate: choose a saved company, start as a guest, or sign in before the region opens. */
import { useEffect, useMemo, useState } from 'react'
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
  { number: '01', title: 'Bring Eastside back', detail: 'Restore the homes, start Kestrel and build your first reserve.' },
  { number: '02', title: 'Earn Regional Producer', detail: 'Deliver 3,000 MWh to open larger plant builds.' },
  { number: '03', title: 'Become System Partner', detail: 'Deliver 15,000 MWh and maintain 97% reliability.' },
  { number: '04', title: 'Earn Grid Anchor', detail: 'Reach 45,000 MWh and maintain 98% reliability.' },
]

const TOUR = [
  {
    label: 'THE FIRST NIGHT', icon: '🌃', title: 'Bring Eastside back',
    detail: 'Your opening rescue is guided step by step: restore the battery, start Kestrel, then build a reserve. Each prompt points to the exact action in the city.',
  },
  {
    label: 'RUN THE GRID', icon: '⚡', title: 'Keep power ahead of demand',
    detail: 'Dispatch plants when the region runs short, build where the city needs capacity, and use the map to spot dark districts and full power lines.',
  },
  {
    label: 'THE MARKET', icon: '🏪', title: 'Trade with living merchants',
    detail: 'Ship delays and rationing tighten stock and move fuel prices. Buy a reserve, let automatic top-ups spend, or hold cash and risk a plant running short. Your choice changes what Vesper can sell.',
  },
  {
    label: 'YOUR CAMPAIGN', icon: '🏆', title: 'Earn permits. Take on the crisis.',
    detail: 'Deliver power and protect reliability to earn four operating permits and unlock stronger builds. Each week brings a shared three-day crisis; your saved city stays separate.',
  },
] as const

export function Title(p: TitleProps) {
  const skyline = useSkyline()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [tourStep, setTourStep] = useState<number | null>(null)
  const auth = p.config?.auth
  const guestPlay = !!auth?.guestPlay
  const canSignIn = !!(auth?.google || auth?.email)
  const host = { config: p.config, boot: p.onSignedIn, toast: () => undefined } as unknown as Game
  const signedIn = p.player?.kind === 'registered'
  const returningGuest = p.player?.kind === 'guest'

  useEffect(() => {
    if (tourStep === null) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTourStep(null)
      if (e.key === 'ArrowRight') setTourStep((step) => step === null ? null : Math.min(TOUR.length - 1, step + 1))
      if (e.key === 'ArrowLeft') setTourStep((step) => step === null ? null : Math.max(0, step - 1))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [tourStep])

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
        <div className="title-main">
          <section className="title-intro">
            <p className="title-overline">VESPER REGION · EMERGENCY SHIFT 01</p>
            <h1 className="title-logo">BLACK<span>OUT</span></h1>
            <h2 className="title-claim">The lights are out in Eastside.</h2>
            <p className="title-tag">Take control of the grid. Restore the homes, bring Kestrel online, and build enough reserve to carry Vesper through the night.</p>
            <div className="title-signal"><span className="title-signal-dot" /> <b>FIRST OPERATION</b><span>Restore Eastside</span></div>
            <button className="title-tour-launch" onClick={() => setTourStep(0)}>🎮 &nbsp;How to play · 1 minute <span aria-hidden>→</span></button>
          </section>

          <section className="title-launch" aria-label="Enter the game">
            <p className="title-launch-kicker">CHOOSE YOUR OPERATOR</p>
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
          </section>
        </div>

        <section className="route-preview" aria-label="Campaign route">
          <div className="route-heading">
            <span>THE VESPER CAMPAIGN</span>
            <small>Four permits · one growing company</small>
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

        <p className="title-loop">Read the warning → choose where your cash and fuel go → watch prices, the grid and businesses react → earn the next permit. Your company keeps its progress between visits.</p>
        <label className="title-music">
          <input type="checkbox" checked={p.music} onChange={(e) => p.onMusic(e.target.checked)} /> ♪ Music
        </label>
      </main>
      {tourStep !== null && (
        <div className="title-tour-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setTourStep(null) }}>
          <section className="title-tour" role="dialog" aria-modal="true" aria-labelledby="title-tour-heading">
            <header className="title-tour-header">
              <div><p className="title-tour-kicker">A QUICK TOUR · {tourStep + 1} OF {TOUR.length}</p><div className="title-tour-progress" aria-hidden><i style={{ width: `${((tourStep + 1) / TOUR.length) * 100}%` }} /></div></div>
              <button className="title-tour-close" aria-label="Close tour" onClick={() => setTourStep(null)}>×</button>
            </header>
            <div className="title-tour-content" aria-live="polite">
              <span className="title-tour-icon" aria-hidden>{TOUR[tourStep].icon}</span>
              <p className="title-tour-kicker">{TOUR[tourStep].label}</p>
              <h2 id="title-tour-heading">{TOUR[tourStep].title}</h2>
              <p>{TOUR[tourStep].detail}</p>
              {tourStep === 1 && (
                <div className="title-tour-controls" aria-label="Game controls">
                  <span>⚡ <b>Power</b><small>Dispatch plants</small></span>
                  <span>🏗️ <b>Build</b><small>Expand the grid</small></span>
                  <span>📈 <b>Market</b><small>Buy and sell</small></span>
                  <span>🗼 <b>Map</b><small>Find trouble</small></span>
                  <span>🏢 <b>Company</b><small>Manage finances</small></span>
                </div>
              )}
            </div>
            <footer className="title-tour-footer">
              <button className="title-tour-skip" onClick={() => setTourStep(null)}>Skip tour</button>
              <div>
                {tourStep > 0 && <button className="btn ghost" onClick={() => setTourStep(tourStep - 1)}>← Back</button>}
                {tourStep < TOUR.length - 1
                  ? <button className="btn primary" onClick={() => setTourStep(tourStep + 1)}>Next →</button>
                  : <button className="btn primary" onClick={() => setTourStep(null)}>Got it · choose how to play</button>}
              </div>
            </footer>
          </section>
        </div>
      )}
    </div>
  )
}
