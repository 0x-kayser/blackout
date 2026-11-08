import { useState } from 'react'
import type { GameStatePublic } from '@blackout/shared'
import type { Game } from '../game/useGame'
import { bizName, fmtClock, fmtCredits, fmtKg, fmtKw, fmtKwh, fmtLitres, fmtRate, genName, objectives, secondsLeft } from './format'

export function TopHud({ s, status, onMenu, sound, onToggleSound, music, onToggleMusic }: { s: GameStatePublic; status: string; onMenu: (m: string) => void; sound?: boolean; onToggleSound?: () => void; music?: boolean; onToggleMusic?: () => void }) {
  const supply = s.generators.reduce((a, g) => a + g.availableW, 0)
  const load = s.generators.reduce((a, g) => a + g.assignedW, 0)
  const demand = s.requests.filter((r) => r.status === 'open' || r.status === 'customer_countered').reduce((a, r) => a + r.requestedW, 0) + load
  const mine = s.businesses.filter((b) => b.provider === 'player' && s.districts.find((d) => d.districtId === b.districtId)?.unlocked)
  const satisfaction = mine.length ? Math.round(mine.reduce((a, b) => a + b.loyaltyBps, 0) / mine.length / 100) : 0
  const day = s.clock.daylightBps > 2000
  const fuelPct = s.player.fuelMl / s.player.tankCapacityMl
  const co2Kg = s.player.permitAllowanceMg / 1e6
  return (
    <header className="hud">
      <div className="hud-brand">
        <span className="mini-mark"><i /> BLACKOUT</span>
        <span className="hud-clock" title="Time of day: affects solar output and city lights, never pauses play">
          {day ? '☀' : '☾'} {s.clock.gameMinuteOfDay !== null ? fmtClock(s.clock.gameMinuteOfDay) : '—'}
        </span>
        <button className="hud-stage" onClick={() => onMenu('expansion')} title={s.company.nextStage ? `Next: ${s.company.nextStage.name}. ${s.company.nextStage.unlocks}` : 'Top stage reached'}>
          <b>Stage {s.company.stage}</b> {s.company.name}
          <span className="stage-bar" aria-hidden><i style={{ width: `${s.company.progressBps / 100}%` }} /></span>
        </button>
      </div>
      <div className="hud-stats" role="list">
        <Stat label="Credits" value={fmtCredits(s.player.creditsCc)} icon="₡" tone="amber" />
        <Stat label="Load / supply" value={`${fmtKw(load)} / ${fmtKw(supply)}`} sub={`demand ${fmtKw(demand)}`} icon="⚡" tone={load / Math.max(1, supply) > 0.9 ? 'coral' : 'teal'} />
        <Stat label="Diesel" value={fmtLitres(s.player.fuelMl)} sub={`${fmtLitres(s.player.fuelReservedMl)} reserved${s.player.pendingFuelMl ? ` · ${fmtLitres(s.player.pendingFuelMl)} arriving` : ''}`} icon="⛽" tone={fuelPct < 0.15 ? 'coral' : 'blue'} bar={fuelPct} />
        <Stat label="CO₂ allowance" value={`${co2Kg.toFixed(1)} kg`} sub={`${Math.floor(co2Kg / 10)} permits left`} icon="☁" tone={co2Kg < 8 ? 'coral' : 'muted'} />
        <Stat label="Customer loyalty" value={`${satisfaction}%`} icon="♥" tone={satisfaction < 40 ? 'coral' : 'teal'} />
      </div>
      <div className="hud-actions">
        <span className={`conn ${status}`} aria-live="polite">{status === 'live' ? '● Live' : status === 'connecting' ? '○ Connecting' : status === 'reconnecting' ? '◌ Reconnecting' : '✕ Offline'}</span>
        {onToggleMusic && <button className={`hud-btn ${music ? 'on' : ''}`} onClick={onToggleMusic} aria-label={music ? 'Music on: tap to stop' : 'Music off: tap to play'} aria-pressed={!!music} title={music ? 'Music on' : 'Music off'}>{music ? '🎵' : '🎶'}</button>}
        {onToggleSound && <button className={`hud-btn ${sound ? 'on' : ''}`} onClick={onToggleSound} aria-label={sound ? 'Sound on: tap to mute' : 'Sound off: tap to turn on'} aria-pressed={!!sound} title={sound ? 'Sound on' : 'Sound off'}>{sound ? '🔊' : '🔇'}</button>}
        <button className="hud-btn" onClick={() => onMenu('help')} aria-label="How to play">?</button>
        <button className="hud-btn" onClick={() => onMenu('profile')} aria-label="Profile and settings">☰</button>
      </div>
    </header>
  )
}

