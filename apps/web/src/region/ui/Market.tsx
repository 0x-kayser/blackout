/**
 * Vesper Market on screen: every merchant's finances, stock and prices, why each price is what it is, every trade as it
 * happens, and a week of trading you can watch in a minute. Nothing here happens out of sight.
 */
import { useEffect, useRef, useState } from 'react'
import type { FastForwardResult, InvestQuote, ItemId, MerchantItemView, MerchantView, PriceWhy, RegionView, TownView, TradeQuote } from '@blackout/shared'
import { CompaniesSection } from './Companies'
import { PlantSales } from './PlantSales'
import { ITEMS, ITEM_IDS } from '@blackout/shared'
import { regionApi, type DeskView, type ResourceSale } from '../api'
import { credits } from '../format'
import { Bar, Section, Spark, Stat } from './Bits'

export type Trade = (merchantId: string, item: ItemId, side: 'buy' | 'sell', qty: number) => Promise<{ ok: boolean; message: string }>
export type Invest = (merchantId: string, amountCc: number) => Promise<{ ok: boolean; message: string }>

const unitPrice = (cc: number) => `₡${(cc / 100).toLocaleString('en-US', { maximumFractionDigits: cc < 10_000 ? 2 : 0 })}`
const LOTS: Record<ItemId, number[]> = {
  'fuel:natural-gas': [1_000, 5_000],
  'fuel:diesel': [5_000, 20_000],
  'permit:carbon': [20, 100],
  'certificate:renewable': [25, 100],
  'material:steel': [50, 200],
  'part:turbine': [1, 4],
}
const RESERVE_SHOP: Partial<Record<ItemId, string>> = { 'fuel:natural-gas': 'bayo', 'fuel:diesel': 'dayo', 'permit:carbon': 'ruth', 'material:steel': 'pavel', 'part:turbine': 'nkechi' }
const RESERVE_DECISION: Partial<Record<ItemId, string>> = {
  'fuel:natural-gas': 'Store fuel before a shortage, or prepare generation that does not depend on gas.',
  'fuel:diesel': 'Decide whether to hold diesel or keep solar, batteries and other units ready.',
  'permit:carbon': 'Thermal plants face tighter allowance supply. Preserve permits or price emissions into your offers.',
  'material:steel': 'Prioritize your next plant build or corridor upgrade while steel is available.',
  'part:turbine': 'Repair kits are scarce. Keep cash ready or plan around longer plant downtime.',
}

export function held(v: RegionView, item: ItemId): number {
  const p = v.player
  return { 'fuel:natural-gas': p.gas, 'fuel:diesel': p.diesel, 'permit:carbon': p.permitsT, 'certificate:renewable': p.certificates, 'material:steel': p.steelT, 'part:turbine': p.parts }[item]
}

/** The merchant's reasoning: hover on a computer, tap on a phone (the brief's "reasoning in a tooltip"). */
export function WhyPrice({ why, children }: { why: PriceWhy; children: React.ReactNode }) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const ref = useRef<HTMLButtonElement>(null)
  // the tip floats above every panel (fixed), placed under the price, or over it near the bottom of the screen
  const show = () => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const w = Math.min(300, window.innerWidth - 16)
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))
    const below = r.bottom + 230 < window.innerHeight
    setAt({ top: below ? r.bottom + 6 : Math.max(8, r.top - 236), left })
  }
  const open = at !== null
  return (
    <span className={`why-price ${open ? 'open' : ''}`} onMouseEnter={show} onMouseLeave={() => setAt(null)}>
      <button ref={ref} className="why-trigger" onClick={() => (open ? setAt(null) : show())} aria-expanded={open} aria-label="Why this price?">
        {children}
        <i>?</i>
      </button>
      {open && (
        <span className="why-tip" role="tooltip" style={{ position: 'fixed', top: at.top, left: at.left, right: 'auto' }}>
          <b>{why.summary}</b>
          {why.lines.map((l) => (
            <span key={l.label} className="why-line">
              <span>{l.label}</span>
              <em>{l.factor}</em>
            </span>
          ))}
        </span>
      )}
    </span>
  )
}

const trend = (it: MerchantItemView) => (it.askCc && it.askAnHourAgoCc ? (it.askCc > it.askAnHourAgoCc * 1.02 ? '▲' : it.askCc < it.askAnHourAgoCc * 0.98 ? '▼' : '') : '')

const ROUTINES: Record<string, { morning: string; afternoon: string; night: string }> = {
  ingrid: {
    morning: 'Checking Cape-route LNG tanker manifests at the harbour jetty',
    afternoon: 'Reviewing cryogenic boil-off gauges with the port tug crews',
    night: 'Grabbing roasted plantain by the berth while night barges unload',
  },
  bayo: {
    morning: 'Sipping hot zobo at the Northline pressure manifold desk',
    afternoon: 'Watching pipeline pack levels and rationing industrial off-takes',
    night: 'Walking the valve station under floodlights to check for pressure drops',
  },
  kettle: {
    morning: 'Rolling 200-litre diesel drums under the corrugated yard awning',
    afternoon: 'Haggling with danfo drivers and neighbourhood generator mechanics',
    night: 'Counting cash notes by rechargeable lantern in the back shed',
  },
  dayo: {
    morning: 'Dispatching Swift road tankers past port traffic before the rush',
    afternoon: 'Waving coastal product barges into the creek jetty to undercut rivals',
    night: 'Topping up night-shift peaker trucks from the fast-fill gantry',
  },
  chioma: {
    morning: 'Auditing diesel dip-stick readings in her fan-cooled depot office',
    afternoon: 'Holding reserve tanks tight while watching spot power prices climb',
    night: 'Locking the main depot gate and quoting premium night-surge rates',
  },
  lena: {
    morning: 'Verifying North Belt solar meter receipts over morning coffee',
    afternoon: 'Matching COP31 corporate buyers with clean-energy certificates',
    night: 'Closing the Greenline ledger while solar farms wait for sunrise',
  },
  ruth: {
    morning: 'Clearing COP31 carbon allowance lots at the Regulator counter',
    afternoon: 'Advising thermal plant operators on avoiding the +25% unpermitted penalty',
    night: 'Reconciling daily emissions surrenders before the midnight audit',
  },
  pavel: {
    morning: 'Unloading fresh structural steel coils from his sister Marta’s mill',
    afternoon: 'Loading crane girders onto flatbeds for substation and plant builds',
    night: 'Checking Industrial South power prices to see if the night pour ran',
  },
  nkechi: {
    morning: 'Rewinding burned alternator coils on the Sparks & Sons workbench',
    afternoon: 'Crating emergency turbine repair kits for tripped peakers',
    night: 'Keeping the night-call repair van fuelled and ready for grid faults',
  },
}

