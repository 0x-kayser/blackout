import { useEffect, useState } from 'react'
import type { GameStatePublic, LeaderboardResponse } from '@blackout/shared'
import { api } from '../api/client'
import { fmtCredits, fmtPct } from './format'

interface ChallengeInfo {
  week: string
  seed: number
  conditionName: string
  description: string
  days: number
}

export function WeeklyCard({ onPlay }: { onPlay: () => void }) {
  const [info, setInfo] = useState<ChallengeInfo | null>(null)
  const [board, setBoard] = useState<LeaderboardResponse | null>(null)
  useEffect(() => {
    fetch('/api/challenge').then((r) => r.json()).then((j) => j.ok && setInfo(j)).catch(() => null)
    api.leaderboard().then(setBoard).catch(() => null)
  }, [])
  if (!info) return null
  return (
    <section className="weekly-card">
      <div>
        <p className="eyebrow amber">🏆 WEEKLY CHALLENGE · {info.week}</p>
        <b>{info.conditionName}</b>
        <small>{info.description} Every entry uses the same seed and world condition. {info.days} game days; scores are ranked after the run ends.</small>
        {board && board.entries.length > 0 && (
          <ol className="mini-board">
            {board.entries.slice(0, 3).map((e) => <li key={e.rank}>{e.rank}. {e.displayName}: {e.score}</li>)}
          </ol>
        )}
      </div>
      <button className="button" onClick={onPlay}>Enter challenge</button>
    </section>
  )
}

export function ChallengeResults({ s, onBack }: { s: GameStatePublic; onBack: () => void }) {
  const [board, setBoard] = useState<LeaderboardResponse | null>(null)
  useEffect(() => {
    // the server records the score when the run finishes; fetch shortly after
    const t = setTimeout(() => api.leaderboard().then(setBoard).catch(() => null), 600)
    return () => clearTimeout(t)
  }, [])
  const c = s.campaign
  return (
    <div className="intro-backdrop" role="dialog" aria-modal="true" aria-labelledby="results-title">
      <section className="intro-card results">
        <p className="eyebrow amber">WEEKLY CHALLENGE {s.run.challengeWeek} · COMPLETE</p>
        <h1 id="results-title">Score {c.score}</h1>
        <div className="report-grid">
          <div className="metric-card"><small>Net worth</small><b>{fmtCredits(c.netWorthCc)}</b></div>
          <div className="metric-card"><small>Reliability</small><b>{fmtPct(c.reliabilityBps)}</b></div>
          <div className="metric-card"><small>City GDP</small><b>{fmtCredits(c.cityGdpCc)}</b></div>
        </div>
        <ul className="badges">{c.badges.map((b) => <li key={b.id} className={b.earned ? 'earned' : ''}>{b.earned ? '🏅' : '○'} {b.label} <small>{b.reason}</small></li>)}</ul>
        <p className="eyebrow">THIS WEEK'S LEADERBOARD</p>
        {board ? (
          <ol className="board">
            {board.entries.map((e) => (
              <li key={e.rank} className={e.you ? 'you' : ''}><span>{e.rank}</span><b>{e.displayName}{e.you ? ' (you)' : ''}</b><em>{e.score}</em></li>
            ))}
          </ol>
        ) : (
          <p className="fine">Loading…</p>
        )}
        <p className="fine">The server calculates each score from the completed run. Every entry uses this week’s seed and world condition.</p>
        <button className="button primary" onClick={onBack}>Back to my city <b>→</b></button>
      </section>
    </div>
  )
}
