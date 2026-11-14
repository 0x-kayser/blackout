/**
 * The single client boundary between the UI and the authoritative game server.
 * - Same-origin `/api` (Vite proxies it in dev; the API serves this app in prod).
 * - Auth: guests and Privy Google/email use BLACKOUT HTTP-only server cookies. Legacy Supabase
 *   sessions use an access token sent as a bearer header. SSE streams use ?token= when bearer auth applies.
 * - Every action carries a fresh idempotency key; retries of the same intent reuse it.
 * - The UI never computes prices, capacity, payments or outcomes: it renders GameStatePublic
 *   and animates EconomyEvents from the server.
 */
import {
  ActionResultSchema,
  BlackoutApiError,
  CompareResponseSchema,
  GameStateResponseSchema,
  LeaderboardResponseSchema,
  MeResponseSchema,
  RunStateResponseSchema,
  PublicConfigSchema,
  ReplayResponseSchema,
  type ActionResult,
  type CompareResponse,
  type EconomyEvent,
  type ErrorCode,
  type GameStatePublic,
  type PlayerAction,
  type PlayerProfile,
  type PublicConfig,
  type ReplaySummary,
} from '@blackout/shared'
import type { z } from 'zod'

export type { GameStatePublic, EconomyEvent, PlayerAction, PlayerProfile, PublicConfig }

let bearer: string | null = null
export const setBearer = (t: string | null) => {
  bearer = t
}
export const bearerHeader = (): Record<string, string> => (bearer ? { authorization: `Bearer ${bearer}` } : {})

/** Which run the UI is playing: the player's city (/api/game) or a specific run (weekly challenge). */
let gameBase = '/api/game'
export const setGameRun = (runId: string | null) => {
  gameBase = runId ? `/api/runs/${encodeURIComponent(runId)}` : '/api/game'
}
const LooseStateSchema = RunStateResponseSchema.extend({ resumed: GameStateResponseSchema.shape.resumed.optional(), awayMs: GameStateResponseSchema.shape.awayMs.optional() })

async function call<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      signal,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new BlackoutApiError('INTERNAL', 'Cannot reach the game server. Check your connection.', 0)
  }
  const json: any = await res.json().catch(() => null)
  if (!json) throw new BlackoutApiError('INTERNAL', `Server error (${res.status}).`, res.status)
  if (json.ok === false && json.error) throw new BlackoutApiError(json.error.code, json.error.message, res.status, json.error.details)
  return schema.parse(json)
}

export const api = {
  config: () => call('GET', '/api/config/public', PublicConfigSchema),
  me: () => call('GET', '/api/me', MeResponseSchema),
  rename: (displayName: string) => call('PATCH', '/api/me', MeResponseSchema, { displayName }),
  logout: () => fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: '{}' }),
  /** Without a token the server links the guest city held by this browser's guest cookie. */
  linkGuest: (guestToken?: string | null) => call('POST', '/api/auth/link-guest', MeResponseSchema, guestToken ? { guestToken } : {}),
  startGame: (fresh = false) => call('POST', '/api/game/start', GameStateResponseSchema, { fresh }),
  state: () => call('GET', `${gameBase}/state`, LooseStateSchema),
  act: (action: PlayerAction, idempotencyKey: string) => call('POST', `${gameBase}/actions`, ActionResultSchema, { action, idempotencyKey }),
  startChallenge: () => call('POST', '/api/challenge/start', GameStateResponseSchema, {}),
  leaderboard: () => call('GET', '/api/challenge/leaderboard', LeaderboardResponseSchema),
  compare: (seed: number, scenarioId: string, a: string, b: string, condition = 'calm') =>
    call('POST', '/api/replays/compare', CompareResponseSchema, { seed, scenarioId, policies: [a, b], days: 7, condition }),
  replay: (seed: number, scenarioId: string, policyId: string) => call('POST', '/api/replays', ReplayResponseSchema, { seed, scenarioId, policyId, days: 7 }),
  replayTraceUrl: (id: string) => `/api/replays/${encodeURIComponent(id)}/events?format=json`,
  replayStreamUrl: (id: string, seconds = 60) => `/api/replays/${encodeURIComponent(id)}/events?seconds=${seconds}`,
}