function Stat({ label, value, sub, icon, tone, bar }: { label: string; value: string; sub?: string; icon: string; tone: string; bar?: number }) {
  return (
    <div className={`hud-stat ${tone}`} role="listitem" aria-label={`${label}: ${value}${sub ? `, ${sub}` : ''}`}>
      <i aria-hidden>{icon}</i>
      <div>
        <small>{label}</small>
        <b>{value}</b>
        {sub && <em>{sub}</em>}
        {bar !== undefined && <span className="hud-bar"><span style={{ width: `${Math.max(2, Math.min(100, bar * 100))}%` }} /></span>}
      </div>
    </div>
  )
}

export function Objectives({ s }: { s: GameStatePublic }) {
  const [open, setOpen] = useState(false)
  const goals = s.goals
  const done = goals.items.filter((x) => x.done).length
  const bonus = Math.round((goals.rewardMultiplierBps - 10_000) / 100)
  if (s.tutorial.active) {
    return (
      <section className="objectives" aria-label="Objectives">
        <p className="eyebrow amber">GETTING STARTED</p>
        <p className="tutorial-hint">💡 {s.tutorial.hint}</p>
        <ul>
          {objectives(s).map((o) => (
            <li key={o.text} className={o.done ? 'done' : ''}>{o.done ? '✓' : '○'} {o.text}</li>
          ))}
        </ul>
      </section>
    )
  }
  return (
    <section className={`objectives goals ${open ? 'open' : ''}`} aria-label="Today's goals">
      <button className="goals-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="eyebrow amber">SHIFT GOALS</span>
        <span className="goals-score">🎯 {done}/{goals.items.length}{goals.streak > 0 && <> · 🔥 {goals.streak}</>}</span>
      </button>
      <ul>
        {goals.items.map((x) => (
          <li key={x.goalId} className={x.done ? 'done' : ''}>
            <span className="goal-line">{x.done ? '✓' : '○'} {x.label}</span>
            <span className="goal-meta">
              <span className="goal-bar"><i style={{ width: `${Math.min(100, (x.progress / Math.max(1, x.target)) * 100)}%` }} /></span>
              <small>{x.kind === 'earn' ? `${fmtCredits(x.progress)} / ${fmtCredits(x.target)}` : `${x.progress} / ${x.target}`} · +{fmtCredits(Math.floor((x.rewardCc * goals.rewardMultiplierBps) / 10_000))}</small>
            </span>
          </li>
        ))}
      </ul>
      <p className="goals-foot">{done === goals.items.length ? 'All done! Your streak grows at the end of the shift.' : goals.streak > 0 ? `🔥 ${goals.streak}-shift streak: rewards +${bonus}%. Finish all three to keep it.` : 'Finish all three this shift to start a streak (+10% rewards per shift).'}</p>
    </section>
  )
}

export function PowerDock({ g, onSelect, highlight }: { g: Game; onSelect: (id: string) => void; highlight: boolean }) {
  const s = g.state!
  return (
    <aside className="dock dock-left" aria-label="Power plant">
      <p className="eyebrow">POWER PLANT</p>
      {s.generators.map((gen) => {
        const pct = gen.ratedW ? gen.assignedW / gen.ratedW : 0
        const customers = s.contracts.filter((c) => c.generatorId === gen.generatorId && c.status === 'active')
        return (
          <button key={gen.generatorId} className={`gen-card ${gen.status} ${highlight && gen.status === 'online' ? 'call' : ''}`} onClick={() => onSelect(gen.generatorId)}>
            <div className="gen-head">
              <b>{gen.type === 'solar' ? '☀' : '⚡'} {gen.name}</b>
              <span className={`pill ${gen.status}`}>{gen.status === 'online' ? (gen.outputW > 0 ? 'running' : 'idle') : gen.status}</span>
            </div>
            <div className="meter-row"><span>Load</span><span>{fmtKw(gen.assignedW)} / {fmtKw(gen.type === 'solar' ? gen.availableW : gen.ratedW)}</span></div>
            <div className="meter"><span className={pct > 0.9 ? 'hot' : ''} style={{ width: `${Math.min(100, pct * 100)}%` }} /></div>
            {gen.type === 'diesel' && (
              <>
                <div className="meter-row"><span>Heat</span><span>{Math.round(gen.heatPermille / 10)}%</span></div>
                <div className="meter heat"><span style={{ width: `${gen.heatPermille / 10}%` }} /></div>
                <div className="meter-row"><span>Wear</span><span>{Math.round(gen.wearBps / 100)}%</span></div>
              </>
            )}
            <small className="gen-foot">{customers.length ? `Serving ${customers.map((c) => bizName(s, c.businessId)).join(', ')}` : gen.status === 'online' ? 'No active contracts' : `Available in ${secondsLeft(s, gen.offlineUntilTick)} s`}</small>
          </button>
        )
      })}
      {s.battery && (
        <div className="gen-card battery">
          <div className="gen-head"><b>▮ Battery</b><span className="pill online">{s.battery.chargeW ? 'charging' : s.battery.dischargeW ? 'discharging' : 'standby'}</span></div>
          <div className="meter teal"><span style={{ width: `${(s.battery.storedWh / s.battery.capacityWh) * 100}%` }} /></div>
          <small className="gen-foot">{fmtKwh(s.battery.storedWh)} of {fmtKwh(s.battery.capacityWh)}</small>
        </div>
      )}
      <div className="plant-facts">
        <span>Tank {fmtLitres(s.player.fuelMl)} / {fmtLitres(s.player.tankCapacityMl)}</span>
        <span>Tariff {fmtRate(s.player.tariffsCcPerKwh.market_quarter ?? 0)}</span>
      </div>
    </aside>
  )
}

