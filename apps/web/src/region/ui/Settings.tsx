/**
 * Account, operating permits, the rotating weekly challenge, the Economy Lab, and game information.
 */
import { useEffect, useRef, useState } from 'react'
import type { PublicConfig, RegionView } from '@blackout/shared'
import { SignInOptions } from '../../ui/SignIn'
import type { Game } from '../../game/useGame'
import { regionApi, type ChallengeInfo, type LabResult, type LeaderboardRow } from '../api'
import { credits, mw, pct, price } from '../format'
import { Section, Spark, Stat } from './Bits'
import { NameCompany } from './Company'
import { Career } from './Progression'

export type SettingsTab = 'account' | 'career' | 'challenge' | 'lab' | 'about'

export interface SettingsProps {
  v: RegionView
  onClose: () => void
  config: PublicConfig | null
  player: { displayName: string; kind: string; companyNamed?: boolean } | null
  onRename: (name: string) => Promise<{ ok: boolean; message: string }>
  onSignOut: () => Promise<void>
  boot: () => Promise<void>
  toast: (text: string, tone?: 'info' | 'good' | 'bad') => void
  sound: boolean
  music: boolean
  onSound: (on: boolean) => void
  onMusic: (on: boolean) => void
  quality: 'high' | 'low'
  onQuality: (q: 'high' | 'low') => void
  onChallenge: () => Promise<void>
  onLive: () => Promise<void>
  initialTab?: SettingsTab
}

export function Settings(p: SettingsProps) {
  const [tab, setTab] = useState<SettingsTab>(p.initialTab ?? 'account')
  return (
    <div className="modal-back" onClick={p.onClose}>
      <div className="modal" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={p.onClose} aria-label="Close">
          ×
        </button>
        <nav className="tabs">
          {(['account', 'career', 'challenge', 'lab', 'about'] as SettingsTab[]).map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {{ account: 'Account', career: 'Permits', challenge: 'Weekly challenge', lab: 'Economy Lab', about: 'About' }[t]}
            </button>
          ))}
        </nav>
        <div className="modal-body">
          {tab === 'account' && <Account {...p} />}
          {tab === 'career' && <Career v={p.v} />}
          {tab === 'challenge' && <Challenge {...p} />}
          {tab === 'lab' && <Lab />}
          {tab === 'about' && <About {...p} />}
        </div>
      </div>
    </div>
  )
}

function Account(p: SettingsProps) {
  const host = { config: p.config, boot: p.boot, toast: p.toast } as unknown as Game
  const registered = p.player?.kind === 'registered'
  return (
    <>
      <h3>{p.player?.companyNamed ? p.player.displayName : 'Your company'}</h3>
      <p className="fine">{registered ? 'Your region is saved to your account and opens on any device.' : 'You’re playing as a guest on this device. Sign in and your region comes with you.'}</p>
      <Section title="Company name">
        <NameCompany current={p.player?.companyNamed ? p.player.displayName : ''} title={p.player?.companyNamed ? 'Rename your company' : 'Name your company'} onSave={p.onRename} />
      </Section>
      {!registered && <SignInOptions g={host} onSignedIn={p.boot} />}
      {registered && (
        <div className="row">
          <button className="btn" onClick={() => void p.onSignOut()}>
            Sign out
          </button>
        </div>
      )}
      <Section title="Preferences">
        <label className="toggle">
          <input type="checkbox" checked={p.sound} onChange={(e) => p.onSound(e.target.checked)} /> Sound effects
        </label>
        <label className="toggle">
          <input type="checkbox" checked={p.music} onChange={(e) => p.onMusic(e.target.checked)} /> Music
        </label>
        <label className="toggle">
          <input type="checkbox" checked={p.quality === 'low'} onChange={(e) => p.onQuality(e.target.checked ? 'low' : 'high')} /> Battery saver (fewer effects, no shadows)
        </label>
      </Section>
    </>
  )
}

function Challenge(p: SettingsProps) {
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null)
  const [challenge, setChallenge] = useState<ChallengeInfo | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    regionApi.leaderboard().then((r) => setRows(r.entries), () => setRows([]))
    regionApi.challenge().then((r) => setChallenge(r.challenge), () => setChallenge(null))
  }, [])
  return (
    <>
      <h3>Weekly challenge</h3>
      <Section title={`${challenge?.week.replace('-', ' · ') ?? 'This week'}${challenge ? ` · ${challenge.name}` : ''}`}>
        <p className="fine">{challenge?.description ?? 'A shared three-day regional scenario.'} Everyone gets the same seed and starting conditions. Finish the three game days (about 15 minutes) to post a score on this week’s board.</p>
        <p className="fine">Score rewards profit and regional business output, and accounts for power left unserved and CO₂ emissions. The scenario rotates weekly; your live region stays saved while you play it.</p>
      </Section>
      <div className="row">
        {p.v.mode === 'challenge' ? (
          <button className="btn" disabled={busy} onClick={async () => { setBusy(true); await p.onLive(); setBusy(false) }}>
            Back to my region
          </button>
        ) : (
          <button className="btn primary" disabled={busy} onClick={async () => { setBusy(true); await p.onChallenge(); setBusy(false) }}>
            Start this week’s run
          </button>
        )}
      </div>
      <Section title="Leaderboard">
        {rows === null && <p className="fine">Loading…</p>}
        {rows?.length === 0 && <p className="fine">No finished runs yet this week. Be first.</p>}
        {rows && rows.length > 0 && (
          <table className="board">
            <thead>
              <tr>
                <th>#</th>
                <th>Operator</th>
                <th>Score</th>
                <th>Profit</th>
                <th>Dark</th>
                <th>CO₂</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.regionId}>
                  <td>{r.rank}</td>
                  <td>{r.name}</td>
                  <td>{r.score.toLocaleString('en-US')}</td>
                  <td>{credits(r.profitCc)}</td>
                  <td>{r.unservedMWh} MWh</td>
                  <td>{r.emissionsT} t</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  )
}

