import type { GameStatePublic } from '@blackout/shared'
import { bizName, fmtCredits, fmtLitres, secondsLeft } from './format'

export type CoachPanel = 'market' | 'exchange' | 'equipment' | 'expansion'
export interface CoachTip {
  icon: string
  text: string
  tone: 'red' | 'amber' | 'teal' | 'muted'
  action?: { label: string; panel: CoachPanel }
}

/**
 * "Your next move": one plain sentence that always says what matters most right now. It reads only the
 * public state the player can already see, so it never reveals anything the game hides.
 */
export function nextMove(s: GameStatePublic): CoachTip {
  const open = s.requests.filter((r) => r.status === 'open' || r.status === 'customer_countered')
  const codeRed = open.find((r) => r.urgency === 'code_red')
  if (codeRed) {
    return { icon: '🚨', tone: 'red', text: `Code Red at ${bizName(s, codeRed.businessId)}: Accept within ${secondsLeft(s, codeRed.deadlineTick) ?? 0}s for double pay.` }
  }
  const pending = s.contracts.find((c) => c.provider === 'player' && c.status === 'pending_assignment')
  if (pending) return { icon: '🔌', tone: 'amber', text: `Tap a glowing generator to power ${bizName(s, pending.businessId)}.` }
  const blocked = open.find((r) => {
    const d = s.districts.find((x) => x.districtId === r.districtId)
    return d && d.feederLoadW + r.requestedW > d.feederCapacityW
  })
  if (blocked) {
    const d = s.districts.find((x) => x.districtId === blocked.districtId)!
    return { icon: '🗼', tone: 'red', text: `${d.name}'s feeder is full (${(d.feederLoadW / 1000).toFixed(1)}/${(d.feederCapacityW / 1000).toFixed(0)} kW). Upgrade its substation to take ${bizName(s, blocked.businessId)}'s call.`, action: { label: 'Grid', panel: 'expansion' } }
  }
  if (open.length) {
    const r = open[0]
    return { icon: '⚡', tone: 'amber', text: `${bizName(s, r.businessId)} lost power: Accept, or Counter to ask for more.${open.length > 1 ? ` (${open.length} calls waiting)` : ''}` }
  }
  const free = s.player.fuelMl - s.player.fuelReservedMl
  if (free < 5_000 && s.player.pendingFuelMl === 0) {
    return { icon: '⛽', tone: 'red', text: `Only ${fmtLitres(Math.max(0, free))} of free diesel. Buy fuel before your generator runs dry.`, action: { label: 'Market', panel: 'market' } }
  }
  const worn = s.generators.find((g) => g.type === 'diesel' && (g.status === 'broken' || g.wearBps >= 7_000))
  if (worn) return { icon: '🛠', tone: 'amber', text: `${worn.name} is ${worn.status === 'broken' ? 'broken' : 'badly worn'}. Service it before your next contract.`, action: { label: 'Equipment', panel: 'equipment' } }
  if (s.player.exchangeDepositableFuelMl >= 5_000) {
    return { icon: '⇄', tone: 'teal', text: `You have ${fmtLitres(s.player.exchangeDepositableFuelMl)} of spare bought fuel. Sell it to other cities on the Exchange.`, action: { label: 'Exchange', panel: 'exchange' } }
  }
  const connectable = s.districts.find((d) => !d.unlocked && d.requiredStage <= s.company.stage && d.unlockCostCc <= s.player.creditsCc)
  if (connectable) return { icon: '🗼', tone: 'teal', text: `You can connect ${connectable.name} (${fmtCredits(connectable.unlockCostCc)}): ${(connectable.totalDemandW / 1000).toFixed(0)} kW of new customers.`, action: { label: 'Grid', panel: 'expansion' } }
  const affordable = s.upgradesCatalog.find((u) => !u.owned && u.requiredStage <= s.company.stage && u.costCc <= s.player.creditsCc)
  if (affordable) return { icon: '📈', tone: 'teal', text: `You can afford ${affordable.name} (${fmtCredits(affordable.costCc)}). More capacity means more customers.`, action: { label: 'Equipment', panel: 'equipment' } }
  if (s.company.nextStage && s.company.progressBps >= 8_000) return { icon: '🏗', tone: 'amber', text: `Almost a ${s.company.nextStage.name}: ${s.company.nextStage.unlocks}`, action: { label: 'Grid', panel: 'expansion' } }
  const goal = s.goals.items.find((g) => !g.done)
  if (goal) return { icon: '🎯', tone: 'muted', text: `Shift goal: ${goal.label}.` }
  return { icon: '🌙', tone: 'muted', text: `All quiet. Next outage in ${Math.max(0, (s.clock.nextWaveTick ?? s.clock.tick) - s.clock.tick)}s. Check the Exchange for cheap diesel.`, action: { label: 'Exchange', panel: 'exchange' } }
}

export function Coach({ s, onOpen }: { s: GameStatePublic; onOpen: (p: CoachPanel) => void }) {
  const tip = nextMove(s)
  return (
    <div className={`coach ${tip.tone}`} role="status" aria-live="polite">
      <span className="coach-label">NEXT MOVE</span>
      <span className="coach-text"><span aria-hidden>{tip.icon}</span> {tip.text}</span>
      {tip.action && <button className="coach-go" onClick={() => onOpen(tip.action!.panel)}>{tip.action.label} →</button>}
    </div>
  )
}
