/** The dock (§34): five modes, nothing else. Each opens one sheet; the world stays visible behind it. */
import { useState } from 'react'
import type { NodeId, RegionView, TechId } from '@blackout/shared'
import { credits, hours, mw, mwh, pct, price } from '../format'
import type { Selection } from '../scene/World3D'
import { Bar, Section, Seg, Spark, Stat } from './Bits'
import type { Act } from './Inspector'

export type DockMode = 'dispatch' | 'build' | 'market' | 'grid' | 'portfolio'

const MODES: { id: DockMode; label: string; icon: string }[] = [
  { id: 'dispatch', label: 'DISPATCH', icon: '⚡' },
  { id: 'build', label: 'BUILD', icon: '🏗️' },
  { id: 'market', label: 'MARKET', icon: '📈' },
  { id: 'grid', label: 'GRID', icon: '🗼' },
  { id: 'portfolio', label: 'PORTFOLIO', icon: '💼' },
]

export function Dock({ mode, onMode, badges }: { mode: DockMode | null; onMode: (m: DockMode | null) => void; badges: Partial<Record<DockMode, string>> }) {
  return (
    <nav className="dock" aria-label="Modes">
      {MODES.map((m) => (
        <button key={m.id} className={mode === m.id ? 'on' : ''} aria-pressed={mode === m.id} onClick={() => onMode(mode === m.id ? null : m.id)}>
          <span aria-hidden>{m.icon}</span>
          {m.label}
          {badges[m.id] && <i className="badge">{badges[m.id]}</i>}
        </button>
      ))}
    </nav>
  )
}

