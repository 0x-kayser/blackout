import type { EconomyEvent as CanonicalEconomyEvent, EventType, GameStatePublic, PlayerAction } from '@blackout/shared'

/**
 * One boundary for game transport. Replace MockGameTransport with the canonical
 * generated API client when packages/shared is available; UI components do not
 * contain economy rules or wallet calls.
 */
export type RequestState = 'open' | 'awaiting-connection' | 'accepted' | 'negotiating' | 'declined' | 'expired'
export type BusinessState = 'dark' | 'powered' | 'struggling' | 'closed'
export type EconomyEventType = EventType
/** Canonical backend-facing shapes kept at the UI boundary. */
export type CanonicalSnapshot = GameStatePublic
export type CanonicalAction = PlayerAction
export type CanonicalEvent = CanonicalEconomyEvent

export interface EconomyEvent {
  id: string
  type: EconomyEventType
  title: string
  detail: string
  timestamp: string
}

export interface Business {
  id: string
  name: string
  icon: string
  state: BusinessState
  demandKw: number
  cashTrend: 'up' | 'steady' | 'down'
  reliability: number
  loyalty: number
  hoursPowered: number
  mood: string
  x: number
  y: number
}

export interface PowerRequest {
  id: string
  businessId: string
  demandKw: number
  hours: number
  pricePerKwh: number
  state: RequestState
  urgency: 'urgent' | 'normal'
  deadline: string
  counterRounds: number
}

export interface ActiveContract {
  id: string
  businessId: string
  demandKw: number
  remainingHours: number
  paidEnergy: number
  source: 'Diesel generator'
}

export interface GameSnapshot {
  version: number
  day: number
  wave: number
  gameTime: string
  credits: number
  fuelLitres: number
  fuelCapacity: number
  carbonUsed: number
  carbonAllowance: number
  generator: { capacityKw: number; loadKw: number; heat: 'low' | 'warm' | 'high'; wear: number }
  businesses: Business[]
  requests: PowerRequest[]
  contracts: ActiveContract[]
  events: EconomyEvent[]
}

export type GameAction =
  | { type: 'ACCEPT_REQUEST'; requestId: string; expectedVersion: number; idempotencyKey: string }
  | { type: 'COUNTER_REQUEST'; requestId: string; expectedVersion: number; idempotencyKey: string }
  | { type: 'DECLINE_REQUEST'; requestId: string; expectedVersion: number; idempotencyKey: string }
  | { type: 'ASSIGN_LOAD'; requestId: string; sourceId: 'diesel-generator'; expectedVersion: number; idempotencyKey: string }
  | { type: 'BUY_FUEL'; litres: number; expectedVersion: number; idempotencyKey: string }
  | { type: 'ADVANCE_WAVE'; expectedVersion: number; idempotencyKey: string }

export interface GameTransport {
  readonly mode: 'preview' | 'live'
  getSnapshot(): Promise<GameSnapshot>
  dispatch(action: GameAction): Promise<GameSnapshot>
  subscribe(listener: (snapshot: GameSnapshot) => void): () => void
}

const now = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const firstEvent = (type: EconomyEventType, title: string, detail: string): EconomyEvent => ({
  id: `${type}-start`, type, title, detail, timestamp: now()
})

const initialSnapshot = (): GameSnapshot => ({
  version: 1,
  day: 1,
  wave: 1,
  gameTime: '09:00',
  credits: 1000,
  fuelLitres: 20,
  fuelCapacity: 60,
  carbonUsed: 0,
  carbonAllowance: 60,
  generator: { capacityKw: 5, loadKw: 0, heat: 'low', wear: 4 },
  businesses: [
    { id: 'cold-room', name: 'Cold Room', icon: '❄', state: 'dark', demandKw: 1.5, cashTrend: 'down', reliability: 0, loyalty: 48, hoursPowered: 0, mood: 'Freezers are warming.', x: 44, y: 45 },
    { id: 'bakery', name: 'Maya’s Bakery', icon: '◒', state: 'dark', demandKw: 1.1, cashTrend: 'down', reliability: 0, loyalty: 55, hoursPowered: 0, mood: 'Ovens are quiet.', x: 71, y: 27 },
    { id: 'pharmacy', name: 'Civic Pharmacy', icon: '✚', state: 'dark', demandKw: 1.2, cashTrend: 'steady', reliability: 0, loyalty: 64, hoursPowered: 0, mood: 'Needs refrigeration.', x: 72, y: 67 },
    { id: 'cyber-cafe', name: 'Byte Café', icon: '⌘', state: 'dark', demandKw: 0.9, cashTrend: 'down', reliability: 0, loyalty: 42, hoursPowered: 0, mood: 'Customers are waiting.', x: 25, y: 26 },
    { id: 'corner-shop', name: 'Corner Shop', icon: '▦', state: 'dark', demandKw: 0.8, cashTrend: 'steady', reliability: 0, loyalty: 51, hoursPowered: 0, mood: 'Open when the lights return.', x: 24, y: 68 }
  ],
  requests: [{ id: 'cold-room-request', businessId: 'cold-room', demandKw: 1.5, hours: 2, pricePerKwh: 8, state: 'open', urgency: 'urgent', deadline: 'Tutorial — no timer', counterRounds: 0 }],
  contracts: [],
  events: [
    firstEvent('OUTAGE_STARTED', 'Rolling blackout', 'Market Quarter is dark. Choose a request to restore a light.'),
    firstEvent('CUSTOMER_REQUESTED', 'Cold Room needs power', '1.5 kW for 2 game-hours · ₡8 per kWh.')
  ]
})

