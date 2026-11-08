import { useCallback, useEffect, useState } from 'react'
import './game.css'
import { CityCanvas } from './city/CityCanvas'
import { useGame } from './game/useGame'
import { EconomyLab } from './ui/EconomyLab'
import { Objectives, PowerDock, RequestDock, TopHud } from './ui/Hud'
import { BusinessPanel, EquipmentPanel, ExpansionPanel, HelpPanel, Inspector, MarketPanel, ProfilePanel, VerifyPanel } from './ui/Panels'
import { Welcome } from './ui/Welcome'
import { WorldChip, WorldPanel } from './ui/World'
import { ChapterBanner, IntroOverlay, JournalPanel, NewsTicker } from './ui/Story'
import { ChallengeResults } from './ui/Challenge'

type Panel = 'market' | 'equipment' | 'expansion' | 'business' | 'lab' | 'verify' | 'profile' | 'help' | 'world' | 'journal' | null

const introSeen = () => {
  try {
    return localStorage.getItem('bo_intro_seen') === '1'
  } catch {
    return true
  }
}
type Prefs = { sound: boolean; reducedMotion: boolean }

const loadPrefs = (): Prefs => {
  try {
    const p = JSON.parse(localStorage.getItem('bo_prefs') ?? '{}')
    return { sound: !!p.sound, reducedMotion: p.reducedMotion ?? window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false }
  } catch {
    return { sound: false, reducedMotion: false }
  }
}

let audio: AudioContext | null = null
function chime() {
  try {
    audio ??= new AudioContext()
    const o = audio.createOscillator()
    const gn = audio.createGain()
    o.type = 'sine'
    o.frequency.setValueAtTime(660, audio.currentTime)
    o.frequency.exponentialRampToValueAtTime(990, audio.currentTime + 0.18)
    gn.gain.setValueAtTime(0.06, audio.currentTime)
    gn.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.5)
    o.connect(gn).connect(audio.destination)
    o.start()
    o.stop(audio.currentTime + 0.5)
  } catch {
    /* audio unavailable */
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

  useEffect(
    () =>
      g.onEvent((e) => {
        if (prefs.sound && e.type === 'SERVICE_STARTED' && e.data.provider === 'player') chime()
      }),
    [g, prefs.sound],
  )

  // returning players with a save go straight back to their city
  useEffect(() => {
    if (!g.booting && g.player?.activeRunId && screen === 'welcome' && !g.state && new URLSearchParams(location.search).has('code')) {
      void g.enterGame().then(() => setScreen('game'))
    }
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
        <Welcome g={g} onPlay={play} onChallenge={playChallenge} onLab={() => setPanel('lab')} onHelp={() => setPanel('help')} reducedMotion={prefs.reducedMotion} />
        {panel === 'lab' && <EconomyLab onClose={() => setPanel(null)} />}
        {panel === 'help' && <HelpPanel onClose={() => setPanel(null)} />}
      </main>
    )
  }

  const powered = s.businesses.filter((b) => s.districts.find((d) => d.districtId === b.districtId)?.unlocked && b.powerSource !== 'none').length
  const total = s.businesses.filter((b) => s.districts.find((d) => d.districtId === b.districtId)?.unlocked).length

  return (
    <main className="app-shell game-mode">
      <TopHud s={s} status={g.status} onMenu={(m) => setPanel(m as Panel)} />
      {g.status !== 'live' && g.status !== 'connecting' && <div className="conn-banner">Connection lost. Reconnecting now; your city is paused on the server.</div>}
      {g.awayMs > 60_000 && (
        <div className="away-banner" role="status">
          Welcome back. Your city was paused for {Math.round(g.awayMs / 60_000)} min. No fuel burned, no bills ran, and no businesses closed while you were away.
          <button onClick={() => g.setAwayMs(0)} aria-label="Dismiss">×</button>
        </div>
      )}
      {g.playing === 'challenge' && (
        <div className="challenge-strip">
          🏆 WEEKLY CHALLENGE {s.run.challengeWeek} · day {s.clock.day} of {s.clock.campaignDays} · same seed and world condition for every entry
          <button className="text-link" onClick={() => void g.enterGame().then(() => setScreen('game'))}>Back to my city</button>
        </div>
      )}
      <div className="stage">
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
        <button onClick={() => setPanel('equipment')}><i>🛠</i>Equipment</button>
        <button onClick={() => setPanel('expansion')}><i>🗺</i>Expand</button>
        <button onClick={() => setPanel('business')}><i>📈</i>Business</button>
        <button onClick={() => setPanel('world')} className={s.world.activeEvents.length ? 'alert' : ''}><i>🌍</i>World</button>
        <button onClick={() => setPanel('journal')}><i>📖</i>Journal</button>
        <button onClick={() => setPanel('lab')}><i>🧪</i>Economy Lab</button>
        <button onClick={() => setPanel('verify')}><i>◇</i>Verify</button>
        <span className="city-count">{powered}/{total} lit</span>
      </nav>
      <NewsTicker events={g.events} />
      <div className="toasts" aria-live="polite">
        {g.toasts.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}
      </div>
      {panel === 'market' && <MarketPanel g={g} onClose={() => setPanel(null)} />}
      {panel === 'equipment' && <EquipmentPanel g={g} onClose={() => setPanel(null)} />}
      {panel === 'expansion' && <ExpansionPanel g={g} onClose={() => setPanel(null)} />}
      {panel === 'business' && <BusinessPanel g={g} onClose={() => setPanel(null)} />}
      {panel === 'lab' && <EconomyLab onClose={() => setPanel(null)} />}
      {panel === 'verify' && <VerifyPanel g={g} onClose={() => setPanel(null)} />}
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
