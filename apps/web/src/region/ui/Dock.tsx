/** Five familiar game controls; each opens one sheet while the region stays in view. */
import { useEffect, useState } from 'react'
import type { NodeId, RegionView, TechId } from '@blackout/shared'
import { credits, hours, mw, mwh, pct, price } from '../format'
import type { Selection } from '../scene/World3D'
import { Bar, Section, Seg, Spark, Stat } from './Bits'
import type { Act } from './Inspector'

export type DockMode = 'dispatch' | 'build' | 'market' | 'grid' | 'portfolio'

const MODES: { id: DockMode; label: string; icon: string }[] = [
  { id: 'dispatch', label: 'Power', icon: '⚡' },
  { id: 'build', label: 'Build', icon: '🏗️' },
  { id: 'market', label: 'Market', icon: '📈' },
  { id: 'grid', label: 'Map', icon: '🗼' },
  { id: 'portfolio', label: 'Company', icon: '🏢' },
]

export function Dock({ mode, onMode, badges, onCampaign, campaignOpen }: { mode: DockMode | null; onMode: (m: DockMode | null) => void; badges: Partial<Record<DockMode, string>>; onCampaign: () => void; campaignOpen: boolean }) {
  return (
    <nav className="dock" aria-label="Game controls">
      {MODES.map((m) => (
        <button key={m.id} className={mode === m.id ? 'on' : ''} aria-label={m.id === 'dispatch' ? 'Manage your power plants' : m.id === 'build' ? 'Build and upgrade plants' : m.id === 'market' ? 'Open the Vesper Market' : m.id === 'grid' ? 'Explore the city map and power lines' : 'Open company finances and assets'} aria-pressed={mode === m.id} onClick={() => onMode(mode === m.id ? null : m.id)}>
          <span aria-hidden>{m.icon}</span>
          {m.label}
          {badges[m.id] && <i className="badge">{badges[m.id]}</i>}
        </button>
      ))}
      <button className={`dock-campaign ${campaignOpen ? 'on' : ''}`} aria-label="Open campaign goals and weekly crisis" aria-pressed={campaignOpen} onClick={onCampaign}>
        <span aria-hidden>🏆</span>
        Goals
      </button>
    </nav>
  )
}

export function ModeSheet({ mode, v, act, onClose, onSelect, onMode, building, setBuilding, buildNode }: { mode: DockMode; v: RegionView; act: Act; onClose: () => void; onSelect: (s: Selection) => void; onMode: (m: DockMode | null) => void; building: { tech: TechId; size: number } | null; setBuilding: (b: { tech: TechId; size: number } | null) => void; buildNode: NodeId | null }) {
  const titles: Record<DockMode, string> = { dispatch: 'Power plants', build: 'Build your grid', market: 'Vesper Market', grid: 'Grid map', portfolio: 'Your company' }
  useEffect(() => {
    const closeOnEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={titles[mode]}>
      <button className="close" onClick={onClose} aria-label="Close">
        ×
      </button>
      {mode === 'dispatch' && <Dispatch v={v} act={act} onSelect={onSelect} />}
      {mode === 'build' && <Build v={v} act={act} building={building} setBuilding={setBuilding} buildNode={buildNode} />}
      {mode === 'market' && <Market v={v} act={act} onSelect={onSelect} />}
      {mode === 'grid' && <Grid v={v} act={act} onSelect={onSelect} />}
      {mode === 'portfolio' && <Portfolio v={v} act={act} onSelect={onSelect} onClose={onClose} onMode={onMode} />}
    </div>
  )
}

function useRun(act: Act) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  return {
    busy,
    msg,
    run: async (a: Parameters<Act>[0]) => {
      setBusy(true)
      try {
        const r = await act(a)
        setMsg({ ok: r.ok, text: r.message })
        return r.ok
      } catch (e) {
        setMsg({ ok: false, text: (e as Error).message || 'The action could not be completed. Try again.' })
        return false
      } finally {
        setBusy(false)
      }
    },
  }
}
const Msg = ({ msg }: { msg: { ok: boolean; text: string } | null }) => (msg ? <p className={msg.ok ? 'ok-line' : 'warn-line'}>{msg.text}</p> : null)

