import { useEffect, useState, type ReactNode } from 'react'
import type { GameStatePublic, MerchantPublic } from '@blackout/shared'
import { api, explainError } from '../api/client'
import { SignInOptions } from './SignIn'
import type { Game } from '../game/useGame'
import { VOICES, voiceLine } from './Story'
import { MOOD_ICON, bizName, fmtCredits, fmtKg, fmtKw, fmtKwh, fmtLitres, fmtPct, fmtRate, secondsLeft, sparkPath } from './format'

export function Drawer({ title, eyebrow, onClose, children, wide }: { title: string; eyebrow: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <section className={`drawer ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="drawer-title" onMouseDown={(e) => e.stopPropagation()}>
        <button className="icon-button close" aria-label="Close" onClick={onClose} autoFocus>×</button>
        <p className="eyebrow amber">{eyebrow}</p>
        <h1 id="drawer-title">{title}</h1>
        {children}
      </section>
    </div>
  )
}

// ------------------------------------------------------------------ market
export function MarketPanel({ g, onClose, onOpenExchange }: { g: Game; onClose: () => void; onOpenExchange?: () => void }) {
  const s = g.state!
  const w = s.world
  const trend = w.oilTrend === 'up' ? '↗' : w.oilTrend === 'down' ? '↘' : '→'
  return (
    <Drawer title="Marketplace" eyebrow="FUEL · CARBON PERMITS · OPEN THROUGHOUT PLAY" onClose={onClose} wide>
      <div className="oil-strip">
        <div>
          <small>OIL INDEX {trend}</small>
          <b>{(w.oilIndexCenti / 100).toFixed(2)}</b>
        </div>
        <p>
          {w.observedBrent ? (
            <>This city follows the week of <b>{w.observedBrent.weekStart}</b>: Brent averaged <b>${w.observedBrent.usdPerBarrel.toFixed(2)}</b>/bbl (<a href={w.observedBrent.sourceUrl} target="_blank" rel="noreferrer">source</a>). {w.oilPassThroughBps / 100}% of each crude move reaches diesel import cost. Merchants then price for their own stock and demand.</>
          ) : (
            <>{w.oilSourceLabel}. Merchants price from import cost, their own stock, and demand.</>
          )}
        </p>
      </div>
      <div className="merchant-grid">
        {s.merchants.map((m) => <MerchantCard key={m.merchantId} g={g} m={m} />)}
      </div>
      <PermitBox g={g} />
      <PlayerListings g={g} onOpenExchange={onOpenExchange} />
      <TradeList s={s} />
    </Drawer>
  )
}

function PlayerListings({ g, onOpenExchange }: { g: Game; onOpenExchange?: () => void }) {
  const s = g.state!
  const p = g.player
  const chainReady = s.run.playerListingsEnabled
  const registered = !!p && p.kind === 'registered'
  const canList = registered && chainReady
  const [quantityMl, setQuantityMl] = useState(5_000)
  const [price, setPrice] = useState(900)
  const listings = [...s.marketListings].reverse()
  const max = Math.min(60_000, s.player.listableFuelMl)
  const qty = Math.min(Math.max(100, quantityMl), Math.max(100, max))
  const total = Math.ceil((qty * price) / 1000)

  return (
    <section className="player-market" aria-labelledby="player-market-title">
      <div className="section-heading"><div><p className="eyebrow amber">PLAYER-OWNED MARKET</p><h2 id="player-market-title">{canList ? 'Sell fuel to local merchants' : 'Sell your fuel'}</h2></div>{canList && <span className="pill">{fmtLitres(s.player.listableFuelMl)} available</span>}</div>
      {!canList ? (
        <div className="x-pointer">
          <p className="fine">Sell your spare diesel to players and traders in <b>every</b> city on the Vesper Fuel Exchange. Your price, your timing; it can sell while you're offline.</p>
          {onOpenExchange && g.playing !== 'challenge' && <button className="button primary" onClick={onOpenExchange}>Open the Exchange ⇄</button>}
        </div>
      ) : (
        <div className="listing-form">
          <p className="fine">Set your ask. Merchants check stockroom space, recent demand, spare cash and restocking cost before buying. Fuel can be listed once its delivery is confirmed; starter supplies can't be resold. If a listing is cancelled or expires, the fuel returns to your tank.</p>
          <label className="field"><span>Fuel quantity · {fmtLitres(qty)}</span><input type="range" min={100} max={Math.max(100, max)} step={100} value={qty} disabled={max < 100} onChange={(e) => setQuantityMl(Number(e.target.value))} aria-label="Fuel quantity to list" /></label>
          <label className="field"><span>Asking price · credits per litre</span><input type="number" min={1} max={100_000} step={1} value={price} onChange={(e) => setPrice(Math.max(1, Math.min(100_000, Number(e.target.value) || 1)))} /></label>
          <p className="fine">A full sale pays {fmtCredits(total)} fictional game credits. They cannot be withdrawn or exchanged outside BLACKOUT.</p>
          <button className="button primary" disabled={max < 100 || g.pending.has('player-listing:create')} onClick={() => void g.act({ type: 'CREATE_PLAYER_LISTING', listingId: `listing_${crypto.randomUUID()}`, quantityMl: qty, unitPriceCcPerL: price }, 'player-listing:create')}>
            {g.pending.has('player-listing:create') ? 'Preparing listing…' : 'List fuel'}
          </button>
        </div>
      )}
      {listings.length > 0 && <div className="player-listings">
        {listings.map((listing) => {
          const status = listing.status === 'reserved' ? 'Preparing your listing' : listing.status === 'active' ? 'Open · merchants are evaluating' : listing.status === 'purchase_pending' ? 'A merchant is arranging delivery' : listing.status === 'cancel_pending' ? 'Cancellation pending · fuel stays reserved' : listing.status === 'filled' ? 'Sold' : listing.status === 'expired' ? 'Expired · fuel returned' : listing.status === 'cancelled' ? 'Cancelled · fuel returned' : 'Could not create listing · fuel returned'
          return <article className="player-listing" key={listing.listingId}>
            <div className="section-heading"><b>{fmtLitres(listing.quantityMl)} diesel · {fmtCredits(listing.unitPriceCcPerL)}/L</b><span className="pill">{status}</span></div>
            <p className="fine">Full offer: {fmtCredits(listing.totalCc)} credits · expires after seven in-game days</p>
            {listing.buyerMerchantId && <p className="fine">Buyer: {s.merchants.find((m) => m.merchantId === listing.buyerMerchantId)?.name ?? listing.buyerMerchantId}</p>}
            <details><summary>Merchant decisions</summary><ul className="fine">{s.merchants.map((m) => <li key={m.merchantId}><b>{m.name}:</b> {listing.decisionReasons[m.merchantId]}</li>)}</ul></details>
            {listing.error && <p className="warn">{listing.error}</p>}
            {listing.status === 'active' && <button className="button mini" disabled={g.pending.has(`player-listing:cancel:${listing.listingId}`)} onClick={() => void g.act({ type: 'CANCEL_PLAYER_LISTING', listingId: listing.listingId }, `player-listing:cancel:${listing.listingId}`)}>Cancel listing</button>}
          </article>
        })}
      </div>}
    </section>
  )
}

function MerchantCard({ g, m }: { g: Game; m: MerchantPublic }) {
  const s = g.state!
  const [litres, setLitres] = useState(10)
  const [quoteId, setQuoteId] = useState<string | null>(null)
  const [why, setWhy] = useState(false)
  const quote = s.quotes.find((q) => q.quoteId === quoteId)
  const left = quote ? secondsLeft(s, quote.expiresTick) : null
  const expired = quote && (quote.status !== 'open' || left === 0)
  const trade = quoteId ? s.trades.find((t) => t.quoteId === quoteId) : undefined
  const sellable = Math.max(0, m.stockMl - (m.policyId === 'reserve_cooperative' ? 120_000 : 0))
  const maxL = Math.max(1, Math.min(40, Math.floor((s.player.tankCapacityMl - s.player.fuelMl - s.player.pendingFuelMl) / 1000), Math.floor(sellable / 1000), m.reasons.rationLimitMl !== null ? Math.floor(m.reasons.rationLimitMl / 1000) : 40))
  const history = m.priceHistory.map((p) => p.priceCcPerL)
  return (
    <article className={`merchant-card ${m.status}`}>
      <header>
        <span className="avatar">{m.name[0]}</span>
        <div><h3>{m.name}</h3><small>{m.style}</small></div>
        <strong>{fmtCredits(m.quoteCcPerL)}<small>/L</small></strong>
      </header>
      <div className="stock">
        <span style={{ width: `${Math.min(100, (m.stockMl / m.targetStockMl) * 100)}%` }} />
      </div>
      <p className="row"><span>Stock {fmtLitres(m.stockMl)} / target {fmtLitres(m.targetStockMl)}</span><span>Cash {fmtCredits(m.cashCc)}</span></p>
      {history.length > 1 && <svg className="spark" viewBox="0 0 200 30" aria-label="Price history"><path d={sparkPath(history, 200, 28)} /></svg>}
      {m.pendingRestockMl > 0 && <p className="fine">🚚 Restock of {fmtLitres(m.pendingRestockMl)} from the exchange traders arrives {m.restockArrivesDay !== null && m.restockArrivesDay <= s.clock.day ? 'soon' : 'next shift'}</p>}
      {m.reasons.rationLimitMl !== null && <p className="warn">Ration limit: up to {fmtLitres(m.reasons.rationLimitMl)} per purchase while crude is rising.</p>}
      <button className="why" onClick={() => setWhy(!why)} aria-expanded={why}>{why ? '▾' : '▸'} See price breakdown</button>
      {why && (
        <div className="reasons">
          <p>{m.reasons.explanation}</p>
          <dl>
            <dt>Import cost</dt><dd>{fmtCredits(m.reasons.baseReplacementCcPerL)}/L</dd>
            <dt>Scarcity</dt><dd>{fmtPct(m.reasons.scarcityBps)}</dd>
            <dt>Demand vs normal</dt><dd>{fmtPct(m.reasons.demandDeltaBps)}</dd>
            <dt>Markup</dt><dd>{fmtPct(m.reasons.markupBps)}</dd>
          </dl>
        </div>
      )}
      {m.status === 'closed' ? (
        <p className="warn">Closed. This merchant has no stock and cannot fund a restock.</p>
      ) : trade ? (
        <TradeStatusLine t={trade} />
      ) : quote && !expired ? (
        <div className="quote-box">
          <p>Your quote: <b>{fmtLitres(Math.min(litres * 1000, quote.maxQuantity))}</b> at <b>{fmtCredits(quote.unitPriceCc)}/L</b> = <b>{fmtCredits(Math.ceil((Math.min(litres * 1000, quote.maxQuantity) * quote.unitPriceCc) / 1000))}</b>. Expires in {left}s.</p>
          <button className="button primary wide" disabled={g.pending.has(`buy:${quote.quoteId}`)} onClick={() => void g.act({ type: 'BUY', quoteId: quote.quoteId, quantity: Math.min(litres * 1000, quote.maxQuantity) }, `buy:${quote.quoteId}`)}>
            {g.pending.has(`buy:${quote.quoteId}`) ? 'Reserving…' : 'Buy fuel'}
          </button>
        </div>
      ) : (
        <div className="buy-row">
          <label>
            <span>{litres} L</span>
            <input type="range" min={1} max={maxL} value={Math.min(litres, maxL)} onChange={(e) => setLitres(Number(e.target.value))} aria-label={`Litres to buy from ${m.name}`} />
          </label>
          <button
            className="button"
            disabled={g.pending.has(`quote:${m.merchantId}`)}
            onClick={async () => {
              const r = await g.act({ type: 'REQUEST_QUOTE', sellerId: `merchant:${m.merchantId}`, item: 'diesel', quantity: Math.min(litres, maxL) * 1000 }, `quote:${m.merchantId}`)
              if (r?.quoteId) setQuoteId(r.quoteId as string)
            }}
          >
            {expired ? 'Refresh quote' : 'Request quote'}
          </button>
        </div>
      )}
      {trade && trade.status !== 'reserved' && <button className="text-link" onClick={() => setQuoteId(null)}>Buy more</button>}
    </article>
  )
}

function TradeStatusLine({ t }: { t: GameStatePublic['trades'][number] }) {
  if (t.status === 'reserved')
    return <p className="pending-line">⏳ Delivery is being confirmed. Your credits are reserved, and the city keeps running.</p>
  if (t.status === 'compensated') return <p className="warn">✕ Purchase couldn't be completed. {fmtCredits(t.totalCc)} were returned to your balance.</p>
  return (
    <p className="ok-line">
      ✓ Purchase complete: {t.item === 'diesel' ? fmtLitres(t.quantity) : `${t.quantity} permits`} for {fmtCredits(t.totalCc)}
    </p>
  )
}

function PermitBox({ g }: { g: Game }) {
  const s = g.state!
  const [n, setN] = useState(2)
  const [quoteId, setQuoteId] = useState<string | null>(null)
  const quote = s.quotes.find((q) => q.quoteId === quoteId && q.status === 'open' && q.expiresTick > s.clock.tick)
  const trade = quoteId ? s.trades.find((t) => t.quoteId === quoteId) : undefined
  return (
    <section className="permit-box">
      <div>
        <p className="eyebrow">CARBON REGULATOR</p>
        <h3>{fmtCredits(s.regulator.permitPriceCc)} per permit <small>(10 kg CO₂)</small></h3>
        <p className="fine">{s.regulator.priceReason} {s.regulator.permitsForSaleToday} of {s.regulator.dailyCapPermits} for sale today. Diesel cannot run without allowance.</p>
      </div>
      {trade ? (
        <TradeStatusLine t={trade} />
      ) : quote ? (
        <button className="button primary" onClick={async () => { await g.act({ type: 'BUY', quoteId: quote.quoteId, quantity: Math.min(n, quote.maxQuantity) }, `buy:${quote.quoteId}`) }}>
          Buy {Math.min(n, quote.maxQuantity)} for {fmtCredits(Math.min(n, quote.maxQuantity) * quote.unitPriceCc)}
        </button>
      ) : (
        <div className="buy-row">
          <label><span>{n} permits</span><input type="range" min={1} max={Math.max(1, s.regulator.permitsForSaleToday)} value={n} onChange={(e) => setN(Number(e.target.value))} aria-label="Permits to buy" /></label>
          <button className="button" disabled={!s.regulator.permitsForSaleToday} onClick={async () => { const r = await g.act({ type: 'REQUEST_QUOTE', sellerId: 'regulator', item: 'permit', quantity: n }, 'quote:regulator'); if (r?.quoteId) setQuoteId(r.quoteId as string) }}>
            {s.regulator.permitsForSaleToday ? 'Request quote' : 'Sold out today'}
          </button>
        </div>
      )}
    </section>
  )
}

function TradeList({ s }: { s: GameStatePublic }) {
  if (!s.trades.length) return null
  return (
    <section className="trade-list">
      <p className="eyebrow">YOUR RECENT PURCHASES</p>
      {s.trades.slice().reverse().slice(0, 8).map((t) => (
        <div key={t.tradeId} className="trade-row">
          <span>{t.item === 'diesel' ? `⛽ ${fmtLitres(t.quantity)}` : `☁ ${t.quantity} permits`}</span>
          <span>{fmtCredits(t.totalCc)}</span>
          <span className={`pill ${t.status === 'settled' ? 'teal' : t.status === 'reserved' ? 'amber' : 'coral'}`}>{t.status === 'reserved' ? 'awaiting settlement' : t.status === 'settled' ? 'complete' : 'refunded'}</span>
          <span className="fine">{t.status === 'settled' ? 'delivered' : t.status === 'compensated' ? 'refunded' : 'confirming delivery'}</span>
        </div>
      ))}
    </section>
  )
}

// ------------------------------------------------------------------ equipment
export function EquipmentPanel({ g, onClose }: { g: Game; onClose: () => void }) {
  const s = g.state!
  const mq = s.districts.filter((d) => d.unlocked)
  return (
    <Drawer title="Equipment & pricing" eyebrow="INVEST · MAINTAIN · SET TARIFFS" onClose={onClose} wide>
      <div className="upgrade-grid">
        {s.upgradesCatalog.map((u) => (
          <article key={u.upgradeId} className={`upgrade ${u.owned ? 'owned' : ''}`}>
            <span className="upgrade-icon">{u.upgradeId === 'solar_2kw' ? '☀' : u.upgradeId === 'battery_10kwh' ? '▮' : '⚡'}</span>
            <h3>{u.name}</h3>
            <p>{u.description}</p>
            <button className="button primary wide" disabled={u.owned || s.company.stage < u.requiredStage || s.player.creditsCc < u.costCc || g.pending.has(`up:${u.upgradeId}`)} onClick={() => void g.act({ type: 'BUY_UPGRADE', upgradeId: u.upgradeId }, `up:${u.upgradeId}`)}>
              {u.owned ? 'Installed' : s.company.stage < u.requiredStage ? `Opens at stage ${u.requiredStage}` : s.player.creditsCc < u.costCc ? `Need ${fmtCredits(u.costCc)}` : `Install · ${fmtCredits(u.costCc)}`}
            </button>
          </article>
        ))}
      </div>
      <p className="eyebrow" style={{ marginTop: 22 }}>MAINTENANCE</p>
      {s.generators.filter((x) => x.type === 'diesel').map((gen) => (
        <div key={gen.generatorId} className="maint-row">
          <span><b>{gen.name}</b> · wear {Math.round(gen.wearBps / 100)}% · heat {Math.round(gen.heatPermille / 10)}%</span>
          <button className="button mini" disabled={gen.status !== 'online' || gen.assignedW > 0} title={gen.assignedW > 0 ? 'Disconnect its customers first' : 'Resets wear; offline for 12 game hours'} onClick={() => void g.act({ type: 'SERVICE_GENERATOR', generatorId: gen.generatorId }, `svc:${gen.generatorId}`)}>
            Service · ₡60
          </button>
        </div>
      ))}
      <p className="eyebrow" style={{ marginTop: 22 }}>TARIFFS</p>
      {mq.map((d) => <TariffRow key={d.districtId} g={g} districtId={d.districtId} />)}
    </Drawer>
  )
}

function TariffRow({ g, districtId }: { g: Game; districtId: string }) {
  const s = g.state!
  const d = s.districts.find((x) => x.districtId === districtId)!
  const cur = s.player.tariffsCcPerKwh[districtId]
  const [v, setV] = useState(cur)
  const members = s.businesses.filter((b) => b.districtId === districtId)
  return (
    <div className="tariff-row">
      <label>
        <span><b>{d.name}</b> {fmtRate(v)}</span>
        <input type="range" min={100} max={3000} step={10} value={v} onChange={(e) => setV(Number(e.target.value))} aria-label={`${d.name} tariff`} />
      </label>
      <p className="fine">Break-even per customer: {members.map((b) => `${b.name.split(' ')[0]} ${fmtRate(b.breakEvenRateCcPerKwh)}`).join(' · ')}. Rival charges {fmtRate(s.rival.tariffCcPerKwh)}.</p>
      <button className="button mini" disabled={v === cur} onClick={() => void g.act({ type: 'SET_TARIFF', districtId, rateCcPerKwh: v }, `tariff:${districtId}`)}>Apply</button>
    </div>
  )
}

// ------------------------------------------------------------------ expansion
export function ExpansionPanel({ g, onClose }: { g: Game; onClose: () => void }) {
  const s = g.state!
  const c = s.company
  const fmtNeed = (r: (typeof c.requirements)[number], v: number) => (r.unit === 'Wh' ? fmtKwh(v) : r.unit === 'W' ? fmtKw(v) : String(v))
  const plantsW = s.generators.reduce((a, x) => a + x.ratedW, 0)
  return (
    <Drawer title="Your grid" eyebrow="GENERATION · SUBSTATIONS · FEEDERS · DISTRICTS" onClose={onClose} wide>
      <section className="stage-card">
        <p className="eyebrow amber">STAGE {c.stage} OF 5</p>
        <h2>{c.name}</h2>
        {c.nextStage ? (
          <>
            <p className="fine">Next: <b>{c.nextStage.name}</b>. {c.nextStage.unlocks}{c.nextStage.rewardCc ? ` City Council grant: ${fmtCredits(c.nextStage.rewardCc)}.` : ''}</p>
            <ul className="stage-reqs">
              {c.requirements.map((r) => (
                <li key={r.label} className={r.have >= r.need ? 'done' : ''}>
                  <span>{r.have >= r.need ? '✓' : '○'} {r.label}</span>
                  <span className="goal-bar"><i style={{ width: `${Math.min(100, (r.have / Math.max(1, r.need)) * 100)}%` }} /></span>
                  <small>{fmtNeed(r, r.have)} / {fmtNeed(r, r.need)}</small>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="fine">You run the whole city's grid. Keep it lit, keep your streak, and trade on the Exchange.</p>
        )}
      </section>
      <p className="fine">Power flows from your plants ({fmtKw(plantsW)} installed) through a substation and feeder into each district. A feeder can only carry so much; longer feeders lose more energy, so you burn more diesel per kWh sold there.</p>
      <div className="grid-districts">
        {s.districts.map((d) => {
          const locked = !d.unlocked
          const stageOk = c.stage >= d.requiredStage
          const pct = d.feederCapacityW ? Math.min(100, (d.feederLoadW / d.feederCapacityW) * 100) : 0
          return (
            <article key={d.districtId} className={`district-card ${d.unlocked ? 'open' : ''}`}>
              <div className="section-heading">
                <h3>{d.unlocked ? '⚡' : stageOk ? '○' : '🔒'} {d.name}</h3>
                {d.unlocked ? <span className="pill teal">SUBSTATION L{d.substationLevel}</span> : <span className="pill muted">STAGE {d.requiredStage}</span>}
              </div>
              <p className="fine">{d.businessIds.map((id) => bizName(s, id)).join(' · ')}</p>
              <p className="fine">Peak demand {fmtKw(d.totalDemandW)} · line loss {(d.lossBps / 100).toFixed(1)}% · {d.payBehaviour === 'fixed_low' ? 'fixed tariff' : d.payBehaviour === 'price_sensitive' ? 'price-sensitive' : d.payBehaviour === 'low' ? 'tight budgets' : 'haggles'}</p>
              {d.unlocked ? (
                <>
                  <div className="feeder">
                    <span>Feeder {fmtKw(d.feederLoadW)} / {fmtKw(d.feederCapacityW)}</span>
                    <span className={`feeder-bar ${pct > 85 ? 'hot' : ''}`}><i style={{ width: `${pct}%` }} /></span>
                  </div>
                  <p className="fine">Reliability this shift {fmtPct(d.reliabilityTodayBps)} · {fmtPct(d.poweredBps)} of businesses lit</p>
                  {d.nextUpgradeCostCc !== null && d.nextCapacityW !== null ? (
                    <button className="button" disabled={s.player.creditsCc < d.nextUpgradeCostCc || g.pending.has(`sub:${d.districtId}`)} onClick={() => void g.act({ type: 'UPGRADE_SUBSTATION', districtId: d.districtId }, `sub:${d.districtId}`)}>
                      Upgrade to {fmtKw(d.nextCapacityW)} · {fmtCredits(d.nextUpgradeCostCc)}
                    </button>
                  ) : (
                    <p className="fine">Substation at full size.</p>
                  )}
                </>
              ) : (
                <button className="button primary" disabled={!stageOk || s.player.creditsCc < d.unlockCostCc || g.pending.has(`unlock:${d.districtId}`)} onClick={() => void g.act({ type: 'UNLOCK_DISTRICT', districtId: d.districtId }, `unlock:${d.districtId}`)}>
                  {!stageOk ? `Opens at stage ${d.requiredStage}` : s.player.creditsCc < d.unlockCostCc ? `Need ${fmtCredits(d.unlockCostCc)}` : `Build substation & connect · ${fmtCredits(d.unlockCostCc)}`}
                </button>
              )}
            </article>
          )
        })}
      </div>
    </Drawer>
  )
}

// ------------------------------------------------------------------ business
export function BusinessPanel({ g, onClose }: { g: Game; onClose: () => void }) {
  const s = g.state!
  const last = s.dayReports[s.dayReports.length - 1]
  const unlocked = new Set(s.districts.filter((d) => d.unlocked).map((d) => d.districtId))
  return (
    <Drawer title="Your power company" eyebrow="CUSTOMERS · BOOKS · RIVAL" onClose={onClose} wide>
      {last ? (
        <div className="report-grid">
          <Metric label="Last shift's revenue" value={fmtCredits(last.revenueCc)} />
          <Metric label="Fuel burned" value={fmtLitres(last.fuelBurnedMl)} />
          <Metric label="CO₂" value={fmtKg(last.co2Mg)} />
          <Metric label="Reliability" value={fmtPct(last.reliabilityBps)} />
          <Metric label="Net cash" value={fmtCredits(last.netCashChangeCc)} />
          <Metric label="City GDP" value={fmtCredits(last.gdpCc)} />
        </div>
      ) : (
        <p className="fine">Your first shift report appears when this shift (24 game hours) settles.</p>
      )}
      {last?.highlights.length ? <ul className="highlights">{last.highlights.map((h) => <li key={h.eventSeq}>{h.text}</li>)}</ul> : null}
      <table className="biz-table">
        <thead><tr><th>Business</th><th>Power source</th><th>Cash</th><th>Loyalty</th><th>Break-even</th><th>Status</th></tr></thead>
        <tbody>
          {s.businesses.filter((b) => unlocked.has(b.districtId)).map((b) => (
            <tr key={b.businessId}>
              <td>{MOOD_ICON[b.mood]} {b.name}</td>
              <td className={b.powerSource === 'none' ? 'neg' : ''}>{b.powerSource === 'player' ? 'You' : b.powerSource === 'rival' ? 'VoltLine' : b.powerSource === 'grid' ? 'Grid' : 'Dark'}{b.provider === 'rival' ? ' ⚠' : ''}</td>
              <td>{fmtCredits(b.cashCc)}</td>
              <td>{Math.round(b.loyaltyBps / 100)}%</td>
              <td>{fmtRate(b.breakEvenRateCcPerKwh)}</td>
              <td>{b.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <section className="rival-box">
        <p className="eyebrow">RIVAL · {s.rival.name}</p>
        <p><b>{fmtRate(s.rival.tariffCcPerKwh)}</b> · {fmtKw(s.rival.assignedW)} of {fmtKw(s.rival.ratedW)} used · fuel {fmtLitres(s.rival.fuelMl)} · cash {fmtCredits(s.rival.cashCc)} · won {s.rival.contractsWon}, passed {s.rival.contractsDeclined}</p>
        <p className="fine">{s.rival.tariffReasons.explanation}</p>
        <p className="fine">Last move: {s.rival.lastAction}</p>
      </section>
      <section>
        <p className="eyebrow">CITY NEWS</p>
        <ul className="news">
          {g.events.slice().reverse().slice(0, 25).map((e) => (
            <li key={e.seq}><span>{e.clock}</span> {e.explanation}</li>
          ))}
        </ul>
      </section>
    </Drawer>
  )
}

const Metric = ({ label, value }: { label: string; value: string }) => (
  <div className="metric-card"><small>{label}</small><b>{value}</b></div>
)

// ------------------------------------------------------------------ profile & settings
export function ProfilePanel({ g, onClose, prefs, setPrefs }: { g: Game; onClose: () => void; prefs: { sound: boolean; music: boolean; reducedMotion: boolean }; setPrefs: (p: { sound: boolean; music: boolean; reducedMotion: boolean }) => void }) {
  const p = g.player!
  const [name, setName] = useState(p.displayName)
  const [msg, setMsg] = useState<string | null>(null)
  const cfg = g.config!
  return (
    <Drawer title={p.displayName} eyebrow={p.kind === 'guest' ? 'GUEST OPERATOR' : `SIGNED IN · ${p.loginMethod.toUpperCase()}`} onClose={onClose}>
      <p className="fine">Your city saves automatically on the server after every action and every few seconds of play. {cfg.offlinePolicy}</p>
      <label className="field">
        <span>Display name</span>
        <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
      </label>
      <button className="button mini" disabled={name.trim() === p.displayName || name.trim().length < 2} onClick={async () => { try { await api.rename(name.trim()); await g.refreshPlayer(); setMsg('Saved.') } catch (e) { setMsg(explainError(e)) } }}>Save name</button>
      {p.kind === 'guest' && (
        <section className="upgrade-account">
          <p className="eyebrow amber">KEEP THIS CITY</p>
          <p className="fine">Sign in to play this city on any device. Your guest progress moves to the new account automatically; an account that already has a city is never overwritten.</p>
          {cfg.auth.google || cfg.auth.email ? <SignInOptions g={g} compact onSignedIn={onClose} /> : <p className="fine">Accounts aren't available on this server yet; your city is saved on this device.</p>}
        </section>
      )}
      {msg && <p className="ok-line">{msg}</p>}
      <div className="settings-list">
        <label className="setting-toggle"><span><b>Sound</b><small>Cues for new calls, restored power, payments, Code Reds and failures.</small></span><input type="checkbox" checked={prefs.sound} onChange={(e) => setPrefs({ ...prefs, sound: e.target.checked })} /><i aria-hidden /></label>
        <label className="setting-toggle"><span><b>Music</b><small>"Night Shift": a quiet generated synthwave loop.</small></span><input type="checkbox" checked={prefs.music} onChange={(e) => setPrefs({ ...prefs, music: e.target.checked })} /><i aria-hidden /></label>
        <label className="setting-toggle"><span><b>Reduced motion</b><small>Stops pulses, smoke and drifting.</small></span><input type="checkbox" checked={prefs.reducedMotion} onChange={(e) => setPrefs({ ...prefs, reducedMotion: e.target.checked })} /><i aria-hidden /></label>
      </div>
      <div className="profile-actions">
        <button className="button" onClick={() => { if (window.confirm('Start a new city? Your current city stays in history, but you will not return to it.')) void g.enterGame(true).then(onClose) }}>Start a new city</button>
        <button className="button" onClick={() => void g.logout()}>Log out</button>
      </div>
    </Drawer>
  )
}

export function HelpPanel({ onClose }: { onClose: () => void }) {
  return (
    <Drawer title="How to play" eyebrow="YOU ARE THE POWER COMPANY" onClose={onClose}>
      <p className="fine">You own a diesel generator in a town where the grid keeps failing. Shops pay you to keep their lights on. VoltLine, a rival power company, wants the same customers. Fuel costs money and its price moves. Your job: keep the town lit and finish each day richer.</p>
      <p className="eyebrow amber">EVERY 30 SECONDS</p>
      <ol className="how-to">
        <li><b>A shop loses power.</b><span>Its call shows what it needs, what it pays, and your margin after diesel and carbon costs.</span></li>
        <li><b>Take the deal, or haggle.</b><span>Accept, counter up to twice, or decline. Wait too long and VoltLine takes the customer. 🚨 Code Red calls pay double but give you 7 seconds.</span></li>
        <li><b>Plug it in.</b><span>Tap a glowing generator. Power flows, the shop lights up, and you're paid for every kWh delivered.</span></li>
      </ol>
      <p className="eyebrow amber">EVERY FEW MINUTES</p>
      <ol className="how-to">
        <li><b>Keep diesel in the tank.</b><span>Market: three merchants price from their own stock, demand and real 2026 oil. Buy before a squeeze.</span></li>
        <li><b>Trade with other cities.</b><span>Exchange: sell spare fuel to other players and traders at your price, or buy when the board is cheaper than your town. Sales land even while you're away.</span></li>
        <li><b>Grow.</b><span>Equipment and Expand: solar, batteries, a second generator, new districts with bigger customers.</span></li>
      </ol>
      <p className="eyebrow amber">EVERY SHIFT (4 MINUTES)</p>
      <ol className="how-to">
        <li><b>Three goals.</b><span>Finish all three for City Council rewards and a streak worth up to +50%.</span></li>
        <li><b>A world that moves.</b><span>Oil follows real 2026 Brent prices; storms and supply shocks hit every merchant and trader on their own.</span></li>
      </ol>
      <p className="fine">The bar at the bottom of the map always says your next move. Your city pauses when you leave; your Exchange offers keep selling.</p>
    </Drawer>
  )
}

export function Inspector({ s, id, onClose }: { s: GameStatePublic; id: string; onClose: () => void }) {
  const b = s.businesses.find((x) => x.businessId === id)
  const gen = s.generators.find((x) => x.generatorId === id)
  if (!b && !gen) return null
  return (
    <aside className="inspector" aria-label="Details">
      <button aria-label="Close details" onClick={onClose}>×</button>
      {b ? (
        <>
          <p className="eyebrow">{b.status.toUpperCase()} · {b.kind.replace('_', ' ')}</p>
          <h2>{MOOD_ICON[b.mood]} {b.name}</h2>
          {(VOICES[b.businessId] ?? b.owner) && <p className="voice"><span aria-hidden>{(VOICES[b.businessId] ?? b.owner)!.face}</span> <b>{(VOICES[b.businessId] ?? b.owner)!.name}:</b> “{voiceLine(b)}”</p>}
          {b.owner && <p className="fine">{b.owner.name} {b.owner.trait}.</p>}
          <dl>
            <dt>Needs</dt><dd>{fmtKw(b.demandW)}</dd>
            <dt>Power</dt><dd>{b.powerSource === 'none' ? 'DARK' : b.powerSource}</dd>
            <dt>Cash</dt><dd>{fmtCredits(b.cashCc)}</dd>
            <dt>Earns</dt><dd>{fmtCredits(b.revenueCcPerPoweredHour)}/h powered</dd>
            <dt>Costs</dt><dd>{fmtCredits(b.variableCostCcPerPoweredHour)}/h + {fmtCredits(b.fixedCostCcPerDay)}/day rent</dd>
            <dt>Break-even</dt><dd>{fmtRate(b.breakEvenRateCcPerKwh)}</dd>
            <dt>Loyalty</dt><dd>{Math.round(b.loyaltyBps / 100)}%{b.provider === 'rival' ? ' (buys from VoltLine)' : ''}</dd>
          </dl>
        </>
      ) : (
        <>
          <p className="eyebrow">{gen!.type.toUpperCase()} · {gen!.status}</p>
          <h2>⚡ {gen!.name}</h2>
          <dl>
            <dt>Output</dt><dd>{fmtKw(gen!.outputW)} of {fmtKw(gen!.ratedW)}</dd>
            <dt>Reserved</dt><dd>{fmtKw(gen!.assignedW)}</dd>
            <dt>Lifetime</dt><dd>{fmtKwh(gen!.cumulativeWh)} · {fmtLitres(gen!.cumulativeFuelMl)}</dd>
            <dt>Heat / wear</dt><dd>{Math.round(gen!.heatPermille / 10)}% / {Math.round(gen!.wearBps / 100)}%</dd>
          </dl>
        </>
      )}
    </aside>
  )
}
