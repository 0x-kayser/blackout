/**
 * Learning by playing (§55–56). The first minute is three taps on glowing buttons in the world; after that one line
 * at the bottom always says the single most useful thing to do now, with a button that does it.
 */
import type { ItemId, NodeId, RegionAction, RegionView, TownView } from '@blackout/shared'
import { credits, hours, mw, price } from '../format'
import type { Selection } from '../scene/World3D'

export interface Mission {
  step: number
  title: string
  hint: string
  target: string
  label: string
  action: RegionAction
}

export function missionFor(v: RegionView): Mission | null {
  if (v.onboarding.done || !v.onboarding.target) return null
  const step = v.onboarding.step
  const diesel = v.techs.find((t) => t.tech === 'diesel')?.sizes[1]
  if (step === 0) return { step, title: 'Residential East is dark', hint: 'Send it power from your battery.', target: 'plant:eastside', label: '⚡ Send power', action: { type: 'SET_BATTERY_MODE', plantId: 'eastside', mode: 'auto' } }
  if (step === 1) return { step, title: 'The region is short of power', hint: 'Start your gas turbine. You get paid for every megawatt it makes.', target: 'plant:kestrel', label: '▶ Start turbine', action: { type: 'SET_PLANT_ONLINE', plantId: 'kestrel', online: true } }
  return { step, title: 'Your battery won’t last all night', hint: 'Build a diesel plant in Residential East.', target: 'node:residential_east', label: `+ Build diesel plant${diesel ? ` · ${credits(diesel.costCc)}` : ''}`, action: { type: 'BUILD_PLANT', tech: 'diesel', nodeId: 'residential_east', size: 1 } }
}

export const CELEBRATE = ['Lights back on in Residential East', 'Your turbine is running — you’re earning', 'Construction started — you run the power company now']

export function MissionBanner({ m }: { m: Mission }) {
  return (
    <div className="mission" role="status" aria-live="polite">
      <div className="mission-dots" aria-label={`Step ${m.step + 1} of 3`}>
        {[0, 1, 2].map((i) => (
          <i key={i} className={i < m.step ? 'done' : i === m.step ? 'now' : ''} />
        ))}
      </div>
      <b>{m.title}</b>
      <span>{m.hint} Tap the glowing button.</span>
    </div>
  )
}

export function Celebration({ text }: { text: string }) {
  return (
    <div className="celebrate" role="status">
      <span>✓</span> {text}
    </div>
  )
}

export interface Move {
  tone: 'crisis' | 'warn' | 'ok' | 'info'
  text: string
  button?: string
  action?: RegionAction
  select?: Selection
  build?: NodeId
  grid?: boolean
  trade?: { merchantId: string; item: ItemId; side: 'buy' | 'sell'; qty: number }
  market?: boolean
}