function daysOfCashFor(m: MerchantView) {
  return m.fixedCcPerDay > 0 ? m.cashCc / m.fixedCcPerDay : 9
}

export function merchantLife(m: MerchantView, clock: string) {
  const hourMatch = clock.match(/(\d{1,2}):\d{2}/)
  const hour = hourMatch ? Number(hourMatch[1]) : 12
  const slot = hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 19 ? 'afternoon' : 'night'
  const routine = ROUTINES[m.merchantId]?.[slot] ?? 'Tending the stall in Vesper Market'
  const daysOfCash = m.fixedCcPerDay > 0 ? m.cashCc / m.fixedCcPerDay : 9
  const mainItem = m.items[0]
  if (!mainItem && m.open) {
    return { moodBadge: '🔵 Steady', moodTone: 'info', cashWorry: `${daysOfCashFor(m).toFixed(1)} days of daily costs in the bank`, routine, voiceLine: 'Quiet day at the stall.' }
  }
  const stockRatio = mainItem && mainItem.target > 0 ? mainItem.stock / mainItem.target : 1

  if (!m.open) {
    return {
      moodBadge: '🔴 Shuttered',
      moodTone: 'crisis',
      cashWorry: `Out of working capital (needs ${credits(m.reopenCc)} to reopen)`,
      routine: 'Padlock on the stall gate; waiting for an investor rescue',
      voiceLine: `Working cash fell below daily overhead (${credits(m.fixedCcPerDay)}/day). Back the stall and we split the profits.`,
    }
  }
  if (daysOfCash < 1.6 || m.profitCcToday < -m.fixedCcPerDay * 0.4) {
    return {
      moodBadge: '🟠 Cash-worried',
      moodTone: 'warn',
      cashWorry: `Tight buffer: ${daysOfCash.toFixed(1)} days of overhead (${credits(m.fixedCcPerDay)}/day)`,
      routine: `${routine} (cutting hours to save cash)`,
      voiceLine: `Daily overhead is ${credits(m.fixedCcPerDay)} and cash is down to ${credits(m.cashCc)}. I’m pricing to protect the till today.`,
    }
  }
  if (stockRatio < 0.45) {
    return {
      moodBadge: '🟡 Stock tight',
      moodTone: 'warn',
      cashWorry: `Healthy cash (${daysOfCash.toFixed(1)} days), but inventory is at ${Math.round(stockRatio * 100)}% of target`,
      routine,
      voiceLine: `Shelves are down to ${mainItem.stock.toLocaleString('en-US')} ${ITEMS[mainItem.item].units} and deliveries running thin, so prices reflect the shortage.`,
    }
  }
  if (m.profitCcToday > 0 && daysOfCash >= 2.5) {
    return {
      moodBadge: '🟢 Thriving',
      moodTone: 'ok',
      cashWorry: `Comfortable reserve: ${daysOfCash.toFixed(1)} days of overhead covered`,
      routine,
      voiceLine: `Up ${credits(m.profitCcToday)} today with ${mainItem.stock.toLocaleString('en-US')} ${ITEMS[mainItem.item].units} in stock. Ready for bulk orders.`,
    }
  }
  return {
    moodBadge: '🔵 Steady',
    moodTone: 'info',
    cashWorry: `${daysOfCash.toFixed(1)} days of daily costs (${credits(m.fixedCcPerDay)}/day) in the bank`,
    routine,
    voiceLine: `Steady trade today. Holding ${mainItem.stock.toLocaleString('en-US')} ${ITEMS[mainItem.item].units} against a target of ${mainItem.target.toLocaleString('en-US')}.`,
  }
}

export function Inventory({ v }: { v: RegionView }) {
  return (
    <div className="inventory">
      {ITEM_IDS.map((item) => (
        <span key={item} className="inv-item" title={ITEMS[item].blurb}>
          <span aria-hidden>{ITEMS[item].icon}</span>
          <b>{held(v, item).toLocaleString('en-US')}</b>
          <small>{ITEMS[item].units}</small>
        </span>
      ))}
    </div>
  )
}

