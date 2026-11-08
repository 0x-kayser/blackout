import { useCallback, useEffect, useMemo, useState } from 'react'
import { explainError } from '../api/client'
import { exchangeApi, type BuyQuote, type ExchangeView, type TraderView } from '../api/exchange'
import type { Game } from '../game/useGame'
import { Drawer } from './Panels'
import { SignInOptions } from './SignIn'
import { fmtCredits, fmtLitres, sparkPath } from './format'

const perL = (cc: number | null | undefined) => (cc == null ? '—' : `${fmtCredits(cc)}/L`)
const STATUS: Record<TraderView['status'], { label: string; tone: string }> = {
  normal: { label: 'trading', tone: 'teal' },
  short: { label: 'rationing', tone: 'coral' },
  cash_strapped: { label: 'out of cash', tone: 'amber' },
  overstocked: { label: 'overstocked', tone: 'blue' },
}
const ORDER_STATUS: Record<string, string> = {
  placing: 'Going on the board…',
  open: 'On the board',
  cancelling: 'Coming off the board…',
  filled: 'Sold',
  cancelled: 'Cancelled · fuel back in warehouse',
  rejected: 'Could not be placed',
}

/** Polls the shared exchange while the panel is open. */
export function useExchange(enabled = true) {
  const [view, setView] = useState<ExchangeView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try {
      setView(await exchangeApi.view())
      setError(null)
    } catch (e) {
      setError(explainError(e))
    }
  }, [])
  useEffect(() => {
    if (!enabled) return
    void refresh()
    const t = setInterval(() => void refresh(), 4_000)
    return () => clearInterval(t)
  }, [enabled, refresh])
  return { view, error, refresh }
}

