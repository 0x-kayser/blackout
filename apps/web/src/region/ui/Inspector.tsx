/** The contextual inspector (§35): whatever you tapped in the world, explained, with the decisions it allows. */
import { useState } from 'react'
import type { ActorView, CorridorView, NodeView, PlantView, RegionAction, RegionView } from '@blackout/shared'
import { credits, hours, mw, mwh, pct, price } from '../format'
import type { Selection } from '../scene/World3D'
import { Bar, Section, Seg, Stat } from './Bits'

export type Act = (a: RegionAction) => Promise<{ ok: boolean; message: string }>

const TECH_NAME: Record<string, string> = { ocgt: 'Gas turbine (OCGT)', ccgt: 'Combined-cycle gas', diesel: 'Diesel peaker', solar: 'Solar farm', battery: 'Battery' }
const STATE_TONE: Record<string, string> = { operating: 'ok', strained: 'warn', distressed: 'crisis', closed: 'muted' }

export function Inspector({ v, sel, act, onClose, onFocus, onBuildHere }: { v: RegionView; sel: Selection; act: Act; onClose: () => void; onFocus: (s: Selection) => void; onBuildHere: (nodeId: string) => void }) {
  let body: React.ReactNode = null
  if (sel.kind === 'plant') {
    const p = v.plants.find((x) => x.plantId === sel.id)
    if (p) body = <PlantInspector v={v} p={p} act={act} />
  } else if (sel.kind === 'node') {
    const n = v.nodes.find((x) => x.nodeId === sel.id)
    if (n) body = <NodeInspector v={v} n={n} onFocus={onFocus} onBuildHere={onBuildHere} />
  } else if (sel.kind === 'corridor') {
    const c = v.corridors.find((x) => x.corridorId === sel.id)
    if (c) body = <CorridorInspector v={v} c={c} act={act} />
  } else if (sel.kind === 'actor') {
    const a = v.actors.find((x) => x.actorId === sel.id)
    if (a) body = <ActorInspector v={v} a={a} />
  }
  return (
    <aside className="inspector" aria-label="Inspector">
      <button className="close" onClick={onClose} aria-label="Close inspector">
        ×
      </button>
      {body ?? <p className="fine">That’s gone from the map.</p>}
    </aside>
  )
}

function useAct(act: Act) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const run = async (a: RegionAction) => {
    setBusy(true)
    try {
      const r = await act(a)
      setMsg({ ok: r.ok, text: r.message })
      return r.ok
    } finally {
      setBusy(false)
    }
  }
  return { busy, msg, run }
}

function Msg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  return msg ? <p className={msg.ok ? 'ok-line' : 'warn-line'}>{msg.text}</p> : null
}