function useBusy() {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  return {
    busy,
    msg,
    run: async (p: Promise<{ ok: boolean; message: string }>) => {
      setBusy(true)
      try {
        const r = await p
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

/** One item at one merchant: stock, prices with reasons, buy and sell buttons. */
function ItemRow({ m, it, v, trade, busy, run }: { m: MerchantView; it: MerchantItemView; v: RegionView; trade: Trade; busy: boolean; run: (p: Promise<{ ok: boolean; message: string }>) => Promise<boolean> }) {
  const mine = held(v, it.item)
  const lots = LOTS[it.item]
  const [quantity, setQuantity] = useState(lots[0] ?? 1)
  const [quote, setQuote] = useState<TradeQuote | null>(null)
  const [side, setSide] = useState<'buy' | 'sell' | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const review = async (nextSide: 'buy' | 'sell', qty = quantity) => {
    setQuoting(true)
    setQuoteError(null)
    setQuote(null)
    setSide(nextSide)
    try {
      const result = await regionApi.tradeQuote(m.merchantId, it.item, nextSide, Math.max(1, Math.floor(qty)))
      setQuote(result.quote)
      setQuantity(Math.max(1, Math.floor(qty)))
    } catch (e) {
      setQuoteError((e as Error).message)
    } finally {
      setQuoting(false)
    }
  }
  const confirm = async () => {
    if (!side || !quote?.canTrade) return
    if (await run(trade(m.merchantId, it.item, side, quote.quantity))) {
      setQuote(null)
      setSide(null)
    }
  }
  return (
    <div className="item-row">
      <div className="item-head">
        <span>
          {ITEMS[it.item].icon} <b>{ITEMS[it.item].name}</b>
        </span>
        <span className="prices">
          {it.askCc !== null && (
            <WhyPrice why={it.why}>
              sells {unitPrice(it.askCc)}
              <small>/{ITEMS[it.item].unit}</small> {trend(it)}
            </WhyPrice>
          )}
          {it.bidCc !== null && <span className="bid-price">buys {unitPrice(it.bidCc)}</span>}
        </span>
      </div>
      <Bar value={it.stock} max={it.target * 2} tone={it.stock < it.target * 0.3 ? 'crisis' : it.stock > it.target * 1.6 ? 'blue' : 'teal'} label="stock" />
      <small className="fine">
        Stock {it.stock.toLocaleString('en-US')} {ITEMS[it.item].units} · target {it.target.toLocaleString('en-US')} · you hold {mine.toLocaleString('en-US')}
      </small>
      {it.history.length > 2 && <Spark values={it.history} height={22} tone="amber" />}
      <div className="trade-controls">
        <label className="trade-quantity">
          Quantity ({ITEMS[it.item].units})
          <input type="number" min={1} max={10_000_000} step={1} value={quantity} onChange={(e) => { setQuantity(Math.max(1, Math.floor(Number(e.target.value) || 1))); setQuote(null); setSide(null) }} />
        </label>
        <div className="row">
          {it.askCc !== null && <button className="btn small" disabled={busy || quoting || !m.open} onClick={() => void review('buy')}>{quoting && side === 'buy' ? 'Pricing…' : 'Review buy'}</button>}
          {it.bidCc !== null && mine > 0 && <button className="btn small" disabled={busy || quoting || !m.open} onClick={() => void review('sell')}>{quoting && side === 'sell' ? 'Pricing…' : 'Review sale'}</button>}
          {it.bidCc !== null && mine > 0 && <button className="btn ghost small" disabled={busy || quoting || !m.open} onClick={() => void review('sell', mine)}>Sell all</button>}
        </div>
      </div>
      {quoteError && <p className="warn-line">{quoteError}</p>}
      {quote && side && (
        <div className="trade-ticket" aria-live="polite">
          <b>Review {side === 'buy' ? 'purchase' : 'sale'}</b>
          <p>{quote.quantity.toLocaleString('en-US')} {ITEMS[it.item].units} at an estimated average of {unitPrice(quote.unitCc)} per {ITEMS[it.item].unit} · {side === 'buy' ? 'total' : 'proceeds'} {credits(quote.totalCc)}</p>
          <div className="trade-ticket-stats">
            <span>Current quote <b>{unitPrice(quote.currentUnitCc)}/{ITEMS[it.item].unit}</b></span>
            <span>Cash after <b>{quote.cashAfterCc >= 0 ? credits(quote.cashAfterCc) : `short ${credits(-quote.cashAfterCc)}`}</b></span>
            <span>Inventory after <b>{quote.heldAfter.toLocaleString('en-US')} {ITEMS[it.item].units}</b></span>
            <span>Separate fee <b>None</b></span>
          </div>
          <small className="fine">The merchant spread is reflected in its buy and sell prices. The final amount is checked again when you confirm.</small>
          {quote.reason && <p className="warn-line">{quote.reason}</p>}
          <div className="row">
            <button className="btn primary small" disabled={busy || quoting || !quote.canTrade} onClick={() => void confirm()}>{quote.canTrade ? `Confirm ${side}` : 'Order unavailable'}</button>
            <button className="btn ghost small" disabled={busy} onClick={() => { setQuote(null); setSide(null) }}>Change order</button>
          </div>
        </div>
      )}
    </div>
  )
}

export function MerchantInspector({ m, v, town, trade, invest }: { m: MerchantView; v: RegionView; town: TownView; trade: Trade; invest: Invest }) {
  const { busy, msg, run } = useBusy()
  const mine = m.investors.find((x) => x.mine)
  const recent = town.trades.filter((t) => t.merchantId === m.merchantId).slice(-6).reverse()
  const [investment, setInvestment] = useState<InvestQuote | null>(null)
  const [investmentAmount, setInvestmentAmount] = useState<number | null>(null)
  const [investmentBusy, setInvestmentBusy] = useState(false)
  const [investmentError, setInvestmentError] = useState<string | null>(null)
  const reviewInvestment = async (amountCc: number) => {
    setInvestmentAmount(amountCc)
    setInvestment(null)
    setInvestmentError(null)
    setInvestmentBusy(true)
    try {
      const r = await regionApi.investQuote(m.merchantId, amountCc)
      setInvestment(r.quote)
    } catch (e) {
      setInvestmentError((e as Error).message || 'Could not price the investment. Try again.')
    } finally {
      setInvestmentBusy(false)
    }
  }
  return (
    <>
      <p className="eyebrow">Vesper Market</p>
      <h3>
        {m.face} {m.name}
      </h3>
      <p className="fine">
        {m.person}. {m.personality}
      </p>
      <p className={`state-pill ${m.open ? 'ok' : 'crisis'}`}>{m.open ? 'open' : 'closed'}</p>
      {!m.open && <p className="warn-line">{m.closedReason}. Nobody can trade here until someone invests {credits(m.reopenCc)}.</p>}
      {(() => {
        const life = merchantLife(m, town.clock)
        return (
          <Section title="Mood & daily routine" aside={<span className={`pill ${life.moodTone}`}>{life.moodBadge}</span>}>
            <p className="fine" style={{ margin: '0 0 4px' }}>
              <b>Now:</b> {life.routine}.
            </p>
            <p className="fine" style={{ margin: '0 0 6px' }}>
              <b>Cash worry:</b> {life.cashWorry}.
            </p>
            <blockquote className="quote" style={{ margin: 0 }}>
              {m.face} “{life.voiceLine}”
            </blockquote>
          </Section>
        )
      })()}
      <Section title="Business finances">
        <Stat label="Cash" value={credits(m.cashCc)} tone={m.cashCc < m.fixedCcPerDay ? 'crisis' : undefined} />
        <Stat label="Costs a day" value={credits(m.fixedCcPerDay)} />
        <Stat label="Since the day began" value={credits(m.profitCcToday)} tone={m.profitCcToday >= 0 ? 'ok' : 'crisis'} />
      </Section>
      <Section title="Trade">
        {m.items.map((it) => (
          <ItemRow key={it.item} m={m} it={it} v={v} trade={trade} busy={busy} run={run} />
        ))}
      </Section>
      <Section title="Invest">
        <p className="fine">
          {m.open ? 'Put cash into the shop for a share of its daily profits.' : `Reopen it with at least ${credits(m.reopenCc)} and earn a share of every day's profits.`}
          {mine ? ` You own ${(mine.shareBps / 100).toFixed(1)}%.` : ''}
        </p>
        <div className="row">
          {(m.open ? [500_000, 2_000_000] : [m.reopenCc, m.reopenCc * 2]).map((amt) => (
            <button key={amt} className={`btn small ${m.open ? '' : 'primary'}`} disabled={busy || investmentBusy} onClick={() => void reviewInvestment(amt)}>
              {m.open ? `Review ${credits(amt)}` : `Review reopen · ${credits(amt)}`}
            </button>
          ))}
        </div>
        {investmentBusy && <p className="fine">Calculating current ownership share…</p>}
        {investmentError && <p className="warn-line">{investmentError}</p>}
        {investment && investmentAmount !== null && (
          <div className="trade-ticket" aria-live="polite">
            <b>Review shop investment</b>
            <div className="trade-ticket-stats">
              <span>Investment <b>{credits(investment.amountCc)}</b></span>
              <span>Cash after <b>{credits(investment.cashAfterCc)}</b></span>
              <span>Estimated profit share <b>{(investment.shareBps / 100).toFixed(1)}%</b></span>
              <span>Separate fee <b>None</b></span>
            </div>
            <small className="fine">This is a share of future simulated shop profits, not a guaranteed return. Credits are fictional game money. The estimate is checked again when you confirm.</small>
            {investment.reason && <p className="warn-line">{investment.reason}</p>}
            <div className="row">
              <button className="btn primary small" disabled={busy || !investment.canInvest} onClick={async () => { if (await run(invest(m.merchantId, investment.amountCc))) { setInvestment(null); setInvestmentAmount(null) } }}>
                {investment.reopens ? 'Confirm reopen' : 'Confirm investment'} · {credits(investment.amountCc)}
              </button>
              <button className="btn ghost small" disabled={busy} onClick={() => { setInvestment(null); setInvestmentAmount(null) }}>Cancel</button>
            </div>
          </div>
        )}
        {m.investors.length > 0 && (
          <ul className="investors">
            {m.investors.map((x) => (
              <li key={x.playerId} className={x.mine ? 'gold' : ''}>
                {x.mine ? 'You' : x.name}: {credits(x.investedCc)} · {(x.shareBps / 100).toFixed(1)}%
              </li>
            ))}
          </ul>
        )}
      </Section>
      {msg && <p className={msg.ok ? 'ok-line' : 'warn-line'}>{msg.text}</p>}
      <Section title="Latest trades here">
        {recent.length === 0 && <p className="fine">No player trades yet.</p>}
        {recent.map((t) => (
          <p key={t.seq} className="fine">
            <b className={t.whoKind === 'you' ? 'gold' : ''}>{t.label}</b> {t.side === 'buy' ? 'bought' : 'sold'} {t.quantity.toLocaleString('en-US')} {ITEMS[t.item].units} at {unitPrice(t.priceCc)}
          </p>
        ))}
      </Section>
    </>
  )
}

/** The price of the story's main item now, and how far it has moved since the story broke. */
function storyMove(town: TownView, n: NonNullable<TownView['news']>[number]) {
  const m = town.merchants.find((x) => x.merchantId === n.merchantIds[0])
  const it = m?.items.find((i) => n.items.includes(i.item))
  if (!m || !it) return null
  const now = it.askCc ?? it.bidCc
  const h = it.history
  const at = h.length - 1 - Math.ceil(n.ageTicks / 12)
  const then = at >= 0 ? h[at] : h[0]
  const pctMove = now && then ? Math.round(((now - then) / then) * 100) : 0
  return { m, it, now, pctMove }
}

/** A slim strip of the stories moving Vesper Market right now. Tap one to open the merchant it hits. */
export function NewsTicker({ town, onMerchant }: { town: TownView | null; onMerchant: (id: string) => void }) {
  const news = town?.news ?? []
  if (!town || !news.length) return null
  return (
    <div className="news-ticker" aria-label="Market news">
      {news.map((n) => {
        const mv = storyMove(town, n)
        return (
          <button key={n.seq} className={`news-item ${n.tone}`} onClick={() => mv && onMerchant(mv.m.merchantId)} title={`${n.detail} (${n.effects.join('; ')})`}>
            <span className="news-tag">{n.tone === 'good' ? 'GOOD NEWS' : 'BREAKING'}</span>
            <span className="news-head">{n.headline}</span>
            {mv?.now != null && (
              <span className={`news-move ${mv.pctMove > 0 ? 'up' : mv.pctMove < 0 ? 'down' : ''}`}>
                {ITEMS[mv.it.item].icon} {credits(mv.now)} {mv.pctMove > 0 ? `▲${mv.pctMove}%` : mv.pctMove < 0 ? `▼${-mv.pctMove}%` : ''}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export function MarketSheet({ v, town, trade, onMerchant, onWatch, onAutoFuel, desk, onDesk }: { v: RegionView; town: TownView | null; trade: Trade; onMerchant: (id: string) => void; onWatch: (days: 7 | 365) => void; onAutoFuel: (fuel: 'gas' | 'diesel', on: boolean) => void; desk: DeskView | null; onDesk: (d: DeskView) => void }) {
  const { busy, msg, run } = useBusy()
  if (!town) return <p className="fine">Opening the market…</p>
  const strainedReserves = (town.reserves ?? []).filter((reserve) => reserve.total > 0 && reserve.remainingBps <= 2_500)
  const reserveAlerts = town.events.filter((event) => event.kind === 'resource').slice(-4).reverse()
  return (
    <>
      <h3>Vesper Market</h3>
      <p className="fine">
        {town.clock} · {town.players} {town.players === 1 ? 'company' : 'companies'} trading · prices move with each merchant’s stock and recent demand. Tap a stall to see the quote and price reasoning.
      </p>
      <Section title="Vesper’s fixed resource endowment">
        <p className="fine">The world’s gas, diesel, carbon permits, steel and turbine parts were set aside at genesis. Sealed deposits enter circulation on schedule; nothing is replenished from an unlimited importer.</p>
        <div className="reserve-grid">
          {(town.reserves ?? []).map((reserve) => (
            <div className="reserve-card" key={reserve.item}>
              <div className="reserve-head"><b>{ITEMS[reserve.item].icon} {ITEMS[reserve.item].name}</b><span>{reserve.total > 0 ? Math.round((reserve.remainingBps / 100)) : 0}% left</span></div>
              <Bar value={reserve.remaining} max={reserve.total} tone={reserve.remainingBps <= 2_500 ? 'crisis' : 'gold'} label={`${ITEMS[reserve.item].name} reserve remaining`} />
              <small className="fine">{reserve.remaining.toLocaleString('en-US')} of {reserve.total.toLocaleString('en-US')} {ITEMS[reserve.item].units} still in reserve</small>
              {reserve.nextReleaseDay !== null && <small className="fine">Next deposit: market day {reserve.nextReleaseDay} · {reserve.nextReleaseQuantity.toLocaleString('en-US')} already counted in the endowment</small>}
              {reserve.legacy && <small className="warn-line">This saved market predates the reserve ledger. Historical stock is carried forward; no new supply is added.</small>}
            </div>
          ))}
        </div>
        <div className="regional-reserve">
          <b>This grid’s local fuel allotment</b>
          <span>Natural gas {v.resourceReserve.gas.remaining.toLocaleString('en-US')} / {v.resourceReserve.gas.total.toLocaleString('en-US')} MMBtu · Diesel {v.resourceReserve.diesel.remaining.toLocaleString('en-US')} / {v.resourceReserve.diesel.total.toLocaleString('en-US')} L</span>
          <small className="fine">Local supplier refills draw from this saved grid’s fixed allocation. Your player-owned plants buy through the shared market above.</small>
        </div>
      </Section>
      {strainedReserves.length > 0 && (
        <Section title="Your next decision">
          {strainedReserves.map((reserve) => {
            const merchantId = RESERVE_SHOP[reserve.item]
            return (
              <div className="reserve-alert" key={reserve.item}>
                <div><b>{ITEMS[reserve.item].name} · {Math.round(reserve.remainingBps / 100)}% remains</b><p className="fine">{RESERVE_DECISION[reserve.item]}</p></div>
                {merchantId && <button className="btn small" onClick={() => onMerchant(merchantId)}>Review {town.merchants.find((m) => m.merchantId === merchantId)?.person.split(' ')[0]}'s quote</button>}
              </div>
            )
          })}
        </Section>
      )}
      <Section title="Choose a stall to trade">
        <p className="fine">Tap a merchant to review a quote, check your cash and confirm a buy or sale.</p>
        {town.merchants.map((m) => {
          const life = merchantLife(m, town.clock)
          return (
            <button key={m.merchantId} type="button" className={`merchant-card ${m.open ? '' : 'closed'}`} onClick={() => onMerchant(m.merchantId)}>
              <span className="mc-head">
                <span>
                  {m.face} <b>{m.person}</b> <small>{m.name}</small>
                </span>
                {!m.open ? <span className="pill-closed">CLOSED</span> : <small className="fine">{credits(m.cashCc)} · {life.moodBadge}</small>}
              </span>
              <small className="fine" style={{ display: 'block', textAlign: 'left', margin: '2px 0 4px', opacity: 0.88 }}>
                {life.routine} — “{life.voiceLine}”
              </small>
              {m.items.map((it) => (
                <span key={it.item} className="mc-item">
                  <span>
                    {ITEMS[it.item].icon} {ITEMS[it.item].name}
                  </span>
                  <span>
                    {it.askCc !== null && <span className="mc-ask">{unitPrice(it.askCc)} {trend(it)}</span>}
                    {it.bidCc !== null && <small className="bid-price"> buys {unitPrice(it.bidCc)}</small>}
                  </span>
                </span>
              ))}
              <span className="mc-action">{m.open ? 'Shop this stall →' : 'See why it closed →'}</span>
            </button>
          )
        })}
      </Section>
      <ResourceExchange v={v} town={town} />
      <Section title="What you hold">
        <Inventory v={v} />
        <div className="row">
          {(['gas', 'diesel'] as const).map((f) => (
            <label key={f} className="toggle">
              <input type="checkbox" checked={v.player.autoFuel[f]} onChange={(e) => onAutoFuel(f, e.target.checked)} /> Auto-buy {f} for running plants
            </label>
          ))}
        </div>
        {v.player.certificates > 0 && (
          <button className="btn primary small" disabled={busy} onClick={() => run(trade('lena', 'certificate:renewable', 'sell', v.player.certificates))}>
            Sell {v.player.certificates} certificates to Lena
          </button>
        )}
        {msg && <p className={msg.ok ? 'ok-line' : 'warn-line'}>{msg.text}</p>}
      </Section>
      <PlantSales v={v} />
      {!!town.news?.length && (
        <Section title="In the news">
          {town.news.map((n) => {
            const mv = storyMove(town, n)
            return (
              <button key={n.seq} className={`news-card ${n.tone}`} onClick={() => mv && onMerchant(mv.m.merchantId)}>
                <b>{n.headline}</b>
                <span className="fine">{n.detail}</span>
                <small className="fine">
                  What it does: {n.effects.join('; ')} · about {Math.max(1, Math.round((n.ticksLeft * 5) / 60))} market hours left
                  {mv?.now != null && mv.pctMove !== 0 && ` · ${ITEMS[mv.it.item].name} ${mv.pctMove > 0 ? 'up' : 'down'} ${Math.abs(mv.pctMove)}% so far`}
                </small>
              </button>
            )
          })}
        </Section>
      )}
      {reserveAlerts.length > 0 && (
        <Section title="Resource discoveries and warnings">
          {reserveAlerts.map((event) => <p key={event.seq} className={`market-event ${event.severity}`}><b>{event.title}</b> {event.detail}</p>)}
        </Section>
      )}
      <div className="replay-actions">
        <button className="btn primary wide" onClick={() => onWatch(7)}>Watch 7 days · about 1 minute</button>
        <button className="btn wide" onClick={() => onWatch(365)}>Simulate 1 year · same rules, about 1 minute</button>
      </div>
      <CompaniesSection c={town.companies} desk={desk} onDesk={onDesk} />
      <TradeFeed town={town} />
    </>
  )
}

function resourceSaleStatus(sale: ResourceSale): string {
  if (sale.status === 'listing') return 'Opening offer…'
  if (sale.status === 'listed') return 'Open · waiting for a merchant decision'
  if (sale.status === 'buying') return `Purchase in progress${sale.buyerName ? ` · ${sale.buyerName}` : ''}`
  if (sale.status === 'cancelling') return 'Withdrawal in progress · stock stays reserved until it clears'
  if (sale.status === 'sold') return `Sold${sale.buyerName ? ` to ${sale.buyerName}` : ''}`
  if (sale.status === 'cancelled') return 'Withdrawn · stock returned'
  return 'Could not open · stock returned'
}

function ResourceExchange({ v, town }: { v: RegionView; town: TownView }) {
  const [sales, setSales] = useState<ResourceSale[]>([])
  const [item, setItem] = useState<ItemId>(() => ITEM_IDS.find((id) => town.merchants.some((m) => m.items.some((x) => x.item === id && x.bidCc !== null))) ?? ITEM_IDS[0])
  const [quantity, setQuantity] = useState(1)
  const [askCredits, setAskCredits] = useState(() => {
    const merchant = town.merchants.find((m) => m.items.some((x) => x.item === item && x.bidCc !== null))
    return Math.max(0.01, ((merchant?.items.find((x) => x.item === item)?.bidCc ?? 100) / 100))
  })
  const [busy, setBusy] = useState(false)
  const [canceling, setCanceling] = useState<string | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const availableItems = ITEM_IDS.filter((id) => town.merchants.some((m) => m.items.some((x) => x.item === id && x.bidCc !== null)))
  const amountHeld = held(v, item)
  const totalCc = Math.round(askCredits * 100) * quantity
  const safeTotal = Number.isSafeInteger(totalCc)

  useEffect(() => {
    let live = true
    let loaded = false
    const refresh = async () => {
      try {
        const result = await regionApi.resourceSales()
        if (live) {
          loaded = true
          setSales(result.sales)
        }
      } catch (error) {
        if (live && !loaded) setMessage({ ok: false, text: (error as Error).message })
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5_000)
    return () => { live = false; window.clearInterval(timer) }
  }, [])

  const defaultAsk = (next: ItemId) => {
    const buyer = town.merchants.find((m) => m.items.some((x) => x.item === next && x.bidCc !== null))
    return Math.max(0.01, (buyer?.items.find((x) => x.item === next)?.bidCc ?? 100) / 100)
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      const result = await regionApi.listResource(item, quantity, Math.round(askCredits * 100))
      setSales(result.sales)
      setQuantity(1)
      setMessage({ ok: true, text: result.sale.status === 'listed' ? 'Offer is open. Merchants will review it against their current stock, cash and buying rules.' : 'Offer is being reserved for the market.' })
    } catch (error) {
      setMessage({ ok: false, text: (error as Error).message || 'The offer could not be opened. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (saleId: string) => {
    setCanceling(saleId)
    setMessage(null)
    try {
      const result = await regionApi.cancelResource(saleId)
      setSales(result.sales)
      setMessage({ ok: true, text: result.sale.status === 'cancelled' ? 'Offer withdrawn; the stock is back in your inventory.' : 'Withdrawal requested. The stock returns after the current market action resolves.' })
    } catch (error) {
      setMessage({ ok: false, text: (error as Error).message || 'The offer could not be withdrawn. Try again.' })
    } finally {
      setCanceling(null)
    }
  }

  return (
    <Section title="Player exchange" aside={<span className="resource-exchange-count">{sales.filter((sale) => ['listing', 'listed', 'buying', 'cancelling'].includes(sale.status)).length} open</span>}>
      <p className="fine">Set your own ask for resources you hold. Vesper’s merchants decide whether to buy based on their budgets, stock room and current market price. Game credits stay inside BLACKOUT.</p>
      {availableItems.length === 0 ? <p className="fine">No merchants are buying resources right now.</p> : (
        <form className="resource-market-form" onSubmit={submit}>
          <label>Resource
            <select value={item} onChange={(event) => { const next = event.target.value as ItemId; setItem(next); setAskCredits(defaultAsk(next)); setQuantity(1) }}>
              {availableItems.map((id) => <option key={id} value={id}>{ITEMS[id].icon} {ITEMS[id].name} · {held(v, id).toLocaleString('en-US')} {ITEMS[id].units}</option>)}
            </select>
          </label>
          <label>Quantity <small>Available: {amountHeld.toLocaleString('en-US')} {ITEMS[item].units}</small>
            <input type="number" min={1} max={amountHeld} step={1} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} required />
          </label>
          <label>Ask per unit <small>in game credits · ₡</small>
            <input type="number" min={0.01} max={10_000_000} step={0.01} value={askCredits} onChange={(event) => setAskCredits(Number(event.target.value))} required />
          </label>
          <div className="resource-market-total"><span>Offer total</span><b>{safeTotal ? unitPrice(totalCc) : '—'}</b></div>
          <button className="btn primary" type="submit" disabled={busy || amountHeld < 1 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > amountHeld || !Number.isFinite(askCredits) || askCredits <= 0 || !safeTotal}>
            {busy ? 'Opening offer…' : 'List resource'}
          </button>
        </form>
      )}
      {message && <p className={message.ok ? 'ok-line' : 'warn-line'} role="status">{message.text}</p>}
      <div className="resource-sale-list" aria-live="polite">
        {sales.length === 0 && <p className="fine">No player offers yet. Set an ask above to open the first one.</p>}
        {sales.slice(0, 12).map((sale) => (
          <article className={`resource-sale ${sale.mine ? 'mine' : ''}`} key={sale.saleId}>
            <div className="resource-sale-main">
              <b>{ITEMS[sale.item].icon} {ITEMS[sale.item].name} · {sale.quantity.toLocaleString('en-US')} {ITEMS[sale.item].units}</b>
              <span>{sale.mine ? 'Your offer' : sale.sellerName}</span>
              <small className="fine">{unitPrice(sale.unitPriceCc)} each · {unitPrice(sale.totalCc)} total</small>
            </div>
            <div className="resource-sale-state">
              <span className={`resource-sale-status ${sale.status}`}>{resourceSaleStatus(sale)}</span>
              <small className="fine">{sale.decision}</small>
            </div>
            {sale.mine && ['listing', 'listed', 'buying'].includes(sale.status) && <button type="button" className="btn small" disabled={canceling === sale.saleId} onClick={() => void cancel(sale.saleId)}>{canceling === sale.saleId ? 'Withdrawing…' : 'Withdraw'}</button>}
          </article>
        ))}
      </div>
    </Section>
  )
}

export function TradeFeed({ town }: { town: TownView }) {
  const items = [...town.trades].reverse().slice(0, 14)
  return (
    <Section title="Live: who's trading">
      {items.length === 0 && <p className="fine">Quiet so far. Your trades and other players' appear here as they happen.</p>}
      <ul className="trade-feed">
        {items.map((t) => (
          <li key={t.seq} className={t.whoKind}>
            <b>{t.label}</b> {t.side === 'buy' ? 'bought' : 'sold'} {t.quantity.toLocaleString('en-US')} {ITEMS[t.item].units} {t.side === 'buy' ? 'from' : 'to'} {town.merchants.find((m) => m.merchantId === t.merchantId)?.person.split(' ')[0]} · {unitPrice(t.priceCc)}
          </li>
        ))}
      </ul>
      {town.events.slice(-4).reverse().map((e) => (
        <p key={e.seq} className={`market-event ${e.severity}`}>
          <b>{e.title}</b> {e.detail}
        </p>
      ))}
    </Section>
  )
}

/** Seven market days in sixty seconds: the shops, their prices and their cash, moving. */
export function WatchAWeek({ days = 7, onClose }: { days?: 7 | 365; onClose: () => void }) {
  const [week, setWeek] = useState<FastForwardResult | null>(null)
  const [i, setI] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])
  useEffect(() => {
    regionApi.fastForward(42, days).then((r) => setWeek(r.week), (e) => setErr((e as Error).message))
  }, [days])
  useEffect(() => {
    if (!week || !playing) return
    timer.current = setInterval(() => setI((x) => (x >= week.frames.length - 1 ? x : x + 1)), 1_000)
    return () => {
      if (timer.current) clearInterval(timer.current)
    }
  }, [week, playing])
  if (err)
    return (
      <div className="modal-back" onClick={onClose}>
        <div className="modal watch">
          <button className="close" onClick={onClose} aria-label="Close">×</button>
          <p className="warn-line">{err}</p>
        </div>
      </div>
    )
  const f = week?.frames[i]
  const done = week && i >= week.frames.length - 1
  const shown = week ? week.events.filter((e) => e.tick <= (f?.tick ?? 0)) : []
  const META: Record<string, { person: string; face: string; name: string }> = {
    ingrid: { person: 'Ingrid', face: '👩🏼‍✈️', name: 'LNG Terminal' },
    bayo: { person: 'Bayo', face: '👨🏿‍💼', name: 'Northline' },
    kettle: { person: 'Kettle', face: '👴🏻', name: 'Kettle Fuels' },
    dayo: { person: 'Dayo', face: '🧑🏾‍✈️', name: 'Swift Tankers' },
    chioma: { person: 'Chioma', face: '👩🏾‍💼', name: 'Okafor & Daughters' },
    lena: { person: 'Lena', face: '👩🏻‍🏫', name: 'Greenline Desk' },
    ruth: { person: 'Ruth', face: '👩🏾‍⚖️', name: 'Carbon Counter' },
    pavel: { person: 'Pavel', face: '👨🏻‍🏭', name: 'Steel Yard' },
    nkechi: { person: 'Nkechi', face: '👩🏾‍🔧', name: 'Sparks & Sons' },
  }
  return (
    <div className="modal-back">
      <div className="modal watch" role="dialog" aria-label={days === 365 ? 'Simulate one year' : 'Watch a week'}>
        <button className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <div className="modal-body">
          <p className="eyebrow">Deterministic replay · same market rules, fixed resource endowment, four trading companies, three NPC power companies · seed {week?.seed ?? 42}</p>
          <h3>{f ? f.label : `Simulating ${days === 365 ? 'one year' : 'a week'} of Vesper Market…`}</h3>
          {week && (
            <>
              <div className="ff-progress">
                <i style={{ width: `${((i + 1) / week.frames.length) * 100}%` }} />
              </div>
              <div className="row">
                <button className="btn small" onClick={() => setPlaying(!playing)}>
                  {playing ? '⏸ Pause' : '▶ Play'}
                </button>
                <button className="btn small ghost" onClick={() => setI(week.frames.length - 1)}>
                  Skip to the end
                </button>
              </div>
              {f!.companies && (
                <div className="ff-companies">
                  {f!.companies.map((c) => {
                    const c0 = week.frames[0].companies!.find((x) => x.firmId === c.firmId)!
                    const ch = c.cashCc - c0.cashCc
                    return (
                      <div key={c.firmId} className={`ff-company ${c.open ? '' : 'closed'}`}>
                        <b>{c.name}</b>
                        <span>
                          {credits(c.cashCc)} <em className={ch >= 0 ? 'ok' : 'warn'}>{ch >= 0 ? '+' : '−'}{credits(Math.abs(ch))}</em>
                        </span>
                        {c.firmId === 'halvard' && <small className="fine">potlines {Math.round(c.productionBps / 100)}%</small>}
                        {!c.open && <span className="pill-closed">STOPPED</span>}
                        <Spark values={week.frames.slice(0, i + 1).map((fr) => fr.companies!.find((x) => x.firmId === c.firmId)!.cashCc)} height={18} tone="gold" />
                      </div>
                    )
                  })}
                  <div className="ff-company">
                    <b>Sky over Vesper</b>
                    <span>{f!.cloudPct ?? 0}% cloud</span>
                    {(f!.cloudPct ?? 0) > 70 && <small className="warn-line">Storm: Solara’s panels fall short</small>}
                    {week.you && (
                      <small className="ok-line">
                        {week.you.name}: {credits(f!.youEarnedCc ?? 0)} from the companies
                      </small>
                    )}
                  </div>
                </div>
              )}
              <div className="ff-grid">
                {f!.merchants.map((m) => {
                  const first = week.frames[0].merchants.find((x) => x.merchantId === m.merchantId)!
                  return (
                    <div key={m.merchantId} className={`ff-shop ${m.open ? '' : 'closed'}`}>
                      <span className="ff-name">
                        {META[m.merchantId]?.face} {META[m.merchantId]?.person}
                        {!m.open && <span className="pill-closed">CLOSED</span>}
                      </span>
                      {Object.entries(m.prices).map(([item, p]) => {
                        const p0 = first.prices[item as ItemId] ?? p!
                        const ch = Math.round(((p! - p0) / p0) * 100)
                        return (
                          <span key={item} className="ff-price">
                            {ITEMS[item as ItemId].icon} {unitPrice(p!)} <em className={ch > 3 ? 'warn' : ch < -3 ? 'ok' : 'muted'}>{ch > 0 ? `+${ch}` : ch}%</em>
                          </span>
                        )
                      })}
                      <small className="fine">cash {credits(m.cashCc)}</small>
                      <Spark values={week.frames.slice(0, i + 1).map((fr) => Object.values(fr.merchants.find((x) => x.merchantId === m.merchantId)!.prices)[0] ?? 0)} height={20} tone="amber" />
                    </div>
                  )
                })}
              </div>
              <Section title="What happened to the shops">
                {shown.filter((e) => !e.kind).length === 0 && <p className="fine">Watch the gas price as Pemberton corners it, and Lena's desk as Greenfield floods it with certificates…</p>}
                {shown.filter((e) => !e.kind).slice(-4).reverse().map((e) => (
                  <p key={e.seq} className={`market-event ${e.severity}`}>
                    <b>{e.title}</b> {e.detail}
                  </p>
                ))}
              </Section>
              {shown.some((e) => e.kind === 'resource') && (
                <Section title="Deposits and scarcity">
                  {shown.filter((e) => e.kind === 'resource').slice(-4).reverse().map((e) => (
                    <p key={e.seq} className={`market-event ${e.severity}`}>
                      <b>{e.title}</b> {e.detail}
                    </p>
                  ))}
                </Section>
              )}
              {f!.reserves && (
                <Section title="Finite reserves · unallocated stock">
                  <div className="reserve-grid replay-reserves">
                    {Object.entries(f!.reserves).map(([item, reserve]) => {
                      if (!reserve) return null
                      const history = week.frames.map((frame) => frame.reserves?.[item as ItemId]?.remaining ?? 0)
                      return (
                        <div className="reserve-card" key={item}>
                          <div className="reserve-head"><b>{ITEMS[item as ItemId].icon} {ITEMS[item as ItemId].name}</b><span>{Math.round((reserve.remaining / Math.max(1, reserve.total)) * 100)}% left</span></div>
                          <Bar value={reserve.remaining} max={reserve.total} tone={reserve.remaining / Math.max(1, reserve.total) <= 0.25 ? 'crisis' : 'gold'} label={`${ITEMS[item as ItemId].name} reserve remaining`} />
                          <small className="fine">{reserve.remaining.toLocaleString('en-US')} / {reserve.total.toLocaleString('en-US')} {ITEMS[item as ItemId].units}</small>
                          <Spark values={history.slice(0, i + 1)} height={24} tone="amber" />
                        </div>
                      )
                    })}
                  </div>
                </Section>
              )}
              {shown.some((e) => e.kind === 'power') && (
                <Section title="What the power companies did">
                  {shown.filter((e) => e.kind === 'power').slice(-3).reverse().map((e) => (
                    <p key={e.seq} className="market-event info">
                      <b>{e.title}</b> <span className="fine">{e.detail}</span>
                    </p>
                  ))}
                </Section>
              )}
              {shown.some((e) => e.kind === 'news') && (
                <Section title="In the news that week">
                  {shown.filter((e) => e.kind === 'news').slice(-3).reverse().map((e) => (
                    <p key={e.seq} className={`market-event ${e.severity}`}>
                      <b>{e.title}</b>
                    </p>
                  ))}
                </Section>
              )}
              {done && (
                <Section title={`The economy after ${days === 365 ? 'one year' : 'one week'}`}>
                  {week.bots.map((b) => (
                    <Stat key={b.name} label={`${b.name}: ${b.strategy}`} value={credits(b.netWorthCc)} />
                  ))}
                  {week.companies?.map((c) => (
                    <Stat key={c.firmId} label={`${c.name}: bought ${c.boughtMWh.toLocaleString('en-US')} MWh, sold ${c.soldMWh.toLocaleString('en-US')} MWh${c.open ? '' : ' (stopped)'}`} value={`${credits(c.startCc)} → ${credits(c.endCc)}`} />
                  ))}
                  {week.you ? (
                    <p className="fine">
                      {week.you.name} offered {Math.round(week.you.kw / 1000)} MW at ₡{Math.round(week.you.priceCcPerMWh / 100)}/MWh all week and won {week.you.deals} deals worth {credits(week.you.earnedCc)}. A projection from your plants right now, not money you have.
                    </p>
                  ) : (
                    <p className="fine">Start a plant before watching and your company joins the week, selling its spare power to these companies.</p>
                  )}
                  <p className="fine">{week.trades.toLocaleString('en-US')} player trades · trace {week.traceHash.slice(0, 12)}… (same seed and policies, same replay)</p>
                </Section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
