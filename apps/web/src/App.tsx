import { DragEvent, type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'
import {
  Business,
  GameAction,
  GameSnapshot,
  GameTransport,
  PowerRequest,
  createGameTransport
} from './api/client'

type Screen = 'welcome' | 'scenario' | 'game'
type ModalName = 'market' | 'observatory' | 'transparency' | 'help' | 'settings' | 'report' | null

const requestStateLabel: Record<PowerRequest['state'], string> = {
  open: 'OPEN',
  'awaiting-connection': 'CONNECT',
  accepted: 'ACTIVE',
  negotiating: 'COUNTERED',
  declined: 'DECLINED',
  expired: 'EXPIRED'
}

const money = (value: number) => `₡${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}`
const getBusiness = (snapshot: GameSnapshot, businessId: string) => snapshot.businesses.find((business) => business.id === businessId)

export default function App() {
  const transport = useRef<GameTransport | null>(null)
  const unsubscribe = useRef<(() => void) | null>(null)
  const [screen, setScreen] = useState<Screen>('welcome')
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null)
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>('cold-room-request')
  const [selectedBusinessId, setSelectedBusinessId] = useState<string | null>('cold-room')
  const [modal, setModal] = useState<ModalName>(null)
  const [negotiation, setNegotiation] = useState<PowerRequest | null>(null)
  const [counterPrice, setCounterPrice] = useState(7.5)
  const [toast, setToast] = useState('The neighborhood is waiting for its first light.')
  const [reducedMotion, setReducedMotion] = useState(false)
  const [soundOn, setSoundOn] = useState(false)
  const [replayRunning, setReplayRunning] = useState(false)
  const [replayTick, setReplayTick] = useState(18)

  useEffect(() => () => unsubscribe.current?.(), [])
  useEffect(() => {
    document.documentElement.dataset.motion = reducedMotion ? 'reduce' : 'full'
  }, [reducedMotion])
  useEffect(() => {
    if (!replayRunning) return
    const timer = window.setInterval(() => setReplayTick((value) => (value >= 96 ? 18 : value + 2)), 500)
    return () => window.clearInterval(timer)
  }, [replayRunning])

  const startPreview = async (openModal?: ModalName) => {
    unsubscribe.current?.()
    const nextTransport = createGameTransport()
    transport.current = nextTransport
    const nextSnapshot = await nextTransport.getSnapshot()
    setSnapshot(nextSnapshot)
    unsubscribe.current = nextTransport.subscribe(setSnapshot)
    setScreen('game')
    if (openModal) setModal(openModal)
  }

  const send = async (factory: (version: number) => GameAction) => {
    if (!transport.current || !snapshot) return
    try {
      const next = await transport.current.dispatch(factory(snapshot.version))
      setSnapshot(next)
      setToast(next.events[0]?.detail ?? 'Action complete.')
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Action could not be completed.')
    }
  }

  const connectSelectedRequest = () => {
    if (!snapshot || !selectedRequestId) {
      setToast('Select an accepted request before connecting a source.')
      return
    }
    send((version) => ({ type: 'ASSIGN_LOAD', requestId: selectedRequestId, sourceId: 'diesel-generator', expectedVersion: version, idempotencyKey: crypto.randomUUID() }))
  }

  const selectedBusiness = snapshot && selectedBusinessId ? getBusiness(snapshot, selectedBusinessId) : undefined
  const selectedRequest = snapshot?.requests.find((request) => request.id === selectedRequestId)
  const activeRequest = snapshot?.requests.find((request) => request.state === 'awaiting-connection')

  return (
    <main className="app-shell">
      <div className="sr-only" aria-live="polite">{toast}</div>
      {screen === 'welcome' && (
        <Welcome
          onNewShift={() => setScreen('scenario')}
          onWatch={() => void startPreview('observatory')}
          onHelp={() => setModal('help')}
          onSettings={() => setModal('settings')}
          onTransparency={() => void startPreview('transparency')}
          soundOn={soundOn}
          setSoundOn={setSoundOn}
        />
      )}
      {screen === 'scenario' && (
        <ScenarioPicker onBack={() => setScreen('welcome')} onStart={() => void startPreview()} />
      )}
      {screen === 'game' && snapshot && (
        <GameScene
          snapshot={snapshot}
          selectedBusiness={selectedBusiness}
          selectedRequestId={selectedRequestId}
          activeRequest={activeRequest}
          toast={toast}
          onSelectBusiness={setSelectedBusinessId}
          onSelectRequest={(request) => {
            setSelectedRequestId(request.id)
            setSelectedBusinessId(request.businessId)
          }}
          onAccept={(request) => {
            setSelectedRequestId(request.id)
            setSelectedBusinessId(request.businessId)
            void send((version) => ({ type: 'ACCEPT_REQUEST', requestId: request.id, expectedVersion: version, idempotencyKey: crypto.randomUUID() }))
          }}
          onDecline={(request) => void send((version) => ({ type: 'DECLINE_REQUEST', requestId: request.id, expectedVersion: version, idempotencyKey: crypto.randomUUID() }))}
          onCounter={(request) => {
            setNegotiation(request)
            setCounterPrice(Math.max(6.5, request.pricePerKwh - 0.5))
          }}
          onConnect={connectSelectedRequest}
          onDropRequest={(requestId) => {
            setSelectedRequestId(requestId)
            void send((version) => ({ type: 'ASSIGN_LOAD', requestId, sourceId: 'diesel-generator', expectedVersion: version, idempotencyKey: crypto.randomUUID() }))
          }}
          onOpenModal={setModal}
          onAdvance={() => void send((version) => ({ type: 'ADVANCE_WAVE', expectedVersion: version, idempotencyKey: crypto.randomUUID() }))}
          soundOn={soundOn}
          onToggleSound={() => setSoundOn((value) => !value)}
        />
      )}

      {negotiation && snapshot && (
        <aside className="slide-over" aria-modal="true" role="dialog" aria-labelledby="counter-title">
          <button className="icon-button close" aria-label="Close counteroffer" onClick={() => setNegotiation(null)}>×</button>
          <p className="eyebrow">NEGOTIATION · ROUND {negotiation.counterRounds + 1} OF 2</p>
          <h2 id="counter-title">{getBusiness(snapshot, negotiation.businessId)?.name} needs a number.</h2>
          <p className="muted">Their current offer is {money(negotiation.pricePerKwh)} / kWh. This preview submits a bounded counter to the simulated transport.</p>
          <div className="price-readout">{money(counterPrice)} <small>/ kWh</small></div>
          <input aria-label="Counteroffer price per kilowatt-hour" type="range" min="6.5" max="8" step="0.1" value={counterPrice} onChange={(event) => setCounterPrice(Number(event.target.value))} />
          <div className="range-labels"><span>₡6.5</span><span>₡8.0</span></div>
          <div className="cost-preview">
            <span>Predicted gross revenue</span><strong>{money(counterPrice * negotiation.demandKw * negotiation.hours)}</strong>
            <span>Estimated fuel + CO₂</span><strong>Preview only</strong>
            <span>Capacity risk</span><strong>{snapshot.generator.capacityKw - snapshot.generator.loadKw >= negotiation.demandKw ? 'Within available capacity' : 'Over capacity'}</strong>
          </div>
          <button className="button primary wide" onClick={() => {
            void send((version) => ({ type: 'COUNTER_REQUEST', requestId: negotiation.id, expectedVersion: version, idempotencyKey: crypto.randomUUID() }))
            setNegotiation(null)
          }}>Send counteroffer</button>
        </aside>
      )}

      {modal === 'market' && snapshot && <MarketModal snapshot={snapshot} onClose={() => setModal(null)} onBuy={() => void send((version) => ({ type: 'BUY_FUEL', litres: 8, expectedVersion: version, idempotencyKey: crypto.randomUUID() }))} />}
      {modal === 'observatory' && <ObservatoryModal replayTick={replayTick} replayRunning={replayRunning} onReplay={() => setReplayRunning((value) => !value)} onClose={() => setModal(null)} />}
      {modal === 'transparency' && <TransparencyModal onClose={() => setModal(null)} />}
      {modal === 'help' && <HelpModal onClose={() => setModal(null)} />}
      {modal === 'settings' && <SettingsModal reducedMotion={reducedMotion} setReducedMotion={setReducedMotion} soundOn={soundOn} setSoundOn={setSoundOn} onClose={() => setModal(null)} />}
      {modal === 'report' && snapshot && <ReportModal snapshot={snapshot} onClose={() => setModal(null)} />}
    </main>
  )
}