export function ModeSheet({ mode, v, act, onClose, onSelect, building, setBuilding, buildNode }: { mode: DockMode; v: RegionView; act: Act; onClose: () => void; onSelect: (s: Selection) => void; building: { tech: TechId; size: number } | null; setBuilding: (b: { tech: TechId; size: number } | null) => void; buildNode: NodeId | null }) {
  return (
    <div className="sheet" role="dialog" aria-label={mode}>
      <button className="close" onClick={onClose} aria-label="Close">
        ×
      </button>
      {mode === 'dispatch' && <Dispatch v={v} act={act} onSelect={onSelect} />}
      {mode === 'build' && <Build v={v} act={act} building={building} setBuilding={setBuilding} buildNode={buildNode} />}
      {mode === 'market' && <Market v={v} act={act} onSelect={onSelect} />}
      {mode === 'grid' && <Grid v={v} act={act} onSelect={onSelect} />}
      {mode === 'portfolio' && <Portfolio v={v} act={act} onSelect={onSelect} />}
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
      const r = await act(a)
      setMsg({ ok: r.ok, text: r.message })
      setBusy(false)
      return r.ok
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
      <h3>Dispatch</h3>
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
      <h3>Build</h3>
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
                const locked = (TECH_LICENCE[t.tech]?.[i] ?? 1) > v.player.licence
                return (
                  <button key={i} className={building?.tech === t.tech && building.size === i ? 'on' : ''} disabled={locked} title={locked ? `Needs licence ${TECH_LICENCE[t.tech]![i]}` : undefined} onClick={() => setBuilding({ tech: t.tech, size: i })}>
                    {mw(z.capacityKw)}
                    {z.energyKwh > 0 && <small> / {mwh(z.energyKwh)}</small>}
                    <small>{locked ? '🔒' : `${credits(z.costCc)} + ${z.steelT} t steel`}</small>
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

/** Mirrors the engine's licence per size (shown as locks; the server enforces it). */
const TECH_LICENCE: Partial<Record<TechId, number[]>> = { diesel: [1, 1], ocgt: [1, 2], ccgt: [2, 3], solar: [1, 1, 2], battery: [1, 1, 3] }

/* -------------------------------------------------------------------------------------------- MARKET */

function Market({ v, act, onSelect }: { v: RegionView; act: Act; onSelect: (s: Selection) => void }) {
  const { busy, msg, run } = useRun(act)
  return (
    <>
      <h3>Market</h3>
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
        <p className="fine">
          <b>VoltLine</b> ({v.voltline.person}): {mw(v.voltline.capacityKw)}, {credits(v.voltline.cashCc)} cash, {credits(v.voltline.debtCc)} debt. {v.voltline.note}
        </p>
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
      <h3>Grid</h3>
      <p className="fine">Lines glow by loading. A full line splits prices: cheap on one side, dear on the other. Whoever owns the capacity collects the difference.</p>
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

function Portfolio({ v, act, onSelect }: { v: RegionView; act: Act; onSelect: (s: Selection) => void }) {
  const { busy, msg, run } = useRun(act)
  const pl = v.player
  const mine = v.plants.filter((p) => p.mine)
  const forSale = v.plants.filter((p) => !p.mine && p.listing)
  return (
    <>
      <h3>Portfolio</h3>
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
      <Section title={`Licence: ${pl.licenceName}`}>
        {pl.nextLicence ? (
          <>
            <p className="fine">
              Next: <b>{pl.nextLicence.name}</b> at {pl.nextLicence.needMWh.toLocaleString('en-US')} MWh delivered{pl.nextLicence.needReliabilityBps ? ` and ${pct(pl.nextLicence.needReliabilityBps)} regional reliability` : ''}.
            </p>
            <Bar value={pl.nextLicence.haveMWh} max={pl.nextLicence.needMWh} tone="gold" />
          </>
        ) : (
          <p className="fine">Top licence. The region leans on you.</p>
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
              <button className="btn primary" disabled={busy} onClick={() => run({ type: 'BUY_LISTED_PLANT', plantId: p.plantId })}>
                Buy {credits(p.listing!.askCc)}
              </button>
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
      <Section title="Banks">
        {v.banks.map((b) => (
          <div key={b.bankId} className="supplier">
            <div className="sup-head">
              <span>
                <b>{b.name}</b> <small>{b.person}</small>
              </span>
              <b>{(b.rateBps / 100).toFixed(2)}%/day</b>
            </div>
            <small className="fine">{b.stance} Will lend you up to {credits(b.offerToPlayerCc)}.</small>
            <div className="row">
              {[5_000_000, 10_000_000].filter((amt) => amt <= b.offerToPlayerCc).map((amt) => (
                <button key={amt} className="btn small" disabled={busy} onClick={() => run({ type: 'TAKE_LOAN', bankId: b.bankId, amountCc: amt })}>
                  Borrow {credits(amt)}
                </button>
              ))}
              {b.offerToPlayerCc < 5_000_000 && <small className="fine">Not lending to you right now.</small>}
            </div>
          </div>
        ))}
        {v.loans.map((l) => (
          <div key={l.loanId} className="bid">
            <span>
              {credits(l.principalCc)} from {v.banks.find((b) => b.bankId === l.bankId)?.name}
              <small>{credits(l.interestCcPerDay)} interest a day</small>
            </span>
            <button className="btn" disabled={busy || pl.cashCc < Math.min(l.principalCc, 5_000_000)} onClick={() => run({ type: 'REPAY_LOAN', loanId: l.loanId, amountCc: Math.min(l.principalCc, pl.cashCc) })}>
              Repay {credits(Math.min(l.principalCc, pl.cashCc))}
            </button>
          </div>
        ))}
      </Section>
      <Section title="The region's economy">
        <Stat label="Steel output index" value={pct(v.economy.steelIndexBps)} tone={v.economy.steelIndexBps > 10_500 ? 'warn' : undefined} />
        <Stat label="Construction costs" value={pct(v.economy.buildCostBps)} tone={v.economy.buildCostBps > 10_200 ? 'warn' : undefined} />
        <Stat label="Business output" value={pct(v.economy.regionOutputBps)} />
        <Stat label="Jobs" value={`${v.economy.employment.toLocaleString('en-US')} / ${v.economy.baseEmployment.toLocaleString('en-US')}`} />
        <Stat label="Household health" value={pct(v.economy.householdHealthBps)} />
      </Section>
      <Msg msg={msg} />
    </>
  )
}
