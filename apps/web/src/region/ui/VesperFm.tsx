/**
 * Vesper FM (98.4 FM) & The Vesper Chronicle.
 * Pure presentation layer: synthesizes live radio call-ins and front-page newspaper editions
 * directly from deterministic simulation state (`RegionView` and `TownView`).
 */
import type { RegionView, TownView } from '@blackout/shared'
import { credits, mw, pct, price } from '../format'

export interface RadioCaller {
  id: string
  person: string
  face: string
  role: string
  district: string
  tone: 'ok' | 'warn' | 'crisis' | 'info'
  line: string
}

export interface RadioBroadcast {
  station: string
  show: string
  host: string
  tone: 'ok' | 'warn' | 'crisis'
  djHeadline: string
  djCommentary: string
  callers: RadioCaller[]
}

export interface ChronicleEdition {
  masthead: string
  dateline: string
  weatherStrip: string
  lead: {
    kicker: string
    headline: string
    subhead: string
    body: string[]
  }
  hormuzDispatch: {
    title: string
    summary: string
    bullets: string[]
  }
  cop31Dispatch: {
    title: string
    summary: string
    bullets: string[]
  }
}

function showForMinute(minuteOfDay: number): string {
  const hour = Math.floor((minuteOfDay % 1440) / 60)
  if (hour >= 5 && hour < 11) return 'Lagoon Dawn Dispatch'
  if (hour >= 11 && hour < 17) return 'Midday Grid & Harbour Watch'
  if (hour >= 17 && hour < 22) return 'Evening Peak Call-In'
  return 'Night Shift on the Trunk'
}