function Welcome({ onNewShift, onWatch, onHelp, onSettings, onTransparency, soundOn, setSoundOn }: {
  onNewShift: () => void; onWatch: () => void; onHelp: () => void; onSettings: () => void; onTransparency: () => void; soundOn: boolean; setSoundOn: (value: boolean) => void
}) {
  return <section className="welcome">
    <div className="landing-noise" />
    <nav className="welcome-nav"><span className="mini-mark"><i /> BLACKOUT</span><button className="quiet-button" onClick={() => setSoundOn(!soundOn)}>{soundOn ? '♪ Sound on' : '♩ Sound off'}</button></nav>
    <div className="city-silhouette" aria-hidden="true"><span /><span /><span /><span /><span /><span /><span /></div>
    <div className="welcome-copy">
      <p className="eyebrow amber">A POWER COMPANY IN A CITY THAT NEVER SLEEPS</p>
      <h1>BLACK<span>OUT</span></h1>
      <p className="tagline">Every light changes the economy.</p>
      <p className="intro">Restore power, keep customers in business, outsmart the market.</p>
      <div className="welcome-actions">
        <button className="button primary" onClick={onNewShift}>New shift <b>→</b></button>
        <button className="button secondary" disabled title="No saved campaign exists in this preview.">Continue</button>
      </div>
      <div className="welcome-links">
        <button onClick={onWatch}>Watch the economy</button><button onClick={onHelp}>How to play</button><button onClick={onSettings}>Accessibility</button><button onClick={onTransparency}>Chain transparency</button>
      </div>
    </div>
    <footer>Simulation gameplay <span>•</span> NEAR testnet assets where enabled</footer>
  </section>
}

