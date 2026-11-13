import type { FuelId, RegionView, SupplierView, TownView } from '@blackout/shared'
import { ITEMS } from '@blackout/shared'
import { credits, mw, pct, price } from '../format'
import { Section, Stat } from './Bits'
import type { ChallengeInfo } from '../api'
import type { Move } from './Guide'
import { useEffect, useState } from 'react'
import { WeeklyChallenge } from './Settings'
import { HotDeskCard } from './HotDesk'

const PERMITS = [
  { rank: 1, name: 'Independent Generator', call: 'First Light', goal: 'Hormuz tanker delays and VoltLine’s debt spiral cut off Eastside. Restore the homes, bring the Kestrel turbine online, and build emergency reserve capacity.', unlock: 'Starter generation and storage builds' },
  { rank: 2, name: 'Regional Producer', call: 'Win a place in the market', goal: 'Break Vesper’s fuel-import vulnerability. Deliver 3,000 MWh to keep Ivanova Steel and the Port running and earn a full seat in the regional market.', unlock: 'Combined-cycle generation and larger turbine and solar builds' },
  { rank: 3, name: 'System Partner', call: 'Hold the line', goal: 'Navigate the COP31 Sovereign Grid Accord: deliver 15,000 MWh while keeping regional reliability at or above 97% amid carbon floor hikes and supply shocks.', unlock: 'The largest combined-cycle plant and 200 MW battery build' },
  { rank: 4, name: 'Grid Anchor', call: 'Become the reserve', goal: 'Achieve energy sovereignty: deliver 45,000 MWh while keeping reliability at or above 98% to insulate Vesper from foreign oil shocks and VoltLine’s defaults.', unlock: 'The region’s highest operating permit' },
] as const

function campaignObjective(v: RegionView) {
  const next = v.player.nextLicence
  if (!next) return { kicker: 'CAMPAIGN COMPLETE', title: 'You are Vesper’s Grid Anchor', detail: 'Your highest operating permit is earned. Keep building your company or take this week’s crisis drill.', progress: 100, reliability: null, unlock: null }
  const mwhProgress = Math.min(100, (next.haveMWh / Math.max(1, next.needMWh)) * 100)
  const reliabilityProgress = next.needReliabilityBps > 0
    ? Math.min(100, (v.player.reliabilityBps / next.needReliabilityBps) * 100)
    : 100
  const nextStage = PERMITS.find((stage) => stage.rank === v.player.licence + 1)
  return {
    kicker: `CHAPTER ${v.player.licence + 1} · ${next.name.toUpperCase()}`,
    title: nextStage?.call ?? `Earn ${next.name}`,
    detail: `${next.haveMWh.toLocaleString('en-US')} / ${next.needMWh.toLocaleString('en-US')} MWh · Earn ${next.name}`,
    progress: Math.min(mwhProgress, reliabilityProgress),
    reliability: next.needReliabilityBps > 0 ? { have: v.player.reliabilityBps, need: next.needReliabilityBps } : null,
    unlock: nextStage?.unlock ?? null,
  }
}

function activeFuelShock(v: RegionView): SupplierView | null {
  const liveShock = [...v.suppliers]
    .filter((supplier) => supplier.disrupted || supplier.rationing)
    .sort((a, b) => Number(b.rationing) - Number(a.rationing) || b.scarcityPremiumPct - a.scarcityPremiumPct || a.stock / Math.max(1, a.capacity) - b.stock / Math.max(1, b.capacity))[0]
  if (liveShock) return liveShock
  const tightFuel = !v.resourceReserve.legacy && (["gas", "diesel"] as const).find((fuel) => {
    const reserve = v.resourceReserve[fuel]
    return reserve.total > 0 && reserve.remaining <= reserve.total * 0.25
  })
  if (!tightFuel) return null
  return [...v.suppliers].filter((supplier) => supplier.fuel === tightFuel).sort((a, b) => b.scarcityPremiumPct - a.scarcityPremiumPct)[0] ?? null
}

