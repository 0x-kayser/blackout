import { useCallback, useEffect, useState } from 'react'
import './game.css'
import { CityCanvas } from './city/CityCanvas'
import { useGame } from './game/useGame'
import { EconomyLab } from './ui/EconomyLab'
import { Objectives, PowerDock, RequestDock, TopHud } from './ui/Hud'
import { BusinessPanel, EquipmentPanel, ExpansionPanel, HelpPanel, Inspector, MarketPanel, ProfilePanel } from './ui/Panels'
import { Welcome } from './ui/Welcome'
import { WorldChip, WorldPanel } from './ui/World'
import { ChapterBanner, IntroOverlay, JournalPanel, NewsTicker } from './ui/Story'
import { ChallengeResults } from './ui/Challenge'
import { ExchangeAway, ExchangePanel } from './ui/Exchange'
import { Coach } from './ui/Coach'
import { PeoplePanel } from './ui/People'
import { bindAudioToPage, enableSound, playCue, startMusic, stopMusic, unlockAudio, unlockOnFirstGesture, type Cue } from './audio'

type Panel = 'people' | 'exchange' | 'market' | 'equipment' | 'expansion' | 'business' | 'lab' | 'profile' | 'help' | 'world' | 'journal' | null

const introSeen = () => {
  try {
    return localStorage.getItem('bo_intro_seen') === '1'
  } catch {
    return true
  }
}
type Prefs = { sound: boolean; music: boolean; reducedMotion: boolean }

const loadPrefs = (): Prefs => {
  try {
    const p = JSON.parse(localStorage.getItem('bo_prefs') ?? '{}')
    return { sound: !!p.sound, music: !!p.music, reducedMotion: p.reducedMotion ?? window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false }
  } catch {
    return { sound: false, music: false, reducedMotion: false }
  }
}

