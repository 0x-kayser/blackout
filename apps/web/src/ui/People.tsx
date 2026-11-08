import { useEffect, useState } from 'react'
import { api, type ChainStatusResponse } from '../api/client'
import type { Game } from '../game/useGame'
import { Drawer } from './Panels'
import { useExchange } from './Exchange'
import { MOOD_ICON, fmtCredits, fmtKw, fmtLitres } from './format'

const STATUS: Record<string, { label: string; tone: string }> = {
  normal: { label: 'trading', tone: 'teal' },
  short: { label: 'rationing', tone: 'coral' },
  cash_strapped: { label: 'out of cash', tone: 'amber' },
  overstocked: { label: 'overstocked', tone: 'blue' },
}

/**
 * Everyone in Vesper City: the NPC traders with their own wallets, the town's fuel merchants, the rival, and the
 * people behind every building you can power.
 */
export function PeoplePanel({ g, onClose }: { g: Game; onClose: () => void }) {
  const s = g.state!
  const { view } = useExchange()
  const [cs, setCs] = useState<ChainStatusResponse | null>(null)
  useEffect(() => {
    api.chain().then(setCs, () => undefined)
  }, [])
  const live = cs?.exchange?.mode === 'testnet'
  const accountOf = (traderId: string) => cs?.exchange?.traderAccounts.find((t) => t.traderId === traderId)?.accountId ?? null
  const connected = new Set(s.districts.filter((d) => d.unlocked).map((d) => d.districtId))
  return (
    <Drawer title="People of Vesper" eyebrow="WHO TRADES, WHO SELLS, WHO NEEDS YOUR POWER" onClose={onClose} wide>
      <section>
        <p className="eyebrow amber">NPC WALLETS · THE FUEL TRADERS</p>
        <p className="fine">
          These traders own their fuel and their money. Each has its own wallet{live ? ' on NEAR testnet and signs its own trades' : ' (on this server: NEAR testnet is not connected, so the same balances live in the game ledger)'}. They supply every town's fuel merchants, buy cheap offers on the Exchange and import when they run low. When they run short, diesel gets dearer in every city.
        </p>
        <div className="people-grid">
          {(view?.book.traders ?? []).map((t) => (
            <article key={t.traderId} className="person wallet">
              <div className="person-head">
                <span className="face" aria-hidden>{t.face}</span>
                <div>
                  <b>{t.person}</b>
                  <small>{t.name}</small>
                </div>
                <span className={`pill ${STATUS[t.status]?.tone ?? ''}`}>{STATUS[t.status]?.label ?? t.status}</span>
              </div>
              <p className="fine"><i>{t.blurb}</i></p>
              <div className="wallet-row">
                <span>👛 Wallet</span>
                <b>{fmtLitres(t.stockMl)} diesel</b>
                <b>{fmtCredits(t.cashCc)}</b>
              </div>
              <p className="fine">Sells at {t.askCcPerL ? `${fmtCredits(t.askCcPerL)}/L` : '— (rationing)'} · buys at {t.bidCcPerL ? `${fmtCredits(t.bidCcPerL)}/L` : '—'}</p>
              <details>
                <summary>Why these prices?</summary>
                <p className="fine">{t.explanation}</p>
              </details>
              {live && accountOf(t.traderId) && (
                <a className="fine" href={`https://testnet.nearblocks.io/address/${accountOf(t.traderId)}`} target="_blank" rel="noreferrer">{accountOf(t.traderId)} ↗</a>
              )}
            </article>
          ))}
          {!view && <p className="fine">Loading the traders…</p>}
        </div>
      </section>

      <section>
        <p className="eyebrow amber">YOUR TOWN'S FUEL MERCHANTS</p>
        <div className="people-grid">
          {s.merchants.map((m) => (
            <article key={m.merchantId} className="person">
              <div className="person-head">
                <span className="face" aria-hidden>⛽</span>
                <div><b>{m.name}</b><small>{m.style}</small></div>
                <span className={`pill ${m.status === 'open' ? 'teal' : 'coral'}`}>{m.status}</span>
              </div>
              <div className="wallet-row"><span>Stock</span><b>{fmtLitres(m.stockMl)}</b><b>{fmtCredits(m.cashCc)}</b></div>
              <p className="fine">Sells at {fmtCredits(m.quoteCcPerL)}/L · restocks from the traders above</p>
            </article>
          ))}
          <article className="person rival">
            <div className="person-head">
              <span className="face" aria-hidden>🧑🏼‍💼</span>
              <div><b>Victor Lane</b><small>{s.rival.name}, your rival</small></div>
              <span className="pill coral">{fmtKw(s.rival.ratedW)}</span>
            </div>
            <div className="wallet-row"><span>Reserves</span><b>{fmtLitres(s.rival.fuelMl)}</b><b>{fmtCredits(s.rival.cashCc)}</b></div>
            <p className="fine">Charges {fmtCredits(s.rival.tariffCcPerKwh)}/kWh and takes every customer you miss.</p>
          </article>
        </div>
      </section>

      <section>
        <p className="eyebrow amber">THE PEOPLE YOU POWER · {s.businesses.length} BUILDINGS</p>
        {s.districts.map((d) => {
          const people = s.businesses.filter((b) => b.districtId === d.districtId)
          return (
            <div key={d.districtId} className="people-district">
              <p className="people-district-name">{connected.has(d.districtId) ? '⚡' : '🔒'} {d.name} <small>{people.length} buildings · {fmtKw(d.totalDemandW)}</small></p>
              <ul className="people-list">
                {people.map((b) => (
                  <li key={b.businessId} className={connected.has(d.districtId) ? '' : 'locked'}>
                    <span className="face" aria-hidden>{b.owner?.face ?? '🏢'}</span>
                    <span><b>{b.owner?.name ?? b.name}</b> <small>{b.name} · {fmtKw(b.demandW)}</small><em>{b.owner?.trait}</em></span>
                    <span className="people-state">{connected.has(d.districtId) ? `${MOOD_ICON[b.mood]} ${b.powerSource === 'player' ? 'your power' : b.powerSource === 'rival' ? 'VoltLine' : b.powerSource === 'none' ? 'dark' : 'grid'}` : 'not connected'}</span>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </section>
    </Drawer>
  )
}