function currentPowerSurge(v: RegionView) {
  const prior = v.history.slice(0, -1).slice(-288)
  const average = prior.length > 24 ? prior.reduce((sum, point) => sum + point.priceCcPerMWh, 0) / prior.length : 8_000
  const threshold = Math.max(25_000, average * 2.5)
  return v.pulse.spotCcPerMWh > threshold
    ? { spot: v.pulse.spotCcPerMWh, average, multiple: v.pulse.spotCcPerMWh / Math.max(1, average) }
    : null
}

function CrisisBrief({ v, town, move, onOpenMarket, onOpenDispatch, onToggleAutoFuel, onDoMove }: { v: RegionView; town: TownView | null; move: Move | null; onOpenMarket: () => void; onOpenDispatch: () => void; onToggleAutoFuel: (fuel: FuelId, enabled: boolean) => void; onDoMove: () => void }) {
  const supplier = activeFuelShock(v)
  const surge = currentPowerSurge(v)
  const marketReserve = (town?.reserves ?? []).find((reserve) => !reserve.legacy && reserve.total > 0 && reserve.remainingBps <= 2_500)
  const reserveStep = marketReserve ? (marketReserve.remainingBps <= 1_000 ? 10 : 25) : null
  const signalKey = supplier
    ? `fuel:${supplier.supplierId}:${supplier.disrupted ? 'disrupted' : ''}:${supplier.rationing ? 'rationing' : ''}:${v.resourceReserve[supplier.fuel].remaining <= v.resourceReserve[supplier.fuel].total * 0.1 ? 'reserve-10' : v.resourceReserve[supplier.fuel].remaining <= v.resourceReserve[supplier.fuel].total * 0.25 ? 'reserve-25' : ''}`
    : marketReserve ? `world:${marketReserve.item}:${reserveStep}` : surge ? 'power:price-surge' : null
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  useEffect(() => setDismissedKey(null), [signalKey])
  if (!signalKey || signalKey === dismissedKey) return null

  if (supplier) {
    const stockPct = Math.max(0, Math.min(100, Math.round((supplier.stock / Math.max(1, supplier.capacity)) * 100)))
    const unit = supplier.fuel === 'gas' ? 'MMBtu' : 'L'
    const autoFuel = v.player.autoFuel[supplier.fuel]
    const running = v.plants.some((plant) => plant.mine && plant.fuel === supplier.fuel && (plant.status === 'online' || plant.status === 'starting'))
    const reserve = v.resourceReserve[supplier.fuel]
    const reserveLow = !v.resourceReserve.legacy && reserve.total > 0 && reserve.remaining <= reserve.total * 0.25
    const scarcity = reserveLow
      ? `${Math.round((reserve.remaining / reserve.total) * 100)}% of this grid’s fixed fuel allotment remains outside supplier tanks.`
      : supplier.scarcityPremiumPct > 0
      ? `Low stock adds about ${supplier.scarcityPremiumPct}% above this supplier’s normal margin.`
      : 'The disruption is active; this supplier has not added a low-stock premium yet.'
    const topUpHint = !running
      ? 'No matching fuel plant is running. Auto top-up waits until you start one.'
      : autoFuel
        ? 'Auto top-up is on. Pausing it can protect cash, but a running plant may run short.'
        : 'Auto top-up is off. Turning it on can protect a running plant, but refills use current market prices.'

    return (
      <section className="crisis-brief supply" aria-label="Live fuel supply crisis">
        <div className="crisis-brief-top">
          <span>LIVE MARKET CRISIS · {supplier.fuel.toUpperCase()}</span>
          <button className="crisis-dismiss" aria-label="Dismiss this crisis alert" onClick={() => setDismissedKey(signalKey)}>×</button>
        </div>
        <strong>{supplier.rationing ? `${supplier.name} is rationing ${supplier.fuel}` : supplier.disrupted ? `${supplier.name} imports are disrupted` : `${supplier.fuel} reserve is running low`}</strong>
        <p>{reserveLow ? 'This saved grid is drawing down its finite allotment. The next deposit is already counted in the fixed total.' : supplier.note}</p>
        <div className="crisis-facts">
          <span>{stockPct}% stock</span>
          <span>{credits(supplier.priceCcPerUnit)} / {unit}</span>
          {supplier.rationing && <span>Buy limits are active</span>}
        </div>
        <small className="crisis-price-note">{scarcity}</small>
        {surge && <p className="crisis-spillover">Power is also at {price(surge.spot)}/MWh · {surge.multiple.toFixed(1)}× the recent average.</p>}
        <p className="crisis-choice">Your call: compare a manual reserve at today’s quote, keep auto top-up on, or preserve cash and accept more shortage risk.</p>
        <div className="crisis-actions">
          <button className="btn primary small" onClick={onOpenMarket}>Compare {supplier.fuel} offers</button>
          {running
            ? <button className="btn ghost small" onClick={() => onToggleAutoFuel(supplier.fuel, !autoFuel)}>{autoFuel ? `Pause ${supplier.fuel} auto-buy` : `Turn on ${supplier.fuel} auto-buy`}</button>
            : <button className="btn ghost small" onClick={onOpenDispatch}>Review dispatch</button>}
        </div>
        {running && <small className="crisis-price-note">{topUpHint}</small>}
      </section>
    )
  }

  if (marketReserve) {
    return (
      <section className="crisis-brief supply" aria-label="Fixed resource reserve warning">
        <div className="crisis-brief-top"><span>FINITE WORLD RESERVE · {ITEMS[marketReserve.item].name.toUpperCase()}</span><button className="crisis-dismiss" aria-label="Dismiss this reserve alert" onClick={() => setDismissedKey(signalKey)}>×</button></div>
        <strong>{Math.round(marketReserve.remainingBps / 100)}% of the {ITEMS[marketReserve.item].name.toLowerCase()} endowment remains</strong>
        <p>{marketReserve.remaining.toLocaleString('en-US')} {ITEMS[marketReserve.item].units} remain in reserve. Merchant stock and your existing inventory are still tradeable.</p>
        <p className="crisis-choice">Choose what to protect: secure stock for the next shift, reserve steel for a build, or keep cash available for a price spike.</p>
        <div className="crisis-actions"><button className="btn primary small" onClick={onOpenMarket}>Review reserve and quotes</button><button className="btn ghost small" onClick={onOpenDispatch}>Choose grid response</button></div>
      </section>
    )
  }

  const canUseRecommendedMove = !!move?.button && (
    (move.action?.type === 'SET_PLANT_ONLINE' && move.action.online) ||
    (move.action?.type === 'SET_BATTERY_MODE' && move.action.mode === 'discharge')
  )
  return (
    <section className="crisis-brief power" aria-label="Live power price crisis">
      <div className="crisis-brief-top">
        <span>LIVE POWER CRISIS</span>
        <button className="crisis-dismiss" aria-label="Dismiss this crisis alert" onClick={() => setDismissedKey(signalKey)}>×</button>
      </div>
      <strong>Spot power is {price(surge!.spot)} / MWh</strong>
      <p>{surge!.multiple.toFixed(1)}× the recent average. A fuelled plant can earn more now, but every extra MWh spends fuel you may need later.</p>
      <p className="crisis-choice">Capture the price with available power, or hold fuel and protect your next shift.</p>
      <div className="crisis-actions">
        <button className="btn primary small" onClick={canUseRecommendedMove ? onDoMove : onOpenDispatch}>{canUseRecommendedMove ? move!.button : 'Review dispatch'}</button>
        <button className="btn ghost small" onClick={onOpenMarket}>Check fuel costs</button>
      </div>
    </section>
  )
}

