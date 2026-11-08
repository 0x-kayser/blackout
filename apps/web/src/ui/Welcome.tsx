import { useState } from 'react'
import { explainError } from '../api/client'
import { sendEmailLink, signInWithGoogle } from '../api/auth'
import { CityCanvas } from '../city/CityCanvas'
import type { Game } from '../game/useGame'
import { WeeklyCard } from './Challenge'

export function Welcome({ g, onPlay, onChallenge, onLab, onHelp, reducedMotion }: { g: Game; onPlay: () => Promise<void>; onChallenge: () => Promise<void>; onLab: () => void; onHelp: () => void; reducedMotion: boolean }) {
  const [mode, setMode] = useState<'home' | 'signin'>('home')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const p = g.player
  const auth = g.config?.auth

  const go = async (fn: () => Promise<void>) => {
    setBusy(true)
    setMsg(null)
    try {
      await fn()
    } catch (e) {
      setMsg(explainError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="welcome2">
      <div className="welcome-city" aria-hidden>
        <CityCanvas state={null} attract reducedMotion={reducedMotion} label="City skyline" />
      </div>
      <div className="welcome-card">
        <p className="eyebrow amber">EMERGENCY POWER FOR A CITY THAT KEEPS GOING DARK</p>
        <h1>BLACK<span>OUT</span></h1>
        <p className="tagline">Every light changes the economy.</p>
        {g.booting ? (
          <p className="intro">Connecting to your city…</p>
        ) : g.bootError ? (
          <>
            <p className="warn">{g.bootError}</p>
            <button className="button" onClick={() => void g.boot()}>Retry</button>
          </>
        ) : mode === 'home' ? (
          <>
            <p className="intro">Restore power, keep shops open, and respond to a fuel market that changes with stock, demand, and world conditions.</p>
            <div className="welcome-actions">
              {p?.activeRunId ? (
                <button className="button primary" disabled={busy} onClick={() => void go(onPlay)}>Continue your city <b>→</b></button>
              ) : (
                <button className="button primary" disabled={busy} onClick={() => void go(async () => { if (!p) await g.playAsGuest(); await onPlay() })}>{p ? 'Start your city' : 'Play now'} <b>→</b></button>
              )}
              {!p || p.kind === 'guest' ? <button className="button secondary" onClick={() => setMode('signin')}>Sign in</button> : <span className="signed-as">Signed in as <b>{p.displayName}</b></span>}
            </div>
            <WeeklyCard onPlay={() => void go(async () => { if (!p) await g.playAsGuest(); await onChallenge() })} />
            <div className="welcome-links">
              <button onClick={onLab}>Economy Lab</button>
              <button onClick={onHelp}>How to play</button>
              {p && <button onClick={() => void g.logout()}>Log out</button>}
            </div>
          </>
        ) : (
          <div className="signin">
            <p className="intro">Sign in to take this city with you across devices.</p>
            {auth?.google && <button className="button wide google" disabled={busy} onClick={() => void go(signInWithGoogle)}>Continue with Google</button>}
            {auth?.email && (
              <form onSubmit={(e) => { e.preventDefault(); void go(async () => { await sendEmailLink(email); setMsg(`We sent a sign-in link to ${email}. Open it on this device.`) }) }}>
                <input type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email address" />
                <button className="button wide" disabled={busy}>Continue with email</button>
              </form>
            )}
            {!auth?.google && !auth?.email && <p className="fine">Google and email sign-in are not configured on this server. You can still start and save a guest city here.</p>}
            <button className="button wide secondary" disabled={busy} onClick={() => void go(async () => { if (!p) await g.playAsGuest(); await onPlay() })}>Play as guest</button>
            <p className="fine">{auth?.xDeferredReason}</p>
            <button className="text-link" onClick={() => setMode('home')}>← Back</button>
          </div>
        )}
        {msg && <p className="ok-line">{msg}</p>}
      </div>
      <footer className="welcome-foot">Game credits are fictional · Your city saves automatically</footer>
    </section>
  )
}