function ScenarioPicker({ onBack, onStart }: { onBack: () => void; onStart: () => void }) {
  return <section className="scenario-screen">
    <header><button className="back-button" onClick={onBack}>← Home</button><span className="mini-mark"><i /> BLACKOUT</span></header>
    <div className="scenario-copy"><p className="eyebrow amber">CHOOSE YOUR SHIFT</p><h1>Start with one neighborhood.</h1><p>Credits are imaginary game currency; they cannot be withdrawn or redeemed.</p></div>
    <div className="scenario-grid">
      <article className="scenario-card selected"><div className="scenario-art starter">⚡</div><p className="eyebrow">DEFAULT SCENARIO</p><h2>Starter District</h2><p>Bring Market Quarter back online across 3 days. Learn contracts, fuel, and trust.</p><dl><div><dt>Generator</dt><dd>5 kW</dd></div><div><dt>Fuel</dt><dd>20 L</dd></div><div><dt>Credits</dt><dd>₡1,000</dd></div><div><dt>Permits</dt><dd>6</dd></div></dl><button className="button primary wide" onClick={onStart}>Start Day 1</button></article>
      <article className="scenario-card locked"><div className="scenario-art squeeze">⛽</div><p className="eyebrow">COMING LATER</p><h2>Fuel Squeeze</h2><p>A high-pressure price challenge that requires backend scenario support.</p><span className="lock-label">Locked</span></article>
      <article className="scenario-card locked"><div className="scenario-art solar">☀</div><p className="eyebrow">COMING LATER</p><h2>Grid Independent</h2><p>Long-term storage and solar progression, not simulated in this preview.</p><span className="lock-label">Locked</span></article>
    </div>
  </section>
}

