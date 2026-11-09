/**
 * Vesper's NPC power companies and the power desk: what each company has, what it just decided and why (in its own
 * numbers), the deals it made (with their NEAR transactions when the server is on testnet), and your own offer.
 */
import { useState } from 'react'
import type { CompaniesView, EconomyView, PowerOrderView } from '@blackout/shared'
import { regionApi } from '../api'
import { credits, mw, mwh, pct, price } from '../format'
import { Section } from './Bits'

const STATUS: Record<PowerOrderView['status'], { label: string; tone: string }> = {
  placing: { label: 'paying into escrow', tone: 'muted' },
  open: { label: 'delivering', tone: 'info' },
  awaiting: { label: 'confirming delivery', tone: 'muted' },
  settled: { label: 'paid', tone: 'ok' },
  failed: { label: 'didn’t go through', tone: 'warn' },
  expired: { label: 'refunded', tone: 'warn' },
}
const KIND = { smelter: '🏭', solar: '☀️', gas: '🔥' } as const

export function TxLink({ hash, label, base }: { hash: string | null; label: string; base?: string }) {
  if (!hash || hash.startsWith('FAKE')) return null
  return (
    <a className="tx-link" href={`${base ?? 'https://testnet.nearblocks.io/txns/'}${hash}`} target="_blank" rel="noreferrer">
      {label} ↗
    </a>
  )
}

export function Deal({ o }: { o: PowerOrderView }) {
  const s = STATUS[o.status]
  return (
    <div className={`deal ${o.mine ? 'mine' : ''}`}>
      <div className="deal-head">
        <b>{o.buyerName}</b> ← <b>{o.sellerName}</b>
        <span className={`pill ${s.tone}`}>{s.label}</span>
      </div>
      <div className="fine">
        {mw(o.kw)} for 3 h at {price(o.priceCcPerMWh)}/MWh · {credits(o.escrowCc)} in escrow
        {o.status === 'settled' && (
          <>
            {' '}
            · delivered {mwh(o.deliveredKwh ?? 0)} of {mwh(o.kwh)}, paid {credits(o.paidCc)}
            {o.refundCc > 0 ? `, ${credits(o.refundCc)} back to ${o.buyerName}` : ''}
          </>
        )}
        {o.failReason ? ` · ${o.failReason}` : ''}
      </div>
      <div className="deal-links">
        <TxLink hash={o.txHash} label="escrow on NEAR" />
        <TxLink hash={o.confirmTxHash} label="delivery confirmed" />
      </div>
    </div>
  )
}

export function CompaniesSection({ c, economy, onEconomy }: { c: CompaniesView | undefined; economy: EconomyView | null; onEconomy: (e: EconomyView) => void }) {
  const [busy, setBusy] = useState(false)
  if (!c) return null
  const mine = c.offers.find((o) => o.mine)
  const desk = economy?.desk ?? { sell: true, markupBps: 1_500 }
  const setDesk = async (d: { sell: boolean; markupBps: number }) => {
    setBusy(true)
    try {
      onEconomy((await regionApi.setDesk(d)).economy)
    } finally {
      setBusy(false)
    }
  }
  const sky = c.sunBps === 0 ? 'Night: no solar' : `Sun ${pct(c.sunBps)} · cloud ${c.cloudPct}%`
  return (
    <Section title="Power companies" aside={<small className="fine">{sky} · next deals in {c.windowTicksLeft}s</small>}>
      <p className="fine">Three companies with their own wallets buy and sell electricity every three market hours. They see the weather, their own cash and the offers below, and decide for themselves.</p>
      {c.firms.map((f) => (
        <div key={f.firmId} className={`company ${f.open ? '' : 'closed'}`}>
          <div className="mc-head">
            <span>
              {f.face} <b>{f.name}</b> <small>{KIND[f.kind]} {f.person}</small>
            </span>
            {f.open ? <small className="fine">{credits(f.cashCc)}</small> : <span className="pill-closed">STOPPED</span>}
          </div>
          <div className="fine">
            {f.blurb} Today {f.profitCcToday >= 0 ? '+' : ''}
            {credits(f.profitCcToday)}
            {f.escrowedCc > 0 ? ` · ${credits(f.escrowedCc)} in escrow` : ''}
            {f.kind === 'smelter' ? ` · potlines at ${pct(f.productionBps)}` : ''}
          </div>
          {f.lastWhy && <p className="company-why">“{f.lastWhy}”</p>}
          {f.chainAccount && (
            <a className="tx-link" href={`https://testnet.nearblocks.io/address/${f.chainAccount}`} target="_blank" rel="noreferrer">
              {f.chainAccount} ↗
            </a>
          )}
        </div>
      ))}
      <div className="desk-you">
        <label className="toggle">
          <input type="checkbox" checked={desk.sell} disabled={busy} onChange={(e) => void setDesk({ ...desk, sell: e.target.checked })} /> Sell my spare power to these companies
        </label>
        {desk.sell && (
          <label className="slider">
            My markup {Math.round(desk.markupBps / 100)}%
            <input type="range" min={0} max={10_000} step={500} value={desk.markupBps} disabled={busy} onChange={(e) => void setDesk({ ...desk, markupBps: Number(e.target.value) })} />
          </label>
        )}
        <p className="fine">
          {mine ? `Your offer: ${mw(mine.kw)} at ${price(mine.priceCcPerMWh)}/MWh. ${mine.why}` : desk.sell ? (economy?.mode === 'near' && economy.wallet?.status !== 'active' ? 'Your offer goes up once your wallet is open (sign in to get one).' : 'No spare capacity to offer right now: start a plant or charge a battery.') : 'You’re not selling.'}
        </p>
      </div>
      {c.orders.length > 0 && (
        <>
          <h4 className="deals-title">Recent deals</h4>
          {[...c.orders].reverse().slice(0, 8).map((o) => (
            <Deal key={o.orderId} o={o} />
          ))}
        </>
      )}
    </Section>
  )
}