export function RequestDock({ g, selectedReq, setSelectedReq }: { g: Game; selectedReq: string | null; setSelectedReq: (id: string | null) => void }) {
  const s = g.state!
  const open = s.requests.filter((r) => r.status === 'open' || r.status === 'customer_countered')
  const pendingContracts = s.contracts.filter((c) => c.provider === 'player' && c.status === 'pending_assignment')
  const active = s.contracts.filter((c) => c.status === 'active')
  return (
    <aside className="dock dock-right" aria-label="Customers">
      <p className="eyebrow">POWER REQUESTS {open.length ? `· ${open.length}` : ''}</p>
      {!open.length && !pendingContracts.length && (
        <p className="empty">All quiet. Next outage in {Math.max(0, (s.clock.nextWaveTick ?? s.clock.tick) - s.clock.tick)} s.</p>
      )}
      {pendingContracts.map((c) => (
        <article key={c.contractId} className="req-card pending">
          <div className="req-top"><b>{bizName(s, c.businessId)}</b><span className="pill amber">CONNECT</span></div>
          <p className="req-line">{fmtKw(c.allottedW)} · {c.durationHours} h · {fmtRate(c.rateCcPerKwh)} · escrow {fmtCredits(c.escrowCc)}</p>
          <p className="req-hint">Choose a generator below, or tap one on the map.</p>
          <div className="req-actions">
            {s.generators.filter((x) => x.status === 'online').map((gen) => (
              <button key={gen.generatorId} className="button mini primary" disabled={g.pending.has(`assign:${c.contractId}`)} onClick={() => void g.act({ type: 'ASSIGN_CONTRACT', contractId: c.contractId, generatorId: gen.generatorId }, `assign:${c.contractId}`)}>
                ⚡ {gen.name} <small>({fmtKw(gen.ratedW - gen.assignedW)} free)</small>
              </button>
            ))}
            <button className="text-danger" onClick={() => void g.act({ type: 'CANCEL_CONTRACT', contractId: c.contractId }, `cancel:${c.contractId}`)}>Release</button>
          </div>
          {c.assignDeadlineTick !== null && <p className="deadline">◷ {secondsLeft(s, c.assignDeadlineTick)} s to connect</p>}
        </article>
      ))}
      {open.map((r) => (
        <RequestCard key={r.requestId} g={g} rid={r.requestId} selected={selectedReq === r.requestId} onSelect={() => setSelectedReq(r.requestId)} />
      ))}
      {active.length > 0 && <p className="eyebrow" style={{ marginTop: 14 }}>FLOWING NOW · {active.length}</p>}
      {active.map((c) => (
        <div key={c.contractId} className={`flow-chip ${c.provider}`}>
          <span>{c.provider === 'player' ? '⚡' : '⚠'}</span>
          <div>
            <b>{bizName(s, c.businessId)}</b>
            <small>{c.provider === 'player' ? `${genName(s, c.generatorId)} · ${fmtKw(c.allottedW)} · ${c.remainingGameHours.toFixed(1)} h left` : `VoltLine @ ${fmtRate(c.rateCcPerKwh)}`}</small>
            <span className="flow-bar"><span style={{ width: `${(c.deliveredTicks / c.totalTicks) * 100}%` }} /></span>
          </div>
          {c.provider === 'player' && <strong>{fmtCredits(c.billedCc)}</strong>}
        </div>
      ))}
    </aside>
  )
}