function PlantInspector({ v, p, act }: { v: RegionView; p: PlantView; act: Act }) {
  const { busy, msg, run } = useAct(act)
  const [ask, setAsk] = useState(Math.round(p.bookValueCc / 100_000) * 100_000 || 1_000_000)
  const [reviewPurchase, setReviewPurchase] = useState(false)
  const [reviewListing, setReviewListing] = useState(false)
  const [reviewBidId, setReviewBidId] = useState<string | null>(null)
  const node = v.nodes.find((n) => n.nodeId === p.nodeId)!
  const thermal = p.fuel !== null
  const listing = p.listing
  const forSale = !p.mine && listing
  const soc = p.energyKwh > 0 ? Math.round((p.socKwh * 100) / p.energyKwh) : 0
  return (
    <>
      <p className="eyebrow">{TECH_NAME[p.tech]} · {node.name}</p>
      <h3>{p.name}</h3>
      <p className="fine">
        Plant Asset <b>{p.assetId}</b> · owned by <b className={p.mine ? 'gold' : ''}>{p.ownerName}</b>
      </p>
      <p className={`why s-${p.status}`}>{p.why}</p>
      {p.mine && p.status === 'tripped' && (
        <button className="btn primary wide" disabled={busy} onClick={() => run({ type: 'REPAIR_PLANT', plantId: p.plantId })}>
          🔧 Repair now with {p.repairParts} turbine kit{p.repairParts > 1 ? 's' : ''} (bought from Nkechi if you have none)
        </button>
      )}
      <div className="gauge">
        <span>{p.tech === 'battery' ? (p.netKw >= 0 ? 'Discharging' : 'Charging') : 'Output'}</span>
        <b>{mw(Math.abs(p.netKw))}</b>
        <small>of {mw(p.capacityKw)}</small>
      </div>
      <Bar value={Math.abs(p.netKw)} max={p.capacityKw} tone={p.netKw < 0 ? 'blue' : 'teal'} />
      {p.tech === 'battery' && (
        <>
          <div className="gauge">
            <span>Stored</span>
            <b>{soc}%</b>
            <small>{mwh(p.socKwh)} of {mwh(p.energyKwh)} · health {pct(p.healthBps)} · {p.cycles} cycles</small>
          </div>
          <Bar value={p.socKwh} max={p.energyKwh} tone="blue" />
        </>
      )}

      {p.mine && p.status !== 'building' && (
        <Section title="Decide">
          {thermal && (
            <div className="row">
              {p.online || p.status === 'starting' ? (
                <button className="btn" disabled={busy} onClick={() => run({ type: 'SET_PLANT_ONLINE', plantId: p.plantId, online: false })}>
                  Shut down
                </button>
              ) : (
                <button className="btn primary" disabled={busy || p.status === 'tripped'} onClick={() => run({ type: 'SET_PLANT_ONLINE', plantId: p.plantId, online: true })}>
                  Start · {p.tech === 'ccgt' ? '60 min' : p.tech === 'ocgt' ? '10 min' : '5 min'}
                </button>
              )}
            </div>
          )}
          {p.tech === 'battery' && (
            <Seg
              value={p.batteryMode}
              disabled={busy}
              onChange={(mode) => run({ type: 'SET_BATTERY_MODE', plantId: p.plantId, mode })}
              options={[
                { value: 'auto', label: 'Auto', hint: 'Charge cheap, sell dear' },
                { value: 'discharge', label: 'Discharge', hint: 'Sell now at any price' },
                { value: 'charge', label: 'Charge', hint: 'Buy now up to ₡300' },
                { value: 'hold', label: 'Hold' },
              ]}
            />
          )}
          {thermal && (
            <>
              <p className="fine">How you offer into the market:</p>
              <Seg
                value={p.strategy}
                disabled={busy}
                onChange={(strategy) => run({ type: 'SET_OFFER', plantId: p.plantId, strategy })}
                options={[
                  { value: 'cost', label: 'At cost', hint: 'Run whenever the price covers fuel' },
                  { value: 'markup', label: `Cost +${p.markupPct}%`, hint: 'Earn more per MWh, run less' },
                  { value: 'scarcity', label: 'Peaks only', hint: 'Only when power is ₡600+' },
                ]}
              />
              {p.strategy === 'markup' && (
                <label className="slider">
                  Markup {p.markupPct}%
                  <input type="range" min={0} max={200} step={10} defaultValue={p.markupPct} onMouseUp={(e) => run({ type: 'SET_OFFER', plantId: p.plantId, strategy: 'markup', markupPct: Number((e.target as HTMLInputElement).value) })} onTouchEnd={(e) => run({ type: 'SET_OFFER', plantId: p.plantId, strategy: 'markup', markupPct: Number((e.target as HTMLInputElement).value) })} />
                </label>
              )}
            </>
          )}
          <Msg msg={msg} />
        </Section>
      )}

      {thermal && (
        <Section title="Marginal cost" aside={<b>{price(p.marginalCostCcPerMWh)}/MWh</b>}>
          {p.costBreakdown.map((c) => (
            <div key={c.label} className="kv">
              <span>{c.label}</span>
              <b>{price(c.ccPerMWh)}</b>
            </div>
          ))}
          <div className="kv">
            <span>Offer now</span>
            <b>{price(p.offerCcPerMWh)}</b>
          </div>
          <div className="kv">
            <span>Price at {node.name}</span>
            <b className={node.priceCcPerMWh >= p.offerCcPerMWh ? 'ok' : 'muted'}>{price(node.priceCcPerMWh)}</b>
          </div>
          {p.fuelIntervalsLeft !== null && <p className={`fine ${p.fuelIntervalsLeft < 24 ? 'warn-line' : ''}`}>Fuel for {hours(p.fuelIntervalsLeft)} at full output{p.mine ? (v.player.autoFuel[p.fuel!] ? ' · auto-buying' : ' · auto-buy is off') : ''}.</p>}
        </Section>
      )}

      <Section title="Money">
        <Stat label="Revenue today" value={credits(p.revenueCcToday)} />
        <Stat label="Margin today" value={credits(p.marginCcToday)} tone={p.marginCcToday >= 0 ? 'ok' : 'crisis'} />
        <Stat label="Lifetime" value={`${p.lifetimeMWh.toLocaleString('en-US')} MWh · ${credits(p.lifetimeRevenueCc)}`} />
        <Stat label="Book value" value={credits(p.bookValueCc)} />
      </Section>

      {p.mine && p.status !== 'building' && (
        <Section title="Sell this plant">
          {!p.listing ? (
            <div className="row">
              <label className="slider">
                Asking {credits(ask)}
                <input type="range" min={Math.max(1_000_00, Math.round(p.bookValueCc * 0.5))} max={Math.max(2_000_00, Math.round(p.bookValueCc * 2))} step={100_000} value={ask} onChange={(e) => setAsk(Number(e.target.value))} />
              </label>
              <button className="btn" disabled={busy} onClick={() => setReviewListing((x) => !x)}>
                {reviewListing ? 'Close review' : 'Review listing'}
              </button>
            </div>
          ) : (
            <>
              <p className="fine">Listed at {credits(p.listing.askCc)}. No fee; the plant remains yours until a purchase completes.</p>
              {p.listing.bids.length === 0 && <p className="fine">No offers yet — buyers look every three game hours.</p>}
              {p.listing.bids.map((b) => (
                <div key={b.bidId} className="bid">
                  <span>
                    <b>{b.bidderName}</b> offers {credits(b.amountCc)}
                    <small>{b.reason}</small>
                  </span>
                  <button className="btn primary" disabled={busy} onClick={() => setReviewBidId(reviewBidId === b.bidId ? null : b.bidId)}>
                    {reviewBidId === b.bidId ? 'Close review' : 'Review offer'}
                  </button>
                  {reviewBidId === b.bidId && (
                    <div className="trade-ticket">
                      <b>Review plant offer</b>
                      <div className="trade-ticket-stats">
                        <span>Buyer offer <b>{credits(b.amountCc)}</b></span>
                        <span>Your asking price <b>{credits(listing!.askCc)}</b></span>
                        <span>Book value <b>{credits(p.bookValueCc)}</b></span>
                        <span>Separate fee <b>None</b></span>
                      </div>
                      <small className="fine">Accepting transfers the plant and its future output to the buyer. The agreed game-credit proceeds are credited when the sale settles.</small>
                      <div className="row">
                        <button className="btn primary small" disabled={busy} onClick={async () => { if (await run({ type: 'ACCEPT_BID', plantId: p.plantId, bidId: b.bidId })) setReviewBidId(null) }}>Accept · {credits(b.amountCc)}</button>
                        <button className="btn ghost small" disabled={busy} onClick={() => setReviewBidId(null)}>Keep listing</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              <button className="btn ghost" disabled={busy} onClick={() => run({ type: 'CANCEL_LISTING', plantId: p.plantId })}>
                Withdraw listing
              </button>
            </>
          )}
          {reviewListing && !p.listing && (
            <div className="trade-ticket">
              <b>Review plant listing</b>
              <div className="trade-ticket-stats">
                <span>Plant <b>{p.assetId}</b></span>
                <span>Book value <b>{credits(p.bookValueCc)}</b></span>
                <span>Asking price <b>{credits(ask)}</b></span>
                <span>Listing fee <b>None</b></span>
              </div>
              <small className="fine">Listing does not transfer the plant or pay you immediately. You keep ownership until another company completes a purchase.</small>
              <div className="row">
                <button className="btn primary small" disabled={busy} onClick={async () => { if (await run({ type: 'LIST_PLANT', plantId: p.plantId, askCc: ask })) setReviewListing(false) }}>Confirm listing</button>
                <button className="btn ghost small" disabled={busy} onClick={() => setReviewListing(false)}>Cancel</button>
              </div>
            </div>
          )}
          <Msg msg={msg} />
        </Section>
      )}
      {forSale && (
        <Section title="For sale">
          <p className="fine">{p.ownerName} is selling {p.name} for {credits(p.listing!.askCc)} (book value {credits(p.bookValueCc)}).</p>
          {!reviewPurchase ? (
            <button className="btn primary" disabled={busy} onClick={() => setReviewPurchase(true)}>Review purchase</button>
          ) : (
            <div className="trade-ticket">
              <b>Review plant purchase</b>
              <div className="trade-ticket-stats">
                <span>Price <b>{credits(p.listing!.askCc)}</b></span>
                <span>Book value <b>{credits(p.bookValueCc)}</b></span>
                <span>Cash after <b>{v.player.cashCc >= p.listing!.askCc ? credits(v.player.cashCc - p.listing!.askCc) : `short ${credits(p.listing!.askCc - v.player.cashCc)}`}</b></span>
                <span>Separate fee <b>None</b></span>
              </div>
              <small className="fine">Game credits move when the purchase completes. The plant and its future output then move to your company.</small>
              <div className="row">
                <button className="btn primary small" disabled={busy || v.player.cashCc < p.listing!.askCc} onClick={async () => { const ok = await run({ type: 'BUY_LISTED_PLANT', plantId: p.plantId }); if (ok) setReviewPurchase(false) }}>
                  {v.player.cashCc < p.listing!.askCc ? 'Not enough cash' : `Confirm · ${credits(p.listing!.askCc)}`}
                </button>
                <button className="btn ghost small" disabled={busy} onClick={() => setReviewPurchase(false)}>Cancel</button>
              </div>
            </div>
          )}
          <Msg msg={msg} />
        </Section>
      )}
    </>
  )
}

function districtStreetLife(v: RegionView, n: NodeView) {
  const dark = n.shedKw > 0
  const squeezed = !dark && (n.curtailedKw > 0 || n.priceCcPerMWh > 25_000)

  const SCENES: Record<string, { lit: string; squeezed: string; dark: string }> = {
    residential_east: {
      lit: '“Up light!” echoes across the Eastside compounds. Backup petrol generators fall silent, ceiling fans hum, and night amala and suya stalls glow along the roundabout while yellow danfo minibuses unload evening commuters.',
      squeezed: 'Mains power is on, but peak tariffs have Eastside compounds switching off air-conditioners and sharing metered extension cords along the street.',
      dark: '“They took light!” Streetlights are out across Residential East. Smoky portable generators roar on every balcony, danfo buses honk through dark junctions by headlight, and cold-room ice blocks are melting fast.',
    },
    central_city: {
      lit: 'Barbershops, tailors, and cold rooms from Market Quarter to Central City are running on clean grid power. Streetlamps light the evening bazaar and shopkeepers keep their shutters open late.',
      squeezed: 'Grid power holds in Central City, but high spot prices have workshops and malls throttling chillers while small kiosks ration outlets.',
      dark: 'Rolling blackouts have darkened Central City blocks. Shopkeepers are cranking backup diesel sets on the pavement and serving customers by rechargeable lantern.',
    },
    industrial_south: {
      lit: 'Arc furnaces at Ivanova Steel and assembly lines at Delta Components are running full shifts. Flatbed trucks queue at Pavel’s yard while roadside canteens serve the night crew.',
      squeezed: 'High wholesale power prices have forced Marta’s furnaces to step back flexible pours; half the yard crews are waiting on standby for prices to cool.',
      dark: 'Industrial South feeders are shedding load. Factory sirens sounded at the shift change and heavy mill lines are locked down on emergency lighting.',
    },
    port: {
      lit: 'Quayside gantry cranes swing containers off rerouted Cape-route ships under bright floodlights, and Harbor Cold Chain’s refrigerated stacks hum steadily.',
      squeezed: 'Port cranes keep moving essential cargo, but cold-store operators are rationing auxiliary chillers as nodal power prices spike.',
      dark: 'Harbour feeders are short of power! Standby diesel packs are coughing black smoke along the jetty to keep frozen cargo from spoiling.',
    },
    tech_corridor: {
      lit: 'Halcyon Data Center chillers and Tech Corridor startup labs are humming smoothly on grid power, with late-night engineers filling the campus cafés.',
      squeezed: 'Spot prices are biting in the Tech Corridor; campus facilities have dimmed non-essential floors to protect server rack budgets.',
      dark: 'UPS battery alarms are chirping across the Tech Corridor as backup diesel generators spin up to save Halcyon’s server racks.',
    },
    hospital: {
      lit: 'St. Aurelia General’s surgical wing, dialysis machines, and vaccine cold lockers are running on steady mains power. Ambulance bays and night pharmacies are brightly lit.',
      squeezed: 'Hospital Row remains protected on priority power, though surrounding clinics and homes are watching every kilowatt.',
      dark: 'Emergency alert in Hospital District! St. Aurelia General has switched to backup diesel tanks to keep operating theatres and incubators alive.',
    },
    north_solar: {
      lit: v.clock.isNight
        ? 'Solar fields rest under the night sky while North Belt farmhouses and grain stores draw quiet power over the 220 kV trunk.'
        : 'Sunlight glints off thousands of North Belt panels, powering local irrigation pumps and exporting cheap clean megawatts south to the city.',
      squeezed: 'North Belt towns are trimming farm machinery loads while regional wholesale prices run hot.',
      dark: 'The North Belt line is short after dark—farmsteads and rural cooperatives have fallen back on tractor generators and lanterns.',
    },
  }

  const scene = SCENES[n.nodeId] ?? SCENES.central_city
  if (dark) {
    return { badge: '🔴 They took light!', tone: 'crisis', text: scene.dark }
  }
  if (squeezed) {
    return { badge: '🟡 Tariff squeeze', tone: 'warn', text: scene.squeezed }
  }
  return { badge: '🟢 Up light!', tone: 'ok', text: scene.lit }
}

function NodeInspector({ v, n, onFocus, onBuildHere }: { v: RegionView; n: NodeView; onFocus: (s: Selection) => void; onBuildHere: (nodeId: string) => void }) {
  const plants = v.plants.filter((p) => p.nodeId === n.nodeId)
  const actors = v.actors.filter((a) => a.nodeId === n.nodeId)
  const tenders = v.tenders.filter((t) => t.nodeId === n.nodeId && t.status === 'open')
  const street = districtStreetLife(v, n)
  return (
    <>
      <p className="eyebrow">Load centre</p>
      <h3>{n.name}</h3>
      <div className="big-price">
        {price(n.priceCcPerMWh)}
        <small>/MWh</small>
        <em>avg today {price(n.avgPriceCcPerMWh)}</em>
      </div>
      <Section title="Street life & district pulse" aside={<span className={`pill ${street.tone}`}>{street.badge}</span>}>
        <p className="fine" style={{ margin: 0 }}>{street.text}</p>
      </Section>
      <Section title={`Why ${price(n.priceCcPerMWh)}?`}>
        <p className="fine">Set by <b>{n.marginal.name}</b>.</p>
        {n.buildUp.map((c) => (
          <div key={c.label} className="kv">
            <span>{c.label}</span>
            <b>{price(c.ccPerMWh)}</b>
          </div>
        ))}
        <div className="kv sep">
          {n.decomposition.map((c) => (
            <span key={c.label} className="chip-kv">
              {c.label}: <b>{c.ccPerMWh >= 0 ? '' : '−'}{price(Math.abs(c.ccPerMWh))}</b>
            </span>
          ))}
        </div>
      </Section>
      <Section title="Power here">
        <Stat label="Demand" value={mw(n.demandKw)} />
        <Stat label="Served" value={mw(n.servedKw)} />
        {n.curtailedKw > 0 && <Stat label="Switched off by price" value={mw(n.curtailedKw)} tone="warn" />}
        {n.shedKw > 0 && <Stat label="Dark (load shed)" value={mw(n.shedKw)} tone="crisis" />}
        <Stat label="Generated here" value={mw(n.generationKw)} />
      </Section>
      {tenders.map((t) => (
        <p key={t.tenderId} className="tender">
          Regulator tender: have <b>{mw(t.needKw)}</b> of your capacity here {t.deadlineLabel} → <b>{credits(t.payCc)}</b>. Now {mw(t.progressKw)}.
        </p>
      ))}
      <button className="btn primary wide" onClick={() => onBuildHere(n.nodeId)}>
        Build here
      </button>
      <Section title="Plants">
        {plants.length === 0 && <p className="fine">No plants. Every megawatt here is imported over the lines.</p>}
        {plants.map((p) => (
          <button key={p.plantId} className="list-row" onClick={() => onFocus({ kind: 'plant', id: p.plantId })}>
            <span className={p.mine ? 'gold' : ''}>{p.name}</span>
            <small>{p.ownerName} · {p.status === 'online' ? mw(Math.abs(p.netKw)) : p.status}</small>
          </button>
        ))}
      </Section>
      <Section title="People and businesses">
        {actors.map((a) => (
          <button key={a.actorId} className="list-row" onClick={() => onFocus({ kind: 'actor', id: a.actorId })}>
            <span>
              {a.face} {a.name}
            </span>
            <small className={STATE_TONE[a.state]}>{a.state} · {mw(a.servedKw)}</small>
          </button>
        ))}
      </Section>
    </>
  )
}

function CorridorInspector({ v, c, act }: { v: RegionView; c: CorridorView; act: Act }) {
  const { busy, msg, run } = useAct(act)
  const name = (id: string) => v.nodes.find((n) => n.nodeId === id)!.name
  const dir = c.flowKw >= 0 ? `${name(c.from)} → ${name(c.to)}` : `${name(c.to)} → ${name(c.from)}`
  return (
    <>
      <p className="eyebrow">Transmission</p>
      <h3>{c.name}</h3>
      <p className="fine">{dir}</p>
      <div className="gauge">
        <span>Flow</span>
        <b>{mw(Math.abs(c.flowKw))}</b>
        <small>of {mw(c.limitKw)}</small>
      </div>
      <Bar value={Math.abs(c.flowKw)} max={c.limitKw} tone={c.congested ? 'crisis' : Math.abs(c.flowKw) > c.limitKw * 0.75 ? 'warn' : 'teal'} />
      {c.congested ? <p className="warn-line">Full. Power costs {price(Math.abs(c.spreadCcPerMWh))}/MWh more on the importing side: that difference is congestion rent.</p> : <p className="fine">Room to spare: prices are the same at both ends.</p>}
      <Section title="Congestion rent today">
        <Stat label="Whole line" value={credits(c.rentCcToday)} />
        <Stat label="Your share" value={credits(c.playerRentCcToday)} tone="gold" />
        <Stat label="Your capacity on it" value={mw(c.playerKw)} />
      </Section>
      <Section title="Upgrade">
        {c.upgrade.building !== null ? (
          <p className="fine">Crews at work: {hours(c.upgrade.building)} left.</p>
        ) : (
          <>
            <p className="fine">+{mw(c.upgrade.addKw)} for {credits(c.upgrade.costCc)} · {hours(c.upgrade.intervals)} to build. You earn the rent on the capacity you add.</p>
            <button className="btn primary" disabled={busy} onClick={() => run({ type: 'UPGRADE_CORRIDOR', corridorId: c.corridorId })}>
              Upgrade for {credits(c.upgrade.costCc)}
            </button>
          </>
        )}
        <Msg msg={msg} />
      </Section>
    </>
  )
}

function ActorInspector({ v, a }: { v: RegionView; a: ActorView }) {
  const node = v.nodes.find((n) => n.nodeId === a.nodeId)!
  return (
    <>
      <p className="eyebrow">{node.name}</p>
      <h3>
        {a.face} {a.name}
      </h3>
      <p className="fine">
        {a.person}, {a.role}
      </p>
      <blockquote className="quote">“{a.quote}”</blockquote>
      <p className={`state-pill ${STATE_TONE[a.state]}`}>{a.state}</p>
      <Section title="Balance sheet">
        <Stat label="Cash" value={credits(a.cashCc)} />
        <Stat label="Debt" value={credits(a.debtCc)} tone={a.debtCc > a.cashCc ? 'warn' : undefined} />
        {a.baseEmployees > 0 && <Stat label="Jobs" value={`${a.employees.toLocaleString('en-US')} of ${a.baseEmployees.toLocaleString('en-US')}`} tone={a.employees < a.baseEmployees ? 'warn' : undefined} />}
        <Stat label="Health" value={pct(a.healthBps)} tone={a.healthBps < 2_500 ? 'crisis' : a.healthBps < 4_500 ? 'warn' : 'ok'} />
        <Stat label={a.kind === 'households' ? 'Saved today' : 'Profit today'} value={credits(a.profitCcToday)} tone={a.profitCcToday >= 0 ? 'ok' : 'crisis'} />
      </Section>
      <Section title="Power">
        <Stat label="Wants" value={mw(a.demandKw)} />
        <Stat label="Gets" value={mw(a.servedKw)} tone={a.servedKw < a.demandKw * 0.95 ? 'warn' : undefined} />
        {a.kind !== 'households' && <Stat label="Output" value={pct(a.productionBps)} />}
        <Stat label="Paid for power today" value={credits(a.energyCostCcToday)} />
        <p className="fine">Switches off flexible load above {price(a.flexCcPerMWh)}/MWh; would pay up to {price(a.wtpCcPerMWh)} to keep the essentials on.</p>
      </Section>
    </>
  )
}
