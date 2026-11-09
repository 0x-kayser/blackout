/**
 * Region client: REST for decisions, one SSE stream for the live view. Auth is the same as the rest of the game
 * (guest cookie, or a bearer token which the stream sends as ?token=).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { EconomyView, FastForwardResult, ItemId, RegionAction, RegionView, TownView } from '@blackout/shared'
import { bearerHeader } from '../api/client'

export class RegionError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message)
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { method, credentials: 'same-origin', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...bearerHeader() }, body: body !== undefined ? JSON.stringify(body) : undefined })
  } catch {
    throw new RegionError('OFFLINE', 'Cannot reach the game server. Check your connection and try again.', 0)
  }
  const json = (await res.json().catch(() => null)) as any
  if (!json) throw new RegionError('INTERNAL', `The server answered ${res.status}. Try again in a moment.`, res.status)
  if (json.ok === false) {
    const err = new RegionError(json.error?.code ?? 'INTERNAL', friendly(json.error?.code, json.error?.message), res.status) as RegionError & { view?: RegionView }
    err.view = json.view
    throw err
  }
  return json as T
}

/** Friendly words for codes the engine may return (§57). */
function friendly(code: string | undefined, message: string | undefined): string {
  if (code === 'RATE_LIMITED') return 'Easy — one decision at a time. Try again in a second.'
  if (code === 'UNAUTHORIZED') return 'Your session ended. Reload to continue.'
  if (code === 'VALIDATION_FAILED') return 'That request didn’t make sense to the server. Reload and try again.'
  return message ?? 'Something went wrong.'
}

let keyN = 0
const newKey = () => `${Date.now().toString(36)}-${(++keyN).toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export const regionApi = {
  live: () => call<{ ok: true; view: RegionView }>('GET', '/api/region'),
  create: (mode: 'live' | 'challenge') => call<{ ok: true; view: RegionView }>('POST', '/api/region/new', { mode }),
  get: (id: string) => call<{ ok: true; view: RegionView }>('GET', `/api/region/${encodeURIComponent(id)}`),
  act: (id: string, action: RegionAction, idempotencyKey: string) => call<{ ok: boolean; message?: string; view: RegionView; replayed?: boolean }>('POST', `/api/region/${encodeURIComponent(id)}/actions`, { action, idempotencyKey }),
  epochs: (id: string) => call<{ ok: true; epochs: EpochDetail[] }>('GET', `/api/region/${encodeURIComponent(id)}/epochs`),
  leaderboard: () => call<{ ok: true; entries: LeaderboardRow[] }>('GET', '/api/region/leaderboard'),
  lab: (seed: number, days = 7) => call<{ ok: true; lab: { gasHeavy: LabResult; solarStorage: LabResult } }>('GET', `/api/region/lab?seed=${seed}&days=${days}`),
  town: () => call<{ ok: true; town: TownView }>('GET', '/api/town'),
  trade: (merchantId: string, item: ItemId, side: 'buy' | 'sell', quantity: number) => call<{ ok: true; message: string; view: RegionView; town: TownView }>('POST', '/api/town/trade', { merchantId, item, side, quantity, idempotencyKey: newKey() }),
  invest: (merchantId: string, amountCc: number) => call<{ ok: true; message: string; view: RegionView; town: TownView }>('POST', '/api/town/invest', { merchantId, amountCc, idempotencyKey: newKey() }),
  fastForward: (seed: number) => call<{ ok: true; week: FastForwardResult }>('GET', `/api/town/fastforward?seed=${seed}`),
  chain: () => call<{ ok: true; mode: string; network?: string; resourceContractId?: string | null; missing?: string[] }>('GET', '/api/chain/status'),
  economy: () => call<{ ok: true; economy: EconomyView }>('GET', '/api/economy'),
  setDesk: (d: { sell: boolean; markupBps: number }) => call<{ ok: true; economy: EconomyView }>('POST', '/api/economy/desk', d),
}

export interface EpochDetail {
  epochNo: number
  epochId: string
  fromInterval: number
  toInterval: number
  transfers: { account: string; deltaCc: number }[]
  plants: { assetId: string; ownerId: string; lifetimeKwh: number; lifetimeRevenueCc: number; status: string }[]
  stateDigest: string
  hash: string
  status: string
  txHash: string | null
  verified: boolean
}
export interface LeaderboardRow {
  rank: number
  name: string
  score: number
  profitCc: number
  unservedMWh: number
  emissionsT: number
  regionOutputBps: number
  regionId: string
}
export interface LabResult {
  strategy: string
  profitCc: number
  cashCc: number
  unservedMWh: number
  emissionsT: number
  avgPriceCcPerMWh: number
  regionOutputBps: number
  score: number
  frames: { interval: number; label: string; demandKw: number; availableKw: number; shedKw: number; priceCcPerMWh: number; playerKw: number; cashCc: number }[]
  events: { interval: number; title: string; severity: string }[]
  traceHash: string
}

export type Connection = 'connecting' | 'live' | 'reconnecting'


/** The live region: the latest view, the connection state, and `act` for decisions. */
export function useRegion(regionId: string | null) {
  const [view, setView] = useState<RegionView | null>(null)
  const [town, setTown] = useState<TownView | null>(null)
  const [conn, setConn] = useState<Connection>('connecting')
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (!regionId) return
    let closed = false
    let retry: ReturnType<typeof setTimeout> | null = null
    const open = () => {
      if (closed) return
      const qs = new URLSearchParams()
      const auth = bearerHeader().authorization
      if (auth) qs.set('token', auth.replace(/^Bearer /, ''))
      const es = new EventSource(`/api/region/${encodeURIComponent(regionId)}/stream${qs.toString() ? `?${qs}` : ''}`, { withCredentials: true })
      esRef.current = es
      es.addEventListener('view', (e) => {
        setView(JSON.parse((e as MessageEvent).data) as RegionView)
        setConn('live')
      })
      es.addEventListener('town', (e) => setTown(JSON.parse((e as MessageEvent).data) as TownView))
      es.onerror = () => {
        setConn('reconnecting')
        if (es.readyState === EventSource.CLOSED) {
          es.close()
          retry = setTimeout(open, 2_000)
        }
      }
    }
    open()
    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      esRef.current?.close()
    }
  }, [regionId])

  const act = useCallback(
    async (action: RegionAction): Promise<{ ok: boolean; message: string }> => {
      if (!regionId) return { ok: false, message: 'No region yet.' }
      try {
        const r = await regionApi.act(regionId, action, newKey())
        setView(r.view)
        return { ok: true, message: r.message ?? 'Done.' }
      } catch (e) {
        const err = e as RegionError & { view?: RegionView }
        if (err.view) setView(err.view)
        return { ok: false, message: err.message }
      }
    },
    [regionId],
  )

  /** Trade with or invest in a Vesper Market merchant. */
  const market = useCallback(async (run: () => Promise<{ message: string; view: RegionView; town: TownView }>): Promise<{ ok: boolean; message: string }> => {
    try {
      const r = await run()
      setView(r.view)
      setTown(r.town)
      return { ok: true, message: r.message }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  }, [])

  return { view, setView, town, setTown, conn, act, market }
}