function GameScene({ snapshot, selectedBusiness, selectedRequestId, activeRequest, toast, onSelectBusiness, onSelectRequest, onAccept, onDecline, onCounter, onConnect, onDropRequest, onOpenModal, onAdvance, soundOn, onToggleSound }: {
  snapshot: GameSnapshot; selectedBusiness?: Business; selectedRequestId: string | null; activeRequest?: PowerRequest; toast: string; onSelectBusiness: (id: string) => void; onSelectRequest: (request: PowerRequest) => void; onAccept: (request: PowerRequest) => void; onDecline: (request: PowerRequest) => void; onCounter: (request: PowerRequest) => void; onConnect: () => void; onDropRequest: (id: string) => void; onOpenModal: (modal: ModalName) => void; onAdvance: () => void; soundOn: boolean; onToggleSound: () => void
}) {
  const capacityPercent = (snapshot.generator.loadKw / snapshot.generator.capacityKw) * 100
  return <section className="game-shell">
    <div className="preview-banner"><span>DESIGN PREVIEW</span> Simulated data · not connected to NEAR or a production game API</div>
    <header className="game-header">
      <div className="brand"><span className="mini-mark"><i /> BLACKOUT</span><span className="day-badge">DAY {snapshot.day} <em>/</em> WAVE {snapshot.wave}</span><span className="clock">◷ {snapshot.gameTime}</span></div>
      <div className="resource-bar"><Metric icon="₡" label="Credits" value={money(snapshot.credits)} /><Metric icon="◒" label="Fuel" value={`${snapshot.fuelLitres.toFixed(1)} L`} /><Metric icon="☁" label="CO₂" value={`${snapshot.carbonUsed.toFixed(1)}/${snapshot.carbonAllowance} kg`} /></div>
      <div className="header-actions"><button className="header-button" onClick={() => onOpenModal('market')}>Morning market</button><button className="header-button" onClick={() => onOpenModal('settings')} aria-label="Settings">⚙</button><button className="header-button" onClick={onToggleSound} aria-label="Toggle sound">{soundOn ? '♪' : '♩'}</button></div>
    </header>
    <div className="game-grid">
      <aside className="power-desk panel">
        <div className="panel-heading"><div><p className="eyebrow">POWER DESK</p><h2>Diesel generator</h2></div><span className="status-dot online">Ready</span></div>
        <button className={`generator-visual ${activeRequest ? 'ready-to-connect' : ''}`} onClick={onConnect} onDragOver={(event) => event.preventDefault()} onDrop={(event: DragEvent) => { event.preventDefault(); const requestId = event.dataTransfer.getData('text/plain'); if (requestId) onDropRequest(requestId) }} aria-label={activeRequest ? `Connect ${getBusiness(snapshot, activeRequest.businessId)?.name} to diesel generator` : 'Diesel generator'}>
          <div className="generator-roof" /><div className="generator-door">⚡</div><span className="generator-smoke" /><span className="generator-glow" />
          {activeRequest && <span className="connect-hint">Tap to connect</span>}
        </button>
        <div className="capacity-row"><div className="capacity-ring" style={{ '--capacity': `${capacityPercent}%` } as CSSProperties}><strong>{snapshot.generator.loadKw.toFixed(1)}</strong><small>/ {snapshot.generator.capacityKw} kW</small></div><div><b>Live power load</b><p>{(snapshot.generator.capacityKw - snapshot.generator.loadKw).toFixed(1)} kW available</p></div></div>
        <div className="stat-stack"><Meter label="Fuel tank" value={`${snapshot.fuelLitres.toFixed(1)} / ${snapshot.fuelCapacity} L`} percent={(snapshot.fuelLitres / snapshot.fuelCapacity) * 100} tone="fuel" /><Meter label="Heat" value={snapshot.generator.heat} percent={22} tone="heat" /><Meter label="Wear" value={`${snapshot.generator.wear}%`} percent={snapshot.generator.wear} tone="wear" /></div>
        <button className="asset-button" onClick={() => onOpenModal('market')}><span>▣</span><span><b>Assets & upgrades</b><small>Battery and solar are locked in preview</small></span><b>→</b></button>
        {activeRequest ? <div className="tutorial-note"><span>2</span><p><b>Connect the Cold Room.</b> Drag its request here or tap this generator.</p></div> : snapshot.requests.some((request) => request.state === 'open') ? <div className="tutorial-note"><span>1</span><p><b>Accept the job.</b> Review the offer, then choose Accept.</p></div> : <div className="tutorial-note complete"><span>✓</span><p><b>Keep an eye on capacity.</b> Ongoing jobs reserve power.</p></div>}
      </aside>

      <CityMap snapshot={snapshot} selectedBusinessId={selectedBusiness?.id} onSelectBusiness={onSelectBusiness} />

      <aside className="request-panel panel">
        <div className="panel-heading"><div><p className="eyebrow">ACTIVE REQUESTS</p><h2>{snapshot.requests.filter((request) => ['open', 'awaiting-connection', 'negotiating'].includes(request.state)).length || 'No'} request{snapshot.requests.filter((request) => ['open', 'awaiting-connection', 'negotiating'].includes(request.state)).length === 1 ? '' : 's'}</h2></div><span className="wave-pill">Wave {snapshot.wave}</span></div>
        <div className="request-list">
          {snapshot.requests.map((request) => <RequestCard key={request.id} request={request} business={getBusiness(snapshot, request.businessId)} selected={selectedRequestId === request.id} onSelect={() => onSelectRequest(request)} onAccept={() => onAccept(request)} onCounter={() => onCounter(request)} onDecline={() => onDecline(request)} />)}
        </div>
        <div className="contracts-heading"><span>ACTIVE CONTRACTS</span><b>{snapshot.contracts.length}</b></div>
        <div className="contract-list">{snapshot.contracts.length ? snapshot.contracts.map((contract) => { const business = getBusiness(snapshot, contract.businessId); return <div className="contract-chip" key={contract.id}><span className="contract-spark">⚡</span><div><b>{business?.name}</b><small>{contract.remainingHours}h left · {contract.demandKw} kW · {contract.source}</small></div><strong>{money(contract.paidEnergy)}</strong></div> }) : <p className="empty-contracts">Accept a request to reserve capacity.</p>}</div>
        <button className="advance-button" onClick={onAdvance}>Skip to next wave <span>→</span></button>
      </aside>
    </div>
    <div className="bottom-strip"><span><b>District trust</b> <i className="trust-fill" /> 48</span><span><b>Today’s margin</b> {money(snapshot.contracts.reduce((total, contract) => total + contract.paidEnergy, 0))}</span><span><b>Market ticker</b> EmberFuel ₡8.00/L <em>↗ 0.4</em></span><button onClick={() => onOpenModal('report')}><b>Why did this happen?</b> {toast}</button></div>
    {selectedBusiness && <BusinessInspector business={selectedBusiness} onClose={() => onSelectBusiness('')} />}
  </section>
}