function RequestCard({ g, rid, selected, onSelect }: { g: Game; rid: string; selected: boolean; onSelect: () => void }) {
  const s = g.state!
  const r = s.requests.find((x) => x.requestId === rid)!
  const b = s.businesses.find((x) => x.businessId === r.businessId)!
  const [counter, setCounter] = useState<number | null>(null)
  const left = secondsLeft(s, r.deadlineTick)
  const freeDiesel = s.generators.filter((x) => x.status === 'online').map((x) => x.ratedW - x.assignedW)
  const fits = freeDiesel.some((f) => f >= r.requestedW)
  return (
    <article className={`req-card ${selected ? 'selected' : ''} ${left !== null && left <= 3 ? 'urgent' : ''} ${r.urgency === 'code_red' ? 'code-red' : ''}`} onClick={onSelect}>
      <div className="req-top">
        <b>{r.urgency === 'code_red' && '🚨 '}{b.name}{b.owner && <small className="req-owner"> {b.owner.face} {b.owner.name}</small>}</b>
        {r.status === 'customer_countered' ? <span className="pill blue">COUNTER</span> : left === null ? <span className="pill muted">NO TIMER</span> : <span className="pill coral">{r.urgency === 'code_red' ? 'CODE RED · ' : '◷ '}{left}s</span>}
      </div>
      {r.urgency === 'code_red' && left !== null && <span className="cr-timer" aria-hidden><i style={{ width: `${Math.min(100, (left / 7) * 100)}%` }} /></span>}
      <p className="req-msg">“{r.message}”</p>
      <div className="req-grid">
        <span><small>Needs</small><b>{fmtKw(r.requestedW)} × {r.durationHours} h</b></span>
        <span><small>Offer</small><b>{fmtRate(r.offerRateCcPerKwh)}</b></span>
        <span><small>Expected payout</small><b>{fmtCredits(r.expectedPaymentCc)}</b></span>
        <span><small>Estimated diesel + CO₂</small><b>{fmtLitres(r.estimatedFuelMl)} · {fmtKg(r.estimatedCo2Mg)}</b></span>
        <span><small>Your margin</small><b className={r.estimatedMarginCc < 0 ? 'neg' : 'pos'}>{fmtCredits(r.estimatedMarginCc)}</b></span>
        <span><small>Their profit/h</small><b className={r.customerProfitPerHourCc < 0 ? 'neg' : 'pos'}>{fmtCredits(r.customerProfitPerHourCc)}</b></span>
      </div>
      {!fits && <p className="warn">⚠ No source has {fmtKw(r.requestedW)} free right now.</p>}
      {counter === null ? (
        <div className="req-actions">
          <button className="button mini primary" disabled={g.pending.has(`accept:${rid}`)} onClick={(e) => { e.stopPropagation(); void g.act({ type: 'ACCEPT_REQUEST', requestId: rid }, `accept:${rid}`) }}>
            {g.pending.has(`accept:${rid}`) ? 'Checking…' : 'Accept'}
          </button>
          <button className="button mini" disabled={r.counterCount >= r.maxCounters} title={r.maxCounters === 0 ? `${b.name} pays a fixed tariff and never haggles` : undefined} onClick={(e) => { e.stopPropagation(); setCounter(Math.min(3000, r.offerRateCcPerKwh + 200)) }}>
            Counter {r.maxCounters ? `(${r.maxCounters - r.counterCount} left)` : ''}
          </button>
          <button className="text-danger" onClick={(e) => { e.stopPropagation(); void g.act({ type: 'DECLINE_REQUEST', requestId: rid }, `decline:${rid}`) }}>Decline</button>
        </div>
      ) : (
        <div className="counter" onClick={(e) => e.stopPropagation()}>
          <label>Your price <b>{fmtRate(counter)}</b>
            <input type="range" min={100} max={3000} step={10} value={counter} onChange={(e) => setCounter(Number(e.target.value))} aria-label="Counter price per kWh" />
          </label>
          <p className="fine">The customer weighs this against its break-even rate ({fmtRate(b.breakEvenRateCcPerKwh)}), loyalty, and VoltLine’s tariff.</p>
          <div className="req-actions">
            <button className="button mini primary" disabled={g.pending.has(`counter:${rid}`)} onClick={async () => { await g.act({ type: 'COUNTER_REQUEST', requestId: rid, rateCcPerKwh: counter }, `counter:${rid}`); setCounter(null) }}>Send counteroffer</button>
            <button className="button mini" onClick={() => setCounter(null)}>Cancel</button>
          </div>
        </div>
      )}
    </article>
  )
}
