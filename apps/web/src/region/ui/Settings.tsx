/**
 * Settings · Verify · About (§62). Account and sign-in, the weekly challenge, the Economy Lab, and Verify: where every
 * world input came from, and each settlement epoch re-hashed here in your browser.
 */
import { useEffect, useRef, useState } from 'react'
import type { PublicConfig, RegionView } from '@blackout/shared'
import { SignInOptions } from '../../ui/SignIn'
import type { Game } from '../../game/useGame'
import { regionApi, type EpochDetail, type LabResult, type LeaderboardRow } from '../api'
import { credits, mw, pct, price } from '../format'
import { Section, Spark, Stat } from './Bits'
import { NameCompany } from './Company'

type Tab = 'account' | 'challenge' | 'verify' | 'lab' | 'about'

export interface SettingsProps {
  v: RegionView
  onClose: () => void
  config: PublicConfig | null
  player: { displayName: string; kind: string; companyNamed?: boolean } | null
  onRename: (name: string) => Promise<{ ok: boolean; message: string }>
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
  initialTab?: Tab
}

export function Settings(p: SettingsProps) {
  const [tab, setTab] = useState<Tab>(p.initialTab ?? 'account')
  return (
    <div className="modal-back" onClick={p.onClose}>
      <div className="modal" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={p.onClose} aria-label="Close">
          ×
        </button>
        <nav className="tabs">
          {(['account', 'challenge', 'verify', 'lab', 'about'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {{ account: 'Account', challenge: 'Weekly challenge', verify: 'Verify', lab: 'Economy Lab', about: 'About' }[t]}
            </button>
          ))}
        </nav>
        <div className="modal-body">
          {tab === 'account' && <Account {...p} />}
          {tab === 'challenge' && <Challenge {...p} />}
          {tab === 'verify' && <Verify v={p.v} />}
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
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    regionApi.leaderboard().then((r) => setRows(r.entries), () => setRows([]))
  }, [])
  return (
    <>
      <h3>Weekly challenge</h3>
      <p className="fine">Same region, same seed, same world inputs for everyone this week. Three game days (about 15 minutes). Score = profit, minus every megawatt-hour left dark and every tonne of CO₂, plus how well the region’s businesses did.</p>
      <div className="row">
        {p.v.mode === 'challenge' ? (
          <button className="btn" disabled={busy} onClick={async () => { setBusy(true); await p.onLive(); setBusy(false) }}>
            Back to my region
          </button>
        ) : (
          <button className="btn primary" disabled={busy} onClick={async () => { setBusy(true); await p.onChallenge(); setBusy(false) }}>
            Start this week’s challenge
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

/** Same canonical JSON as the server: sorted keys, no whitespace. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v)
}
async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function Verify({ v }: { v: RegionView }) {
  const [epochs, setEpochs] = useState<(EpochDetail & { local?: boolean })[] | null>(null)
  const [chain, setChain] = useState<{ mode: string; resourceContractId?: string | null } | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 5_000) // new epochs close while you look
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    regionApi.epochs(v.regionId).then(async (r) => {
      const checked = await Promise.all(
        r.epochs.map(async (e) => {
          const body = { epochId: e.epochId, fromInterval: e.fromInterval, toInterval: e.toInterval, transfers: e.transfers, plants: e.plants, stateDigest: e.stateDigest }
          const h = await sha256(canonical(body))
          return { ...e, local: h === e.hash && e.transfers.reduce((a, t) => a + t.deltaCc, 0) === 0 }
        }),
      )
      setEpochs(checked)
    }, () => setEpochs((e) => e ?? []))
    if (tick === 0) regionApi.chain().then((c) => setChain(c as any), () => setChain(null))
  }, [v.regionId, tick])
  const live = chain?.mode === 'testnet'
  return (
    <>
      <h3>Verify</h3>
      <p className="fine">The simulation runs fast on the server. What it can prove, it proves here.</p>
      <Section title="Real-world inputs">
        <Stat label="Snapshot" value={`${v.world.source} · ${new Date(v.world.capturedAt).toLocaleString()}`} />
        <Stat label="Gas" value={`$${v.world.gasUsdPerMMBtu.toFixed(2)}/MMBtu`} />
        <Stat label="Brent" value={`$${v.world.brentUsdPerBbl.toFixed(1)}/bbl`} />
        <Stat label="Carbon" value={`$${v.world.carbonUsdPerT}/t`} />
        <Stat label="Weather" value={`${Math.round(v.world.tempC)}°C, cloud ${Math.round(v.world.cloudPct)}%`} />
        <ul className="sources">
          {v.world.sources.map((s) => (
            <li key={s.field}>
              <b>{s.field}</b>: {s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.provider}</a> : s.provider} <small>({s.observedAt})</small>
            </li>
          ))}
        </ul>
        {v.mode === 'challenge' && <p className="fine">Challenge worlds always use the fixed weekly fixture, so every player faces the same inputs.</p>}
      </Section>
      <Section title="Settlement epochs">
        <p className="fine">
          Every 3 game hours the server closes an epoch: each account’s net credit movement (always summing to zero), every Plant Asset’s owner and record, and a SHA-256 over all of it. Your browser re-computes each hash below.
          {live ? ' Epochs are submitted to NEAR testnet; the contract refuses any epoch id it has already seen.' : ' This server is not connected to NEAR testnet, so epochs are stored here (“local”) and not submitted.'}
        </p>
        {epochs === null && <p className="fine">Loading…</p>}
        {epochs?.length === 0 && <p className="fine">The first epoch closes at interval {v.settlement.nextEpochAt}.</p>}
        <ul className="epochs">
          {epochs?.map((e) => (
            <li key={e.epochId}>
              <span className={e.local ? 'ok' : 'crisis'}>{e.local ? '✓' : '✗'}</span> <b>#{e.epochNo}</b> intervals {e.fromInterval}–{e.toInterval} · {e.transfers.length} accounts · {e.status}
              <code title={e.hash}>{e.hash.slice(0, 16)}…</code>
              {e.txHash && (
                <a href={`https://testnet.nearblocks.io/txns/${e.txHash}`} target="_blank" rel="noreferrer">
                  transaction ↗
                </a>
              )}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Plant Assets">
        <p className="fine">
          Each plant is a numbered asset ({v.plants.slice(0, 3).map((p) => p.assetId).join(', ')}…). {live ? `On testnet each is an NEP-171 token in ${chain?.resourceContractId}, with its own account p00042.${chain?.resourceContractId} that only the current owner can direct.` : 'On a testnet deployment each becomes an NEP-171 token with its own plant account that only the current owner can direct; this server has no testnet connection.'}
        </p>
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