function Metric({ icon, label, value }: { icon: string; label: string; value: string }) { return <span className="metric"><i>{icon}</i><small>{label}</small><b>{value}</b></span> }
function Meter({ label, value, percent, tone }: { label: string; value: string; percent: number; tone: string }) { return <div className="meter"><div><span>{label}</span><b>{value}</b></div><i><em className={tone} style={{ width: `${Math.max(3, percent)}%` }} /></i></div> }

function CityMap({ snapshot, selectedBusinessId, onSelectBusiness }: { snapshot: GameSnapshot; selectedBusinessId?: string; onSelectBusiness: (id: string) => void }) {
  return <section className="city-panel panel" aria-label="Interactive city map">
    <div className="map-heading"><div><p className="eyebrow">MARKET QUARTER</p><h2>Restore the block, one cable at a time.</h2></div><span className="map-key"><i className="key-dark" /> Unpowered <i className="key-lit" /> Powered</span></div>
    <div className="city-map">
      <div className="map-rain" /><div className="road road-one" /><div className="road road-two" /><div className="road road-three" /><div className="street-light one" /><div className="street-light two" /><div className="street-light three" />
      <div className="generator-marker"><span>⚡</span><small>Grid shed</small></div>
      <svg className="cable-map" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {snapshot.businesses.map((business) => <path key={business.id} className={business.state === 'powered' ? 'cable active' : 'cable'} d={`M 42 75 C 48 68, ${business.x - 8} ${business.y + 9}, ${business.x} ${business.y}`} />)}
      </svg>
      {snapshot.businesses.map((business) => <button key={business.id} className={`shop ${business.state} ${selectedBusinessId === business.id ? 'selected' : ''}`} style={{ left: `${business.x}%`, top: `${business.y}%` }} onClick={() => onSelectBusiness(business.id)} aria-label={`${business.name}: ${business.state}. ${business.mood}`}>
        <span className="shop-roof" /><span className="shop-face"><i>{business.icon}</i></span><span className="shop-name">{business.name}</span>{business.state === 'dark' && <span className="outage-ping" />}{business.state === 'powered' && <span className="powered-pulse" />}
      </button>)}
      <div className="map-caption">{snapshot.businesses.filter((business) => business.state === 'powered').length} / {snapshot.businesses.length} businesses powered</div>
    </div>
  </section>
}

