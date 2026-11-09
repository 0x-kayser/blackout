/**
 * Vesper Market on screen: every merchant's wallet, stock and prices, why each price is what it is, every trade as it
 * happens, and a week of trading you can watch in a minute. Nothing here happens out of sight.
 */
import { useEffect, useRef, useState } from 'react'
import type { FastForwardResult, ItemId, MerchantItemView, MerchantView, PriceWhy, RegionView, TownView } from '@blackout/shared'
import { ITEMS, ITEM_IDS } from '@blackout/shared'
import { regionApi } from '../api'
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
      const r = await p
      setMsg({ ok: r.ok, text: r.message })
      setBusy(false)
    },
  }
}

/** One item at one merchant: stock, prices with reasons, buy and sell buttons. */
function ItemRow({ m, it, v, trade, busy, run }: { m: MerchantView; it: MerchantItemView; v: RegionView; trade: Trade; busy: boolean; run: (p: Promise<{ ok: boolean; message: string }>) => void }) {
  const mine = held(v, it.item)
  const lots = LOTS[it.item]
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
      <div className="row">
        {it.askCc !== null &&
          lots.map((q) => (
            <button key={`b${q}`} className="btn small" disabled={busy || !m.open || it.stock < q} onClick={() => run(trade(m.merchantId, it.item, 'buy', q))}>
              Buy {q.toLocaleString('en-US')}
            </button>
          ))}
        {it.bidCc !== null && mine > 0 && (
          <button className="btn small primary" disabled={busy || !m.open} onClick={() => run(trade(m.merchantId, it.item, 'sell', Math.min(mine, it.target * 4 - it.stock)))}>
            Sell all {Math.min(mine, it.target * 4 - it.stock).toLocaleString('en-US')} · ~{credits(Math.min(mine, it.target * 4 - it.stock) * it.bidCc)}
          </button>
        )}
      </div>
    </div>
  )
}

export function MerchantInspector({ m, v, town, trade, invest }: { m: MerchantView; v: RegionView; town: TownView; trade: Trade; invest: Invest }) {
  const { busy, msg, run } = useBusy()
  const mine = m.investors.find((x) => x.mine)
  const recent = town.trades.filter((t) => t.merchantId === m.merchantId).slice(-6).reverse()
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
      <Section title="Wallet">
        <Stat label="Cash" value={credits(m.cashCc)} tone={m.cashCc < m.fixedCcPerDay ? 'crisis' : undefined} />
        <Stat label="Costs a day" value={credits(m.fixedCcPerDay)} />
        <Stat label="Since the day began" value={credits(m.profitCcToday)} tone={m.profitCcToday >= 0 ? 'ok' : 'crisis'} />
        {m.chainAccount && (
          <a className="fine" href={`https://testnet.nearblocks.io/address/${m.chainAccount}`} target="_blank" rel="noreferrer">
            {m.chainAccount} ↗
          </a>
        )}
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
            <button key={amt} className={`btn small ${m.open ? '' : 'primary'}`} disabled={busy || v.player.cashCc < amt} onClick={() => run(invest(m.merchantId, amt))}>
              {m.open ? `Invest ${credits(amt)}` : `Reopen · ${credits(amt)}`}
            </button>
          ))}
        </div>
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

export function MarketSheet({ v, town, trade, onMerchant, onWatch, onAutoFuel }: { v: RegionView; town: TownView | null; trade: Trade; onMerchant: (id: string) => void; onWatch: () => void; onAutoFuel: (fuel: 'gas' | 'diesel', on: boolean) => void }) {
  const { busy, msg, run } = useBusy()
  if (!town) return <p className="fine">Opening the market…</p>
  return (
    <>
      <h3>Vesper Market</h3>
      <p className="fine">
        {town.clock} · {town.players} {town.players === 1 ? 'company' : 'companies'} trading · every merchant sets prices from its own stock and recent demand. Hover a price to see why.
      </p>
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
      <button className="btn primary wide" onClick={onWatch}>
        ⏩ Watch a week of trading in a minute
      </button>
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
      <Section title="Merchants">
        {town.merchants.map((m) => (
          <div key={m.merchantId} role="button" tabIndex={0} className={`merchant-card ${m.open ? '' : 'closed'}`} onClick={() => onMerchant(m.merchantId)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onMerchant(m.merchantId))}>
            <span className="mc-head">
              <span>
                {m.face} <b>{m.person}</b> <small>{m.name}</small>
              </span>
              {!m.open ? <span className="pill-closed">CLOSED</span> : <small className="fine">{credits(m.cashCc)}</small>}
            </span>
            {m.items.map((it) => (
              <span key={it.item} className="mc-item">
                <span>
                  {ITEMS[it.item].icon} {ITEMS[it.item].name}
                </span>
                <span>
                  {it.askCc !== null && (
                    <WhyPrice why={it.why}>
                      {unitPrice(it.askCc)} {trend(it)}
                    </WhyPrice>
                  )}
                  {it.bidCc !== null && <small className="bid-price"> buys {unitPrice(it.bidCc)}</small>}
                </span>
              </span>
            ))}
          </div>
        ))}
      </Section>
      <TradeFeed town={town} />
    </>
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
export function WatchAWeek({ onClose }: { onClose: () => void }) {
  const [week, setWeek] = useState<FastForwardResult | null>(null)
  const [i, setI] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    regionApi.fastForward(42).then((r) => setWeek(r.week), (e) => setErr((e as Error).message))
  }, [])
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
      <div className="modal watch" role="dialog" aria-label="Watch a week">
        <button className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <div className="modal-body">
          <p className="eyebrow">Fast-forward · same rules, four bot companies, seed {week?.seed ?? 42}</p>
          <h3>{f ? f.label : 'Simulating a week of Vesper Market…'}</h3>
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
                {shown.filter((e) => e.kind !== 'news').length === 0 && <p className="fine">Watch the gas price as Pemberton corners it, and Lena's desk as Greenfield floods it with certificates…</p>}
                {shown.filter((e) => e.kind !== 'news').slice(-4).reverse().map((e) => (
                  <p key={e.seq} className={`market-event ${e.severity}`}>
                    <b>{e.title}</b> {e.detail}
                  </p>
                ))}
              </Section>
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
                <Section title="The bots after a week">
                  {week.bots.map((b) => (
                    <Stat key={b.name} label={`${b.name}: ${b.strategy}`} value={credits(b.netWorthCc)} />
                  ))}
                  <p className="fine">{week.trades.toLocaleString('en-US')} player trades · trace {week.traceHash.slice(0, 12)}… (same seed, same week, every time)</p>
                </Section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
