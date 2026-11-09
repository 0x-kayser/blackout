/**
 * Plants for sale between companies. A sale on NEAR is one transaction: the buyer's credits go to the seller and the
 * plant's NFT to the buyer, both or neither; then the plant leaves the seller's grid and joins the buyer's.
 */
import { useEffect, useState } from 'react'
import type { RegionView } from '@blackout/shared'
import { regionApi, type PlantSale } from '../api'
import { credits, mw } from '../format'
import { Section } from './Bits'

const STATUS: Record<PlantSale['status'], string> = { listing: 'listing on NEAR…', listed: 'for sale', buying: 'being bought…', sold: 'sold', cancelled: 'withdrawn', failed: "didn't list" }

export function PlantSales({ v }: { v: RegionView }) {
  const [sales, setSales] = useState<PlantSale[] | null>(null)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
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
    } catch (e) {
      setMsg({ text: (e as Error).message, ok: false })
    } finally {
      setBusy(false)
    }
  }
  const open = (sales ?? []).filter((s) => s.status === 'listed' || s.status === 'buying' || s.status === 'listing')
  const listed = new Set(open.filter((s) => s.mine).map((s) => s.name))
  return (
    <Section title="Plants for sale">
      <p className="fine">Companies sell whole plants to each other. Buying one moves your credits to the seller and the plant's NFT to you in one transaction, then the plant joins your grid where it stands.</p>
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
                <button className="btn primary small" disabled={busy || v.pulse.cashCc < s.priceCc} onClick={() => void run(() => regionApi.buyPlant(s.saleId), `Buying ${s.name}: it joins your grid once the sale is confirmed.`)}>
                  Buy
                </button>
              )
            )}
            {s.tokenUrl && (
              <a className="tx-link" href={s.tokenUrl} target="_blank" rel="noreferrer">
                its NFT ↗
              </a>
            )}
          </div>
          {s.detail && <small className="fine">{s.detail}</small>}
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
            Price ₡
            <input type="number" min={100} step={1000} value={price} onChange={(e) => setPrice(Math.max(100, Number(e.target.value) || 100))} />
          </label>
          <button className="btn small" disabled={busy || !plantId} onClick={() => void run(() => regionApi.listPlant(plantId, Math.round(price * 100)), 'Listed for other companies.')}>
            List it
          </button>
        </div>
      )}
      {msg && <p className={msg.ok ? 'ok-line' : 'warn-line'}>{msg.text}</p>}
    </Section>
  )
}