function RequestCard({ request, business, selected, onSelect, onAccept, onCounter, onDecline }: { request: PowerRequest; business?: Business; selected: boolean; onSelect: () => void; onAccept: () => void; onCounter: () => void; onDecline: () => void }) {
  const isOpen = request.state === 'open' || request.state === 'negotiating'
  return <article className={`request-card ${request.state} ${selected ? 'selected' : ''}`} draggable={request.state === 'awaiting-connection'} onDragStart={(event) => event.dataTransfer.setData('text/plain', request.id)} onClick={onSelect}>
    <div className="request-top"><span className={`urgency ${request.urgency}`}>{request.urgency === 'urgent' ? 'URGENT' : 'OPEN'}</span><span className="request-state">{requestStateLabel[request.state]}</span></div>
    <div className="request-title"><span className="customer-icon">{business?.icon}</span><div><h3>{business?.name ?? 'Customer'}</h3><p>{request.demandKw} kW · {request.hours} game-hours</p></div></div>
    <div className="quote-row"><div><small>OFFER</small><b>{money(request.pricePerKwh)} <em>/ kWh</em></b></div><div><small>FUEL + CO₂</small><b>Preview <em>details</em></b></div></div>
    <p className="request-deadline">◷ {request.deadline}</p>
    {isOpen && <div className="card-actions"><button className="button mini primary" onClick={(event) => { event.stopPropagation(); onAccept() }}>Accept</button><button className="button mini" onClick={(event) => { event.stopPropagation(); onCounter() }}>Counter</button><button className="text-danger" onClick={(event) => { event.stopPropagation(); onDecline() }}>Decline</button></div>}
    {request.state === 'awaiting-connection' && <button className="connect-card" onClick={(event) => { event.stopPropagation(); onSelect() }}>Tap generator to connect <b>→</b></button>}
    {request.state === 'accepted' && <p className="active-card-note">⚡ Electricity is flowing. Settlement is simulated.</p>}
  </article>
}

function BusinessInspector({ business, onClose }: { business: Business; onClose: () => void }) {
  return <aside className="business-inspector" aria-label={`${business.name} details`}><button aria-label="Close business details" onClick={onClose}>×</button><span className={`inspector-icon ${business.state}`}>{business.icon}</span><div><p className="eyebrow">{business.state.toUpperCase()} BUSINESS</p><h2>{business.name}</h2><p>{business.mood}</p></div><dl><div><dt>Need</dt><dd>{business.demandKw} kW</dd></div><div><dt>Cash trend</dt><dd className={business.cashTrend}>↗ {business.cashTrend}</dd></div><div><dt>Reliability</dt><dd>{business.reliability}%</dd></div><div><dt>Loyalty</dt><dd>{business.loyalty}</dd></div></dl></aside>
}

function MarketModal({ snapshot, onClose, onBuy }: { snapshot: GameSnapshot; onClose: () => void; onBuy: () => void }) {
  return <Modal title="Morning Market" eyebrow="DAY 1 · PAUSED" onClose={onClose} wide><div className="market-intro"><div><span className="market-sun">☀</span><div><p className="eyebrow amber">SAMPLE SCENARIO</p><h2>Fuel is thin. Your day starts here.</h2><p>Quotes below are explicit preview data; a live integration must use a server quote ID and idempotency key.</p></div></div><div className="oil-index"><small>OIL INDEX</small><b>82.4</b><em>↗ 0.4%</em></div></div><div className="merchant-grid"><Merchant name="EmberFuel" avatar="E" quote="₡8.00" stock="18 L left" reason="Low depot stock (+₡0.40) · regular route" primary onBuy={onBuy} /><Merchant name="Nkem & Sons" avatar="N" quote="₡8.30" stock="42 L left" reason="Higher transport cost · stable stock" /><Merchant name="Blue Tank" avatar="B" quote="₡7.85" stock="0 L left" reason="Merchant inventory is depleted" unavailable /></div><div className="market-bottom"><section><p className="eyebrow">CARBON PERMITS</p><h3>6 permits · 60 kg allowance</h3><p>Each permit covers 10 kg CO₂. Purchases must be confirmed by the game API.</p></section><section><p className="eyebrow">EQUIPMENT SHOP</p><h3>Battery & solar <span className="coming">Coming later</span></h3><p>Locked until the backend exposes upgrade actions.</p></section></div></Modal>
}

