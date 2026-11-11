/** The System Pulse (§33): one bar, five numbers, and the question that matters right now. */
import { useRef } from 'react'
import type { RegionView } from '@blackout/shared'
import { credits } from '../format'

const WX: Record<string, string> = { clear: '☀️', cloudy: '⛅', rain: '🌧️', storm: '⛈️', heatwave: '🔥' }

export function PulseBar({ v, simple, company, onCompany, player, conn, onSettings, onSignOut, onHome, sound, onSound }: { v: RegionView; simple?: boolean; company?: string | null; onCompany?: () => void; player: { displayName: string; kind: string; companyNamed?: boolean } | null; conn: string; onSettings: () => void; onSignOut: () => Promise<void>; onHome: () => void; sound: boolean; onSound: () => void }) {
  const accountMenu = useRef<HTMLDetailsElement>(null)
  const p = v.pulse
  const tone = p.status === 'blackout' ? 'crisis' : p.status === 'shortfall' ? 'warn' : p.status === 'tight' ? 'tight' : 'ok'
  const dark = v.nodes.filter((n) => n.shedKw > 0).length
  const gridLabel = p.status === 'blackout' ? 'DARK' : p.status === 'shortfall' ? 'RUNNING SHORT' : p.status === 'tight' ? 'LOW RESERVE' : 'ALL LIT'
  const gridDetail = dark > 0 ? `${dark} district${dark === 1 ? '' : 's'} dark` : undefined
  const registered = player?.kind === 'registered'
  const closeAccount = () => accountMenu.current?.removeAttribute('open')
  return (
    <header className={`pulse ${tone}`}>
      <div className="pulse-row">
        <div className="brand-block">
          <button className="brand" onClick={onHome} title="Back to the whole region">
            BLACKOUT
          </button>
          {company && !simple && (
            <button className="company-chip" onClick={onCompany} title="Your company · tap to rename">
              {company}
            </button>
          )}
        </div>
        <div className={`pulse-metrics ${simple ? 'simple' : ''}`}>
          <Metric label="THE CITY" value={gridLabel} unit={gridDetail ? ` · ${gridDetail}` : undefined} tone={tone} />
          <Metric label="CASH" value={credits(p.cashCc)} tone="gold" />
        </div>
        <div className="pulse-side">
          <span className="clock" title={v.weather.label}>
            {WX[v.weather.condition] ?? ''} {v.clock.label} · {Math.round(v.weather.tempC)}°
          </span>
          <button className="icon-btn" onClick={onSound} aria-label={sound ? 'Mute sound' : 'Turn sound on'} title={sound ? 'Sound on' : 'Sound off'}>
            {sound ? '🔊' : '🔈'}
          </button>
          <details className="account-menu" ref={accountMenu}>
            <summary className="account-trigger" aria-label="Open player account">
              <span className="account-avatar" aria-hidden>{(player?.displayName || 'P').slice(0, 1).toUpperCase()}</span>
              <span>Account</span>
            </summary>
            <div className="account-popover">
              <b>{player?.companyNamed ? player.displayName : registered ? 'Your company' : 'Guest company'}</b>
              <small>{registered ? 'Progress saved to your account' : 'Progress saved in this browser'}</small>
              {!registered && <small>Sign in before leaving to keep this company across devices.</small>}
              {!player?.companyNamed && <button onClick={() => { closeAccount(); onCompany?.() }}>Name your company</button>}
              <button className="account-signout" onClick={() => { closeAccount(); void onSignOut() }}>Sign out</button>
            </div>
          </details>
          <button className="icon-btn settings-trigger" onClick={onSettings} aria-label="Open settings" title="Settings">
            ⚙︎
          </button>
        </div>
      </div>
      {!simple && <p className="question" aria-live="polite">
        <span className={`dot ${tone}`} /> {v.question}
        <span className="zoom">
          {conn !== 'live' && <em>{conn === 'reconnecting' ? ' · reconnecting…' : ' · connecting…'}</em>}
          {v.paused && conn === 'live' && <em> · paused</em>}
          {v.mode === 'challenge' && <em> · weekly crisis</em>}
        </span>
      </p>}
    </header>
  )
}

function Metric({ label, value, unit, tone }: { label: string; value: string; unit?: string; tone?: string }) {
  return (
    <div className={`metric ${tone ?? ''}`}>
      <span>{label}</span>
      <b>
        {value}
        {unit && <small>{unit}</small>}
      </b>
    </div>
  )
}