export function synthesizeBroadcast(v: RegionView, town: TownView | null, companyName?: string | null): RadioBroadcast {
  const co = companyName || 'the independent utility'
  const show = showForMinute(v.clock.minuteOfDay)
  const darkNodes = v.nodes.filter((n) => n.shedKw > 0)
  const congested = v.corridors.filter((c) => c.congested)
  const rationingSuppliers = v.suppliers.filter((s) => s.rationing)
  const latestCrisis = [...v.events].reverse().find((e) => e.severity === 'crisis' || e.severity === 'warn')

  let tone: 'ok' | 'warn' | 'crisis' = 'ok'
  let djHeadline = `All seven districts lit at ${price(v.pulse.spotCcPerMWh)}/MWh`
  let djCommentary = `You're locked to 98.4 Vesper FM with DJ Kemi. Right now ${co} is holding ${mw(Math.max(0, v.pulse.reserveKw))} of spare reserve across the lagoon while Cape-route tankers queue outside the harbour.`

  if (v.pulse.status === 'blackout' && darkNodes.length > 0) {
    tone = 'crisis'
    const names = darkNodes.map((n) => n.name).join(', ')
    djHeadline = `Rolling blackout hits ${names} (${mw(v.pulse.shedKw)} unserved)`
    djCommentary = `Switchboards are lighting up at 98.4 Vesper FM! Feeder relays just dropped ${mw(v.pulse.shedKw)} in ${names}. Residents are cranking backup diesel sets while ${co} races to bring reserve power online.`
  } else if (v.pulse.status === 'shortfall') {
    tone = 'warn'
    djHeadline = `Grid shortfall of ${mw(v.pulse.shortfallKw)} pushes spot to ${price(v.pulse.spotCcPerMWh)}/MWh`
    djCommentary = `Evening fans and factory lines are straining the grid. Spot power has climbed to ${price(v.pulse.spotCcPerMWh)}/MWh and flexible industrial loads are stepping back to keep the lights on.`
  } else if (latestCrisis && v.interval - latestCrisis.interval <= 18) {
    tone = latestCrisis.severity === 'crisis' ? 'crisis' : 'warn'
    djHeadline = latestCrisis.title
    djCommentary = `${latestCrisis.detail} Listeners across Vesper are watching how ${co} responds on the dispatch board.`
  } else if (v.weather.condition === 'heatwave') {
    tone = 'warn'
    djHeadline = `${Math.round(v.weather.tempC)}°C heatwave drives air-conditioning surge across Vesper`
    djCommentary = `Every split-unit AC from Residential East to Central City is running flat out in this ${Math.round(v.weather.tempC)}°C heat. Thermal turbines are derating in the hot air.`
  }

  const callers: RadioCaller[] = []

  // 1. Hospital / Residential caller
  const hosp = v.actors.find((a) => a.actorId === 'hospital')
  const hospNode = v.nodes.find((n) => n.nodeId === 'hospital')
  if (hosp && hospNode) {
    callers.push({
      id: 'caller-petrov',
      person: hosp.person,
      face: hosp.face,
      role: 'St. Aurelia General',
      district: 'Hospital District',
      tone: hospNode.shedKw > 0 ? 'crisis' : hospNode.priceCcPerMWh > 25_000 ? 'warn' : 'ok',
      line:
        hospNode.shedKw > 0
          ? `Hospital Feeder is shedding ${mw(hospNode.shedKw)}! We are on emergency diesel in the surgical wing—get Hospital District back on grid power now!`
          : `St. Aurelia General is holding steady at ${price(hospNode.priceCcPerMWh)}/MWh. Cold vaccine lockers and dialysis wards are fully powered.`,
    })
  }

  // 2. Industrial South caller (Marta Ivanova)
  const steel = v.actors.find((a) => a.actorId === 'steel')
  const southNode = v.nodes.find((n) => n.nodeId === 'industrial_south')
  if (steel && southNode) {
    callers.push({
      id: 'caller-marta',
      person: steel.person,
      face: steel.face,
      role: 'Ivanova Steel Works',
      district: 'Industrial South',
      tone: steel.productionBps < 8_500 ? 'warn' : 'ok',
      line:
        steel.productionBps < 9_500
          ? `With Industrial South power at ${price(southNode.priceCcPerMWh)}/MWh, our arc furnaces are running at ${pct(steel.productionBps)}. Every curtailed pour slows Pavel's steel yard.`
          : `Arc furnaces are pouring at ${pct(steel.productionBps)} capacity (${price(southNode.priceCcPerMWh)}/MWh). Keep Southern Trunk clear and we'll keep Vesper supplied with steel.`,
    })
  }

  // 3. Fuel & Shipping caller (Ingrid Halvorsen or Dayo Swift)
  if (rationingSuppliers.length > 0) {
    const r = rationingSuppliers[0]
    callers.push({
      id: `caller-sup-${r.supplierId}`,
      person: r.person,
      face: r.face,
      role: r.name,
      district: 'Port Fuel Terminal',
      tone: 'warn',
      line: `Strait of Hormuz tanker rerouting has our ${r.fuel} tanks down to ${r.stock.toLocaleString('en-US')} units. We are rationing lifts at ${price(r.priceCcPerUnit)} until the next Cape convoy berths.`,
    })
  } else {
    const swift = v.suppliers.find((s) => s.supplierId === 'swift') ?? v.suppliers[0]
    if (swift) {
      callers.push({
        id: 'caller-swift',
        person: swift.person,
        face: swift.face,
        role: swift.name,
        district: 'Harbour Anchorage',
        tone: 'info',
        line: `Product tankers are discharging at Vesper Port. ${swift.fuel === 'diesel' ? 'Diesel' : 'Gas'} wholesale stands at ${price(swift.priceCcPerUnit)} with ${swift.stock.toLocaleString('en-US')} units in the harbour tanks.`,
      })
    }
  }

  // 4. Neighbourhood / Market Quarter bridge caller (Tomás Rivera or Amara Obi)
  const eastHomes = v.actors.find((a) => a.actorId === 'res_east')
  const eastNode = v.nodes.find((n) => n.nodeId === 'residential_east')
  if (eastHomes && eastNode) {
    callers.push({
      id: 'caller-tomas',
      person: eastHomes.person,
      face: eastHomes.face,
      role: 'Eastside Residents Assoc.',
      district: 'Residential East',
      tone: eastNode.shedKw > 0 ? 'crisis' : congested.some((c) => c.corridorId === 'c_east') ? 'warn' : 'ok',
      line:
        eastNode.shedKw > 0
          ? `They took light in Eastside again! ${mw(eastNode.shedKw)} of homes are dark and the whole street is breathing generator exhaust.`
          : congested.some((c) => c.corridorId === 'c_east')
            ? `Eastside Line 132 kV is packed to the limit. The lights are on, but we need local storage or a line upgrade before the next evening peak.`
            : `Streetlights and cold rooms are humming across Residential East tonight. Folks can finally sleep without backup generators roaring outside.`,
    })
  }

  if (town?.news?.length) {
    const topNews = town.news[0]
    callers.push({
      id: `caller-market-${topNews.seq}`,
      person: 'Mama Ade',
      face: '👵🏿',
      role: 'Market Quarter Elder',
      district: 'Vesper Market',
      tone: topNews.tone === 'good' ? 'ok' : 'warn',
      line: `Down at Vesper Market everyone is talking about "${topNews.headline}". Remember when you ran that 5 kW shed behind my shop? Keep the big grid steady for us!`,
    })
  }

  return {
    station: '98.4 VESPER FM',
    show,
    host: 'DJ Kemi',
    tone,
    djHeadline,
    djCommentary,
    callers: callers.slice(0, 4),
  }
}