function Merchant({ name, avatar, quote, stock, reason, primary, unavailable, onBuy }: { name: string; avatar: string; quote: string; stock: string; reason: string; primary?: boolean; unavailable?: boolean; onBuy?: () => void }) { return <article className="merchant"><div className="merchant-head"><span className="merchant-avatar">{avatar}</span><div><h3>{name}</h3><p>{stock}</p></div><strong>{quote}<small>/ L</small></strong></div><div className="stock-bar"><i style={{ width: unavailable ? '2%' : primary ? '32%' : '66%' }} /></div><p className="reason"><b>Explain price</b> {reason}</p>{primary ? <button className="button primary wide" onClick={onBuy}>Buy 8 L · ₡64</button> : <button className="button wide" disabled={unavailable} title={unavailable ? 'Merchant has no public inventory.' : 'Other seller interaction needs live quote support.'}>{unavailable ? 'Out of stock' : 'Live quote required'}</button>}</article> }

function ObservatoryModal({ replayTick, replayRunning, onReplay, onClose }: { replayTick: number; replayRunning: boolean; onReplay: () => void; onClose: () => void }) {
  return <Modal title="Economy Observatory" eyebrow="SIMULATED FUTURE SCENARIO" onClose={onClose} wide><div className="observatory-top"><div><p className="eyebrow amber">NO BLOCKCHAIN SETTLEMENT</p><h2>Compare policy with the same seed.</h2><p>UI ready; deterministic server traces and replay streaming are blocked by the missing API.</p></div><button className="button primary" onClick={onReplay}>{replayRunning ? 'Pause preview' : 'Start preview'} <b>{replayRunning ? 'Ⅱ' : '▶'}</b></button></div><div className="observatory-controls"><label>Scenario<select defaultValue="baseline"><option value="baseline">Baseline</option><option value="oil">Illustrative Oil Supply Pressure</option><option value="grid">Diversified Grid</option></select></label><label>Seed<div className="seed-field">BLK-2407-19 <button onClick={() => navigator.clipboard?.writeText('BLK-2407-19')}>Copy</button></div></label><label>Policy<select defaultValue="diesel"><option value="diesel">Cheap Diesel First</option><option value="storage">Storage First</option></select></label></div><div className="observatory-grid"><section className="speed-city"><div className="mini-city"><span className="mini-building lit" /><span className="mini-building" /><span className="mini-building lit tall" /><span className="mini-building" /><i className="mini-pulse" style={{ left: `${replayTick}%` }} /></div><p><b>Day {Math.ceil(replayTick / 14)} / 7</b><span>{replayRunning ? 'Streaming local preview frames' : 'Paused at a preview frame'}</span></p></section><section className="chart-card"><p className="eyebrow">NEIGHBORHOOD UPTIME</p><svg viewBox="0 0 260 110" role="img" aria-label="Illustrative uptime chart"><path d="M0 92 C20 87 36 78 52 82 S80 42 104 55 S133 65 151 35 S190 50 211 27 S240 31 260 14" fill="none" stroke="var(--teal)" strokeWidth="4" /><path d="M0 92 C20 87 36 78 52 82 S80 42 104 55 S133 65 151 35 S190 50 211 27 S240 31 260 14 L260 110 L0 110Z" fill="url(#chartGlow)" opacity=".35" /><defs><linearGradient id="chartGlow" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#47e4c2" /><stop offset="1" stopColor="#47e4c2" stopOpacity="0" /></linearGradient></defs></svg><b>68% <small>illustrative result</small></b></section></div><div className="blocked-note">Live replay, comparison output, and event feed are intentionally unavailable until the server exposes a seeded stream and trace endpoint.</div></Modal>
}