export function LoopGoals({ v, town, challenge, move, onCareer, onChallenge, onLive, onDoMove, onHotDesk, tutorialIncomplete, onResumeTutorial, onOpenMarket, onOpenDispatch, onToggleAutoFuel }: { v: RegionView; town: TownView | null; challenge: ChallengeInfo | null; move: Move | null; onCareer: (tab: OperationTab) => void; onChallenge: () => void; onLive: () => void; onDoMove: () => void; onHotDesk?: (callId: string, choice: 'accept' | 'decline') => Promise<unknown>; tutorialIncomplete?: boolean; onResumeTutorial?: () => void; onOpenMarket: () => void; onOpenDispatch: () => void; onToggleAutoFuel: (fuel: FuelId, enabled: boolean) => void }) {
  const operation = campaignObjective(v)
  const isChallenge = v.mode === 'challenge'
  const progress = isChallenge ? Math.min(100, (v.clock.day / 3) * 100) : operation.progress
  const title = isChallenge ? (challenge?.name ?? 'The regional grid needs you') : operation.title
  const detail = isChallenge
    ? `Day ${Math.min(v.clock.day, 3)} of 3 · ${v.scores.score.toLocaleString('en-US')} points earned`
    : operation.detail
  return (
    <section className={`operation-hud ${move?.tone ?? 'ok'}`} aria-label="Current operation">
      <div className="operation-heading">
        <span className="operation-kicker">{isChallenge ? `THIS WEEK’S CRISIS · ${challenge?.week ?? 'LIVE'}` : operation.kicker}</span>
        <button className="operation-log" onClick={() => onCareer(isChallenge ? 'weekly' : 'campaign')}>{isChallenge ? 'Run details' : 'View route'} <span aria-hidden>↗</span></button>
      </div>
      <strong className="operation-title">{title}</strong>
      <span className="operation-detail">{detail}</span>
      {progress !== undefined && <i className="operation-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)} aria-label={isChallenge ? 'Weekly run progress' : 'Campaign progress'}><b style={{ width: `${progress}%` }} /></i>}
      {!isChallenge && operation.reliability && <div className="operation-reliability">Grid reliability <b>{pct(operation.reliability.have)}</b><span>needs {pct(operation.reliability.need)}</span></div>}
      {!isChallenge && operation.unlock && <div className="operation-unlock"><span>Next unlock</span><b>{operation.unlock}</b></div>}
      {move && (
        <div className="operation-next">
          <div><span>YOUR NEXT MOVE</span><p>{move.text}</p></div>
          {move.button && <button className="btn primary small" onClick={onDoMove}>{move.button} <span aria-hidden>→</span></button>}
        </div>
      )}
      <CrisisBrief v={v} town={town} move={move} onOpenMarket={onOpenMarket} onOpenDispatch={onOpenDispatch} onToggleAutoFuel={onToggleAutoFuel} onDoMove={onDoMove} />
      {tutorialIncomplete && onResumeTutorial && <button className="operation-resume-guide" onClick={onResumeTutorial}>↩ Resume the first-night guide</button>}
      {v.hotDesk && onHotDesk && <HotDeskCard call={v.hotDesk} onAnswer={onHotDesk} />}
      <button className="operation-weekly" onClick={isChallenge ? onLive : onChallenge}>{isChallenge ? '← Return to your company' : `Play this week’s crisis · ${challenge?.name ?? '3-day run'} →`}</button>
    </section>
  )
}

export type OperationTab = 'campaign' | 'weekly' | 'whos_who' | 'certificate'

export function OperationCenter({ v, challenge, initialTab, companyName = null, onClose, onChallenge, onLive }: { v: RegionView; challenge: ChallengeInfo | null; initialTab: OperationTab; companyName?: string | null; onClose: () => void; onChallenge: () => Promise<void>; onLive: () => Promise<void> }) {
  const [activeTab, setActiveTab] = useState<OperationTab>(initialTab)
  useEffect(() => {
    const closeOnEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])
  useEffect(() => { if (v.mode === 'challenge' && initialTab === 'campaign') setActiveTab('weekly') }, [v.mode, initialTab])
  return (
    <div className="ops-backdrop" onMouseDown={onClose}>
      <section className="ops-center" role="dialog" aria-modal="true" aria-labelledby="ops-title" onMouseDown={(e) => e.stopPropagation()}>
        <header className="ops-header">
          <div><p className="eyebrow">YOUR COMPANY · VESPER REGION</p><h2 id="ops-title">Campaign</h2></div>
          <button className="close" onClick={onClose} aria-label="Close operations">×</button>
        </header>
        <nav className="ops-tabs" aria-label="Operations">
          <button className={activeTab === 'campaign' ? 'on' : ''} aria-current={activeTab === 'campaign' ? 'page' : undefined} onClick={() => setActiveTab('campaign')}>Campaign</button>
          <button className={activeTab === 'weekly' ? 'on' : ''} aria-current={activeTab === 'weekly' ? 'page' : undefined} onClick={() => setActiveTab('weekly')}>Weekly crisis</button>
          <button className={activeTab === 'whos_who' ? 'on' : ''} aria-current={activeTab === 'whos_who' ? 'page' : undefined} onClick={() => setActiveTab('whos_who')}>Who’s Who</button>
          <button className={activeTab === 'certificate' ? 'on' : ''} aria-current={activeTab === 'certificate' ? 'page' : undefined} onClick={() => setActiveTab('certificate')}>Certificate</button>
        </nav>
        <div className="ops-body">
          {activeTab === 'campaign' && (
            <>
              <p className="ops-intro">Build a company the region can rely on. Keep the lights on, grow your power business, and earn stronger plants as you rise through the permits.</p>
              <Career v={v} />
            </>
          )}
          {activeTab === 'weekly' && (
            <>
              <p className="ops-intro">A fresh regional condition changes the opening market each week. Solve the three-day crisis, then compare your score with other operators.</p>
              <WeeklyChallenge v={v} onChallenge={onChallenge} onLive={onLive} />
            </>
          )}
          {activeTab === 'whos_who' && (
            <>
              <p className="ops-intro">Every generator and major employer in Vesper runs on the same double-entry ledger. Compare your cash, active capacity, and market standing against the region’s cast.</p>
              <WhosWho v={v} companyName={companyName} />
            </>
          )}
          {activeTab === 'certificate' && (
            <>
              <p className="ops-intro">Your official Vesper Grid Authority Operating Certificate under the COP31 Sovereign Grid Accord, with a customizable charter origin and shareable dispatch summary.</p>
              <OperatorCertificate v={v} companyName={companyName} />
            </>
          )}
        </div>
      </section>
    </div>
  )
}

export function Career({ v }: { v: RegionView }) {
  const next = v.player.nextLicence
  const nextRank = next ? v.player.licence + 1 : null
  const nextStage = nextRank ? PERMITS.find((x) => x.rank === nextRank) : null
  const delivered = next?.haveMWh ?? v.player.deliveredMWh
  const mwhDone = !!next && delivered >= next.needMWh
  const reliabilityDone = !next?.needReliabilityBps || v.player.reliabilityBps >= next.needReliabilityBps
  const mwhProgress = next ? Math.min(100, (delivered / Math.max(1, next.needMWh)) * 100) : 100
  const reliabilityProgress = next?.needReliabilityBps ? Math.min(100, (v.player.reliabilityBps / next.needReliabilityBps) * 100) : 100
  const operation = campaignObjective(v)

  return (
    <>
      <p className="eyebrow">VESPER CAMPAIGN · YOUR COMPANY’S ROUTE</p>
      <h3>{operation.title}</h3>
      <p className="fine">Deliver power and keep the region reliable to earn each rank. Every rank opens stronger plants for the road ahead.</p>
      {next && nextStage ? (
        <section className="campaign-brief">
          <div className="campaign-brief-top">
            <span>CHAPTER {nextRank} · {nextStage.call}</span>
            <b>{v.player.licence} / 4 permits</b>
          </div>
          <p>{nextStage.goal}</p>
          <div className="campaign-metrics">
            <div><small>POWER DELIVERED</small><strong>{delivered.toLocaleString('en-US')} <em>/ {next.needMWh.toLocaleString('en-US')} MWh</em></strong><i><b style={{ width: `${mwhProgress}%` }} /></i></div>
            {next.needReliabilityBps > 0 && <div><small>REGIONAL RELIABILITY</small><strong>{pct(v.player.reliabilityBps)} <em>/ {pct(next.needReliabilityBps)}</em></strong><i><b className={reliabilityDone ? 'complete' : ''} style={{ width: `${reliabilityProgress}%` }} /></i></div>}
          </div>
          <div className="campaign-unlock"><span>NEW BUILD OPTIONS</span><b>{nextStage.unlock}</b></div>
          {(!mwhDone || !reliabilityDone) && <p className="campaign-next">{mwhDone && !reliabilityDone ? 'Output target reached. Keep the region reliable to qualify.' : `${Math.max(0, next.needMWh - delivered).toLocaleString('en-US')} MWh left${next.needReliabilityBps ? ` · reliability must stay at ${pct(next.needReliabilityBps)} or higher` : ''}.`}</p>}
        </section>
      ) : (
        <section className="campaign-brief campaign-complete">
          <div className="campaign-brief-top"><span>ALL FOUR PERMITS EARNED</span><b>Campaign complete</b></div>
          <p>You hold Grid Anchor, Vesper’s highest operating permit. Continue building and trading in your saved region, or take the shared weekly crisis drill.</p>
          <div className="campaign-unlock"><span>YOUR CURRENT RESERVE</span><b>{credits(v.player.cashCc)} in company cash</b></div>
        </section>
      )}

      <h4 className="route-list-title">YOUR CAMPAIGN ROUTE</h4>
      <ol className="career-ladder">
        {PERMITS.map((stage) => {
          const status = stage.rank <= v.player.licence ? 'earned' : stage.rank === v.player.licence + 1 ? 'current' : 'future'
          return (
            <li key={stage.rank} className={`career-stage ${status}`}>
              <span className="career-stage-mark" aria-hidden>{status === 'earned' ? '✓' : status === 'current' ? '→' : '○'}</span>
              <div>
                <div className="career-stage-title"><b>{stage.rank}. {stage.name}</b><small>{status === 'earned' ? 'Earned' : status === 'current' ? 'Next permit' : 'Future permit'}</small></div>
                <p><strong>{stage.call}.</strong> {stage.goal}</p>
                <small className="fine">Unlock: {stage.unlock}</small>
              </div>
            </li>
          )
        })}
      </ol>

      <Section title="Two acts · one economy">
        <p className="fine">Your company began in Act I behind Mama Ade’s corner shop (/city), keeping Market Quarter alive through the 2026 Strait of Hormuz oil shock. Now in Act II, the Regulator has drafted you to command Vesper’s 7-district regional grid under the COP31 Sovereign Grid Accord.</p>
        <p className="fine">The weekly crisis drill gives every operator the same starting conditions for a three-day run. Your saved company stays separate, and there is no penalty for missing a week or stepping away.</p>
      </Section>
    </>
  )
}

const ORIGINS = [
  {
    id: 'eastside_shed',
    badge: '⚡ Market Quarter Shed Alumni',
    motto: 'From a 5 kW diesel shed behind Mama Ade’s shop to the regional dispatch desk.',
  },
  {
    id: 'harbor_syndicate',
    badge: '⚓ Harbour Marine Engineers',
    motto: 'Keeping dockside cranes and cold-chain reefers running through the Strait fuel squeeze.',
  },
  {
    id: 'northbelt_coop',
    badge: '☀️ North Belt Solar Syndicate',
    motto: 'Zero-carbon noon power paired with grid-scale storage under the COP31 Accord.',
  },
  {
    id: 'civic_trust',
    badge: '🏥 St. Aurelia Civic Power Trust',
    motto: 'Sworn to critical hospital uptime, fair household tariffs, and sovereign reserve.',
  },
] as const

type OriginId = (typeof ORIGINS)[number]['id']

function loadOrigin(): OriginId {
  try {
    const saved = localStorage.getItem('bo_origin_id') as OriginId | null
    if (saved && ORIGINS.some((o) => o.id === saved)) return saved
  } catch {
    /* ignore storage errors */
  }
  return 'eastside_shed'
}

export function WhosWho({ v, companyName = null }: { v: RegionView; companyName?: string | null }) {
  const myPlants = v.plants.filter((p) => p.mine)
  const myCapKw = myPlants.reduce((a, p) => a + p.capacityKw, 0)
  const myOutKw = myPlants.reduce((a, p) => a + Math.max(0, p.netKw), 0)
  const totalOutKw = v.plants.reduce((a, p) => a + Math.max(0, p.netKw), 0)
  const mySharePct = totalOutKw > 0 ? Math.round((myOutKw / totalOutKw) * 100) : 0

  const generators = [
    {
      id: 'player',
      name: companyName || 'Your Power Company',
      person: `You · ${v.player.licenceName}`,
      face: '⚡',
      cashCc: v.player.cashCc,
      debtCc: v.player.debtCc,
      capacityKw: myCapKw,
      outputKw: myOutKw,
      plantCount: myPlants.length,
      state: 'healthy' as const,
      quote: `Supplying ${mySharePct}% of active regional generation (${v.player.deliveredMWh.toLocaleString('en-US')} MWh delivered at ${pct(v.player.reliabilityBps)} reliability).`,
      mine: true,
    },
    ...(v.rivals ?? []).map((r) => ({ ...r, id: r.ownerId, mine: false })),
  ].sort((a, b) => b.cashCc - a.cashCc)

  return (
    <>
      <p className="eyebrow">VESPER DIRECTORY · POWER GENERATORS</p>
      <h3>Who’s Who on the Vesper Grid</h3>
      <p className="fine">Ranked by live company cash on the regional ledger. Every generator competes in the same 5-minute nodal pool.</p>
      <ol className="career-ladder">
        {generators.map((g, idx) => (
          <li key={g.id} className={`career-stage ${g.mine ? 'current' : 'earned'}`}>
            <span className="career-stage-mark" aria-hidden>{idx + 1}</span>
            <div style={{ width: '100%' }}>
              <div className="career-stage-title">
                <b>{g.face} {g.name} <small className="fine">· {g.person}</small></b>
                <small>{g.state === 'distressed' ? 'Distressed' : g.state === 'strained' ? 'Strained' : g.mine ? 'Your company' : 'Active rival'}</small>
              </div>
              <div className="stat-grid" style={{ marginTop: 6, marginBottom: 6 }}>
                <Stat label="Cash" value={credits(g.cashCc)} tone={g.mine ? 'gold' : undefined} />
                <Stat label="Debt" value={credits(g.debtCc)} tone={g.debtCc > 0 ? 'warn' : undefined} />
                <Stat label="Fleet" value={`${mw(g.capacityKw)} (${g.plantCount})`} />
                <Stat label="Dispatch now" value={mw(g.outputKw)} />
              </div>
              <p className="fine" style={{ margin: 0 }}>“{g.quote}”</p>
            </div>
          </li>
        ))}
      </ol>

      <Section title="Civic & Industrial Leaders">
        <p className="fine">Major employers and community anchors across the seven districts, with their live cash reserves and operating status.</p>
        {v.actors.slice(0, 8).map((a) => (
          <div key={a.actorId} className="supplier" style={{ marginBottom: 8 }}>
            <div className="sup-head">
              <span>{a.face} <b>{a.person}</b> <small>{a.name}</small></span>
              <b>{credits(a.cashCc)}</b>
            </div>
            <small className="fine">
              Load {mw(a.servedKw)} / {mw(a.demandKw)} · Output {pct(a.productionBps)} · Health {pct(a.healthBps)} · Status: <b>{a.state}</b>
            </small>
            <p className="fine" style={{ margin: '4px 0 0' }}>“{a.quote}”</p>
          </div>
        ))}
      </Section>
    </>
  )
}

export function OperatorCertificate({ v, companyName = null }: { v: RegionView; companyName?: string | null }) {
  const [originId, setOriginId] = useState<OriginId>(loadOrigin)
  const [copied, setCopied] = useState(false)
  const origin = ORIGINS.find((o) => o.id === originId) ?? ORIGINS[0]
  const myPlants = v.plants.filter((p) => p.mine)
  const myCapKw = myPlants.reduce((a, p) => a + p.capacityKw, 0)
  const co = companyName || 'Vesper Independent Utility'

  const selectOrigin = (id: OriginId) => {
    setOriginId(id)
    try {
      localStorage.setItem('bo_origin_id', id)
    } catch {
      /* ignore */
    }
  }

  const copySummary = async () => {
    const text = [
      `=== VESPER GRID AUTHORITY · OPERATING CERTIFICATE ===`,
      `Company: ${co}`,
      `Charter: ${origin.badge} — "${origin.motto}"`,
      `Permit Rank: Level ${v.player.licence}/4 · ${v.player.licenceName}`,
      `Delivered Energy: ${v.player.deliveredMWh.toLocaleString('en-US')} MWh`,
      `Regional Reliability: ${pct(v.player.reliabilityBps)}`,
      `Company Cash: ${credits(v.player.cashCc)} · Net Worth: ${credits(v.player.netWorthCc)}`,
      `Installed Fleet: ${myPlants.length} plants (${mw(myCapKw)})`,
      `Cumulative CO₂: ${v.player.emissionsT.toLocaleString('en-US')} t · Score: ${v.scores.score.toLocaleString('en-US')} pts`,
      `Verified Settlement Epochs: ${v.settlement.epochs.length}`,
    ].join('\n')
    try {
      await navigator.clipboard?.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 3_000)
    } catch {
      setCopied(true)
      setTimeout(() => setCopied(false), 3_000)
    }
  }

  return (
    <>
      <section className="campaign-brief campaign-complete" aria-label="Operating certificate">
        <div className="campaign-brief-top">
          <span>VESPER GRID AUTHORITY · COP31 SOVEREIGN GRID ACCORD</span>
          <b>PERMIT LEVEL {v.player.licence} / 4</b>
        </div>
        <h3 style={{ margin: '6px 0 2px' }}>{co}</h3>
        <p className="fine" style={{ margin: '0 0 8px' }}>
          <b>{origin.badge}</b> — <em>“{origin.motto}”</em>
        </p>
        <div className="stat-grid" style={{ marginBottom: 10 }}>
          <Stat label="Permit class" value={v.player.licenceName} tone="gold" />
          <Stat label="Delivered" value={`${v.player.deliveredMWh.toLocaleString('en-US')} MWh`} />
          <Stat label="Grid reliability" value={pct(v.player.reliabilityBps)} tone={v.player.reliabilityBps >= 9_700 ? 'ok' : 'warn'} />
          <Stat label="Net worth" value={credits(v.player.netWorthCc)} />
          <Stat label="Company cash" value={credits(v.player.cashCc)} />
          <Stat label="Active fleet" value={`${mw(myCapKw)} (${myPlants.length})`} />
          <Stat label="CO₂ emissions" value={`${v.player.emissionsT.toLocaleString('en-US')} t`} />
          <Stat label="Operator score" value={v.scores.score.toLocaleString('en-US')} />
        </div>
        <div className="campaign-unlock">
          <span>SETTLEMENT RECORD</span>
          <b>{v.settlement.epochs.length} verified epochs · Day {v.clock.day} ({v.clock.label})</b>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary small" onClick={() => void copySummary()}>
            {copied ? '✓ Certificate copied to clipboard' : '📋 Copy official certificate summary'}
          </button>
        </div>
      </section>

      <Section title="Company charter & origin badge (cosmetic)">
        <p className="fine">Choose the background story printed on your Operating Certificate. Charter badges are purely cosmetic so weekly crisis leaderboards stay strictly fair.</p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {ORIGINS.map((o) => (
            <button
              key={o.id}
              type="button"
              className={`btn small ${originId === o.id ? 'primary' : 'ghost'}`}
              onClick={() => selectOrigin(o.id)}
            >
              {o.badge}
            </button>
          ))}
        </div>
      </Section>
    </>
  )
}
