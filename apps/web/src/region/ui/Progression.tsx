import type { FuelId, RegionView, SupplierView, TownView } from '@blackout/shared'
import { ITEMS } from '@blackout/shared'
import { credits, pct, price } from '../format'
import { Section } from './Bits'
import type { ChallengeInfo } from '../api'
import type { Move } from './Guide'
import { useEffect, useState } from 'react'
import { WeeklyChallenge } from './Settings'

const PERMITS = [
  { rank: 1, name: 'Independent Generator', call: 'First Light', goal: 'Restore Eastside, bring the Kestrel turbine online, and build emergency capacity.', unlock: 'Starter generation and storage builds' },
  { rank: 2, name: 'Regional Producer', call: 'Win a place in the market', goal: 'Deliver 3,000 MWh to earn a place in Vesper’s regional market.', unlock: 'Combined-cycle generation and larger turbine and solar builds' },
  { rank: 3, name: 'System Partner', call: 'Hold the line', goal: 'Deliver 15,000 MWh while keeping reliability at or above 97%.', unlock: 'The largest combined-cycle plant and 200 MW battery build' },
  { rank: 4, name: 'Grid Anchor', call: 'Become the reserve', goal: 'Deliver 45,000 MWh while keeping reliability at or above 98%.', unlock: 'The region’s highest operating permit' },
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

export function LoopGoals({ v, town, challenge, move, onCareer, onChallenge, onLive, onDoMove, tutorialIncomplete, onResumeTutorial, onOpenMarket, onOpenDispatch, onToggleAutoFuel }: { v: RegionView; town: TownView | null; challenge: ChallengeInfo | null; move: Move | null; onCareer: (tab: OperationTab) => void; onChallenge: () => void; onLive: () => void; onDoMove: () => void; tutorialIncomplete?: boolean; onResumeTutorial?: () => void; onOpenMarket: () => void; onOpenDispatch: () => void; onToggleAutoFuel: (fuel: FuelId, enabled: boolean) => void }) {
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
      <button className="operation-weekly" onClick={isChallenge ? onLive : onChallenge}>{isChallenge ? '← Return to your company' : `Play this week’s crisis · ${challenge?.name ?? '3-day run'} →`}</button>
    </section>
  )
}

export type OperationTab = 'campaign' | 'weekly'

export function OperationCenter({ v, challenge, initialTab, onClose, onChallenge, onLive }: { v: RegionView; challenge: ChallengeInfo | null; initialTab: OperationTab; onClose: () => void; onChallenge: () => Promise<void>; onLive: () => Promise<void> }) {
  const [activeTab, setActiveTab] = useState<OperationTab>(initialTab)
  useEffect(() => {
    const closeOnEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])
  useEffect(() => { if (v.mode === 'challenge') setActiveTab('weekly') }, [v.mode])
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
        </nav>
        <div className="ops-body">
          {activeTab === 'campaign' ? (
            <>
          <p className="ops-intro">Build a company the region can rely on. Keep the lights on, grow your power business, and earn stronger plants as you rise through the permits.</p>
              <Career v={v} />
            </>
          ) : (
            <>
              <p className="ops-intro">A fresh regional condition changes the opening market each week. Solve the three-day crisis, then compare your score with other operators.</p>
              <WeeklyChallenge v={v} onChallenge={onChallenge} onLive={onLive} />
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

      <Section title="A fresh challenge every week">
        <p className="fine">The crisis drill gives every operator the same starting conditions for a three-day run. Your saved company stays separate, and there is no penalty for missing a week or stepping away.</p>
      </Section>
    </>
  )
}
