/**
 * Companies sell whole plants to each other. Completed purchases move the plant from one company to another.
 */
import { useEffect, useState } from 'react'
import type { RegionView } from '@blackout/shared'
import { regionApi, type PlantSale } from '../api'
import { credits, mw } from '../format'
import { Section } from './Bits'

const STATUS: Record<PlantSale['status'], string> = { listing: 'preparing listing…', listed: 'for sale', buying: 'purchase processing…', sold: 'sold', cancelled: 'withdrawn', failed: "couldn't list" }

export function PlantSales({ v }: { v: RegionView }) {
  const [sales, setSales] = useState<PlantSale[] | null>(null)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [reviewBuy, setReviewBuy] = useState<string | null>(null)
  const [reviewList, setReviewList] = useState(false)
  const mine = v.plants.filter((p) => p.mine && p.status !== 'building')
  const [plantId, setPlantId] = useState('')
  const [price, setPrice] = useState(50_000)
  useEffect(() => {
    let live = true
    const load = () => regionApi.plantSales().then((r) => live && setSales(r.sales), () => undefined)
    void load()
    const t = setInterval(load, 4_000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [])
  const run = async (fn: () => Promise<{ sales: PlantSale[] }>, ok: string) => {
    setBusy(true)
    setMsg(null)
    try {
      setSales((await fn()).sales)
      setMsg({ text: ok, ok: true })
      return true
    } catch (e) {
      setMsg({ text: (e as Error).message, ok: false })
      return false
    } finally {
      setBusy(false)
    }
  }
  const open = (sales ?? []).filter((s) => s.status === 'listed' || s.status === 'buying' || s.status === 'listing')
  const listed = new Set(open.filter((s) => s.mine).map((s) => s.name))
  return (
    <Section title="Plants for sale">
      <p className="fine">Companies sell whole plants to each other. When a purchase completes, the plant leaves the seller’s grid and joins yours where it stands.</p>
      {open.length === 0 && <p className="fine">Nothing for sale right now.</p>}
      {open.map((s) => (
        <div key={s.saleId} className={`deal ${s.mine ? 'mine' : ''}`}>
          <div className="deal-head">
            <b>{s.name}</b> <small className="fine">{mw(s.capacityKw)} {s.tech} · {s.sellerName}</small>
            <span className={`pill ${s.status === 'listed' ? 'ok' : 'muted'}`}>{STATUS[s.status]}</span>
          </div>
          <div className="row">
            <b>{credits(s.priceCc)}</b>
            {s.mine ? (
              s.status !== 'buying' && (
                <button className="btn small" disabled={busy} onClick={() => void run(() => regionApi.cancelPlant(s.saleId), 'Withdrawn.')}>
                  Withdraw
                </button>
              )
            ) : (
              s.status === 'listed' && (
                <button className="btn primary small" disabled={busy} onClick={() => setReviewBuy(reviewBuy === s.saleId ? null : s.saleId)}>
                  {reviewBuy === s.saleId ? 'Close review' : 'Review purchase'}
                </button>
              )
            )}
          </div>
          {!s.mine && reviewBuy === s.saleId && s.status === 'listed' && (
            <div className="trade-ticket" aria-live="polite">
              <b>Review plant purchase</b>
              <p>{s.name} · {mw(s.capacityKw)} {s.tech} · seller {s.sellerName}</p>
              <div className="trade-ticket-stats">
                <span>Price <b>{credits(s.priceCc)}</b></span>
                <span>Cash now <b>{credits(v.pulse.cashCc)}</b></span>
                <span>Cash after <b>{v.pulse.cashCc >= s.priceCc ? credits(v.pulse.cashCc - s.priceCc) : `short ${credits(s.priceCc - v.pulse.cashCc)}`}</b></span>
                <span>Separate fee <b>None</b></span>
              </div>
              <small className="fine">Game credits move when the sale completes. The plant and its future output then move to your company.</small>
              <div className="row">
                <button className="btn primary small" disabled={busy || v.pulse.cashCc < s.priceCc} onClick={async () => { const ok = await run(() => regionApi.buyPlant(s.saleId), `Bought ${s.name}. It joins your grid when the sale completes.`); if (ok) setReviewBuy(null) }}>
                  {v.pulse.cashCc < s.priceCc ? 'Not enough cash' : `Confirm · ${credits(s.priceCc)}`}
                </button>
                <button className="btn ghost small" disabled={busy} onClick={() => setReviewBuy(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      ))}
      {mine.length > 0 && (
        <div className="sell-plant">
          <label className="slider">
            Sell one of yours
            <select value={plantId} onChange={(e) => setPlantId(e.target.value)}>
              <option value="">Choose a plant…</option>
              {mine.filter((p) => !listed.has(p.name)).map((p) => (
                <option key={p.plantId} value={p.plantId}>
                  {p.name} · {p.assetId} ({mw(p.capacityKw)})
                </option>
              ))}
            </select>
          </label>
          <label className="slider">
            Listing price ₡
            <input type="number" min={1_000} step={1_000} value={price} onChange={(e) => setPrice(Math.max(1_000, Number(e.target.value) || 1_000))} />
          </label>
          <button className="btn small" disabled={busy || !plantId} onClick={() => setReviewList((x) => !x)}>
            {reviewList ? 'Close review' : 'Review listing'}
          </button>
          {reviewList && (() => {
            const selected = mine.find((p) => p.plantId === plantId)
            return selected ? (
              <div className="trade-ticket">
                <b>Review plant listing</b>
                <div className="trade-ticket-stats">
                  <span>Asset <b>{selected.assetId}</b></span>
                  <span>Book value <b>{credits(selected.bookValueCc)}</b></span>
                  <span>Asking price <b>{credits(Math.round(price * 100))}</b></span>
                  <span>Listing fee <b>None</b></span>
                </div>
                <small className="fine">Listing does not sell the plant or pay you immediately. You keep ownership until another company completes the purchase; then the agreed amount is credited.</small>
                <div className="row">
                  <button className="btn primary small" disabled={busy} onClick={async () => { if (await run(() => regionApi.listPlant(plantId, Math.round(price * 100)), 'Listed for other companies.')) setReviewList(false) }}>Confirm listing</button>
                  <button className="btn ghost small" disabled={busy} onClick={() => setReviewList(false)}>Cancel</button>
                </div>
              </div>
            ) : null
          })()}
        </div>
      )}
      {msg && <p className={msg.ok ? 'ok-line' : 'warn-line'}>{msg.text}</p>}
    </Section>
  )
}