/* ------------------------------------------------------------------------------------------ DISPATCH */

function Dispatch({ v, act, onSelect }: { v: RegionView; act: Act; onSelect: (s: Selection) => void }) {
  const { busy, msg, run } = useRun(act)
  const mine = v.plants.filter((p) => p.mine)
  const myKw = mine.reduce((a, p) => a + Math.max(0, p.netKw), 0)
  return (
    <>
      <h3>Run your power plants</h3>
      <p className="fine">
        You are supplying <b className="gold">{mw(myKw)}</b> of {mw(v.nodes.reduce((a, n) => a + n.servedKw, 0))} served. Spot {price(v.pulse.spotCcPerMWh)}/MWh.
      </p>
      {mine.map((p) => {
        const thermal = p.fuel !== null
        return (
          <div key={p.plantId} className={`plant-row s-${p.status}`}>
            <button className="plant-name" onClick={() => onSelect({ kind: 'plant', id: p.plantId })}>
              <b>{p.name}</b>
              <small>
                {p.status === 'online' ? `${mw(Math.abs(p.netKw))} ${p.netKw < 0 ? 'charging' : ''}` : p.status === 'building' ? `building · ${hours(p.buildRemaining)}` : p.status} · cost {price(p.marginalCostCcPerMWh)}
              </small>
            </button>
            <Bar value={Math.abs(p.netKw)} max={p.capacityKw} tone={p.netKw < 0 ? 'blue' : 'teal'} />
            {thermal && p.status !== 'building' && (
              <button className={`btn small ${p.online ? '' : 'primary'}`} disabled={busy || p.status === 'tripped'} onClick={() => run({ type: 'SET_PLANT_ONLINE', plantId: p.plantId, online: !p.online })}>
                {p.online ? 'Stop' : 'Start'}
              </button>
            )}
            {p.tech === 'battery' && p.status === 'online' && (
              <Seg value={p.batteryMode} disabled={busy} onChange={(mode) => run({ type: 'SET_BATTERY_MODE', plantId: p.plantId, mode })} options={[{ value: 'auto', label: 'Auto' }, { value: 'discharge', label: 'Sell' }, { value: 'charge', label: 'Buy' }, { value: 'hold', label: 'Hold' }]} />
            )}
          </div>
        )
      })}
      <Msg msg={msg} />
      <Section title="Last 24 h · spot price">
        <Spark values={v.history.map((h) => h.priceCcPerMWh)} tone="amber" />
        <Spark values={v.history.map((h) => h.playerKw)} tone="gold" height={24} />
        <p className="fine">Amber: price. Gold: your output.</p>
      </Section>
    </>
  )
}

/* --------------------------------------------------------------------------------------------- BUILD */

