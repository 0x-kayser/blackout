import type { RegionView } from '@blackout/shared'
import { credits, pct } from '../format'
import { Section } from './Bits'
import type { ChallengeInfo } from '../api'

const PERMITS = [
  { rank: 1, name: 'Independent Generator', call: 'First Light', goal: 'Restore Eastside, bring the Kestrel turbine online, and build emergency capacity.', unlock: 'Starter generation and storage builds' },
  { rank: 2, name: 'Regional Producer', call: 'Build the first reserve', goal: 'Deliver 3,000 MWh to earn a place in the regional market.', unlock: 'Combined-cycle generation and larger turbine and solar builds' },
  { rank: 3, name: 'System Partner', call: 'Hold the line', goal: 'Deliver 15,000 MWh while keeping reliability at or above 97%.', unlock: 'The largest combined-cycle plant and 200 MW battery build' },
  { rank: 4, name: 'Grid Anchor', call: 'Become the reserve', goal: 'Deliver 45,000 MWh while keeping reliability at or above 98%.', unlock: 'The region’s highest operating permit' },
] as const

function campaignObjective(v: RegionView) {
  const next = v.player.nextLicence
  if (!next) return { kicker: 'CAMPAIGN COMPLETE', title: 'You are Vesper’s Grid Anchor', detail: 'Your highest operating permit is earned. Keep building your company or take this week’s crisis drill.' }
  const mwhProgress = Math.min(100, (next.haveMWh / Math.max(1, next.needMWh)) * 100)
  const reliabilityProgress = next.needReliabilityBps > 0
    ? Math.min(100, (v.player.reliabilityBps / next.needReliabilityBps) * 100)
    : 100
  const reliability = next.needReliabilityBps > 0
    ? ` · ${pct(v.player.reliabilityBps)} reliability / ${pct(next.needReliabilityBps)} required`
    : ''
  const chapter = v.player.licence
  const titles = ['', 'Earn the Regional Producer permit', 'Prove you can hold 97% reliability', 'Become Vesper’s Grid Anchor']
  return {
    kicker: `VESPER CAMPAIGN · OPERATION ${chapter} OF 3`,
    title: titles[chapter] ?? `Earn ${next.name}`,
    detail: `${next.haveMWh.toLocaleString('en-US')} / ${next.needMWh.toLocaleString('en-US')} MWh delivered${reliability}`,
    progress: Math.min(mwhProgress, reliabilityProgress),
  }
}

export function LoopGoals({ v, challenge, onCareer, onChallenge }: { v: RegionView; challenge: ChallengeInfo | null; onCareer: () => void; onChallenge: () => void }) {
  const operation = campaignObjective(v)
  const week = challenge?.week.replace('-', ' · ') ?? 'THIS WEEK'
  return (
    <nav className="loop-goals" aria-label="Campaign and weekly challenge">
      {v.mode === 'live' && (
        <button className="loop-goal career-goal" onClick={onCareer} aria-label="Open Vesper campaign">
          <span className="loop-kicker">{operation.kicker}</span>
          <strong>{operation.title}</strong>
          <span className="loop-detail">{operation.detail}</span>
          {operation.progress !== undefined && <i className="loop-meter" aria-hidden><b style={{ width: `${operation.progress}%` }} /></i>}
        </button>
      )}
      <button className="loop-goal weekly-goal" onClick={onChallenge} aria-label="Open this week’s crisis drill">
        <span className="loop-kicker">WEEKLY CRISIS DRILL · {week}</span>
        <strong>{challenge?.name ?? 'The regional grid needs you'}</strong>
        <span className="loop-detail">
          {v.mode === 'challenge'
            ? `Day ${Math.min(v.clock.day, 3)} of 3 · score ${v.scores.score.toLocaleString('en-US')}`
            : challenge?.description ?? 'Same starting conditions for every operator. Play the three-day run and compare results.'}
        </span>
      </button>
    </nav>
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
      <p className="fine">Each permit is earned from the power you deliver and the reliability you maintain. It opens real plant sizes in your region; there are no XP levels to grind.</p>
      {next && nextStage ? (
        <section className="campaign-brief">
          <div className="campaign-brief-top">
            <span>ACTIVE OPERATION · {nextStage.call}</span>
            <b>{v.player.licence} / 4 permits</b>
          </div>
          <p>{nextStage.goal}</p>
          <div className="campaign-metrics">
            <div><small>POWER DELIVERED</small><strong>{delivered.toLocaleString('en-US')} <em>/ {next.needMWh.toLocaleString('en-US')} MWh</em></strong><i><b style={{ width: `${mwhProgress}%` }} /></i></div>
            {next.needReliabilityBps > 0 && <div><small>REGIONAL RELIABILITY</small><strong>{pct(v.player.reliabilityBps)} <em>/ {pct(next.needReliabilityBps)}</em></strong><i><b className={reliabilityDone ? 'complete' : ''} style={{ width: `${reliabilityProgress}%` }} /></i></div>}
          </div>
          <div className="campaign-unlock"><span>PERMIT UNLOCK</span><b>{nextStage.unlock}</b></div>
          {(!mwhDone || !reliabilityDone) && <p className="campaign-next">{mwhDone && !reliabilityDone ? 'Output target reached. Keep the region reliable to qualify.' : `${Math.max(0, next.needMWh - delivered).toLocaleString('en-US')} MWh left${next.needReliabilityBps ? ` · reliability must stay at ${pct(next.needReliabilityBps)} or higher` : ''}.`}</p>}
        </section>
      ) : (
        <section className="campaign-brief campaign-complete">
          <div className="campaign-brief-top"><span>ALL FOUR PERMITS EARNED</span><b>Campaign complete</b></div>
          <p>You hold Grid Anchor, Vesper’s highest operating permit. Continue building and trading in your saved region, or take the shared weekly crisis drill.</p>
          <div className="campaign-unlock"><span>YOUR CURRENT RESERVE</span><b>{credits(v.player.cashCc)} in company cash</b></div>
        </section>
      )}

      <h4 className="route-list-title">PERMIT ROUTE</h4>
      <ol className="career-ladder">
        {PERMITS.map((stage) => {
          const status = stage.rank <= v.player.licence ? stage.rank === v.player.licence && next ? 'current' : 'earned' : stage.rank === v.player.licence + 1 ? 'next' : 'future'
          return (
            <li key={stage.rank} className={`career-stage ${status}`}>
              <span className="career-stage-mark" aria-hidden>{status === 'earned' ? '✓' : status === 'current' ? '●' : status === 'next' ? '→' : '○'}</span>
              <div>
                <div className="career-stage-title"><b>{stage.rank}. {stage.name}</b><small>{status === 'earned' ? 'Earned' : status === 'current' ? 'Current permit' : status === 'next' ? 'Next permit' : 'Future permit'}</small></div>
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
