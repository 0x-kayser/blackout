/** The System Pulse (§33): one bar, five numbers, and the question that matters right now. */
import type { RegionView } from '@blackout/shared'
import { credits, mw, price } from '../format'
import type { ZoomLevel } from '../scene/World3D'

const WX: Record<string, string> = { clear: '☀️', cloudy: '⛅', rain: '🌧️', storm: '⛈️', heatwave: '🔥' }

export function PulseBar({ v, simple, company, onCompany, conn, zoom, onSettings, onHome, sound, onSound }: { v: RegionView; simple?: boolean; company?: string | null; onCompany?: () => void; conn: string; zoom: ZoomLevel; onSettings: () => void; onHome: () => void; sound: boolean; onSound: () => void }) {
  const p = v.pulse
  const tone = p.status === 'blackout' ? 'crisis' : p.status === 'shortfall' ? 'warn' : p.status === 'tight' ? 'tight' : 'ok'
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
          {!simple && <>
          <Metric label="DEMAND" value={mw(p.demandKw)} />
          <Metric label="AVAILABLE" value={mw(p.availableKw)} />
          <Metric label="RESERVE" value={`${p.reserveKw >= 0 ? '+' : '−'}${mw(Math.abs(p.reserveKw))}`} tone={p.reserveKw < 0 ? 'crisis' : p.reserveKw < p.demandKw * 0.08 ? 'warn' : 'ok'} />
          <Metric label="SPOT PRICE" value={`${price(p.spotCcPerMWh)}`} unit="/MWh" tone={p.spotCcPerMWh >= 25_000 ? 'warn' : undefined} />
          </>}
          <Metric label="CASH" value={credits(p.cashCc)} tone="gold" />
        </div>
        <div className="pulse-side">
          <span className="clock" title={v.weather.label}>
            {WX[v.weather.condition] ?? ''} {v.clock.label} · {Math.round(v.weather.tempC)}°
          </span>
          <button className="icon-btn" onClick={onSound} aria-label={sound ? 'Mute sound' : 'Turn sound on'} title={sound ? 'Sound on' : 'Sound off'}>
            {sound ? '🔊' : '🔈'}
          </button>
          <button className="icon-btn" onClick={onSettings} aria-label="Settings, account and Verify" title="Settings · Verify · About">
            ⚙︎
          </button>
        </div>
      </div>
      {!simple && <p className="question" aria-live="polite">
        <span className={`dot ${tone}`} /> {v.question}
        <span className="zoom">
          {zoom}
          {conn !== 'live' && <em> · {conn === 'reconnecting' ? 'reconnecting…' : 'connecting…'}</em>}
          {v.paused && conn === 'live' && <em> · paused</em>}
          {v.mode === 'challenge' && <em> · weekly challenge</em>}
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