function Build({ v, act, building, setBuilding, buildNode }: { v: RegionView; act: Act; building: { tech: TechId; size: number } | null; setBuilding: (b: { tech: TechId; size: number } | null) => void; buildNode: NodeId | null }) {
  const { busy, msg, run } = useRun(act)
  const sel = building ? v.techs.find((t) => t.tech === building.tech) : null
  const size = sel && building ? sel.sizes[building.size] : null
  const node = buildNode ? v.nodes.find((n) => n.nodeId === buildNode) : null
  const steel = v.economy.buildCostBps
  return (
    <>
      <h3>Expand the grid</h3>
      <p className="fine">
        Pick a plant, then tap where it goes. {steel > 10_200 ? <b className="warn">Steel shortage: everything costs {Math.round(steel / 100 - 100)}% more.</b> : 'Steel prices are normal.'}
      </p>
      <div className="tech-grid">
        {v.techs.map((t) => (
          <div key={t.tech} className={`tech ${building?.tech === t.tech ? 'on' : ''}`}>
            <b>{t.name}</b>
            <small>{t.blurb}</small>
            <small>Runs at about {price(t.marginalCostCcPerMWh)}/MWh</small>
            <div className="sizes">
              {t.sizes.map((z, i) => {
                const requiredPermit = TECH_LICENCE[t.tech]?.[i] ?? 1
                const locked = requiredPermit > v.player.licence
                const permitName = PERMIT_NAMES[requiredPermit - 1] ?? 'a higher operating'
                return (
                  <button key={i} className={building?.tech === t.tech && building.size === i ? 'on' : ''} disabled={locked} title={locked ? `Requires the ${permitName} permit` : undefined} onClick={() => setBuilding({ tech: t.tech, size: i })}>
                    {mw(z.capacityKw)}
                    {z.energyKwh > 0 && <small> / {mwh(z.energyKwh)}</small>}
                    <small>{locked ? `🔒 ${permitName} permit required` : `${credits(z.costCc)} + ${z.steelT} t steel`}</small>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      {building && size && (
        <div className="confirm">
          {node ? (
            <>
              <p>
                Build <b>{mw(size.capacityKw)} {sel!.name.toLowerCase()}</b> in <b>{node.name}</b> for <b>{credits(size.costCc)}</b> and <b>{size.steelT} t of steel</b> (you hold {v.player.steelT} t; the rest is bought at Pavel's yard). Online in {hours(size.intervals)}. Price there now {price(node.priceCcPerMWh)}, today’s average {price(node.avgPriceCcPerMWh)}.
              </p>
              <button className="btn primary" disabled={busy} onClick={async () => (await run({ type: 'BUILD_PLANT', tech: building.tech, nodeId: node.nodeId, size: building.size })) && setBuilding(null)}>
                Build for {credits(size.costCc)}
              </button>
            </>
          ) : (
            <p className="hint">Now tap a glowing pad in the region (or a district) to place it.</p>
          )}
          <button className="btn ghost" onClick={() => setBuilding(null)}>
            Cancel
          </button>
        </div>
      )}
      <Msg msg={msg} />
    </>
  )
}

/** Mirrors the engine's permit per size (shown as locks; the server enforces it). */
const TECH_LICENCE: Partial<Record<TechId, number[]>> = { diesel: [1, 1], ocgt: [1, 2], ccgt: [2, 3], solar: [1, 1, 2], battery: [1, 1, 3] }
const PERMIT_NAMES = ['Independent Generator', 'Regional Producer', 'System Partner', 'Grid Anchor'] as const

/* -------------------------------------------------------------------------------------------- MARKET */

function Market({ v, act, onSelect }: { v: RegionView; act: Act; onSelect: (s: Selection) => void }) {
  const { busy, msg, run } = useRun(act)
  return (
    <>
      <h3>Vesper Market</h3>
      <Section title="Prices by load centre">
        {[...v.nodes].sort((a, b) => b.priceCcPerMWh - a.priceCcPerMWh).map((n) => (
          <button key={n.nodeId} className="list-row" onClick={() => onSelect({ kind: 'node', id: n.nodeId })}>
            <span>{n.name}</span>
            <small className={n.shedKw > 0 ? 'crisis' : n.priceCcPerMWh > 25_000 ? 'warn' : ''}>
              {price(n.priceCcPerMWh)} · avg {price(n.avgPriceCcPerMWh)}
            </small>
          </button>
        ))}
      </Section>
      <Section title="Your fuel">
        <Stat label="Gas" value={`${v.player.gas.toLocaleString('en-US')} MMBtu`} />
        <Stat label="Diesel" value={`${v.player.diesel.toLocaleString('en-US')} L`} />
        <div className="row">
          {(['gas', 'diesel'] as const).map((f) => (
            <label key={f} className="toggle">
              <input type="checkbox" checked={v.player.autoFuel[f]} disabled={busy} onChange={(e) => run({ type: 'SET_AUTO_FUEL', fuel: f, enabled: e.target.checked })} /> Auto-buy {f}
            </label>
          ))}
        </div>
      </Section>
      <Section title="Fuel suppliers">
        {v.suppliers.map((s) => {
          const lots = s.fuel === 'gas' ? [1_000, 5_000] : [10_000, 50_000]
          return (
            <div key={s.supplierId} className="supplier">
              <div className="sup-head">
                <span>
                  {s.face} <b>{s.person}</b> <small>{s.name}</small>
                </span>
                <b>
                  {price(s.priceCcPerUnit)}/{s.fuel === 'gas' ? 'MMBtu' : 'L'}
                </b>
              </div>
              <Bar value={s.stock} max={s.capacity} tone={s.rationing ? 'crisis' : s.stock < s.capacity * 0.3 ? 'warn' : 'teal'} />
              <small className={s.rationing ? 'crisis' : 'fine'}>{s.rationing ? 'Rationing. ' : ''}{s.note}</small>
              {s.scarcityPremiumPct > 0 && <small className="crisis">Price includes a {s.scarcityPremiumPct}% low-stock premium.</small>}
              <div className="row">
                {lots.map((q) => (
                  <button key={q} className="btn small" disabled={busy || s.stock <= 0} onClick={() => run({ type: 'BUY_FUEL', supplierId: s.supplierId, quantity: q })}>
                    Buy {q.toLocaleString('en-US')} {s.fuel === 'gas' ? 'MMBtu' : 'L'} · {credits((q * s.priceCcPerUnit))}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
        <Msg msg={msg} />
      </Section>
      <Section title="Who else is in the market">
        {(v.rivals ?? []).map((r) => (
          <p key={r.ownerId} className="fine">
            {r.face} <b>{r.name}</b> ({r.person}): {mw(r.capacityKw)}, {credits(r.cashCc)} cash{r.debtCc > 0 ? `, ${credits(r.debtCc)} debt` : ''}. {r.quote}
          </p>
        ))}
        <p className="fine">
          <b>Regulator</b>: cap {price(v.regulator.priceCapCcPerMWh)}/MWh, carbon {price(v.regulator.carbonCcPerT)}/t, fund {credits(v.regulator.fundCc)}. {v.regulator.note}
        </p>
      </Section>
    </>
  )
}

/* ---------------------------------------------------------------------------------------------- GRID */

function Grid({ v, act, onSelect }: { v: RegionView; act: Act; onSelect: (s: Selection) => void }) {
  const { busy, msg, run } = useRun(act)
  const name = (id: string) => v.nodes.find((n) => n.nodeId === id)!.name
  return (
    <>
      <h3>Grid and power lines</h3>
      <p className="fine">See where power is flowing and which lines are full. Upgrading a line sends more power between districts and can capture price differences.</p>
      {v.corridors.map((c) => (
        <div key={c.corridorId} className={`line-row ${c.congested ? 'crisis' : ''}`}>
          <button className="plant-name" onClick={() => onSelect({ kind: 'corridor', id: c.corridorId })}>
            <b>{c.name}</b>
            <small>
              {name(c.from)} ↔ {name(c.to)} · {mw(Math.abs(c.flowKw))} / {mw(c.limitKw)}
              {c.congested ? ` · FULL Δ${price(Math.abs(c.spreadCcPerMWh))}` : ''}
            </small>
          </button>
          <Bar value={Math.abs(c.flowKw)} max={c.limitKw} tone={c.congested ? 'crisis' : Math.abs(c.flowKw) > c.limitKw * 0.75 ? 'warn' : 'teal'} />
          {c.upgrade.building !== null ? (
            <small className="fine">Upgrading · {hours(c.upgrade.building)}</small>
          ) : (
            <button className="btn small" disabled={busy} onClick={() => run({ type: 'UPGRADE_CORRIDOR', corridorId: c.corridorId })}>
              +{mw(c.upgrade.addKw)} · {credits(c.upgrade.costCc)} + {c.upgrade.steelT} t steel
            </button>
          )}
        </div>
      ))}
      <Msg msg={msg} />
    </>
  )
}

/* ----------------------------------------------------------------------------------------- PORTFOLIO */

function Portfolio({ v, act, onSelect, onClose, onMode }: { v: RegionView; act: Act; onSelect: (s: Selection) => void; onClose: () => void; onMode: (m: DockMode | null) => void }) {
  const { busy, msg, run } = useRun(act)
  const [reviewPlantId, setReviewPlantId] = useState<string | null>(null)
  const pl = v.player
  const mine = v.plants.filter((p) => p.mine)
  const forSale = v.plants.filter((p) => !p.mine && p.listing)
  const cashTight = pl.cashCc < 3_000_000 || (pl.cashCc < 8_000_000 && pl.profitCcToday < 0)
  const autoFuelOn = (['gas', 'diesel'] as const).filter((fuel) => pl.autoFuel[fuel] && mine.some((p) => p.fuel === fuel && (p.status === 'online' || p.status === 'starting')))
  const saleCandidate = mine.find((p) => p.status !== 'building' && !p.listing)
  return (
    <>
      <h3>Your company</h3>
      <div className="stat-grid">
        <Stat label="Cash" value={credits(pl.cashCc)} tone="gold" />
        <Stat label="Net worth" value={credits(pl.netWorthCc)} />
        <Stat label="Debt" value={credits(pl.debtCc)} tone={pl.debtCc > 0 ? 'warn' : undefined} />
        <Stat label="Profit today" value={credits(pl.profitCcToday)} tone={pl.profitCcToday >= 0 ? 'ok' : 'crisis'} />
        <Stat label="Delivered" value={`${pl.deliveredMWh.toLocaleString('en-US')} MWh`} />
        <Stat label="Region reliability" value={pct(pl.reliabilityBps)} tone={pl.reliabilityBps < 9_700 ? 'warn' : 'ok'} />
        <Stat label="Your CO₂" value={`${pl.emissionsT.toLocaleString('en-US')} t`} />
        <Stat label="Score" value={v.scores.score.toLocaleString('en-US')} />
      </div>
      {cashTight && (
        <Section title={pl.cashCc < 1_000_000 ? 'Cash is nearly out' : 'Cash buffer is thin'}>
          <p className="fine">You have {credits(pl.cashCc)} available. Today’s profit is {credits(pl.profitCcToday)}. Review these cash options before funding the next build or fuel order.</p>
          <div className="row">
            <button className="btn primary small" onClick={() => onMode('market')}>Open market and power desk</button>
            {saleCandidate && <button className="btn small" onClick={() => { onClose(); onSelect({ kind: 'plant', id: saleCandidate.plantId }) }}>Review a plant sale</button>}
          </div>
          {autoFuelOn.length > 0 && (
            <>
              <p className="fine">Automatic fuel purchases can use cash each time stock is low. Pausing them protects the balance; a plant may slow or stop when its fuel runs out.</p>
              <div className="row">
                {autoFuelOn.map((fuel) => <button key={fuel} className="btn small" disabled={busy} onClick={() => void run({ type: 'SET_AUTO_FUEL', fuel, enabled: false })}>Pause auto-buy {fuel}</button>)}
              </div>
            </>
          )}
        </Section>
      )}
      <CreditSection v={v} busy={busy} run={run} />
      <Section title={`Operating permit: ${pl.licenceName}`}>
        {pl.nextLicence ? (
          <>
            <p className="fine">
              Next permit: <b>{pl.nextLicence.name}</b> at {pl.nextLicence.needMWh.toLocaleString('en-US')} MWh delivered{pl.nextLicence.needReliabilityBps ? ` and ${pct(pl.nextLicence.needReliabilityBps)} regional reliability` : ''}.
            </p>
            <Bar value={pl.nextLicence.haveMWh} max={pl.nextLicence.needMWh} tone="gold" />
          </>
        ) : (
          <p className="fine">Highest operating permit. The region leans on your company.</p>
        )}
      </Section>
      <Section title="Your Plant Assets">
        {mine.map((p) => (
          <button key={p.plantId} className="list-row" onClick={() => onSelect({ kind: 'plant', id: p.plantId })}>
            <span>
              <b>{p.assetId}</b> {p.name}
            </span>
            <small>
              {p.lifetimeMWh.toLocaleString('en-US')} MWh · {credits(p.lifetimeRevenueCc)} earned · book {credits(p.bookValueCc)}
              {p.listing ? ` · listed ${credits(p.listing.askCc)}` : ''}
            </small>
          </button>
        ))}
      </Section>
      {forSale.length > 0 && (
        <Section title="Plants for sale">
          {forSale.map((p) => (
            <div key={p.plantId} className="bid">
              <span>
                <b>{p.name}</b> ({p.assetId}) from {p.ownerName}
                <small>
                  {mw(p.capacityKw)} {p.tech.toUpperCase()} · book {credits(p.bookValueCc)}
                </small>
              </span>
              <button className="btn primary" disabled={busy} onClick={() => setReviewPlantId(reviewPlantId === p.plantId ? null : p.plantId)}>
                {reviewPlantId === p.plantId ? 'Close review' : 'Review purchase'}
              </button>
              {reviewPlantId === p.plantId && (
                <div className="trade-ticket">
                  <b>Review plant purchase</b>
                  <div className="trade-ticket-stats">
                    <span>Price <b>{credits(p.listing!.askCc)}</b></span>
                    <span>Cash now <b>{credits(pl.cashCc)}</b></span>
                    <span>Cash after <b>{pl.cashCc >= p.listing!.askCc ? credits(pl.cashCc - p.listing!.askCc) : `short ${credits(p.listing!.askCc - pl.cashCc)}`}</b></span>
                    <span>Separate fee <b>None</b></span>
                  </div>
                  <small className="fine">Game credits move when the purchase completes. The plant and its future output then move to your company.</small>
                  <div className="row">
                    <button className="btn primary small" disabled={busy || pl.cashCc < p.listing!.askCc} onClick={async () => { const ok = await run({ type: 'BUY_LISTED_PLANT', plantId: p.plantId }); if (ok) setReviewPlantId(null) }}>
                      {pl.cashCc < p.listing!.askCc ? 'Not enough cash' : `Confirm · ${credits(p.listing!.askCc)}`}
                    </button>
                    <button className="btn ghost small" disabled={busy} onClick={() => setReviewPlantId(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </Section>
      )}
      <Section title="Regulator tenders">
        {v.tenders.length === 0 && <p className="fine">None open. Tenders appear where the lights go out.</p>}
        {v.tenders.map((t) => (
          <p key={t.tenderId} className={`tender ${t.status}`}>
            {v.nodes.find((n) => n.nodeId === t.nodeId)!.name}: {mw(t.needKw)} firm, {t.deadlineLabel} → {credits(t.payCc)} · <b>{t.status === 'open' ? `you have ${mw(t.progressKw)}` : t.status}</b>
          </p>
        ))}
      </Section>
      <Section title="The region's economy">
        <Stat label="Steel output index" value={pct(v.economy.steelIndexBps)} tone={v.economy.steelIndexBps > 10_500 ? 'warn' : undefined} />
        <Stat label="Construction costs" value={pct(v.economy.buildCostBps)} tone={v.economy.buildCostBps > 10_200 ? 'warn' : undefined} />
        <Stat label="Business output" value={pct(v.economy.regionOutputBps)} />
        <Stat label="Jobs" value={`${v.economy.employment.toLocaleString('en-US')} / ${v.economy.baseEmployment.toLocaleString('en-US')}`} />
        <Stat label="Household health" value={pct(v.economy.householdHealthBps)} />
      </Section>
      <Section title="Who's Who · Rival Generators">
        {(v.rivals ?? []).map((r) => (
          <div key={r.ownerId} className="supplier" style={{ marginBottom: 6 }}>
            <div className="sup-head">
              <span>{r.face} <b>{r.name}</b> <small>{r.person}</small></span>
              <b>{credits(r.cashCc)}</b>
            </div>
            <small className="fine">
              {mw(r.outputKw)} / {mw(r.capacityKw)} online · {r.plantCount} {r.plantCount === 1 ? 'plant' : 'plants'}{r.debtCc > 0 ? ` · ${credits(r.debtCc)} debt` : ''} · {r.state}
            </small>
          </div>
        ))}
      </Section>
      <Msg msg={msg} />
    </>
  )
}

function CreditSection({ v, busy, run }: { v: RegionView; busy: boolean; run: (a: Parameters<Act>[0]) => Promise<boolean> }) {
  const [amounts, setAmounts] = useState<Record<string, number>>({})
  const [reviewBank, setReviewBank] = useState<string | null>(null)
  const { player: pl } = v
  return (
    <Section title="Bank credit lines">
      <p className="fine">Banks lend against your cash and plant book value. Interest accrues each game day. If debt rises above 95% of company assets, a bank can force a plant sale.</p>
      {v.banks.map((b) => {
        const max = b.offerToPlayerCc
        const minimum = 100_000
        const eligible = max >= minimum
        const amount = eligible ? Math.min(max, Math.max(minimum, amounts[b.bankId] ?? Math.min(5_000_000, max))) : 0
        const dailyInterest = Math.round((amount * b.rateBps) / 10_000)
        return (
          <div key={b.bankId} className="supplier">
            <div className="sup-head">
              <span><b>{b.name}</b> <small>{b.person}</small></span>
              <b>{(b.rateBps / 100).toFixed(2)}% / game day</b>
            </div>
            <small className="fine">{b.stance} Available now: {credits(max)}.</small>
            {eligible ? (
              <>
                <label className="slider">
                  Borrow {credits(amount)}
                  <input type="range" min={100_000} max={max} step={100_000} value={amount} disabled={busy} onChange={(e) => setAmounts((x) => ({ ...x, [b.bankId]: Number(e.target.value) }))} />
                </label>
                <small className="fine">Estimated interest: {credits(dailyInterest)} per game day. No separate origination fee.</small>
                <button className="btn small" disabled={busy} onClick={() => setReviewBank(reviewBank === b.bankId ? null : b.bankId)}>{reviewBank === b.bankId ? 'Close review' : `Review ${credits(amount)} loan`}</button>
                {reviewBank === b.bankId && (
                  <div className="trade-ticket">
                    <b>Review loan</b>
                    <div className="trade-ticket-stats">
                      <span>Borrow <b>{credits(amount)}</b></span>
                      <span>Cash after <b>{credits(pl.cashCc + amount)}</b></span>
                      <span>Interest / game day <b>{credits(dailyInterest)}</b></span>
                      <span>Separate fee <b>None</b></span>
                    </div>
                    <small className="fine">Interest is charged as time passes. If cash cannot cover it, the unpaid amount is added to principal. Partial repayments are allowed. Debt above 95% of company assets can trigger a forced plant sale. The offer is checked again when you confirm.</small>
                    <div className="row">
                      <button className="btn primary small" disabled={busy || amount > max} onClick={async () => { if (await run({ type: 'TAKE_LOAN', bankId: b.bankId, amountCc: amount })) setReviewBank(null) }}>Confirm borrow · {credits(amount)}</button>
                      <button className="btn ghost small" disabled={busy} onClick={() => setReviewBank(null)}>Cancel</button>
                    </div>
                  </div>
                )}
              </>
            ) : <small className="fine">{max > 0 ? `The current offer (${credits(max)}) is below the minimum loan amount.` : 'No credit is available at your current asset and debt position.'}</small>}
          </div>
        )
      })}
      {v.loans.map((l) => {
        const repay = Math.min(l.principalCc, pl.cashCc)
        return (
          <div key={l.loanId} className="bid">
            <span>{credits(l.principalCc)} from {v.banks.find((b) => b.bankId === l.bankId)?.name}<small>{credits(l.interestCcPerDay)} interest each game day</small></span>
            <button className="btn small" disabled={busy || repay <= 0} onClick={() => void run({ type: 'REPAY_LOAN', loanId: l.loanId, amountCc: repay })}>Repay {credits(repay)}</button>
          </div>
        )
      })}
    </Section>
  )
}
