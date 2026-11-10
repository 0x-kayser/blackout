/**
 * BLACKOUT — the regional power game. World first (§32): the region fills the screen, the System Pulse sits on
 * top, the dock at the bottom, the inspector beside whatever you tapped. No menus before play: a guest session
 * starts on its own and the first minute teaches by doing (§55–56).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EconomyView, NodeId, PublicConfig, RegionEvent, RegionView, TechId } from '@blackout/shared'
import { api, BlackoutApiError, clearGuestUpgradeToken, guestUpgradeToken, startGuestSession } from '../api/client'
import { currentSession, initSupabase, signOutProvider } from '../api/auth'
import { bindAudioToPage, enableSound, playCue, setMusicMood, startMusic, stopMusic, unlockAudio, unlockOnFirstGesture, type Cue } from '../audio'
import { regionApi, useRegion } from './api'
import { World3D, type FocusCmd, type Selection, type ZoomLevel } from './scene/World3D'
import { Dock, ModeSheet, type DockMode } from './ui/Dock'
import { Inspector } from './ui/Inspector'
import { PulseBar } from './ui/Pulse'
import { Settings } from './ui/Settings'
import { Feed, Toasts, useNewEvents } from './ui/Story'
import { CELEBRATE, Celebration, MissionBanner, NextMoveBar, missionFor, nextMove } from './ui/Guide'
import { MarketSheet, MerchantInspector, NewsTicker, WatchAWeek, type Trade, type Invest } from './ui/Market'
import { NameCompany } from './ui/Company'
import { Title } from './ui/Title'
import type { TownEvent } from '@blackout/shared'
import './region.css'

type Prefs = { sound: boolean; music: boolean; quality: 'high' | 'low' }
const loadPrefs = (): Prefs => {
  try {
    const p = JSON.parse(localStorage.getItem('bo_prefs') ?? '{}')
    const lowEnd = (navigator.hardwareConcurrency ?? 8) <= 4 || window.matchMedia?.('(max-width: 700px)').matches || navigator.webdriver
    return { sound: !!p.sound, music: p.music ?? true, quality: p.quality ?? (lowEnd ? 'low' : 'high') }
  } catch {
    return { sound: false, music: false, quality: 'high' }
  }
}

const CUE_FOR: Record<string, Cue> = { BLACKOUT: 'siren', RESTORED: 'restore', PLANT_TRIPPED: 'fail', PRICE_SPIKE: 'ping', BUILD_STARTED: 'coin', PLANT_COMMISSIONED: 'restore', TENDER_MET: 'coin', LICENCE: 'coin', PLANT_SOLD: 'coin', BUSINESS_CLOSED: 'fail', VOLTLINE_MOTHBALL: 'fail' }
const TOAST_TYPES = new Set(['BLACKOUT', 'PLANT_TRIPPED', 'PRICE_SPIKE', 'HEATWAVE', 'STORM', 'RATIONING', 'SUPPLY_DISRUPTION', 'CONGESTION', 'BUSINESS_DISTRESS', 'BUSINESS_CLOSED', 'LAYOFFS', 'STEEL_SHORTAGE', 'VOLTLINE_DISTRESS', 'VOLTLINE_MOTHBALL', 'VOLTLINE_BUILDS', 'ASSET_FOR_SALE', 'TENDER_POSTED', 'TENDER_MET', 'TENDER_MISSED', 'LICENCE', 'PLANT_COMMISSIONED', 'LINE_UPGRADED', 'REGULATOR_FINE', 'REGULATOR_MITIGATION', 'BLACKOUT_IMPACT', 'DEMAND_RESPONSE', 'ONBOARDING_DONE', 'CHALLENGE_ENDED', 'FORECLOSURE', 'BUSINESS_REOPENED'])

export default function RegionApp() {
  const [config, setConfig] = useState<PublicConfig | null>(null)
  const [player, setPlayer] = useState<{ playerId: string; displayName: string; kind: string; companyNamed: boolean } | null>(null)
  const [economy, setEconomy] = useState<EconomyView | null>(null)
  const [nameLater, setNameLater] = useState(() => {
    try {
      return sessionStorage.getItem('bo_name_later') === '1'
    } catch {
      return false
    }
  })
  const [renaming, setRenaming] = useState(false)
  const [regionId, setRegionId] = useState<string | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  /** No session yet: show the title screen (play as guest, or sign in) instead of creating a guest on our own. */
  const [entry, setEntry] = useState(false)
  const { view, setView, town, conn, act, market } = useRegion(regionId)
  const [watching, setWatching] = useState(false)
  const viewRef = useRef<RegionView>(null as unknown as RegionView)
  if (view) viewRef.current = view

  const [selection, setSelection] = useState<Selection | null>(null)
  const [mode, setMode] = useState<DockMode | null>(null)
  const [building, setBuilding] = useState<{ tech: TechId; size: number } | null>(null)
  const [buildNode, setBuildNode] = useState<NodeId | null>(null)
  const [focus, setFocus] = useState<FocusCmd | null>(null)
  const [zoom, setZoom] = useState<ZoomLevel>('REGION')
  const [settings, setSettings] = useState(false)
  const [feed, setFeed] = useState(false)
  const [toasts, setToasts] = useState<RegionEvent[]>([])
  const [flash, setFlash] = useState<{ text: string; ok: boolean } | null>(null)
  const flashId = useRef(0)
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs)
  const setPrefs = (p: Prefs) => {
    if (p.sound && !prefs.sound) void enableSound()
    if (p.music && !prefs.music) {
      unlockAudio()
      startMusic()
    }
    if (!p.music && prefs.music) stopMusic()
    setPrefsState(p)
    try {
      localStorage.setItem('bo_prefs', JSON.stringify(p))
    } catch {
      /* per-device convenience only */
    }
  }
  useEffect(() => bindAudioToPage(), [])
  useEffect(() => (prefs.sound || prefs.music ? unlockOnFirstGesture() : undefined), [prefs.sound, prefs.music])
  // music that was on last visit starts again on the first tap (browsers only allow sound after a gesture)
  useEffect(() => {
    if (!prefs.music) return
    const go = () => {
      unlockAudio()
      startMusic()
    }
    window.addEventListener('pointerdown', go, { once: true })
    return () => window.removeEventListener('pointerdown', go)
  }, [prefs.music])

  /* -------------------------------------------------------------- boot: session → region */
  const boot = useCallback(async () => {
    setBootError(null)
    try {
      const cfg = await api.config()
      setConfig(cfg)
      await initSupabase(cfg)
      await currentSession()
      let me
      try {
        me = await api.me()
      } catch (e) {
        if (!(e instanceof BlackoutApiError && e.code === 'UNAUTHORIZED')) throw e
        setEntry(true)
        return
      }
      // this server asks everyone to sign in first: a guest session from before gets the sign-in screen (and keeps
      // its company when it signs in)
      if (!cfg.auth.guestPlay && me.player.kind !== 'registered') {
        setEntry(true)
        return
      }
      setEntry(false)
      if (me.player.kind === 'registered' && guestUpgradeToken()) {
        // Supabase creates a separate registered identity and needs the guest save linked.
        // Direct Google/local email upgrades the guest player in place, so linking it again
        // would send an invalid request and is unnecessary.
        if (me.player.identities.some((identity) => identity.provider === 'supabase')) {
          try {
            me = await api.linkGuest(guestUpgradeToken())
          } catch {
            /* this account already had a save: the guest one stays put */
          }
        }
        clearGuestUpgradeToken()
      }
      setPlayer({ playerId: me.player.playerId, displayName: me.player.displayName, kind: me.player.kind, companyNamed: !!me.player.companyNamed })
      const r = await regionApi.live()
      // a signed-in player's wallet is created (once) as soon as the game opens
      regionApi.economy().then((x) => setEconomy(x.economy), () => undefined)
      setView(r.view)
      setRegionId(r.view.regionId)
    } catch (e) {
      setBootError((e as Error).message || 'Could not reach the game server.')
    }
  }, [setView])
  useEffect(() => {
    void boot()
  }, [boot])

  const playAsGuest = useCallback(async () => {
    await startGuestSession()
    await boot()
  }, [boot])
  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined)
    await signOutProvider().catch(() => undefined)
    setSettings(false)
    setRegionId(null)
    setView(null)
    setPlayer(null)
    await boot()
  }, [boot, setView])

  // the music follows the grid: tense while the region is short of power or dark
  // a guest's wallet is created once they finish the first minute: ask again at that moment
  const onboarded = !!view?.onboarding.done
  useEffect(() => {
    if (onboarded && player) regionApi.economy().then((x) => setEconomy(x.economy), () => undefined)
  }, [onboarded, player?.playerId])

  const gridStatus = view?.pulse.status
  useEffect(() => setMusicMood(gridStatus === 'shortfall' || gridStatus === 'blackout' ? 'tense' : 'calm'), [gridStatus])

  /* -------------------------------------------------------------- market: trades, investments, its news */
  const trade: Trade = useCallback(async (merchantId, item, side, qty) => {
    const r = await market(() => regionApi.trade(merchantId, item, side, qty))
    if (prefs.sound) playCue(r.ok ? 'coin' : 'fail')
    return r
  }, [market, prefs.sound])
  const invest: Invest = useCallback(async (merchantId, amountCc) => {
    const r = await market(() => regionApi.invest(merchantId, amountCc))
    if (prefs.sound) playCue(r.ok ? 'restore' : 'fail')
    return r
  }, [market, prefs.sound])
  const seenTown = useRef<number | null>(null)
  useEffect(() => {
    if (!town) return
    const last = town.events.at(-1)?.seq ?? 0
    if (seenTown.current === null) {
      seenTown.current = last
      return
    }
    const me = player ? `player:${player.playerId}` : null
    for (const e of town.events) if (e.seq > seenTown.current && (e.severity !== 'info' || (e.kind === 'power' && e.who === me))) {
      // the power desk talks to everyone in the feed, but only toasts the deals that involve you
      if (e.kind === 'power' && e.who !== me) continue
      // market news appears like region news, linked to the shop
      const asRegion = { seq: 1_000_000 + e.seq, interval: 0, type: 'MARKET', severity: e.severity, title: e.title, detail: e.detail, nodeId: null, actorId: null, causes: [], quote: null, merchantId: e.merchantId } as RegionEvent & { merchantId: string | null }
      setToasts((t) => [...t.slice(-3), asRegion])
      setTimeout(() => setToasts((t) => t.filter((x) => x.seq !== asRegion.seq)), 8_000)
      if (prefs.sound) playCue(e.severity === 'crisis' ? 'fail' : 'coin')
    }
    seenTown.current = Math.max(seenTown.current, last)
  }, [town?.events.at(-1)?.seq])
  void (null as unknown as TownEvent)

  /* -------------------------------------------------------------- events → sound + toasts */
  useNewEvents(view, (e) => {
    const cue = CUE_FOR[e.type]
    if (cue && prefs.sound) playCue(cue)
    if (TOAST_TYPES.has(e.type)) {
      setToasts((t) => [...t.filter((x) => x.type !== e.type || x.nodeId !== e.nodeId).slice(-3), e])
      const ttl = e.severity === 'crisis' ? 9_000 : 6_000
      setTimeout(() => setToasts((t) => t.filter((x) => x.seq !== e.seq)), ttl)
    }
  })

  const doAct = useCallback(
    async (a: Parameters<typeof act>[0]) => {
      const r = await act(a)
      const id = ++flashId.current
      setFlash({ text: r.message, ok: r.ok })
      if (!r.ok && prefs.sound) playCue('fail')
      // only the latest message clears itself; an older timer never wipes a newer one
      setTimeout(() => flashId.current === id && setFlash(null), 3_500)
      return r
    },
    [act, prefs.sound],
  )

  const select = useCallback((s: Selection | null) => {
    setSelection(s)
    if (s) setFocus({ kind: s.kind, id: s.id, nonce: Date.now() })
  }, [])

  const onBuildAt = (nodeId: NodeId) => {
    setBuildNode(nodeId)
    setMode('build')
    setSelection({ kind: 'node', id: nodeId })
  }

  // each first-minute step: fly to the thing to tap; each step done: celebrate what just changed
  const [celebrate, setCelebrate] = useState<string | null>(null)
  const lastStep = useRef<number | null>(null)
  const step = view ? (view.onboarding.done ? 3 : view.onboarding.step) : null
  useEffect(() => {
    if (step === null || !view) return
    const prev = lastStep.current
    lastStep.current = step
    if (prev !== null && step > prev) {
      setCelebrate(CELEBRATE[Math.min(prev, CELEBRATE.length - 1)])
      if (prefs.sound) playCue('restore')
      setTimeout(() => setCelebrate(null), 2_800)
      setSelection(null)
      if (step >= 3) setFocus({ kind: 'home', id: '', nonce: Date.now() })
    }
    const t = view.onboarding.done ? null : view.onboarding.target
    if (t) {
      // frame the whole district around the thing to tap, so you see the problem and the fix together
      const [kind, id] = t.split(':') as [Selection['kind'], string]
      // centre on the button's spot (a plant, or the build pad's district), pulled back to show what's around it
      setTimeout(() => setFocus({ kind, id, nonce: Date.now(), dist: kind === 'plant' ? 135 : 150 }), prev === null ? 600 : 1_400)
    }
  }, [step])

  const badges = useMemo(() => {
    if (!view) return {}
    const b: Partial<Record<DockMode, string>> = {}
    const idle = view.plants.filter((p) => p.mine && p.fuel && p.status === 'offline').length
    if (idle && view.pulse.reserveKw < 0) b.dispatch = '!'
    if (view.corridors.some((c) => c.congested)) b.grid = String(view.corridors.filter((c) => c.congested).length)
    if (town?.merchants.some((m) => !m.open)) b.market = String(town.merchants.filter((m) => !m.open).length)
    if (view.plants.some((p) => (p.mine && p.listing?.bids.length) || (!p.mine && p.listing))) b.portfolio = '•'
    return b
  }, [view, town])

  if (bootError)
    return (
      <div className="region-boot">
        <h1>BLACKOUT</h1>
        <p>{bootError}</p>
        <button className="btn primary" onClick={() => void boot()}>
          Try again
        </button>
      </div>
    )
  if (entry)
    return (
      <Title
        config={config}
        music={prefs.music}
        onMusic={(on) => setPrefs({ ...prefs, music: on })}
        onGuest={async () => {
          if (prefs.music) {
            unlockAudio()
            startMusic()
          }
          await playAsGuest()
        }}
        onSignedIn={async () => {
          if (prefs.music) {
            unlockAudio()
            startMusic()
          }
          await boot()
        }}
      />
    )
  if (!view)
    return (
      <div className="region-boot">
        <h1>BLACKOUT</h1>
        <p>Bringing the Vesper region online…</p>
      </div>
    )

  /** Name (or rename) the company: the name every other player sees. */
  const renameCompany = async (name: string): Promise<{ ok: boolean; message: string }> => {
    try {
      const me = await api.rename(name)
      setPlayer({ playerId: me.player.playerId, displayName: me.player.displayName, kind: me.player.kind, companyNamed: !!me.player.companyNamed })
      setRenaming(false)
      setFlash({ text: `You're ${me.player.displayName} now. Everyone in Vesper Market sees it.`, ok: true })
      setTimeout(() => setFlash(null), 3_500)
      if (prefs.sound) playCue('coin')
      return { ok: true, message: 'Saved.' }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  }
  const askName = !!player && view.onboarding.done && !player.companyNamed && !nameLater && !celebrate
  const highlight = view.onboarding.done ? null : view.onboarding.target
  const mission = missionFor(view)
  const simple = !view.onboarding.done
  const move = simple ? null : nextMove(view, town)
  const doMove = async () => {
    if (!move) return
    if (move.action) await doAct(move.action)
    else if (move.build) {
      setBuilding(building ?? { tech: 'diesel', size: 1 })
      onBuildAt(move.build)
    } else if (move.trade) await trade(move.trade.merchantId, move.trade.item, move.trade.side, move.trade.qty)
    else if (move.select) select(move.select)
    else if (move.market) setMode('market')
    else setMode('portfolio')
  }
  return (
    <div className={`region-app ${view.pulse.status}`}>
      <World3D
        view={view}
        viewRef={viewRef}
        selection={selection}
        onSelect={select}
        overlay={mode === 'grid' ? 'grid' : 'normal'}
        building={mode === 'build' ? (building ?? { tech: 'diesel', size: 0 }) : null}
        onBuildAt={onBuildAt}
        focus={focus}
        highlight={highlight}
        quality={prefs.quality}
        onZoom={setZoom}
        mission={mission ? { target: mission.target, label: mission.label } : null}
        onMission={() => mission && void act(mission.action).then((r) => !r.ok && setFlash({ text: r.message, ok: false }))}
        simple={simple}
        town={town}
        zoom={zoom}
      />
      <PulseBar v={view} simple={simple} company={player?.companyNamed ? player.displayName : null} onCompany={() => setRenaming(true)} conn={conn} zoom={zoom} onSettings={() => setSettings(true)} onHome={() => { setSelection(null); setFocus({ kind: 'home', id: '', nonce: Date.now() }) }} sound={prefs.sound} onSound={() => setPrefs({ ...prefs, sound: !prefs.sound })} />
      {mission && <MissionBanner m={mission} />}
      {!simple && !mode && <NewsTicker town={town} onMerchant={(id) => select({ kind: 'merchant', id })} />}
      {celebrate && <Celebration text={celebrate} />}
      {move && !mode && !selection && !askName && !renaming && <NextMoveBar m={move} onDo={() => void doMove()} />}
      {(askName || renaming) && !mode && (
        <NameCompany
          current={player?.companyNamed ? player.displayName : ''}
          title={renaming ? 'Rename your company' : 'You run a power company now. What is it called?'}
          onSave={renameCompany}
          onLater={() => {
            setRenaming(false)
            setNameLater(true)
            try {
              sessionStorage.setItem('bo_name_later', '1')
            } catch {
              /* asks again next visit */
            }
          }}
        />
      )}
      {!simple && <Toasts items={toasts} onDismiss={(seq) => setToasts((t) => t.filter((x) => x.seq !== seq))} onOpen={(e) => { const mid = (e as RegionEvent & { merchantId?: string | null }).merchantId; if (mid) select({ kind: 'merchant', id: mid }); else if (e.actorId) select({ kind: 'actor', id: e.actorId }); else if (e.nodeId) select({ kind: 'node', id: e.nodeId }); if (!mid) setFeed(true) }} />}
      {mode === 'market' && (
        <div className="sheet" role="dialog" aria-label="market">
          <button className="close" onClick={() => setMode(null)} aria-label="Close">
            ×
          </button>
          <MarketSheet v={view} town={town} trade={trade} onMerchant={(id) => select({ kind: 'merchant', id })} onWatch={() => setWatching(true)} onAutoFuel={(fuel, enabled) => void doAct({ type: 'SET_AUTO_FUEL', fuel, enabled })} economy={economy} onEconomy={setEconomy} />
        </div>
      )}
      {watching && <WatchAWeek onClose={() => setWatching(false)} />}
      {mode && mode !== 'market' && <ModeSheet mode={mode} v={view} act={doAct} onClose={() => { setMode(null); setBuildNode(null) }} onSelect={select} building={building} setBuilding={(b) => { setBuilding(b); if (!b) setBuildNode(null) }} buildNode={buildNode} />}
      {feed && !mode && <Feed v={view} onSelect={select} onClose={() => setFeed(false)} />}
      {selection?.kind === 'merchant' && town ? (
        <aside className="inspector" aria-label="Merchant">
          <button className="close" onClick={() => setSelection(null)} aria-label="Close inspector">
            ×
          </button>
          {town.merchants.find((m) => m.merchantId === selection.id) && <MerchantInspector m={town.merchants.find((m) => m.merchantId === selection.id)!} v={view} town={town} trade={trade} invest={invest} />}
        </aside>
      ) : (
        selection && selection.kind !== 'merchant' && <Inspector v={view} sel={selection} act={doAct} onClose={() => setSelection(null)} onFocus={select} onBuildHere={(n) => onBuildAt(n as NodeId)} />
      )}
      {flash && <div className={`flash ${flash.ok ? 'ok' : 'bad'}`} role="status">{flash.text}</div>}
      {!simple && (
        <>
          <button className="feed-btn" onClick={() => { setFeed(!feed); setMode(null) }} aria-pressed={feed}>
            📰 What happened
          </button>
          <Dock mode={mode} onMode={(m) => { setMode(m); setFeed(false); if (m !== 'build') setBuildNode(null) }} badges={badges} />
        </>
      )}
      {view.ended && (
        <div className="ended">
          <b>Challenge complete · score {view.scores.score.toLocaleString('en-US')}</b>
          <button className="btn primary small" onClick={() => setSettings(true)}>
            See the leaderboard
          </button>
        </div>
      )}
      {settings && (
        <Settings
          v={view}
          onClose={() => setSettings(false)}
          config={config}
          player={player}
          onRename={renameCompany}
          onSignOut={signOut}
          boot={boot}
          toast={(text) => setFlash({ text, ok: true })}
          sound={prefs.sound}
          music={prefs.music}
          onSound={(on) => setPrefs({ ...prefs, sound: on })}
          onMusic={(on) => setPrefs({ ...prefs, music: on })}
          quality={prefs.quality}
          onQuality={(q) => setPrefs({ ...prefs, quality: q })}
          onChallenge={async () => {
            const r = await regionApi.create('challenge')
            setView(r.view)
            setRegionId(r.view.regionId)
            setSettings(false)
          }}
          onLive={async () => {
            const r = await regionApi.live()
            setView(r.view)
            setRegionId(r.view.regionId)
            setSettings(false)
          }}
        />
      )}
    </div>
  )
}
