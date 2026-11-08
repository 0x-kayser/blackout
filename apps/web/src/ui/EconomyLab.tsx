import { useEffect, useRef, useState } from 'react'
import type { EconomyEvent, ReplaySummary } from '@blackout/shared'
import { api, explainError, type CompareResponse } from '../api/client'
import { Drawer } from './Panels'
import { fmtCredits, fmtPct } from './format'

const POLICIES = [
  { id: 'diesel', name: 'Cheap Diesel First' },
  { id: 'diversified', name: 'Storage First' },
  { id: 'gouger', name: 'Price Gouger' },
]
const CONDITIONS = [
  { id: 'calm', name: 'Normal market' },
  { id: 'disruption', name: 'Fuel supply disruption (Hormuz, fictional)' },
  { id: 'recovery', name: 'Disruption, then recovery' },
  { id: 'demand_surge', name: 'Higher customer demand (heatwaves)' },
  { id: 'carbon_tightening', name: 'Carbon-policy tightening (fictional local)' },
  { id: 'solar_boom', name: 'Renewable investment wave' },
  { id: 'historical', name: 'Historical: March–April 2026 (EIA-sourced)' },
]
const SCENARIOS = [
  { id: 'oil_shock_2026', name: 'Brent 2026 replay (historical)' },
  { id: 'starter', name: 'Baseline (illustrative)' },
  { id: 'fuel_squeeze', name: 'Fuel squeeze (illustrative)' },
]