export class MockGameTransport implements GameTransport {
  readonly mode = 'preview' as const
  private state = initialSnapshot()
  private listeners = new Set<(snapshot: GameSnapshot) => void>()

  async getSnapshot(): Promise<GameSnapshot> {
    return clone(this.state)
  }

  subscribe(listener: (snapshot: GameSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async dispatch(action: GameAction): Promise<GameSnapshot> {
    if (action.expectedVersion !== this.state.version) throw new Error('This view is out of date. Please try again.')
    const request = 'requestId' in action ? this.state.requests.find((entry) => entry.id === action.requestId) : undefined

    if (action.type === 'ACCEPT_REQUEST' && request?.state === 'open') {
      request.state = 'awaiting-connection'
      this.event('CONTRACT_ACCEPTED', 'Cold Room accepted', 'Connection is required before electricity can flow.')
    } else if (action.type === 'COUNTER_REQUEST' && request?.state === 'open') {
      request.state = 'negotiating'
      request.counterRounds += 1
      request.pricePerKwh = 7.5
      this.event('MERCHANT_REPRICED', 'Counteroffer returned', 'Cold Room can pay ₡7.5 per kWh for this emergency shift.')
    } else if (action.type === 'DECLINE_REQUEST' && request && ['open', 'negotiating', 'awaiting-connection'].includes(request.state)) {
      request.state = 'declined'
      this.event('REQUEST_DECLINED', 'Request declined', 'Cold Room remains dark; no capacity was reserved.')
    } else if (action.type === 'ASSIGN_LOAD' && request?.state === 'awaiting-connection') {
      const available = this.state.generator.capacityKw - this.state.generator.loadKw
      if (available < request.demandKw) throw new Error(`Only ${available.toFixed(1)} kW is available.`)
      request.state = 'accepted'
      this.state.generator.loadKw += request.demandKw
      this.state.contracts.push({ id: 'contract-cold-room', businessId: request.businessId, demandKw: request.demandKw, remainingHours: request.hours, paidEnergy: 0, source: 'Diesel generator' })
      const business = this.state.businesses.find((entry) => entry.id === request.businessId)
      if (business) {
        business.state = 'powered'
        business.reliability = 100
        business.hoursPowered = request.hours
        business.cashTrend = 'up'
        business.mood = 'Freezers are safe again.'
      }
      this.event('LOAD_ASSIGNED', 'Generator connected', '1.5 kW reserved. A pulse is travelling to Cold Room.')
      window.setTimeout(() => {
        const contract = this.state.contracts.find((entry) => entry.id === 'contract-cold-room')
        if (!contract) return
        contract.paidEnergy = 24
        this.state.credits += 24
        this.state.fuelLitres = Math.max(0, this.state.fuelLitres - 0.8)
        this.state.carbonUsed += 2.1
        this.event('SERVICE_STARTED', 'Power restored', '3 kWh scheduled. Credits settle as power is delivered.')
        this.event('FUEL_CONSUMED', 'Fuel used', '0.8 L consumed by the first delivery interval.')
        this.emit()
      }, 800)
    } else if (action.type === 'BUY_FUEL') {
      const cost = action.litres * 8
      if (this.state.fuelLitres + action.litres > this.state.fuelCapacity) throw new Error('Fuel tank capacity would be exceeded.')
      if (this.state.credits < cost) throw new Error('Not enough credits for this quote.')
      this.state.fuelLitres += action.litres
      this.state.credits -= cost
      this.event('TRADE_CONFIRMED', 'Fuel delivery confirmed', `${action.litres} L purchased from EmberFuel for ₡${cost}.`)
    } else if (action.type === 'ADVANCE_WAVE') {
      this.state.wave += 1
      this.state.gameTime = `${String(9 + Math.floor(this.state.wave / 2)).padStart(2, '0')}:${this.state.wave % 2 ? '30' : '00'}`
      const bakeryExists = this.state.requests.some((entry) => entry.businessId === 'bakery')
      if (!bakeryExists) {
        this.state.requests.push({ id: 'bakery-request', businessId: 'bakery', demandKw: 1.1, hours: 2, pricePerKwh: 6.4, state: 'open', urgency: 'normal', deadline: 'Wave 4', counterRounds: 0 })
        this.event('CUSTOMER_REQUESTED', 'Maya’s Bakery is calling', 'A new 1.1 kW request arrived. Capacity remains server-authoritative in live mode.')
      }
    } else {
      throw new Error('That action is no longer available.')
    }

    this.state.version += 1
    this.emit()
    return clone(this.state)
  }

  private event(type: EconomyEventType, title: string, detail: string) {
    this.state.events.unshift({ id: `${type}-${Date.now()}-${Math.random()}`, type, title, detail, timestamp: now() })
    this.state.events = this.state.events.slice(0, 12)
  }

  private emit() {
    const snapshot = clone(this.state)
    this.listeners.forEach((listener) => listener(snapshot))
  }
}

export const createGameTransport = (): GameTransport => new MockGameTransport()
