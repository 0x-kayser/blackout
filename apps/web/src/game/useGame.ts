import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  clearGuestUpgradeToken,
  explainError,
  GameStream,
  guestUpgradeToken,
  setBearer,
  setGameRun,
  startGuestSession,
  BlackoutApiError,
  type ConnectionStatus,
  type EconomyEvent,
  type GameStatePublic,
  type PlayerAction,
  type PlayerProfile,
  type PublicConfig,
} from '../api/client'
import { currentSession, initSupabase, signOutProvider } from '../api/auth'

export type Toast = { id: number; tone: 'info' | 'good' | 'bad'; text: string }
type Listener = (e: EconomyEvent) => void

const TOAST_EVENTS: Partial<Record<EconomyEvent['type'], Toast['tone']>> = {
  SERVICE_STARTED: 'good',
  CONTRACT_COMPLETED: 'good',
  TRADE_CONFIRMED: 'good',
  UPGRADE_PURCHASED: 'good',
  DISTRICT_UNLOCKED: 'good',
  CUSTOMER_COUNTERED: 'info',
  CUSTOMER_REJECTED_COUNTER: 'bad',
  CONTRACT_FAILED: 'bad',
  GENERATOR_BROKEN: 'bad',
  OVERHEAT_WARNING: 'bad',
  RIVAL_WON_CONTRACT: 'bad',
  TRADE_FAILED: 'bad',
  GOAL_COMPLETED: 'good',
  STAGE_REACHED: 'good',
  WORLD_EVENT_STARTED: 'info',
  SUBSTATION_UPGRADED: 'good',
  EXCHANGE_PRICE_SIGNAL: 'info',
  STREAK_UPDATED: 'good',
  CODE_RED_CALLED: 'bad',
  CODE_RED_MISSED: 'bad',
  EXCHANGE_SALE_PAID: 'good',
  PLAYER_LISTING_FILLED: 'good',
  PLAYER_LISTING_FAILED: 'bad',
  REQUEST_EXPIRED: 'bad',
  MERCHANT_CLOSED: 'info',
  REGULATOR_NOTICE: 'info',
}