export function synthesizeChronicle(v: RegionView, town: TownView | null, companyName?: string | null): ChronicleEdition {
  const co = companyName || 'Your Utility'
  const darkNodes = v.nodes.filter((n) => n.shedKw > 0)
  const congested = v.corridors.filter((c) => c.congested)
  const myMw = v.plants.filter((p) => p.mine).reduce((a, p) => a + Math.max(0, p.netKw), 0)
  const totalServedMw = v.nodes.reduce((a, n) => a + n.servedKw, 0)
  const sharePct = totalServedMw > 0 ? Math.round((myMw / totalServedMw) * 100) : 0

  let kicker = 'ENERGY SOVEREIGNTY & THE TWIN SQUEEZE'
  let headline = `${co.toUpperCase()} SUPPLIES ${sharePct}% OF VESPER AS GRID HOLDS THROUGH TWIN SQUEEZE`
  let subhead = `Reliability stands at ${pct(v.player.reliabilityBps)} across ${v.clock.day} days of operation while spot power clears at ${price(v.pulse.spotCcPerMWh)}/MWh.`

  if (darkNodes.length > 0) {
    kicker = 'EMERGENCY EDITION · GRID SHORTFALL'
    headline = `BLACKOUT IN ${darkNodes.map((n) => n.name.toUpperCase()).join(' & ')}: ${mw(v.pulse.shedKw)} SHED AS FEEDERS STRAIN`
    subhead = `Regulator urges immediate dispatch as ${co} and rival generators battle fuel bottlenecks and line limits.`
  } else if (v.voltline.state === 'distressed') {
    kicker = 'MARKET SHAKEUP · LEGACY UTILITY IN DISTRESS'
    headline = `VOLTLINE CRUMBLES UNDER ₡15M DEBT AS ${co.toUpperCase()} ANCHORS VESPER GRID`
    subhead = `Victor Lane puts legacy turbines on the auction block while ${co} reaches ${v.player.deliveredMWh.toLocaleString('en-US')} MWh delivered.`
  } else if (congested.length > 0) {
    kicker = 'TRANSMISSION WATCH · CORRIDOR BOTTLENECKS'
    headline = `${congested.map((c) => c.name.toUpperCase()).join(' & ')} HIT CAPACITY AS NODAL SPREADS WIDEN`
    subhead = `Power stays on across all seven districts, but transmission congestion splits regional wholesale prices.`
  }

  const body = [
    `VESPER — Operating under the dual pressure of 2026 Strait of Hormuz tanker rerouting and the COP31 Sovereign Grid Accord, ${co} currently holds the ${v.player.licenceName} permit (Level ${v.player.licence}/4), having delivered ${v.player.deliveredMWh.toLocaleString('en-US')} MWh at ${pct(v.player.reliabilityBps)} regional reliability.`,
    `Across the region's businesses and factories, economic output stands at ${pct(v.economy.regionOutputBps)} with ${v.economy.employment.toLocaleString('en-US')} of ${v.economy.baseEmployment.toLocaleString('en-US')} jobs active. Incumbent rival VoltLine Energy (${v.voltline.person}) is currently ${v.voltline.state} with ${credits(v.voltline.cashCc)} in cash against ${credits(v.voltline.debtCc)} in debt.`,
  ]

  const hormuzBullets = v.suppliers.slice(0, 4).map(
    (s) => `${s.face} ${s.name} (${s.person}): ${ price(s.priceCcPerUnit) }/${s.fuel === 'gas' ? 'MMBtu' : 'L'} · stock ${s.stock.toLocaleString('en-US')}/${s.capacity.toLocaleString('en-US')}${s.rationing ? ' [RATIONING]' : ''}`,
  )
  if (town?.news?.[0]) {
    hormuzBullets.unshift(`Market wire: "${town.news[0].headline}"`)
  }

  const cop31Bullets = [
    `Carbon compliance floor: ${price(v.regulator.carbonCcPerT)}/t CO₂ · Your permits held: ${v.player.permitsT.toLocaleString('en-US')} t`,
    `Renewable certificates held: ${v.player.certificates.toLocaleString('en-US')} MWh · Your cumulative CO₂: ${v.player.emissionsT.toLocaleString('en-US')} t`,
    `Regulator fund: ${credits(v.regulator.fundCc)} · Active warnings on your licence: ${v.regulator.warnings}`,
  ]

  return {
    masthead: 'THE VESPER CHRONICLE',
    dateline: `DAY ${v.clock.day} · ${v.clock.label} · MARITIME & GRID DISPATCH`,
    weatherStrip: `${v.weather.label} · Brent $${v.world.brentUsdPerBbl.toFixed(2)}/bbl · Gas $${v.world.gasUsdPerMMBtu.toFixed(2)}/MMBtu · Carbon $${v.world.carbonUsdPerT.toFixed(0)}/t`,
    lead: { kicker, headline, subhead, body },
    hormuzDispatch: {
      title: 'Strait of Hormuz & Harbour Fuel Desk',
      summary: 'Observed crude and LNG pass-through into Vesper port terminals and merchant tanks.',
      bullets: hormuzBullets,
    },
    cop31Dispatch: {
      title: 'COP31 Sovereign Grid Accord Desk',
      summary: 'Carbon allowance surrenders, clean-energy certificates, and grid reliability oversight.',
      bullets: cop31Bullets,
    },
  }
}
