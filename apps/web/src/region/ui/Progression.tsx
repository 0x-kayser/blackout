import type { RegionView } from '@blackout/shared'
import { credits, pct } from '../format'
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

export function LoopGoals({ v, challenge, move, onCareer, onChallenge, onLive, onDoMove }: { v: RegionView; challenge: ChallengeInfo | null; move: Move | null; onCareer: (tab: OperationTab) => void; onChallenge: () => void; onLive: () => void; onDoMove: () => void }) {
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