function Lab() {
  const [seed, setSeed] = useState(42)
  const [lab, setLab] = useState<{ gasHeavy: LabResult; solarStorage: LabResult } | null>(null)
  const [busy, setBusy] = useState(false)
  const [frame, setFrame] = useState<number | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const run = async () => {
    setBusy(true)
    try {
      setLab((await regionApi.lab(seed)).lab)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current)
  }, [])
  const play = () => {
    if (timer.current) clearInterval(timer.current)
    setFrame(0)
    let i = 0
    timer.current = setInterval(() => {
      i += 1
      if (i >= 60) {
        clearInterval(timer.current!)
        timer.current = null
        setFrame(null)
        return
      }
      setFrame(i)
    }, 1_000)
  }
  const col = (r: LabResult, title: string) => {
    const f = frame !== null ? r.frames[frame] : null
    return (
      <div className="lab-col">
        <h4>{title}</h4>
        <Stat label="Profit" value={credits(r.profitCc)} tone={r.profitCc >= 0 ? 'ok' : 'crisis'} />
        <Stat label="Left dark" value={`${r.unservedMWh} MWh`} />
        <Stat label="Your CO₂" value={`${r.emissionsT.toLocaleString('en-US')} t`} />
        <Stat label="Average price" value={`${price(r.avgPriceCcPerMWh)}/MWh`} />
        <Stat label="Business output" value={pct(r.regionOutputBps)} />
        <Stat label="Score" value={r.score.toLocaleString('en-US')} />
        <Spark values={r.frames.map((x) => x.priceCcPerMWh)} tone="amber" />
        <Spark values={r.frames.map((x) => x.cashCc)} tone="gold" height={24} />
        {f && (
          <p className="fine replay-frame">
            {f.label}: demand {mw(f.demandKw)}, price {price(f.priceCcPerMWh)}, yours {mw(f.playerKw)}, cash {credits(f.cashCc)}
            {f.shedKw > 0 ? `, ${mw(f.shedKw)} dark` : ''}
          </p>
        )}
        <small className="fine">trace {r.traceHash.slice(0, 12)}…</small>
      </div>
    )
  }
  return (
    <>
      <h3>Economy Lab</h3>
      <p className="fine">The same region and seed, seven game days, two strategies: spend the starter grant and a loan on gas turbines and a diesel peaker, or on solar and batteries. Same weather, same trips, same suppliers. Same seed, same result, every time.</p>
      <div className="row">
        <label className="slider">
          Seed
          <input type="number" min={1} max={999999} value={seed} onChange={(e) => setSeed(Math.max(1, Number(e.target.value) || 1))} />
        </label>
        <button className="btn primary" disabled={busy} onClick={run}>
          {busy ? 'Simulating 7 days…' : 'Run both'}
        </button>
        {lab && (
          <button className="btn" onClick={play} disabled={frame !== null}>
            ▶ 60-second replay
          </button>
        )}
      </div>
      {lab && (
        <div className="lab">
          {col(lab.gasHeavy, 'Gas-heavy')}
          {col(lab.solarStorage, 'Solar + storage')}
        </div>
      )}
    </>
  )
}

function About(p: SettingsProps) {
  return (
    <>
      <h3>About BLACKOUT</h3>
      <p>You run a power company in the Vesper region. Seven load centres, six transmission lines, a dozen businesses and households with their own balance sheets, six fuel suppliers, two banks, a regulator and a rival, VoltLine. Every five game minutes the market clears: cheapest power first, line limits respected, one price per load centre.</p>
      <p>When there isn’t enough power, customers who can switch off do; when even that isn’t enough, the lights go out. Businesses lose money, lay people off and close; steel stops and every new plant costs more. Your plants, lines and batteries change all of that.</p>
      <Section title="Controls">
        <p className="fine">Drag to pan · scroll or pinch to zoom · right-drag or two fingers to rotate · tap anything to inspect it.</p>
      </Section>
      <Section title="Elsewhere">
        <a className="btn ghost" href="/city">
          Classic city mode
        </a>
      </Section>
      <p className="fine">{p.v.regionId} · interval {p.v.interval}</p>
    </>
  )
}