export function useGame() {
  const [config, setConfig] = useState<PublicConfig | null>(null)
  const [player, setPlayer] = useState<PlayerProfile | null>(null)
  const [state, setState] = useState<GameStatePublic | null>(null)
  const [events, setEvents] = useState<EconomyEvent[]>([])
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [booting, setBooting] = useState(true)
  const [bootError, setBootError] = useState<string | null>(null)
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [toasts, setToasts] = useState<Toast[]>([])
  const [awayMs, setAwayMs] = useState(0)
  const [chapter, setChapter] = useState<EconomyEvent | null>(null)
  const [playing, setPlaying] = useState<'city' | 'challenge'>('city')
  const stream = useRef<GameStream | null>(null)
  const seen = useRef(new Set<number>())
  const listeners = useRef(new Set<Listener>())
  const toastId = useRef(0)
  /** Events at or below this seq existed before we (re)entered the city: show in news, never toast/animate. */
  const historyCutoff = useRef(0)

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = ++toastId.current
    // at most three on screen; the news ticker carries everything else
    setToasts((t) => [...t.filter((x) => x.text !== text).slice(-2), { id, tone, text }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6500)
  }, [])

  const addEvents = useCallback(
    (evs: EconomyEvent[], fromHistory = false) => {
      const fresh = evs.filter((e) => !seen.current.has(e.seq))
      if (!fresh.length) return
      for (const e of fresh) {
        seen.current.add(e.seq)
        stream.current?.setLastSeq(e.seq)
        if (!fromHistory && e.seq > historyCutoff.current) {
          for (const l of listeners.current) l(e)
          if (e.type === 'CHAPTER_COMPLETED') setChapter(e)
          // the rival's own deliveries are news, not something the player needs to act on
          const tone = e.type === 'SERVICE_STARTED' && e.data.provider !== 'player' ? undefined : TOAST_EVENTS[e.type]
          if (tone) toast(e.explanation.split('. ').slice(0, 2).join('. '), tone)
        }
      }
      setEvents((old) => [...old, ...fresh].slice(-120))
    },
    [toast],
  )

  const onEvent = useCallback((l: Listener) => {
    listeners.current.add(l)
    return () => {
      listeners.current.delete(l)
    }
  }, [])

  /** Boot: config -> provider session (if any) -> existing player (guest cookie or token). */
  const boot = useCallback(async () => {
    setBooting(true)
    setBootError(null)
    try {
      const cfg = await api.config()
      setConfig(cfg)
      await initSupabase(cfg)
      await currentSession()
      try {
        const me = await api.me()
        setPlayer(me.player)
        // Supabase sign-in creates a separate player, so link the guest city to it. Direct Google
        // and local email sign-in upgrade the guest player in place and need no second link call.
        const guestToken = guestUpgradeToken()
        if (me.player.kind === 'registered' && !me.player.activeRunId && guestToken && me.player.identities.some((identity) => identity.provider === 'supabase')) {
          try {
            const linked = await api.linkGuest(guestToken)
            setPlayer(linked.player)
            if (linked.player.activeRunId) toast('Signed in. Your city is saved to your account.', 'good')
          } catch (e) {
            if (e instanceof BlackoutApiError && e.code === 'ACCOUNT_EXISTS') toast('This account already had a city; your guest city was left untouched.', 'info')
          }
        }
        if (me.player.kind === 'registered') clearGuestUpgradeToken()
      } catch (e) {
        if (!(e instanceof BlackoutApiError && e.code === 'UNAUTHORIZED')) throw e
        setPlayer(null)
      }
    } catch (e) {
      setBootError(explainError(e))
    } finally {
      setBooting(false)
    }
  }, [toast])

  useEffect(() => {
    void boot()
  }, [boot])

  const playAsGuest = useCallback(async () => {
    await startGuestSession()
    const me = await api.me()
    setPlayer(me.player)
    return me.player
  }, [])

  const openStream = useCallback(() => {
    stream.current?.close()
    const s = new GameStream(
      (st) => setState(st),
      (ev) => addEvents([ev]),
      (st) => setStatus(st),
    )
    stream.current = s
    s.open()
  }, [addEvents])

  /** This week's challenge: same seed and world conditions for every player, 3 game days, ranked. */
  const enterChallenge = useCallback(async () => {
    const res = await api.startChallenge()
    setGameRun(res.state.run.runId)
    setPlaying('challenge')
    seen.current.clear()
    setEvents([])
    historyCutoff.current = res.state.lastEventSeq
    setState(res.state)
    setAwayMs(0)
    openStream()
    return res
  }, [openStream])

  const enterGame = useCallback(
    async (fresh = false) => {
      setGameRun(null)
      setPlaying('city')
      const res = await api.startGame(fresh)
      seen.current.clear()
      setEvents([])
      historyCutoff.current = res.state.lastEventSeq
      setState(res.state)
      setAwayMs(res.awayMs)
      const me = await api.me()
      setPlayer(me.player)
      stream.current?.close()
      const s = new GameStream(
        (st) => setState(st),
        (ev) => addEvents([ev]),
        (st) => setStatus(st),
      )
      stream.current = s
      // replay recent history silently (no toasts/effects), then go live
      s.setLastSeq(0)
      s.open()
      return res
    },
    [addEvents],
  )

  useEffect(() => () => stream.current?.close(), [])

  /** Sends one player intent. A second click on the same control is ignored while in flight. */
  const act = useCallback(
    async (action: PlayerAction, label: string): Promise<Record<string, unknown> | null> => {
      if (pending.has(label)) return null
      setPending((p) => new Set(p).add(label))
      const key = crypto.randomUUID()
      try {
        const res = await api.act(action, key)
        if (!res.ok) throw new BlackoutApiError(res.error.code, res.error.message, 422)
        setState(res.state)
        addEvents(res.events)
        return res.result
      } catch (e) {
        toast(explainError(e), 'bad')
        if (e instanceof BlackoutApiError && e.code === 'STALE_STATE') {
          const st = await api.state().catch(() => null)
          if (st) setState(st.state)
        }
        return null
      } finally {
        setPending((p) => {
          const n = new Set(p)
          n.delete(label)
          return n
        })
      }
    },
    [pending, addEvents, toast],
  )

  const logout = useCallback(async () => {
    stream.current?.close()
    await api.logout().catch(() => null)
    await signOutProvider()
    setBearer(null)
    setPlayer(null)
    setState(null)
    setEvents([])
  }, [])

  const refreshPlayer = useCallback(async () => {
    const me = await api.me()
    setPlayer(me.player)
  }, [])

  return { config, player, state, events, status, booting, bootError, pending, toasts, awayMs, chapter, setChapter, playing, toast, boot, playAsGuest, enterGame, enterChallenge, act, logout, onEvent, refreshPlayer, setAwayMs }
}

export type Game = ReturnType<typeof useGame>