export function ExchangePanel({ g, onClose }: { g: Game; onClose: () => void }) {
  const s = g.state!
  const { view, error, refresh } = useExchange()
  const [busy, setBusy] = useState<string | null>(null)
  const me = view?.me ?? null
  const book = view?.book
  const cheapestLocal = Math.min(...s.merchants.filter((m) => m.status === 'open').map((m) => m.quoteCcPerL))
  const depositable = s.player.exchangeDepositableFuelMl
  const tankRoom = Math.max(0, s.player.tankCapacityMl - s.player.fuelMl - s.player.pendingFuelMl - (me?.pendingRedeemMl ?? 0))

  const run = async (label: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(label)
    try {
      await fn()
      g.toast(ok, 'good')
      await refresh()
    } catch (e) {
      g.toast(explainError(e), 'bad')
    } finally {
      setBusy(null)
    }
  }

  const tip = useMemo(() => {
    if (!book) return null
    if (book.bestAskCcPerL !== null && Number.isFinite(cheapestLocal) && book.bestAskCcPerL < cheapestLocal) {
      return { tone: 'teal', text: `Diesel here is ${fmtCredits(cheapestLocal - book.bestAskCcPerL)}/L cheaper than your town's merchants. Stock up.` }
    }
    if (book.bestBidCcPerL !== null && Number.isFinite(cheapestLocal) && book.bestBidCcPerL > cheapestLocal) {
      return { tone: 'amber', text: `Traders pay ${perL(book.bestBidCcPerL)}, more than your merchants charge (${perL(cheapestLocal)}). Buy at home, sell here.` }
    }
    return { tone: 'muted', text: `Your merchants sell at ${perL(Number.isFinite(cheapestLocal) ? cheapestLocal : null)}. Watch for a gap: other cities' shortages move this board.` }
  }, [book, cheapestLocal])

  return (
    <Drawer title="Vesper Fuel Exchange" eyebrow="ONE MARKET · EVERY CITY · LIVE" onClose={onClose} wide>
      {!view ? (
        <p className="fine">{error ?? 'Opening the trading floor…'}</p>
      ) : (
        <>
          <div className="x-strip">
            <Stat label="Traders sell at" value={perL(book!.bestAskCcPerL)} tone="amber" />
            <Stat label="Traders buy at" value={perL(book!.bestBidCcPerL)} tone="teal" />
            <Stat label="Last trade" value={perL(book!.lastPriceCcPerL)} />
            <Stat label="Import cost" value={perL(book!.replacementCcPerL)} />
            <Spark history={book!.history.map((h) => h.bestAskCcPerL ?? h.lastPriceCcPerL).filter((x): x is number => x !== null)} />
          </div>
          {tip && <p className={`x-tip ${tip.tone}`}>{tip.text}</p>}

          {!view.canTrade ? (
            <section className="x-locked">
              <p><b>{view.blockedReason}</b></p>
              <p className="fine">Your fuel, your price, sold to players and traders in other cities, even while you're offline.</p>
              <SignInOptions g={g} compact />
            </section>
          ) : (
            <div className="x-grid">
              <Warehouse
                me={me!}
                depositable={depositable}
                tankRoom={tankRoom}
                busy={busy}
                onDeposit={(ml) => run('deposit', () => exchangeApi.deposit(ml), `${fmtLitres(ml)} sent to your warehouse.`)}
                onRedeem={(ml) => run('redeem', () => exchangeApi.redeem(ml), `${fmtLitres(ml)} on its way to your tank.`)}
              />
              <Sell me={me!} book={book!} busy={busy} onSell={(ml, p) => run('sell', () => exchangeApi.ask(ml, p), `Offered ${fmtLitres(ml)} at ${perL(p)}.`)} />
              <Buy busy={busy} credits={s.player.creditsCc} onBuy={(ml, max) => run('buy', () => exchangeApi.buy(ml, max), `Bought ${fmtLitres(ml)}. It's in your warehouse.`)} />
            </div>
          )}

          <div className="x-two">
            <section className="x-card">
              <h3>The board</h3>
              {book!.asks.length === 0 ? (
                <p className="fine">Nobody is selling right now. Post the first offer.</p>
              ) : (
                <ul className="x-book">
                  {book!.asks.slice(0, 8).map((a) => {
                    const max = Math.max(...book!.asks.map((x) => x.quantityMl))
                    return (
                      <li key={a.priceCcPerL}>
                        <span className="x-depth" style={{ width: `${Math.max(6, (a.quantityMl / max) * 100)}%` }} />
                        <b>{perL(a.priceCcPerL)}</b>
                        <span>{fmtLitres(a.quantityMl)}</span>
                        <small>{a.orders} offer{a.orders === 1 ? '' : 's'}</small>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
            <section className="x-card">
              <h3>Traders</h3>
              {book!.traders.map((t) => (
                <details key={t.traderId} className="x-trader">
                  <summary>
                    <b>{t.name}</b>
                    <span className={`pill ${STATUS[t.status].tone}`}>{STATUS[t.status].label}</span>
                    <small>sells {perL(t.askCcPerL)} · buys {perL(t.bidCcPerL)}</small>
                  </summary>
                  <p className="fine"><i>{t.blurb}</i></p>
                  <p className="fine">{t.explanation}</p>
                  <p className="fine">Stock {fmtLitres(t.stockMl)} · cash {fmtCredits(t.cashCc)}</p>
                </details>
              ))}
            </section>
          </div>

          {me && (me.orders.length > 0 || me.fills.length > 0) && (
            <section className="x-card">
              <h3>Your trades</h3>
              <ul className="x-orders">
                {me.orders.map((o) => (
                  <li key={o.orderId}>
                    <span>Selling {fmtLitres(o.quantityMl)} at {perL(o.unitPriceCcPerL)}</span>
                    <span className="x-progress"><i style={{ width: `${(o.filledMl / o.quantityMl) * 100}%` }} /></span>
                    <small>{fmtLitres(o.filledMl)} sold · {o.status === 'cancelled' && o.cancelReason === 'expired' ? 'Expired · fuel back in warehouse' : ORDER_STATUS[o.status]}</small>
                    {o.status === 'open' && <button className="button mini" disabled={!!busy || o.reservedMl > 0} onClick={() => void run('cancel', () => exchangeApi.cancel(o.orderId), 'Offer cancelled.')}>Cancel</button>}
                  </li>
                ))}
                {me.fills.slice(0, 8).map((f) => {
                  const sold = f.seller.kind === 'player'
                  const mine = me.orders.some((o) => o.orderId === f.orderId)
                  return (
                    <li key={f.fillId} className={mine ? 'sold' : 'bought'}>
                      <span>{mine ? 'Sold' : 'Bought'} {fmtLitres(f.quantityMl)} for {fmtCredits(f.totalCc)}</span>
                      <small>{mine ? `to ${f.buyer.kind === 'trader' ? traderName(book!.traders, f.buyer.id) : 'another city'}` : `from ${sold ? 'another city' : traderName(book!.traders, f.seller.id)}`} · {f.status === 'pending' ? 'delivering…' : f.status === 'failed' ? 'did not go through' : 'done'}</small>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
          <p className="fine">Credits are fictional game money. Fuel you put on the exchange is yours until it sells; cancel any time and it comes back.</p>
        </>
      )}
    </Drawer>
  )
}

const traderName = (traders: TraderView[], id: string) => traders.find((t) => t.traderId === id)?.name ?? id

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className={`x-stat ${tone ?? ''}`}>
      <small>{label}</small>
      <b>{value}</b>
    </div>
  )
}

function Spark({ history }: { history: number[] }) {
  if (history.length < 2) return <div className="x-stat"><small>7-day price</small><b className="muted">building…</b></div>
  return (
    <div className="x-stat">
      <small>{history.length}-day price</small>
      <svg viewBox="0 0 120 32" width="120" height="32" aria-label="Exchange price trend">
        <path d={sparkPath(history.slice(-14), 120, 30)} fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
    </div>
  )
}

function Slider({ label, max, value, onChange }: { label: string; max: number; value: number; onChange: (v: number) => void }) {
  const v = Math.min(value, max)
  return (
    <label className="field">
      <span>{label} · <b>{fmtLitres(v)}</b></span>
      <input type="range" min={0} max={Math.max(0, max)} step={100} value={v} disabled={max < 100} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

function Warehouse({ me, depositable, tankRoom, busy, onDeposit, onRedeem }: { me: NonNullable<ExchangeView['me']>; depositable: number; tankRoom: number; busy: string | null; onDeposit: (ml: number) => void; onRedeem: (ml: number) => void }) {
  const [inMl, setIn] = useState(5_000)
  const [outMl, setOut] = useState(5_000)
  const sendMax = Math.min(depositable, me.depositLeftTodayMl)
  const homeMax = Math.min(me.warehouseMl, Math.floor(tankRoom / 100) * 100)
  return (
    <section className="x-card">
      <h3>Your warehouse</h3>
      <p className="x-big">{fmtLitres(me.warehouseMl)}</p>
      <p className="fine">
        {me.pendingDepositMl > 0 && <>+{fmtLitres(me.pendingDepositMl)} arriving · </>}
        {me.pendingRedeemMl > 0 && <>{fmtLitres(me.pendingRedeemMl)} heading home · </>}
        Storage {fmtCredits(me.estimatedDailyFeeCc)}/day
      </p>
      <Slider label="Send from tank" max={sendMax} value={inMl} onChange={setIn} />
      <button className="button" disabled={!!busy || sendMax < 100 || Math.min(inMl, sendMax) < 100} onClick={() => onDeposit(Math.min(inMl, sendMax))}>Send to warehouse</button>
      {depositable < 100 && <p className="fine">Only fuel you bought can be sold. Buy diesel from a merchant first; starter fuel stays in your city.</p>}
      <Slider label="Bring home" max={homeMax} value={outMl} onChange={setOut} />
      <button className="button" disabled={!!busy || homeMax < 100 || Math.min(outMl, homeMax) < 100} onClick={() => onRedeem(Math.min(outMl, homeMax))}>Deliver to tank</button>
    </section>
  )
}

function Sell({ me, book, busy, onSell }: { me: NonNullable<ExchangeView['me']>; book: NonNullable<ExchangeView['book']>; busy: string | null; onSell: (ml: number, priceCcPerL: number) => void }) {
  const [ml, setMl] = useState(5_000)
  const suggested = book.bestBidCcPerL ?? book.replacementCcPerL
  const [price, setPrice] = useState<number | null>(null)
  const p = price ?? suggested
  const q = Math.min(ml, me.warehouseMl)
  const instant = book.bestBidCcPerL !== null && p <= book.bestBidCcPerL
  return (
    <section className="x-card">
      <h3>Sell</h3>
      <Slider label="Amount" max={me.warehouseMl} value={ml} onChange={setMl} />
      <label className="field">
        <span>Your price · credits per litre</span>
        <input type="number" min={1} step={0.1} value={(p / 100).toFixed(2)} onChange={(e) => setPrice(Math.max(1, Math.round(Number(e.target.value) * 100) || 1))} />
      </label>
      <div className="x-chips">
        {book.bestBidCcPerL !== null && <button onClick={() => setPrice(book.bestBidCcPerL)}>Sell fast {perL(book.bestBidCcPerL)}</button>}
        {book.bestAskCcPerL !== null && <button onClick={() => setPrice(book.bestAskCcPerL! - 10)}>Undercut {perL(book.bestAskCcPerL - 10)}</button>}
        <button onClick={() => setPrice(Math.round(book.replacementCcPerL * 1.25))}>Hold out {perL(Math.round(book.replacementCcPerL * 1.25))}</button>
      </div>
      <p className="fine">{q >= 100 ? <>Earns up to <b>{fmtCredits(Math.ceil((q * p) / 1000))}</b>. {instant ? 'A trader is buying at this price: likely to sell within seconds.' : 'Waits on the board for a buyer from any city.'}</> : 'Send fuel to your warehouse to sell it.'}</p>
      <button className="button primary" disabled={!!busy || q < 100} onClick={() => onSell(q, p)}>Post offer</button>
    </section>
  )
}

function Buy({ busy, credits, onBuy }: { busy: string | null; credits: number; onBuy: (ml: number, max: number | null) => void }) {
  const [ml, setMl] = useState(10_000)
  const [quote, setQuote] = useState<BuyQuote | null>(null)
  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      exchangeApi.quote(ml).then((r) => live && setQuote(r.quote)).catch(() => live && setQuote(null))
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [ml])
  const enough = quote && quote.quantityMl >= ml
  return (
    <section className="x-card">
      <h3>Buy</h3>
      <Slider label="Amount" max={60_000} value={ml} onChange={(v) => setMl(Math.max(100, v))} />
      <p className="fine">
        {!quote ? 'Checking the board…' : enough ? <>Costs <b>{fmtCredits(quote.totalCc)}</b> (avg {perL(quote.averageCcPerL)}) from {quote.legs.length} seller{quote.legs.length === 1 ? '' : 's'}.</> : <>Only {fmtLitres(quote.quantityMl)} is on offer right now.</>}
      </p>
      <button className="button primary" disabled={!!busy || !enough || quote!.totalCc > credits} onClick={() => onBuy(ml, null)}>{quote && enough && quote.totalCc > credits ? 'Not enough credits' : 'Buy'}</button>
      <p className="fine">Lands in your warehouse. Deliver it to your tank when you need it.</p>
    </section>
  )
}

const SEEN_KEY = 'bo_x_seen_fills'
const loadSeen = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

/** "While you were away": exchange sales that settled since this device last looked. */
export function ExchangeAway({ playerId, onOpen }: { playerId: string; onOpen: () => void }) {
  const [sales, setSales] = useState<{ ids: string[]; litres: number; credits: number; buyers: string[] } | null>(null)
  useEffect(() => {
    let live = true
    exchangeApi
      .view()
      .then((v) => {
        if (!live || !v.me) return
        const seen = new Set(loadSeen())
        const fresh = v.me.fills.filter((f) => f.status === 'settled' && f.seller.kind === 'player' && f.seller.id === playerId && !seen.has(f.fillId))
        if (!fresh.length) return
        const buyers = [...new Set(fresh.map((f) => (f.buyer.kind === 'trader' ? traderName(v.book.traders, f.buyer.id) : 'another city')))]
        setSales({ ids: fresh.map((f) => f.fillId), litres: fresh.reduce((a, f) => a + f.quantityMl, 0), credits: fresh.reduce((a, f) => a + f.totalCc, 0), buyers })
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [playerId])
  if (!sales) return null
  const dismiss = () => {
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify([...loadSeen(), ...sales.ids].slice(-200)))
    } catch {
      /* per-device convenience */
    }
    setSales(null)
  }
  return (
    <div className="away-banner x-away" role="status">
      <span>💰 While you were away you sold <b>{fmtLitres(sales.litres)}</b> on the exchange for <b>{fmtCredits(sales.credits)}</b> to {sales.buyers.join(', ')}.</span>
      <button className="text-link" onClick={() => { dismiss(); onOpen() }}>Open exchange</button>
      <button onClick={dismiss} aria-label="Dismiss">×</button>
    </div>
  )
}
