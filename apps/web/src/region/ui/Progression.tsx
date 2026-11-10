import type { RegionView } from '@blackout/shared'
import { credits, pct } from '../format'
import { Bar, Section } from './Bits'
import type { ChallengeInfo } from '../api'

const PERMITS = [
  { rank: 1, name: 'Independent Generator', mwh: 0, reliabilityBps: 0, detail: 'Start your company and learn to keep the region supplied.', unlock: 'Starting build options' },
  { rank: 2, name: 'Regional Producer', mwh: 3_000, reliabilityBps: 0, detail: 'Deliver 3,000 MWh to earn a larger place in the regional market.', unlock: 'Combined-cycle generation and selected larger builds' },
  { rank: 3, name: 'System Partner', mwh: 15_000, reliabilityBps: 9_700, detail: 'Deliver 15,000 MWh while keeping regional reliability at or above 97%.', unlock: 'The largest combined-cycle plant and battery build' },
  { rank: 4, name: 'Grid Anchor', mwh: 45_000, reliabilityBps: 9_800, detail: 'Deliver 45,000 MWh while keeping regional reliability at or above 98%.', unlock: 'BLACKOUT’s highest operating permit' },
] as const

export function LoopGoals({ v, challenge, onCareer, onChallenge }: { v: RegionView; challenge: ChallengeInfo | null; onCareer: () => void; onChallenge: () => void }) {
  const next = v.player.nextLicence
  const delivered = next?.haveMWh ?? v.player.deliveredMWh
  const mwhProgress = next ? Math.min(100, (delivered / Math.max(1, next.needMWh)) * 100) : 100
  const week = challenge?.week.replace('-', ' · ') ?? 'THIS WEEK'
  return (
    <nav className="loop-goals" aria-label="Ongoing goals">
      {v.mode === 'live' && (
        <button className="loop-goal career-goal" onClick={onCareer} aria-label="Open operating permits">
          <span className="loop-kicker">OPERATING PERMIT · {v.player.licenceName}</span>
          <strong>{next ? `Next permit: ${next.name}` : 'Grid Anchor reached'}</strong>
          <span className="loop-detail">
            {next ? `${delivered.toLocaleString('en-US')} / ${next.needMWh.toLocaleString('en-US')} MWh delivered${next.needReliabilityBps ? ` · ${pct(v.player.reliabilityBps)} / ${pct(next.needReliabilityBps)} reliability` : ''}` : 'You hold the highest regional permit.'}
          </span>
          {next && <i className="loop-meter" aria-hidden><b style={{ width: `${mwhProgress}%` }} /></i>}
        </button>
      )}
      <button className="loop-goal weekly-goal" onClick={onChallenge} aria-label="Open this week’s challenge">
        <span className="loop-kicker">WEEKLY CHALLENGE · {week}</span>
        <strong>{challenge?.name ?? 'A new regional scenario'}</strong>
        <span className="loop-detail">{challenge?.description ?? 'A shared three-day scenario. Set a score and compare it on the leaderboard.'}</span>
      </button>
    </nav>
  )
}

export function Career({ v }: { v: RegionView }) {
  const next = v.player.nextLicence
  const delivered = next?.haveMWh ?? v.player.deliveredMWh
  const mwhDone = !!next && delivered >= next.needMWh
  const reliabilityDone = !next?.needReliabilityBps || v.player.reliabilityBps >= next.needReliabilityBps
  return (
    <>
      <h3>Operating permits</h3>
      <p className="fine">Earn larger permits by supplying power and keeping the region reliable. Each permit opens plant sizes that are restricted by the regional regulator.</p>
      {next ? (
        <Section title={`Next permit · ${next.name}`}>
          <p className="fine">{mwhDone ? 'Delivery target met.' : `${Math.max(0, next.needMWh - delivered).toLocaleString('en-US')} MWh left to deliver.`}{next.needReliabilityBps ? ` Regional reliability must also stay at or above ${pct(next.needReliabilityBps)}; it is now ${pct(v.player.reliabilityBps)}.` : ''}</p>
          <Bar value={delivered} max={next.needMWh} tone="gold" label={`${delivered} of ${next.needMWh} MWh delivered`} />
          {next.needReliabilityBps > 0 && <Bar value={v.player.reliabilityBps} max={10_000} tone={reliabilityDone ? 'teal' : 'amber'} label={`Regional reliability ${pct(v.player.reliabilityBps)}; need ${pct(next.needReliabilityBps)}`} />}
        </Section>
      ) : (
        <Section title="Highest permit earned">
          <p className="fine">You hold Grid Anchor, the region’s highest operating permit. Keep your company running and set a score in the weekly challenge.</p>
        </Section>
      )}
      <div className="career-ladder">
        {PERMITS.map((stage) => {
          const status = stage.rank < v.player.licence ? 'earned' : stage.rank === v.player.licence ? 'current' : stage.rank === v.player.licence + 1 ? 'next' : 'future'
          return (
            <article key={stage.rank} className={`career-stage ${status}`}>
              <span className="career-stage-mark" aria-hidden>{status === 'earned' ? '✓' : status === 'current' ? '●' : status === 'next' ? '→' : '○'}</span>
              <div>
                <div className="career-stage-title"><b>{stage.name}</b><small>{status === 'earned' ? 'Permit earned' : status === 'current' ? 'Current permit' : status === 'next' ? 'Next permit' : 'Future permit'}</small></div>
                <p>{stage.detail}</p>
                <small className="fine">{stage.unlock}</small>
              </div>
            </article>
          )
        })}
      </div>
      <p className="fine">Your permit progress is part of your saved company. The weekly challenge gives you a fresh shared scenario without a login streak or missed-day penalty.</p>
      <p className="fine">Current balance: {credits(v.player.cashCc)}.</p>
    </>
  )
}