function TransparencyModal({ onClose }: { onClose: () => void }) { return <Modal title="Chain Transparency" eyebrow="OPTIONAL PROOF PANEL" onClose={onClose}><div className="transparency"><span className="transparency-shield">◇</span><h2>Nothing to verify yet.</h2><p>This local design preview has no wallet, account, NEAR contract, transaction hash, or explorer link. The game remains fully playable without this drawer.</p><div className="transparency-row"><span>Network</span><b>Unavailable</b></div><div className="transparency-row"><span>Game resources</span><b>Not connected</b></div><div className="transparency-row"><span>Trust boundary</span><b>Simulation preview only</b></div><p className="fine-print">In a live version: game electricity is simulated on the server; resource ownership or trades are shown only where testnet proof is actually available.</p></div></Modal> }

function HelpModal({ onClose }: { onClose: () => void }) { return <Modal title="How to Play" eyebrow="FIVE QUICK STEPS" onClose={onClose}><ol className="how-to"><li><b>Read the outage.</b><span>A dark shop sends a request with power, time, and offer.</span></li><li><b>Choose the deal.</b><span>Accept, counter twice at most, or decline.</span></li><li><b>Connect the load.</b><span>Drag it to the generator or use the tap-to-connect hint.</span></li><li><b>Protect capacity.</b><span>kW is live power; kWh is energy delivered over time.</span></li><li><b>Trade for tomorrow.</b><span>Buy fuel and permits only when a quote or API result is verified.</span></li></ol><p className="help-callout">Tip: first-shift tutorial requests have no countdown. Later requests are timed by the authoritative server clock.</p></Modal> }

function SettingsModal({ reducedMotion, setReducedMotion, soundOn, setSoundOn, onClose }: { reducedMotion: boolean; setReducedMotion: (value: boolean) => void; soundOn: boolean; setSoundOn: (value: boolean) => void; onClose: () => void }) { return <Modal title="Sound & Accessibility" eyebrow="PLAYER SETTINGS" onClose={onClose}><div className="settings-list"><Toggle label="Reduced motion" description="Stops pulse and glow movement while keeping status visible." value={reducedMotion} onChange={setReducedMotion} /><Toggle label="Sound" description="Sound is opt-in; this preview has no autoplay audio." value={soundOn} onChange={setSoundOn} /></div><button className="reset-button" onClick={() => window.confirm('Resetting is not connected in this preview.')}>Reset campaign <small>Preview unavailable</small></button></Modal> }
function Toggle({ label, description, value, onChange }: { label: string; description: string; value: boolean; onChange: (value: boolean) => void }) { return <label className="setting-toggle"><span><b>{label}</b><small>{description}</small></span><input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} /><i aria-hidden="true" /></label> }

function ReportModal({ snapshot, onClose }: { snapshot: GameSnapshot; onClose: () => void }) { const revenue = snapshot.contracts.reduce((total, contract) => total + contract.paidEnergy, 0); return <Modal title="Shift Report" eyebrow="SIMULATED DAY 1" onClose={onClose} wide><div className="report-summary"><div><span>Revenue earned</span><b>{money(revenue)}</b></div><div><span>Fuel used</span><b>{(20 - snapshot.fuelLitres).toFixed(1)} L</b></div><div><span>Carbon emitted</span><b>{snapshot.carbonUsed.toFixed(1)} kg</b></div><div><span>Neighborhood uptime</span><b>{Math.round(snapshot.businesses.filter((business) => business.state === 'powered').length / snapshot.businesses.length * 100)}%</b></div></div><div className="causal-events"><p className="eyebrow">WHAT CHANGED</p>{snapshot.events.slice(0, 3).map((event) => <article key={event.id}><span>⚡</span><div><b>{event.title}</b><p>{event.detail}</p></div><small>{event.timestamp}</small></article>)}</div><button className="button primary" onClick={onClose}>Continue shift <b>→</b></button></Modal> }

function Modal({ title, eyebrow, onClose, children, wide = false }: { title: string; eyebrow: string; onClose: () => void; children: ReactNode; wide?: boolean }) { return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" onMouseDown={(event) => event.stopPropagation()}><button className="icon-button close" aria-label="Close dialog" onClick={onClose}>×</button><p className="eyebrow amber">{eyebrow}</p><h1 id="modal-title">{title}</h1>{children}</section></div> }