function Chart({ title, a, b, fmt }: { title: string; a: number[]; b: number[]; fmt: (n: number) => string }) {
  const all = [...a, ...b]
  const min = Math.min(...all)
  const max = Math.max(...all)
  const span = Math.max(1, max - min)
  const W = 260
  const H = 90
  const path = (v: number[]) => v.map((x, i) => `${i ? 'L' : 'M'}${(i / Math.max(1, v.length - 1)) * W},${H - ((x - min) / span) * H}`).join(' ')
  return (
    <figure className="lab-chart">
      <figcaption>{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H + 4}`} role="img" aria-label={`${title}: A ends ${fmt(a[a.length - 1] ?? 0)}, B ends ${fmt(b[b.length - 1] ?? 0)}`}>
        <path d={path(a)} className="line-a" />
        <path d={path(b)} className="line-b" />
      </svg>
      <div className="chart-legend"><span className="a">A {fmt(a[a.length - 1] ?? 0)}</span><span className="b">B {fmt(b[b.length - 1] ?? 0)}</span></div>
    </figure>
  )
}

export function EconomyLab({ onClose }: { onClose: () => void }) {
  const [seed, setSeed] = useState(424242)
  const [scenario, setScenario] = useState('oil_shock_2026')
  const [pa, setPa] = useState('diesel')
  const [pb, setPb] = useState('diversified')
  const [condition, setCondition] = useState('disruption')
  const [res, setRes] = useState<CompareResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [feed, setFeed] = useState<EconomyEvent[]>([])
  const [progress, setProgress] = useState(0)
  const es = useRef<EventSource | null>(null)
  useEffect(() => () => es.current?.close(), [])

  const run = async () => {
    setBusy(true)
    setErr(null)
    es.current?.close()
    setFeed([])
    setProgress(0)
    try {
      setRes(await api.compare(seed, condition === 'historical' ? 'oil_shock_2026' : scenario, pa, pb, condition))
    } catch (e) {
      setErr(explainError(e))
    } finally {
      setBusy(false)
    }
  }

  const play = (r: ReplaySummary) => {
    es.current?.close()
    setFeed([])
    const src = new EventSource(api.replayStreamUrl(r.replayId, 60))
    es.current = src
    const lastTick = r.days * 240
    const interesting = new Set(['WORLD_EVENT_STARTED', 'WORLD_EVENT_ENDED', 'RIVAL_STRATEGY_CHANGED', 'MERCHANT_REPRICED', 'RIVAL_WON_CONTRACT', 'RIVAL_REPRICED', 'BUSINESS_STATUS_CHANGED', 'MERCHANT_RESTOCK_ORDERED', 'MERCHANT_CLOSED', 'CUSTOMER_SWITCHED_PROVIDER', 'DAY_SETTLED', 'UPGRADE_PURCHASED', 'TRADE_CONFIRMED', 'OIL_INDEX_UPDATED', 'REGULATOR_NOTICE'])
    src.addEventListener('replay', (m) => {
      const ev = JSON.parse((m as MessageEvent).data) as EconomyEvent
      setProgress(Math.min(1, ev.tick / lastTick))
      if (interesting.has(ev.type)) setFeed((f) => [...f.slice(-60), ev])
    })
    src.addEventListener('replay_done', () => {
      setProgress(1)
      src.close()
    })
  }

  const download = async (r: ReplaySummary) => {
    const res = await fetch(api.replayTraceUrl(r.replayId))
    const blob = new Blob([await res.text()], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${r.replayId}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const A = res?.a
  const B = res?.b
  return (
    <Drawer title="Economy Lab" eyebrow="SEPARATE 7-DAY SIMULATION · YOUR CITY IS UNCHANGED" onClose={onClose} wide>
      <p className="fine">Run seven game days through the same engine as your city. The policy bot and every NPC follow their own rules. The same seed and policy produce the same trace hash every time. This replay has no blockchain settlement.</p>
      <div className="lab-controls">
        <label>Seed<input type="number" value={seed} onChange={(e) => setSeed(Math.max(0, Math.floor(Number(e.target.value) || 0)))} /></label>
        <label>World condition<select value={condition} onChange={(e) => setCondition(e.target.value)}>{CONDITIONS.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>Oil series<select value={condition === 'historical' ? 'oil_shock_2026' : scenario} disabled={condition === 'historical'} onChange={(e) => setScenario(e.target.value)}>{SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Strategy A<select value={pa} onChange={(e) => setPa(e.target.value)}>{POLICIES.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Strategy B<select value={pb} onChange={(e) => setPb(e.target.value)}>{POLICIES.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <button className="button primary" onClick={run} disabled={busy || pa === pb}>{busy ? 'Simulating…' : 'Run simulation'}</button>
      </div>
      {err && <p className="warn">{err}</p>}
      {A && B && (
        <>
          <div className="lab-summary">
            {[A, B].map((r, i) => (
              <article key={r.replayId} className={i ? 'b' : 'a'}>
                <p className="eyebrow">{i ? 'B' : 'A'} · {POLICIES.find((p) => p.id === r.policyId)?.name}</p>
                <dl>
                  <dt>Net worth</dt><dd>{fmtCredits(r.final.netWorthCc)}</dd>
                  <dt>Reliability</dt><dd>{fmtPct(r.final.reliabilityBps)}</dd>
                  <dt>City GDP</dt><dd>{fmtCredits(r.final.cityGdpCc)}</dd>
                  <dt>Closures</dt><dd>{r.final.closures}</dd>
                </dl>
                <code title="sha256 of the full normalised event + ledger trace">trace {r.traceHash.slice(0, 16)}…</code>
                <div className="lab-actions">
                  <button className="button mini" onClick={() => play(r)}>▶ Play 60-second replay</button>
                  <button className="button mini" onClick={() => void download(r)}>⬇ Download event ledger</button>
                </div>
              </article>
            ))}
          </div>
          <div className="lab-charts">
            <Chart title="Your cash" a={A.daily.map((d) => d.playerCashCc)} b={B.daily.map((d) => d.playerCashCc)} fmt={fmtCredits} />
            <Chart title="Reliability" a={A.daily.map((d) => d.reliabilityBps)} b={B.daily.map((d) => d.reliabilityBps)} fmt={fmtPct} />
            <Chart title="Avg diesel price /L" a={A.daily.map((d) => Object.values(d.merchantPrices).reduce((x, y) => x + y, 0) / 3)} b={B.daily.map((d) => Object.values(d.merchantPrices).reduce((x, y) => x + y, 0) / 3)} fmt={(n) => fmtCredits(Math.round(n))} />
            <Chart title="Merchant stock (all)" a={A.daily.map((d) => Object.values(d.merchantStockMl).reduce((x, y) => x + y, 0))} b={B.daily.map((d) => Object.values(d.merchantStockMl).reduce((x, y) => x + y, 0))} fmt={(n) => `${(n / 1000).toFixed(0)} L`} />
            <Chart title="Rival cash" a={A.daily.map((d) => d.rivalCashCc)} b={B.daily.map((d) => d.rivalCashCc)} fmt={fmtCredits} />
            <Chart title="Merchant cash (all)" a={A.daily.map((d) => Object.values(d.merchantCashCc).reduce((x, y) => x + y, 0))} b={B.daily.map((d) => Object.values(d.merchantCashCc).reduce((x, y) => x + y, 0))} fmt={fmtCredits} />
            <Chart title="Your CO₂ (kg, cumulative)" a={A.daily.map((d) => d.playerCo2Mg)} b={B.daily.map((d) => d.playerCo2Mg)} fmt={(n) => (n / 1e6).toFixed(1)} />
            <Chart title="Solar kWh/day" a={A.daily.map((d) => d.generationMixWh.solar)} b={B.daily.map((d) => d.generationMixWh.solar)} fmt={(n) => `${(n / 1000).toFixed(1)}`} />
          </div>
          <ul className="differences">{res!.differences.map((d) => <li key={d}>{d}</li>)}</ul>
          <section className="lab-world">
            <p className="eyebrow">WORLD INPUTS AND SIMULATED OUTCOMES</p>
            <table className="biz-table">
              <thead><tr><th>Day</th><th>Oil index</th><th>World events (input)</th><th>Fuel imports</th><th>Avg diesel (simulated)</th><th>Rival</th></tr></thead>
              <tbody>
                {A.daily.map((d) => (
                  <tr key={d.day}>
                    <td>{d.day}</td>
                    <td>{(d.oilIndexCenti / 100).toFixed(1)}{condition === 'historical' ? ' (observed)' : ''}</td>
                    <td>{d.activeWorldEvents.length ? d.activeWorldEvents.map((e) => <span key={e.headline} className={`badge ${e.verification}`}>{e.verification === 'sourced' ? 'SOURCED' : 'FICTIONAL'} · {e.headline.replace(/ \(fictional.*\)$/, '').slice(0, 44)}</span>) : '—'}</td>
                    <td>{d.importCapacityBps ? `${d.importCapacityBps / 100}%` : 'normal'}</td>
                    <td>{fmtCredits(Math.round(Object.values(d.merchantPrices).reduce((x, y) => x + y, 0) / 3))}</td>
                    <td>{(d.rivalTariffCcPerKwh / 100).toFixed(2)}{d.rivalSolarW ? ' ☀' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {(progress > 0 || feed.length > 0) && (
            <section className="lab-feed">
              <div className="lab-progress"><span style={{ width: `${progress * 100}%` }} /></div>
              <ul>{feed.slice().reverse().map((e) => <li key={`${e.seq}`}><span>Day {e.day}</span>{e.type.startsWith('WORLD_') ? <em className="tag world">WORLD</em> : <em className="tag sim">SIMULATION</em>} {e.explanation}</li>)}</ul>
            </section>
          )}
        </>
      )}
    </Drawer>
  )
}
