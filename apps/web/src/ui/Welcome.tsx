import { useState } from 'react'
import { explainError } from '../api/client'
import { CityCanvas } from '../city/CityCanvas'
import type { Game } from '../game/useGame'
import { WeeklyCard } from './Challenge'
import { SignInOptions } from './SignIn'

export function Welcome({ g, onPlay, onChallenge, onLab, onHelp, reducedMotion, music, onToggleMusic }: { g: Game; onPlay: () => Promise<void>; onChallenge: () => Promise<void>; onLab: () => void; onHelp: () => void; reducedMotion: boolean; music?: boolean; onToggleMusic?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const p = g.player
  const canSignIn = !!g.config?.auth.privy

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
  const start = () => go(async () => { if (!p) await g.playAsGuest(); await onPlay() })

  return (
    <section className="welcome2">
      <div className="welcome-city" aria-hidden>
        <CityCanvas state={null} attract reducedMotion={reducedMotion} label="City skyline" />
      </div>
      <div className="welcome-card">
        <p className="eyebrow amber">ACT I: STREET MICROGRID · STRAIT OIL SHOCK & COP31</p>
        <h1>BLACK<span>OUT</span></h1>
        <p className="tagline">Every light changes the economy.</p>
        {g.booting ? (
          <p className="intro">Connecting to your city…</p>
        ) : g.bootError ? (
          <>
            <p className="warn">{g.bootError}</p>
            <button className="button" onClick={() => void g.boot()}>Retry</button>
          </>
        ) : (
          <>
            <p className="intro">Strait of Hormuz tanker delays and the COP31 Carbon Accord have pushed Vesper’s grid to the breaking point. Starting from Mama Ade’s 5 kW shed, keep Market Quarter lit, beat VoltLine to every customer, and earn your promotion to the Regional Grid (<a href="/" style={{ color: 'inherit' }}>Act II</a>).</p>
            <ol className="howto3" aria-label="How you play">
              <li><b>⚡ Sell power</b><span>A shop goes dark. Take its call, plug it into your generator, get paid for every kWh.</span></li>
              <li><b>⛽ Run on diesel</b><span>Buy fuel before prices jump. Every merchant prices from its own stock and real 2026 oil.</span></li>
              <li><b>⇄ Trade with other cities</b><span>Sell spare fuel to other players and traders on the shared Exchange, even while you're away.</span></li>
            </ol>
            <div className="welcome-actions">
              <button className="button primary big" disabled={busy} onClick={() => void start()}>
                {p?.activeRunId ? 'Continue your city' : 'Play now'} <b>→</b>
              </button>
              {p?.kind === 'registered' && <span className="signed-as">Signed in as <b>{p.displayName}</b></span>}
            </div>
            {canSignIn && p?.kind !== 'registered' && (
              <div className="welcome-signin">
                <p className="divider"><span>{p?.activeRunId ? 'Keep this city on every device' : 'or sign in to play anywhere'}</span></p>
                <SignInOptions g={g} onSignedIn={onPlay} />
              </div>
            )}
            <WeeklyCard onPlay={() => void go(async () => { if (!p) await g.playAsGuest(); await onChallenge() })} />
            <div className="welcome-links">
              <button onClick={onLab}>Economy Lab</button>
              <button onClick={onHelp}>How to play</button>
              <a className="button mini" href="/" style={{ textDecoration: 'none' }}>Act II: Regional Grid →</a>
              {onToggleMusic && <button onClick={onToggleMusic} aria-pressed={!!music}>{music ? '🎵 Music on' : '🎶 Music off'}</button>}
              {p && <button onClick={() => void g.logout()}>Log out</button>}
            </div>
          </>
        )}
        {msg && <p className="warn">{msg}</p>}
      </div>
      <footer className="welcome-foot">Game credits are fictional · Your city saves automatically</footer>
    </section>
  )
}