export default function App() {
  const g = useGame()
  const [screen, setScreen] = useState<'welcome' | 'game'>('welcome')
  const [panel, setPanel] = useState<Panel>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedReq, setSelectedReq] = useState<string | null>(null)
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs)
  const [showIntro, setShowIntro] = useState(false)
  const setPrefs = (p: Prefs) => {
    // turning sound on is a click, which is exactly when browsers allow audio to start
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
  useEffect(() => {
    document.documentElement.dataset.motion = prefs.reducedMotion ? 'reduce' : 'full'
  }, [prefs.reducedMotion])

  // music and sound only play while you're on the page: hidden tab or another window = silence
  useEffect(() => bindAudioToPage(), [])
  // after a reload with sound already on, the first tap or key press starts the audio engine
  useEffect(() => (prefs.sound || prefs.music ? unlockOnFirstGesture() : undefined), [prefs.sound, prefs.music])
  // music that was on last visit resumes with the first tap (browsers block it before that)
  useEffect(() => {
    if (!prefs.music) return
    const go = () => startMusic()
    window.addEventListener('pointerdown', go, { once: true })
    window.addEventListener('keydown', go, { once: true })
    return () => {
      window.removeEventListener('pointerdown', go)
      window.removeEventListener('keydown', go)
    }
  }, [prefs.music])

  useEffect(() => {
    let lastSiren = 0
    const CUE: Partial<Record<string, Cue>> = {
      CUSTOMER_REQUESTED: 'ping',
      CODE_RED_CALLED: 'siren',
      CONTRACT_COMPLETED: 'coin',
      GOAL_COMPLETED: 'coin',
      STAGE_REACHED: 'test',
      EXCHANGE_SALE_PAID: 'coin',
      CONTRACT_FAILED: 'fail',
      CODE_RED_MISSED: 'fail',
      GENERATOR_BROKEN: 'fail',
    }
    return g.onEvent((e) => {
      if (!prefs.sound) return
      if (e.type === 'SERVICE_STARTED') {
        if (e.data.provider === 'player') playCue('restore')
        return
      }
      const cue = CUE[e.type]
      if (!cue) return
      if (cue === 'siren') lastSiren = Date.now()
      if (cue === 'ping' && Date.now() - lastSiren < 1_000) return // the siren already announced this call
      playCue(cue)
    })
  }, [g, prefs.sound])

  // back from Google / an email link: tidy the URL, and players with a save go straight back to their city
  useEffect(() => {
    if (g.booting) return
    const q = new URLSearchParams(location.search)
    if (!q.has('code') && !q.has('error_description')) return
    if (q.has('error_description')) g.toast(`Sign-in didn't finish: ${q.get('error_description')}`, 'bad')
    history.replaceState(null, '', location.pathname)
    if (g.player?.activeRunId && screen === 'welcome' && !g.state) void g.enterGame().then(() => setScreen('game'))
  }, [g.booting, g.player, screen, g])

  const play = async () => {
    const res = await g.enterGame()
    if (!introSeen() && res.state.clock.wavesTotal <= 2) setShowIntro(true)
    setScreen('game')
  }
  const playChallenge = async () => {
    await g.enterChallenge()
    setScreen('game')
  }
  const closeIntro = () => {
    setShowIntro(false)
    try {
      localStorage.setItem('bo_intro_seen', '1')
    } catch {
      /* per-device convenience */
    }
  }

  const s = g.state
  const pending = s?.contracts.find((c) => c.provider === 'player' && c.status === 'pending_assignment') ?? null

  const onPick = useCallback(
    (id: string | null) => {
      if (!s) return
      // landmarks on the map open the part of the economy they stand for
      if (id === 'fuel_depot') return setPanel('market')
      if (id === 'exchange_port') return setPanel(g.playing === 'challenge' ? 'market' : 'exchange')
      if (id === 'rival_plant') return setPanel('business')
      if (id?.startsWith('district:')) return setPanel('expansion')
      const gen = id ? s.generators.find((x) => x.generatorId === id) : undefined
      if (gen && pending) {
        void g.act({ type: 'ASSIGN_CONTRACT', contractId: pending.contractId, generatorId: gen.generatorId }, `assign:${pending.contractId}`)
        return
      }
      if (id && s.requests.some((r) => r.businessId === id && (r.status === 'open' || r.status === 'customer_countered'))) {
        setSelectedReq(s.requests.find((r) => r.businessId === id && (r.status === 'open' || r.status === 'customer_countered'))!.requestId)
      }
      setSelected(id)
    },
    [s, pending, g],
  )

  if (screen === 'welcome' || !s) {
    return (
      <main className="app-shell">
        <Welcome g={g} onPlay={play} onChallenge={playChallenge} onLab={() => setPanel('lab')} onHelp={() => setPanel('help')} reducedMotion={prefs.reducedMotion} music={prefs.music} onToggleMusic={() => setPrefs({ ...prefs, music: !prefs.music })} />
        {panel === 'lab' && <EconomyLab onClose={() => setPanel(null)} />}
        {panel === 'help' && <HelpPanel onClose={() => setPanel(null)} />}
      </main>
    )
  }

  const powered = s.businesses.filter((b) => s.districts.find((d) => d.districtId === b.districtId)?.unlocked && b.powerSource !== 'none').length
  const total = s.businesses.filter((b) => s.districts.find((d) => d.districtId === b.districtId)?.unlocked).length

  return (
    <main className="app-shell game-mode">
      <TopHud s={s} status={g.status} onMenu={(m) => setPanel(m as Panel)} sound={prefs.sound} onToggleSound={() => setPrefs({ ...prefs, sound: !prefs.sound })} music={prefs.music} onToggleMusic={() => setPrefs({ ...prefs, music: !prefs.music })} />
      {g.status !== 'live' && g.status !== 'connecting' && <div className="conn-banner">Connection lost. Reconnecting now; your city is paused on the server.</div>}
      {g.awayMs > 60_000 && (
        <div className="away-banner" role="status">
          Welcome back. Your city was paused for {Math.round(g.awayMs / 60_000)} min. No fuel burned, no bills ran, and no businesses closed while you were away.
          <button onClick={() => g.setAwayMs(0)} aria-label="Dismiss">×</button>
        </div>
      )}
      {g.playing !== 'challenge' && g.player && <ExchangeAway playerId={g.player.playerId} onOpen={() => setPanel('exchange')} />}
      {g.playing === 'challenge' && (
        <div className="challenge-strip">
          🏆 WEEKLY CHALLENGE {s.run.challengeWeek} · shift {s.clock.day} of {s.clock.campaignDays} · same seed and world condition for every entry
          <button className="text-link" onClick={() => void g.enterGame().then(() => setScreen('game'))}>Back to my city</button>
        </div>
      )}
      <div className="stage">
        {!s.tutorial.active && g.playing !== 'challenge' && <Coach s={s} onOpen={(p) => setPanel(p)} />}
        <WorldChip s={s} onOpen={() => setPanel('world')} />
        <CityCanvas
          state={s}
          selectedId={selected}
          pendingBusinessId={pending?.businessId ?? null}
          highlightGenerators={!!pending}
          reducedMotion={prefs.reducedMotion}
          onPick={onPick}
          subscribe={g.onEvent}
          label={`City map: ${powered} of ${total} businesses powered`}
        />
        <Objectives s={s} />
        <PowerDock g={g} onSelect={(id) => onPick(id)} highlight={!!pending} />
        <RequestDock g={g} selectedReq={selectedReq} setSelectedReq={setSelectedReq} />
        {selected && <Inspector s={s} id={selected} onClose={() => setSelected(null)} />}
        {pending && <div className="connect-tip" role="status">Tap a glowing generator to connect {s.businesses.find((b) => b.businessId === pending.businessId)?.name}</div>}
      </div>
      <nav className="toolbar" aria-label="Game menu">
        <button onClick={() => setPanel('market')}><i>⛽</i>Market</button>
        {g.playing !== 'challenge' && <button onClick={() => setPanel('exchange')} className="x-tab"><i>⇄</i>Exchange</button>}
        <button onClick={() => setPanel('equipment')}><i>🛠</i>Equipment</button>
        <button onClick={() => setPanel('expansion')}><i>🗼</i>Grid</button>
        <button onClick={() => setPanel('business')}><i>📈</i>Business</button>
        <button onClick={() => setPanel('people')}><i>👥</i>People</button>
        <button onClick={() => setPanel('world')} className={s.world.activeEvents.length ? 'alert' : ''}><i>🌍</i>World</button>
        <button onClick={() => setPanel('journal')}><i>📖</i>Journal</button>
        <button onClick={() => setPanel('lab')}><i>🧪</i>Economy Lab</button>
        <span className="city-count">{powered}/{total} lit</span>
      </nav>
      <NewsTicker events={g.events} />
      <div className="toasts" aria-live="polite">
        {g.toasts.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}
      </div>
      {panel === 'market' && <MarketPanel g={g} onClose={() => setPanel(null)} onOpenExchange={() => setPanel('exchange')} />}
      {panel === 'exchange' && <ExchangePanel g={g} onClose={() => setPanel(null)} />}
      {panel === 'people' && <PeoplePanel g={g} onClose={() => setPanel(null)} />}
      {panel === 'equipment' && <EquipmentPanel g={g} onClose={() => setPanel(null)} />}
      {panel === 'expansion' && <ExpansionPanel g={g} onClose={() => setPanel(null)} />}
      {panel === 'business' && <BusinessPanel g={g} onClose={() => setPanel(null)} />}
      {panel === 'lab' && <EconomyLab onClose={() => setPanel(null)} />}
      {panel === 'profile' && g.player && <ProfilePanel g={g} onClose={() => setPanel(null)} prefs={prefs} setPrefs={setPrefs} />}
      {panel === 'help' && <HelpPanel onClose={() => setPanel(null)} />}
      {panel === 'world' && <WorldPanel s={s} events={g.events} onClose={() => setPanel(null)} />}
      {panel === 'journal' && <JournalPanel s={s} onClose={() => setPanel(null)} />}
      {showIntro && <IntroOverlay onDone={closeIntro} />}
      {g.chapter && <ChapterBanner ev={g.chapter} onDone={() => g.setChapter(null)} />}
      {s.clock.phase === 'finished' && g.playing === 'challenge' && <ChallengeResults s={s} onBack={() => void g.enterGame()} />}
    </main>
  )
}