/** The one thing worth doing now, from the live view. */
export function nextMove(v: RegionView, town: TownView | null = null): Move {
  const mine = v.plants.filter((p) => p.mine)
  const dark = v.nodes.filter((n) => n.shedKw > 0).sort((a, b) => b.shedKw - a.shedKw)[0]
  if (dark) {
    const batt = mine.find((p) => p.tech === 'battery' && p.nodeId === dark.nodeId && p.status === 'online' && p.socKwh > p.energyKwh * 0.05 && p.batteryMode !== 'discharge')
    if (batt) return { tone: 'crisis', text: `${dark.name} is dark (${mw(dark.shedKw)}).`, button: `⚡ Discharge ${batt.name}`, action: { type: 'SET_BATTERY_MODE', plantId: batt.plantId, mode: 'discharge' } }
    const idle = mine.find((p) => p.fuel && p.nodeId === dark.nodeId && p.status === 'offline')
    if (idle) return { tone: 'crisis', text: `${dark.name} is dark (${mw(dark.shedKw)}).`, button: `▶ Start ${idle.name}`, action: { type: 'SET_PLANT_ONLINE', plantId: idle.plantId, online: true } }
    const coming = mine.find((p) => p.nodeId === dark.nodeId && p.status === 'building')
    if (coming) return { tone: 'crisis', text: `${dark.name} is dark (${mw(dark.shedKw)}). ${coming.name} arrives in ${hours(coming.buildRemaining)}.`, button: 'Watch it', select: { kind: 'plant', id: coming.plantId } }
    const line = v.corridors.find((c) => (c.from === dark.nodeId || c.to === dark.nodeId) && c.congested && c.upgrade.building === null)
    if (line) return { tone: 'crisis', text: `${dark.name} is dark: ${line.name} is full.`, button: `Upgrade it · ${credits(line.upgrade.costCc)}`, action: { type: 'UPGRADE_CORRIDOR', corridorId: line.corridorId } }
    return { tone: 'crisis', text: `${dark.name} is dark (${mw(dark.shedKw)}). Build power there.`, button: `+ Build in ${dark.name}`, build: dark.nodeId }
  }
  const broken = mine.find((p) => p.status === 'tripped')
  if (broken) return { tone: 'warn', text: `${broken.name} tripped (${broken.tripReason}). Crews take hours; turbine kits fix it now.`, button: `🔧 Repair with ${broken.repairParts} kit${broken.repairParts > 1 ? 's' : ''}`, action: { type: 'REPAIR_PLANT', plantId: broken.plantId } }
  if (v.player.cashCc < 3_000_000 || (v.player.cashCc < 8_000_000 && v.player.profitCcToday < 0)) {
    return { tone: v.player.cashCc < 1_000_000 ? 'crisis' : 'warn', text: `Cash is tight at ${credits(v.player.cashCc)}. Check credit, fuel spending and assets before the next purchase.`, button: 'Review company finances' }
  }
  const idleThermal = mine.find((p) => p.fuel && p.status === 'offline')
  if (idleThermal) {
    const at = v.nodes.find((n) => n.nodeId === idleThermal.nodeId)!
    if (at.priceCcPerMWh > idleThermal.marginalCostCcPerMWh * 1.1) return { tone: 'warn', text: `Power sells for ${price(at.priceCcPerMWh)} and ${idleThermal.name} makes it for ${price(idleThermal.marginalCostCcPerMWh)}.`, button: `▶ Start ${idleThermal.name}`, action: { type: 'SET_PLANT_ONLINE', plantId: idleThermal.plantId, online: true } }
  }
  if (town) {
    const ruth = town.merchants.find((m) => m.merchantId === 'ruth')
    const burning = mine.some((p) => p.fuel && p.status === 'online' && p.outputKw > 0)
    if (burning && v.player.permitsT < 5 && ruth?.open && ruth.items[0].askCc) return { tone: 'warn', text: `Your plants are out of carbon permits, so the regulator charges 25% extra for every tonne. Ruth sells them at ${price(ruth.items[0].askCc * 1)}/t.`, button: 'Buy 100 permits', trade: { merchantId: 'ruth', item: 'permit:carbon', side: 'buy', qty: 100 } }
    const lena = town.merchants.find((m) => m.merchantId === 'lena')
    const room = lena ? lena.items[0].target * 4 - lena.items[0].stock : 0
    if (v.player.certificates >= 25 && lena?.open && lena.items[0].bidCc && room > 0) {
      const q = Math.min(v.player.certificates, room)
      return { tone: 'info', text: `You hold ${v.player.certificates} renewable certificates. Lena pays ${price(lena.items[0].bidCc)} each, less if everyone sells at once.`, button: `Sell ${q} · ~${credits(q * lena.items[0].bidCc)}`, trade: { merchantId: 'lena', item: 'certificate:renewable', side: 'sell', qty: q } }
    }
    const shut = town.merchants.find((m) => !m.open && v.pulse.cashCc >= m.reopenCc * 1.5)
    if (shut) return { tone: 'info', text: `${shut.name} has closed: ${shut.closedReason}. Reopen it for ${credits(shut.reopenCc)} and you own a share of its profits.`, button: `See ${shut.person.replace('Prof. ', '').split(' ')[0]}'s shop`, select: { kind: 'merchant', id: shut.merchantId } }
  }
  const lazy = mine.find((p) => p.tech === 'battery' && p.status === 'online' && p.batteryMode === 'hold')
  if (lazy) return { tone: 'warn', text: `${lazy.name} is sitting idle.`, button: 'Let it trade (Auto)', action: { type: 'SET_BATTERY_MODE', plantId: lazy.plantId, mode: 'auto' } }
  const empty = mine.find((p) => p.tech === 'battery' && p.status === 'online' && p.batteryMode === 'discharge' && p.socKwh < p.energyKwh * 0.05)
  if (empty) return { tone: 'info', text: `${empty.name} is empty. On Auto it recharges when power is cheap.`, button: 'Set to Auto', action: { type: 'SET_BATTERY_MODE', plantId: empty.plantId, mode: 'auto' } }
  const short = mine.find((p) => p.fuelLimited)
  if (short) return { tone: 'warn', text: `${short.name} is short of fuel.`, button: 'Turn on auto-buy', action: { type: 'SET_AUTO_FUEL', fuel: short.fuel!, enabled: true } }
  const jam = v.corridors.filter((c) => c.congested && Math.abs(c.spreadCcPerMWh) >= 2_000 && c.upgrade.building === null).sort((a, b) => Math.abs(b.spreadCcPerMWh) - Math.abs(a.spreadCcPerMWh))[0]
  if (jam && v.pulse.cashCc >= jam.upgrade.costCc) return { tone: 'info', text: `${jam.name} is full: prices differ by ${price(Math.abs(jam.spreadCcPerMWh))} across it.`, button: `Upgrade · ${credits(jam.upgrade.costCc)}`, action: { type: 'UPGRADE_CORRIDOR', corridorId: jam.corridorId } }
  const building = mine.find((p) => p.status === 'building')
  const dear = [...v.nodes].sort((a, b) => b.avgPriceCcPerMWh - a.avgPriceCcPerMWh)[0]
  const cheapest = Math.min(...v.techs.flatMap((t) => t.sizes.map((z) => z.costCc)))
  if (!building && v.pulse.cashCc >= cheapest && dear.avgPriceCcPerMWh > 12_000) return { tone: 'info', text: `Power is dearest in ${dear.name} (average ${price(dear.avgPriceCcPerMWh)}). More plants there earn more.`, button: `+ Build in ${dear.name}`, build: dear.nodeId }
  if (building) return { tone: 'ok', text: `${building.name} is being built: ${hours(building.buildRemaining)} to go. Everything's lit.`, button: 'Watch it', select: { kind: 'plant', id: building.plantId } }
  if (v.pulse.reserveKw < v.pulse.demandKw * 0.08) return { tone: 'warn', text: `Only ${mw(Math.max(0, v.pulse.reserveKw))} spare. One more trip and someone goes dark.`, button: '+ Build more power', build: dear.nodeId }
  return { tone: 'ok', text: `Every district is lit. You made ${credits(v.player.profitCcToday)} today.`, button: 'See your company', select: undefined }
}

export function NextMoveBar({ m, onDo }: { m: Move; onDo: () => void }) {
  return (
    <div className={`next-move ${m.tone}`} role="status" aria-live="polite">
      <span>{m.text}</span>
      {m.button && (
        <button className="btn primary small" onClick={onDo}>
          {m.button}
        </button>
      )}
    </div>
  )
}