/** Guest session: the server sets an HTTP-only cookie; we keep the token only to support a later upgrade. */
export async function startGuestSession(): Promise<void> {
  const res = await fetch('/api/session/start', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{"kind":"guest"}' })
  const json = await res.json()
  if (!json.ok) throw new BlackoutApiError(json.error?.code ?? 'INTERNAL', json.error?.message ?? 'Could not start a guest session.', res.status)
  try {
    sessionStorage.setItem('bo_guest_upgrade', json.token) // only used to link this guest city to a real account
  } catch {
    /* storage unavailable: upgrade path simply won't be offered */
  }
}

export const guestUpgradeToken = () => {
  try {
    return sessionStorage.getItem('bo_guest_upgrade')
  } catch {
    return null
  }
}
export const clearGuestUpgradeToken = () => {
  try {
    sessionStorage.removeItem('bo_guest_upgrade')
  } catch {
    /* ignore */
  }
}

/** Human-readable explanation for every server error code (no guessing in components). */
export const ERROR_TEXT: Partial<Record<ErrorCode, string>> = {
  CAPACITY_EXCEEDED: 'No online source has enough unreserved capacity.',
  GENERATOR_OFFLINE: 'That generator is offline.',
  INSUFFICIENT_FUEL: 'Not enough unreserved diesel. Buy fuel in the Marketplace.',
  INSUFFICIENT_PERMITS: 'Not enough unreserved carbon allowance. Buy permits in the Marketplace.',
  INSUFFICIENT_CREDITS: 'Not enough credits.',
  CUSTOMER_CANNOT_PAY: 'The customer cannot fund that contract.',
  REQUEST_EXPIRED: 'Too late: the customer gave up waiting.',
  MAX_COUNTERS_REACHED: 'This customer has no more counteroffers. Accept or decline.',
  QUOTE_EXPIRED: 'That quote expired. Ask for a fresh price.',
  OUT_OF_STOCK: 'The seller does not have that much.',
  RATION_LIMIT: 'The seller is rationing; buy less.',
  MERCHANT_CLOSED: 'That seller is closed.',
  TANK_FULL: 'Your tank cannot hold that much.',
  REQUIREMENT_NOT_MET: 'Requirements not met yet.',
  ALREADY_PROCESSED: 'This action is already complete.',
  RATE_LIMITED: 'Slow down a little.',
  UNAUTHORIZED: 'Your session expired. Please sign in again.',
}
export const explainError = (e: unknown): string => {
  if (e instanceof BlackoutApiError) return `${ERROR_TEXT[e.code] ?? ''} ${e.message}`.trim()
  return e instanceof Error ? e.message : 'Something went wrong.'
}

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'offline'

/**
 * Live game stream. EventSource reconnects by itself and resends Last-Event-ID; we also
 * dedupe by seq and resync the full state on every (re)connect.
 */
export class GameStream {
  private es: EventSource | null = null
  private lastSeq = 0
  private closed = false
  constructor(
    private readonly onState: (s: GameStatePublic) => void,
    private readonly onEvent: (e: EconomyEvent) => void,
    private readonly onStatus: (s: ConnectionStatus) => void,
  ) {}

  open(): void {
    this.closed = false
    this.onStatus('connecting')
    const qs = new URLSearchParams()
    if (bearer) qs.set('token', bearer)
    if (this.lastSeq) qs.set('lastEventId', String(this.lastSeq))
    const es = new EventSource(`${gameBase}/events${qs.toString() ? `?${qs}` : ''}`, { withCredentials: true })
    this.es = es
    es.addEventListener('open', () => this.onStatus('live'))
    es.addEventListener('state', (m) => this.onState(JSON.parse((m as MessageEvent).data)))
    es.addEventListener('economy', (m) => {
      const ev = JSON.parse((m as MessageEvent).data) as EconomyEvent
      if (ev.seq <= this.lastSeq) return
      this.lastSeq = ev.seq
      this.onEvent(ev)
    })
    es.addEventListener('error', () => {
      if (this.closed) return
      this.onStatus(navigator.onLine ? 'reconnecting' : 'offline')
      if (es.readyState === EventSource.CLOSED) {
        // the browser gave up (e.g. 401 after token expiry): reopen with a fresh token shortly
        setTimeout(() => !this.closed && this.open(), 2500)
      }
    })
  }

  setLastSeq(seq: number) {
    this.lastSeq = Math.max(this.lastSeq, seq)
  }

  close(): void {
    this.closed = true
    this.es?.close()
    this.es = null
  }
}

export type { ActionResult, CompareResponse, ReplaySummary }
export { BlackoutApiError }
