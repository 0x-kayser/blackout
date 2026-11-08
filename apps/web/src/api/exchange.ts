/**
 * Shared Vesper Fuel Exchange client. The server is authoritative; these types mirror its views.
 */
import { z } from 'zod'
import { BlackoutApiError, type GameStatePublic } from '@blackout/shared'
import { bearerHeader } from './client'

export type OwnerRef = { kind: 'player' | 'trader'; id: string }
export interface TraderView {
  traderId: string
  name: string
  blurb: string
  person: string
  face: string
  status: 'normal' | 'short' | 'cash_strapped' | 'overstocked'
  stockMl: number
  cashCc: number
  askCcPerL: number | null
  bidCcPerL: number | null
  bidRoomMl: number
  explanation: string
}
export interface BookView {
  tick: number
  day: number
  replacementCcPerL: number
  asks: { priceCcPerL: number; quantityMl: number; orders: number }[]
  bestAskCcPerL: number | null
  bestBidCcPerL: number | null
  lastPriceCcPerL: number | null
  traders: TraderView[]
  history: { day: number; volumeMl: number; lastPriceCcPerL: number | null; bestAskCcPerL: number | null; bestBidCcPerL: number | null }[]
}
export interface OrderView {
  orderId: string
  owner: OwnerRef
  quantityMl: number
  filledMl: number
  reservedMl: number
  unitPriceCcPerL: number
  status: 'placing' | 'open' | 'cancelling' | 'filled' | 'cancelled' | 'rejected'
  cancelReason: 'owner' | 'expired' | 'reprice' | null
}
export interface FillView {
  fillId: string
  orderId: string
  seller: OwnerRef
  buyer: OwnerRef
  quantityMl: number
  unitPriceCcPerL: number
  totalCc: number
  status: 'pending' | 'settled' | 'failed'
  txHash: string | null
}
export interface ExchangeEventView {
  seq: number
  tick: number
  type: string
  actors: string[]
  explanation: string
  data: Record<string, unknown>
}
export interface MeView {
  warehouseMl: number
  pendingDepositMl: number
  pendingRedeemMl: number
  depositLeftTodayMl: number
  estimatedDailyFeeCc: number
  orders: OrderView[]
  fills: FillView[]
  chainId: string | null
  recent: ExchangeEventView[]
}
export interface ExchangeView {
  ok: true
  mode: 'sandbox' | 'testnet'
  note: string
  canTrade: boolean
  blockedReason: string | null
  depositableFuelMl: number
  book: BookView
  me: MeView | null
}
export interface ExchangeWrite {
  ok: true
  replayed: boolean
  exchange: Omit<ExchangeView, 'canTrade' | 'blockedReason' | 'depositableFuelMl'>
  state: GameStatePublic
  [k: string]: unknown
}
export interface BuyQuote {
  legs: { orderId: string; quantityMl: number; unitPriceCcPerL: number; totalCc: number }[]
  quantityMl: number
  totalCc: number
  averageCcPerL: number | null
}

const any = <T,>() => z.any() as unknown as z.ZodType<T>

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...bearerHeader() },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new BlackoutApiError('INTERNAL', 'Cannot reach the game server. Check your connection.', 0)
  }
  const json: any = await res.json().catch(() => null)
  if (!json) throw new BlackoutApiError('INTERNAL', `Server error (${res.status}).`, res.status)
  if (json.ok === false && json.error) throw new BlackoutApiError(json.error.code, json.error.message, res.status, json.error.details)
  return any<T>().parse(json)
}

const key = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`)

export const exchangeApi = {
  view: () => call<ExchangeView>('GET', '/api/exchange'),
  quote: (quantityMl: number, maxPriceCcPerL: number | null = null) => call<{ ok: true; quote: BuyQuote }>('POST', '/api/exchange/quote', { quantityMl, maxPriceCcPerL }),
  deposit: (quantityMl: number) => call<ExchangeWrite>('POST', '/api/exchange/deposit', { quantityMl, idempotencyKey: key() }),
  redeem: (quantityMl: number) => call<ExchangeWrite>('POST', '/api/exchange/redeem', { quantityMl, idempotencyKey: key() }),
  ask: (quantityMl: number, unitPriceCcPerL: number) => call<ExchangeWrite>('POST', '/api/exchange/asks', { quantityMl, unitPriceCcPerL, idempotencyKey: key() }),
  cancel: (orderId: string) => call<ExchangeWrite>('POST', `/api/exchange/asks/${encodeURIComponent(orderId)}/cancel`, {}),
  buy: (quantityMl: number, maxPriceCcPerL: number | null = null) => call<ExchangeWrite>('POST', '/api/exchange/buy', { quantityMl, maxPriceCcPerL, idempotencyKey: key() }),
}
