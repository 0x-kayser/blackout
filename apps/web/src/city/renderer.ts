/**
 * BLACKOUT city renderer: a small isometric Canvas-2D engine.
 * Renders only what GameStatePublic says (lit/dark, ownership, contracts, heat,
 * daylight) and plays short effects for confirmed EconomyEvents. No game rules here.
 */
import type { EconomyEvent, GameStatePublic } from '@blackout/shared'
import { DISTRICT_AREAS, LOTS, ROADS, TILE_H, TILE_W, type Lot } from './layout'

export interface CityView {
  state: GameStatePublic | null
  selectedId: string | null
  /** Business whose accepted contract still needs a generator (draws a dashed "wire me" hint). */
  pendingBusinessId: string | null
  highlightGenerators: boolean
  reducedMotion: boolean
  attract: boolean // welcome-screen backdrop: no interaction, slow drift
}

interface Effect {
  kind: 'burst' | 'fail' | 'float'
  x: number
  y: number
  t0: number
  text?: string
  color?: string
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const mix = (c1: string, c2: string, t: number) => {
  const p = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
  const a = p(c1)
  const b = p(c2)
  return `rgb(${a.map((v, i) => Math.round(lerp(v, b[i], t))).join(',')})`
}
const shade = (hex: string, f: number) => {
  const n = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return `rgb(${n.map((v) => Math.max(0, Math.min(255, Math.round(v * f)))).join(',')})`
}

export class CityRenderer {
  private ctx: CanvasRenderingContext2D
  private view: CityView = { state: null, selectedId: null, pendingBusinessId: null, highlightGenerators: false, reducedMotion: false, attract: false }
  private cam = { x: 0, y: 0, z: 1 }
  private raf = 0
  private dpr = 1
  private effects: Effect[] = []
  private hover: string | null = null
  private drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null
  private pointers = new Map<number, { x: number; y: number }>()
  private pinch: { d: number; z: number } | null = null
  private hit: { id: string; poly: [number, number][] }[] = []
  onPick: (id: string | null) => void = () => {}
  onHover: (id: string | null) => void = () => {}

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D not supported')
    this.ctx = ctx
    this.bind()
  }

  setView(v: Partial<CityView>) {
    this.view = { ...this.view, ...v }
  }

  /** Centre the camera on the Market Quarter and fit the visible area. */
  fit() {
    const r = this.canvas.getBoundingClientRect()
    const unlocked = this.view.state?.districts.filter((d) => d.unlocked).length ?? 1
    this.cam.z = Math.max(0.5, Math.min(1.25, r.width / (unlocked > 1 ? 1500 : r.width < 760 ? 700 : 1050)))
    const c = this.iso(5.5, -0.5)
    this.cam.x = -c.x
    // on phones the request sheet covers the lower ~45%: centre the city in the visible top part
    this.cam.y = -c.y + (r.width < 760 ? -(r.height * 0.2) / this.cam.z : 30)
  }

  pushEvent(ev: EconomyEvent) {
    const s = this.view.state
    if (!s || this.view.reducedMotion) return
    const bid = (ev.data.businessId as string | undefined) ?? ev.actors.find((a) => a.startsWith('business:'))?.slice(9)
    const lot = LOTS.find((l) => l.id === bid)
    const at = lot ? this.lotTop(lot) : this.lotTop(LOTS.find((l) => l.id === 'gen_1')!)
    const now = performance.now()
    if (ev.type === 'SERVICE_STARTED') this.effects.push({ kind: 'burst', x: at.x, y: at.y, t0: now, color: ev.data.provider === 'rival' ? '#f26f6f' : '#47e4c2' })
    else if (ev.type === 'CONTRACT_FAILED' || ev.type === 'GENERATOR_BROKEN') this.effects.push({ kind: 'fail', x: at.x, y: at.y, t0: now })
    else if (ev.type === 'ENERGY_DELIVERED' && typeof ev.data.billedCc === 'number' && ev.data.billedCc > 0)
      this.effects.push({ kind: 'float', x: at.x, y: at.y - 10, t0: now, text: `+₡${(ev.data.billedCc / 100).toFixed(2)}`, color: '#ffd28d' })
    else if (ev.type === 'TRADE_CONFIRMED' && ev.data.item === 'diesel') {
      const g = this.lotTop(LOTS.find((l) => l.id === 'gen_1')!)
      this.effects.push({ kind: 'float', x: g.x, y: g.y - 10, t0: now, text: `+${((ev.data.quantity as number) / 1000).toFixed(1)} L`, color: '#56b6ff' })
    }
    if (this.effects.length > 40) this.effects.splice(0, this.effects.length - 40)
  }

  start() {
    const loop = (t: number) => {
      this.draw(t)
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }
  stop() {
    cancelAnimationFrame(this.raf)
    this.unbind?.()
  }

  // ---------------------------------------------------------------- geometry
  private iso(gx: number, gy: number) {
    return { x: ((gx - gy) * TILE_W) / 2, y: ((gx + gy) * TILE_H) / 2 }
  }
  private toScreen(p: { x: number; y: number }) {
    const r = this.canvas.getBoundingClientRect()
    return { x: r.width / 2 + (p.x + this.cam.x) * this.cam.z, y: r.height / 2 + (p.y + this.cam.y) * this.cam.z }
  }
  private lotTop(l: Lot) {
    const c = this.iso(l.gx + l.w / 2, l.gy + l.d / 2)
    return { x: c.x, y: c.y - l.h }
  }

  // ---------------------------------------------------------------- input
  private unbind?: () => void
  private bind() {
    const c = this.canvas
    const pos = (e: PointerEvent | WheelEvent) => {
      const r = c.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const down = (e: PointerEvent) => {
      if (this.view.attract) return
      c.setPointerCapture(e.pointerId)
      const p = pos(e)
      this.pointers.set(e.pointerId, p)
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()]
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: this.cam.z }
        this.drag = null
      } else this.drag = { x: p.x, y: p.y, cx: this.cam.x, cy: this.cam.y, moved: false }
    }
    const move = (e: PointerEvent) => {
      if (this.view.attract) return
      const p = pos(e)
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p)
      if (this.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()]
        this.cam.z = Math.max(0.4, Math.min(2.2, (this.pinch.z * Math.hypot(a.x - b.x, a.y - b.y)) / this.pinch.d))
        return
      }
      if (this.drag) {
        const dx = p.x - this.drag.x
        const dy = p.y - this.drag.y
        if (Math.abs(dx) + Math.abs(dy) > 5) this.drag.moved = true
        if (this.drag.moved) {
          this.cam.x = this.drag.cx + dx / this.cam.z
          this.cam.y = this.drag.cy + dy / this.cam.z
        }
        return
      }
      const h = this.pick(p.x, p.y)
      if (h !== this.hover) {
        this.hover = h
        c.style.cursor = h ? 'pointer' : 'grab'
        this.onHover(h)
      }
    }
    const up = (e: PointerEvent) => {
      if (this.view.attract) return
      const p = pos(e)
      this.pointers.delete(e.pointerId)
      if (this.pointers.size < 2) this.pinch = null
      if (this.drag && !this.drag.moved) this.onPick(this.pick(p.x, p.y))
      this.drag = null
    }
    const wheel = (e: WheelEvent) => {
      if (this.view.attract) return
      e.preventDefault()
      const z0 = this.cam.z
      const z1 = Math.max(0.4, Math.min(2.2, z0 * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))
      const p = pos(e)
      const r = c.getBoundingClientRect()
      // zoom around the cursor
      this.cam.x += (p.x - r.width / 2) * (1 / z1 - 1 / z0)
      this.cam.y += (p.y - r.height / 2) * (1 / z1 - 1 / z0)
      this.cam.z = z1
    }
    c.addEventListener('pointerdown', down)
    c.addEventListener('pointermove', move)
    c.addEventListener('pointerup', up)
    c.addEventListener('pointercancel', up)
    c.addEventListener('wheel', wheel, { passive: false })
    this.unbind = () => {
      c.removeEventListener('pointerdown', down)
      c.removeEventListener('pointermove', move)
      c.removeEventListener('pointerup', up)
      c.removeEventListener('pointercancel', up)
      c.removeEventListener('wheel', wheel)
    }
  }

  zoomBy(f: number) {
    this.cam.z = Math.max(0.4, Math.min(2.2, this.cam.z * f))
  }

  /** Dev/test helper: which entity is under a canvas-relative point. */
  debugPick(x: number, y: number) {
    return { id: this.pick(x, y), hits: this.hit.map((h) => h.id) }
  }

  private pick(x: number, y: number): string | null {
    for (let i = this.hit.length - 1; i >= 0; i--) {
      const { id, poly } = this.hit[i]
      let inside = false
      for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
        const [xi, yi] = poly[a]
        const [xj, yj] = poly[b]
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
      }
      if (inside) return id
    }
    return null
  }

  // ---------------------------------------------------------------- drawing
  private resize() {
    const r = this.canvas.getBoundingClientRect()
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (this.canvas.width !== Math.round(r.width * dpr) || this.canvas.height !== Math.round(r.height * dpr) || this.dpr !== dpr) {
      this.canvas.width = Math.round(r.width * dpr)
      this.canvas.height = Math.round(r.height * dpr)
      this.dpr = dpr
    }
    return r
  }

  private draw(t: number) {
    const r = this.resize()
    const ctx = this.ctx
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const s = this.view.state
    const motion = !this.view.reducedMotion
    if (this.view.attract && motion) this.cam.x = Math.sin(t / 9000) * 60 - this.iso(5.5, -0.5).x
    const day = (s?.clock.daylightBps ?? 0) / 10_000
    // sky
    const g = ctx.createLinearGradient(0, 0, 0, r.height)
    g.addColorStop(0, mix('#070b16', '#2e5487', day))
    g.addColorStop(0.55, mix('#0d1730', '#5d86b5', day))
    g.addColorStop(1, mix('#111d36', '#a9c3dc', day))
    ctx.fillStyle = g
    ctx.fillRect(0, 0, r.width, r.height)
    if (day < 0.35) this.stars(r, t, 1 - day / 0.35)

    ctx.save()
    ctx.translate(r.width / 2, r.height / 2)
    ctx.scale(this.cam.z, this.cam.z)
    ctx.translate(this.cam.x, this.cam.y)

    this.ground(day, s)
    this.roads(day, t)
    this.hit = []

    const unlocked = new Set(s?.districts.filter((d) => d.unlocked).map((d) => d.districtId) ?? ['market_quarter'])
    const gens = new Set(s?.generators.map((x) => x.generatorId) ?? ['gen_1'])
    const lots = LOTS.filter((l) => {
      if (l.kind === 'generator' || l.kind === 'solar') return gens.has(l.id)
      if (l.kind === 'battery') return !!s?.battery
      return true
    }).sort((a, b) => a.gx + a.gy + (a.w + a.d) / 2 - (b.gx + b.gy + (b.w + b.d) / 2))

    // cables under buildings' tops but over ground
    if (s) this.cables(s, t, motion)

    for (const l of lots) {
      if (l.kind === 'decor') this.tree(l, day)
      else if (l.kind === 'business') this.business(l, s, unlocked.has(l.district!), t, day, motion)
      else if (l.kind === 'generator') this.generator(l, s, t, motion)
      else if (l.kind === 'solar') this.solar(l, s, day)
      else if (l.kind === 'battery') this.battery(l, s)
      else if (l.kind === 'rival') this.rival(l, s, t, motion)
      else if (l.kind === 'depot') this.depot(l, s, t, motion)
    }
    if (s) this.trucks(s, t, motion)
    this.effectsDraw(t)
    ctx.restore()

    // heatwave haze (world event: weather with grid stress)
    if (s?.world.modifiers.gridStressHours) {
      const pulse = motion ? 0.06 + 0.03 * Math.sin(t / 1500) : 0.07
      ctx.fillStyle = `rgba(255,140,60,${pulse})`
      ctx.fillRect(0, 0, r.width, r.height)
    }

    // night ambient wash
    if (day < 0.9) {
      ctx.fillStyle = `rgba(8,12,30,${0.12 * (1 - day)})`
      ctx.fillRect(0, 0, r.width, r.height)
    }
  }

  private stars(r: DOMRect, t: number, a: number) {
    const ctx = this.ctx
    for (let i = 0; i < 70; i++) {
      const x = (i * 137.5) % r.width
      const y = ((i * 71.3) % (r.height * 0.45)) + 4
      const tw = this.view.reducedMotion ? 0.6 : 0.5 + 0.5 * Math.sin(t / 900 + i)
      ctx.fillStyle = `rgba(220,230,255,${0.5 * a * tw})`
      ctx.fillRect(x, y, 1.4, 1.4)
    }
  }

  private diamond(gx: number, gy: number, w: number, d: number) {
    const a = this.iso(gx, gy)
    const b = this.iso(gx + w, gy)
    const c = this.iso(gx + w, gy + d)
    const e = this.iso(gx, gy + d)
    const ctx = this.ctx
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.lineTo(c.x, c.y)
    ctx.lineTo(e.x, e.y)
    ctx.closePath()
  }

  private ground(day: number, s: GameStatePublic | null) {
    const ctx = this.ctx
    this.diamond(-6, -8, 24, 17)
    ctx.fillStyle = mix('#0f1a2e', '#3b5d4a', day * 0.8)
    ctx.fill()
    for (const [id, a] of Object.entries(DISTRICT_AREAS)) {
      const unlocked = s?.districts.find((d) => d.districtId === id)?.unlocked ?? id === 'market_quarter'
      this.diamond(a.gx0, a.gy0, a.gx1 - a.gx0, a.gy1 - a.gy0)
      ctx.fillStyle = unlocked ? mix('#17243f', '#5c7766', day * 0.8) : 'rgba(10,14,26,0.55)'
      ctx.fill()
      ctx.strokeStyle = unlocked ? 'rgba(255,191,105,0.18)' : 'rgba(150,170,200,0.12)'
      ctx.setLineDash(unlocked ? [] : [6, 6])
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.setLineDash([])
      const p = this.iso(a.gx0 + 0.2, a.gy1 + 0.3)
      ctx.font = '600 11px Outfit, system-ui'
      ctx.fillStyle = unlocked ? 'rgba(255,210,141,0.75)' : 'rgba(160,176,204,0.55)'
      ctx.fillText(`${unlocked ? '' : '🔒 '}${a.name.toUpperCase()}`, p.x - 30, p.y + 14)
    }
  }

  private roads(day: number, t: number) {
    const ctx = this.ctx
    for (const [x0, y0, x1, y1] of ROADS) {
      const w = x1 === x0 ? 1 : x1 - x0
      const d = y1 === y0 ? 1 : y1 - y0
      this.diamond(x0, y0, w, d)
      ctx.fillStyle = mix('#1a2133', '#4b5262', day)
      ctx.fill()
      // centre line
      const a = this.iso(x0 + (x1 === x0 ? 0.5 : 0), y0 + (y1 === y0 ? 0.5 : 0))
      const b = this.iso(x1 + (x1 === x0 ? 0.5 : 0), y1 + (y1 === y0 ? 0.5 : 0))
      ctx.strokeStyle = 'rgba(255,220,150,0.18)'
      ctx.setLineDash([8, 10])
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
      ctx.setLineDash([])
      // street lamps at night
      if (day < 0.5) {
        const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
        for (let i = 0; i <= n; i += 3) {
          const p = this.iso(x0 + (x1 === x0 ? 1.05 : i), y0 + (y1 === y0 ? 1.05 : i))
          const flick = this.view.reducedMotion ? 1 : 0.85 + 0.15 * Math.sin(t / 300 + i)
          const rg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 26)
          rg.addColorStop(0, `rgba(255,200,120,${0.28 * (1 - day * 2) * flick})`)
          rg.addColorStop(1, 'rgba(255,200,120,0)')
          ctx.fillStyle = rg
          ctx.fillRect(p.x - 26, p.y - 26, 52, 52)
          ctx.fillStyle = '#ffd28d'
          ctx.fillRect(p.x - 1, p.y - 14, 2, 2)
          ctx.fillStyle = '#2b3550'
          ctx.fillRect(p.x - 0.5, p.y - 12, 1, 12)
        }
      }
    }
  }

  /** Draws an isometric box and registers its silhouette for hit testing. */
  private box(l: Lot, top: string, left: string, right: string, h = l.h, id = l.id) {
    const ctx = this.ctx
    const a = this.iso(l.gx, l.gy + l.d)
    const b = this.iso(l.gx + l.w, l.gy + l.d)
    const c = this.iso(l.gx + l.w, l.gy)
    const d = this.iso(l.gx, l.gy)
    // left face
    ctx.beginPath()
    ctx.moveTo(d.x, d.y)
    ctx.lineTo(a.x, a.y)
    ctx.lineTo(a.x, a.y - h)
    ctx.lineTo(d.x, d.y - h)
    ctx.closePath()
    ctx.fillStyle = left
    ctx.fill()
    // right face
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.lineTo(b.x, b.y - h)
    ctx.lineTo(a.x, a.y - h)
    ctx.closePath()
    ctx.fillStyle = right
    ctx.fill()
    // top
    ctx.beginPath()
    ctx.moveTo(d.x, d.y - h)
    ctx.lineTo(a.x, a.y - h)
    ctx.lineTo(b.x, b.y - h)
    ctx.lineTo(c.x, c.y - h)
    ctx.closePath()
    ctx.fillStyle = top
    ctx.fill()
    const m = ctx.getTransform()
    const toPx = (p: { x: number; y: number }): [number, number] => [(m.a * p.x + m.e) / this.dpr, (m.d * p.y + m.f) / this.dpr]
    const P = 10 // touch-friendly padding (world px)
    this.hit.push({ id, poly: [toPx({ x: d.x - P, y: d.y }), toPx({ x: a.x, y: a.y + P }), toPx({ x: b.x + P, y: b.y }), toPx({ x: b.x + P, y: b.y - h }), toPx({ x: c.x, y: c.y - h - P }), toPx({ x: d.x - P, y: d.y - h })] })
    return { a, b, c, d }
  }

  private windows(l: Lot, lit: boolean, warm: string, t: number, flicker: boolean) {
    const ctx = this.ctx
    const rows = Math.max(1, Math.floor((l.h - 10) / 14))
    const face = (p0: { x: number; y: number }, p1: { x: number; y: number }, cols: number, seed: number) => {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const u = (c + 0.3) / cols
          const u2 = (c + 0.75) / cols
          const yb = -8 - r * 14
          const x0 = lerp(p0.x, p1.x, u)
          const y0 = lerp(p0.y, p1.y, u) + yb
          const x1 = lerp(p0.x, p1.x, u2)
          const y1 = lerp(p0.y, p1.y, u2) + yb
          const on = lit && (seed + r * 3 + c * 5) % 7 !== 0
          const fl = flicker && !this.view.reducedMotion ? (Math.sin(t / 90 + seed + c) > 0.6 ? 0.25 : 0.05) : 0.05
          ctx.beginPath()
          ctx.moveTo(x0, y0)
          ctx.lineTo(x1, y1)
          ctx.lineTo(x1, y1 - 7)
          ctx.lineTo(x0, y0 - 7)
          ctx.closePath()
          ctx.fillStyle = on ? warm : `rgba(30,40,64,${0.9 - fl})`
          ctx.fill()
        }
      }
    }
    const a = this.iso(l.gx, l.gy + l.d)
    const b = this.iso(l.gx + l.w, l.gy + l.d)
    const d = this.iso(l.gx, l.gy)
    face(d, a, Math.max(2, l.d * 2), 1)
    face(a, b, Math.max(2, l.w * 2), 4)
  }

  private label(x: number, y: number, text: string, sub: string | null, tone: string, selected: boolean, hitId?: string) {
    const ctx = this.ctx
    ctx.font = '700 11px Outfit, system-ui'
    const w = Math.max(ctx.measureText(text).width, sub ? ctx.measureText(sub).width * 0.9 : 0) + 16
    const h = sub ? 30 : 18
    ctx.fillStyle = selected ? 'rgba(255,191,105,0.95)' : 'rgba(10,16,33,0.82)'
    if (hitId) {
      const m = ctx.getTransform()
      const px = (X: number, Y: number): [number, number] => [(m.a * X + m.e) / this.dpr, (m.d * Y + m.f) / this.dpr]
      this.hit.push({ id: hitId, poly: [px(x - w / 2, y - h), px(x + w / 2, y - h), px(x + w / 2, y), px(x - w / 2, y)] })
    }
    ctx.beginPath()
    ctx.roundRect(x - w / 2, y - h, w, h, 6)
    ctx.fill()
    ctx.strokeStyle = tone
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.fillStyle = selected ? '#2a1a05' : '#f3f4f8'
    ctx.textAlign = 'center'
    ctx.fillText(text, x, y - (sub ? 17 : 5))
    if (sub) {
      ctx.font = '500 10px DM Mono, monospace'
      ctx.fillStyle = selected ? '#4a3210' : tone
      ctx.fillText(sub, x, y - 5)
    }
    ctx.textAlign = 'start'
  }

  private business(l: Lot, s: GameStatePublic | null, unlocked: boolean, t: number, day: number, motion: boolean) {
    const ctx = this.ctx
    const b = s?.businesses.find((x) => x.businessId === l.id)
    if (!unlocked || !b) {
      this.box(l, 'rgba(70,82,108,0.55)', 'rgba(30,38,58,0.7)', 'rgba(40,50,74,0.7)')
      return
    }
    const closed = b.status === 'closed'
    const lit = !closed && b.powerSource !== 'none'
    const dim = closed ? 0.45 : lit ? 1 : 0.6
    const { a } = this.box(l, shade(l.roof, dim * (0.75 + 0.25 * day)), shade(l.wall, dim * 0.85), shade(l.wall, dim * 1.15))
    const warm = b.powerSource === 'player' ? '#ffd27a' : b.powerSource === 'rival' ? '#ffb0a0' : '#ffe2a8'
    this.windows(l, lit, warm, t, !lit && !closed)
    const top = this.lotTop(l)
    // glow when lit at night
    if (lit && day < 0.7) {
      const rg = ctx.createRadialGradient(a.x, a.y - l.h / 2, 0, a.x, a.y - l.h / 2, 70)
      rg.addColorStop(0, `rgba(255,190,100,${0.22 * (1 - day)})`)
      rg.addColorStop(1, 'rgba(255,190,100,0)')
      ctx.fillStyle = rg
      ctx.fillRect(a.x - 70, a.y - l.h / 2 - 70, 140, 140)
    }
    // outage ping
    if (!lit && !closed) {
      const pulse = motion ? (t / 1200) % 1 : 0.5
      const base = this.iso(l.gx + l.w / 2, l.gy + l.d / 2)
      ctx.strokeStyle = `rgba(242,111,111,${0.8 * (1 - pulse)})`
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.ellipse(base.x, base.y, 20 + 30 * pulse, 10 + 15 * pulse, 0, 0, Math.PI * 2)
      ctx.stroke()
    }
    if (closed) {
      ctx.strokeStyle = '#8a95ab'
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(top.x - 14, top.y + 18)
      ctx.lineTo(top.x + 14, top.y + 30)
      ctx.moveTo(top.x + 14, top.y + 18)
      ctx.lineTo(top.x - 14, top.y + 30)
      ctx.stroke()
    }
    const selected = this.view.selectedId === l.id
    const hovered = this.hover === l.id
    const showLabel = selected || hovered || this.cam.z >= 0.75 || !lit
    if (showLabel && !this.view.attract) {
      const tone = closed ? '#8a95ab' : lit ? (b.powerSource === 'player' ? '#47e4c2' : b.powerSource === 'rival' ? '#f26f6f' : '#9dafca') : '#f26f6f'
      const sub = closed ? 'CLOSED' : lit ? (b.powerSource === 'player' ? 'YOUR POWER' : b.powerSource === 'rival' ? 'VOLTLINE' : 'GRID') : 'BLACKOUT'
      this.label(top.x, top.y - 8, `${l.icon ?? ''} ${l.label}`, sub, tone, selected, l.id)
    }
    if (this.view.pendingBusinessId === l.id) {
      ctx.strokeStyle = '#ffbf69'
      ctx.setLineDash([4, 4])
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.ellipse(top.x, top.y + l.h, 34, 17, 0, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
    }
  }

  private generator(l: Lot, s: GameStatePublic | null, t: number, motion: boolean) {
    const ctx = this.ctx
    const g = s?.generators.find((x) => x.generatorId === l.id)
    const heat = (g?.heatPermille ?? 0) / 1000
    const off = g && g.status !== 'online'
    const roof = off ? '#6b7280' : mix('#ffbf69', '#f26f6f', heat)
    this.box(l, roof, shade(l.wall, 0.9), shade(l.wall, 1.2))
    const top = this.lotTop(l)
    // exhaust stack
    ctx.fillStyle = '#3a3f4f'
    ctx.fillRect(top.x + 8, top.y - 16, 5, 18)
    if (g && g.outputW > 0 && motion) {
      for (let i = 0; i < 5; i++) {
        const p = ((t / 1400 + i / 5) % 1)
        ctx.fillStyle = `rgba(160,170,190,${0.35 * (1 - p)})`
        ctx.beginPath()
        ctx.arc(top.x + 10 + p * 12 + Math.sin(t / 500 + i) * 3, top.y - 18 - p * 34, 3 + p * 7, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    if (this.view.highlightGenerators && g?.status === 'online') {
      const pulse = motion ? 0.5 + 0.5 * Math.sin(t / 220) : 1
      ctx.strokeStyle = `rgba(255,191,105,${0.5 + 0.5 * pulse})`
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.ellipse(top.x, top.y + l.h + 2, 40, 20, 0, 0, Math.PI * 2)
      ctx.stroke()
    }
    if (!this.view.attract) {
      const load = g ? `${(g.assignedW / 1000).toFixed(1)}/${(g.ratedW / 1000).toFixed(0)} kW` : ''
      this.label(top.x, top.y - 22, `⚡ ${l.label}`, off ? g!.status.toUpperCase() : load, off ? '#f26f6f' : heat > 0.6 ? '#f2a46f' : '#ffbf69', this.view.selectedId === l.id, l.id)
    }
  }

  private solar(l: Lot, s: GameStatePublic | null, day: number) {
    const ctx = this.ctx
    const g = s?.generators.find((x) => x.generatorId === l.id)
    this.box(l, mix('#14284a', '#3f74b8', day), '#1a2638', '#223149')
    // panel grid
    ctx.strokeStyle = `rgba(150,200,255,${0.25 + 0.4 * day})`
    ctx.lineWidth = 1
    for (let i = 1; i < l.w * 3; i++) {
      const p0 = this.iso(l.gx + i / 3, l.gy)
      const p1 = this.iso(l.gx + i / 3, l.gy + l.d)
      ctx.beginPath()
      ctx.moveTo(p0.x, p0.y - l.h)
      ctx.lineTo(p1.x, p1.y - l.h)
      ctx.stroke()
    }
    if (!this.view.attract) {
      const top = this.lotTop(l)
      this.label(top.x, top.y - 10, '☀ Solar', g ? `${(g.availableW / 1000).toFixed(1)} kW now` : '', '#56b6ff', this.view.selectedId === l.id, l.id)
    }
  }

  private battery(l: Lot, s: GameStatePublic | null) {
    const ctx = this.ctx
    const bt = s?.battery
    this.box(l, '#2a8f7c', '#1b3f39', '#235148')
    const top = this.lotTop(l)
    const frac = bt ? bt.storedWh / bt.capacityWh : 0
    ctx.fillStyle = '#0d1b1a'
    ctx.fillRect(top.x - 9, top.y + 6, 18, 6)
    ctx.fillStyle = '#47e4c2'
    ctx.fillRect(top.x - 9, top.y + 6, 18 * frac, 6)
    if (!this.view.attract) this.label(top.x, top.y - 6, '▮ Battery', bt ? `${(bt.storedWh / 1000).toFixed(1)} kWh` : '', '#47e4c2', this.view.selectedId === l.id)
  }

  private rival(l: Lot, s: GameStatePublic | null, t: number, motion: boolean) {
    const ctx = this.ctx
    this.box(l, '#a8484f', '#4a2329', '#5e2c33')
    const top = this.lotTop(l)
    if (s && s.rival.assignedW > 0 && motion) {
      for (let i = 0; i < 4; i++) {
        const p = (t / 1600 + i / 4) % 1
        ctx.fillStyle = `rgba(180,140,140,${0.3 * (1 - p)})`
        ctx.beginPath()
        ctx.arc(top.x - 6 + p * 10, top.y - 8 - p * 30, 3 + p * 6, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    if (!this.view.attract && s) this.label(top.x, top.y - 10, 'VoltLine (rival)', `${(s.rival.tariffCcPerKwh / 100).toFixed(2)} ₡/kWh`, '#f26f6f', this.view.selectedId === l.id)
  }

  private depot(l: Lot, s: GameStatePublic | null, t: number, motion: boolean) {
    const ctx = this.ctx
    this.box(l, '#6d7891', '#2f3648', '#3b4459')
    const stock = s ? s.merchants.reduce((a, m) => a + m.stockMl, 0) : 0
    const target = s ? s.merchants.reduce((a, m) => a + m.targetStockMl, 0) : 1
    const frac = Math.max(0, Math.min(1, stock / Math.max(1, target)))
    for (let i = 0; i < 2; i++) {
      const p = this.iso(l.gx + 0.5 + i, l.gy + 0.5)
      const y0 = p.y - l.h
      ctx.fillStyle = '#c9d2e3'
      ctx.beginPath()
      ctx.ellipse(p.x, y0 - 18, 11, 5, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#9aa6bd'
      ctx.fillRect(p.x - 11, y0 - 18, 22, 16)
      ctx.fillStyle = frac < 0.35 ? '#f26f6f' : '#ffbf69'
      ctx.fillRect(p.x - 9, y0 - 2 - 14 * frac, 4, 14 * frac)
    }
    const cap = s?.world.modifiers.importCapacityBps ?? 0
    if (!this.view.attract) {
      const top = this.lotTop(l)
      const limited = cap < 0
      const pulse = motion ? 0.6 + 0.4 * Math.sin(t / 300) : 1
      this.label(top.x, top.y - 28, '⛽ Fuel depot', limited ? `DELIVERIES LIMITED ${cap / 100}%` : `shelves ${(frac * 100).toFixed(0)}%`, limited ? `rgba(242,111,111,${pulse})` : '#9dafca', this.view.selectedId === l.id)
    }
  }

  /** Tanker trucks on the lower road: fewer and rarer when world events cut import capacity. */
  private trucks(s: GameStatePublic, t: number, motion: boolean) {
    const ctx = this.ctx
    const cap = 10_000 + s.world.modifiers.importCapacityBps
    const n = Math.max(0, Math.round((3 * cap) / 10_000))
    for (let i = 0; i < n; i++) {
      const u = motion ? (t / (9000 + i * 1300) + i / Math.max(1, n)) % 1 : (i + 0.5) / Math.max(1, n)
      const p = this.iso(-4 + u * 7.5, 4.5)
      ctx.fillStyle = '#e6ebf4'
      ctx.fillRect(p.x - 7, p.y - 9, 10, 6)
      ctx.fillStyle = '#ffbf69'
      ctx.fillRect(p.x + 3, p.y - 8, 4, 5)
      ctx.fillStyle = '#1b2233'
      ctx.fillRect(p.x - 6, p.y - 3, 2, 2)
      ctx.fillRect(p.x + 2, p.y - 3, 2, 2)
    }
  }

  private tree(l: Lot, day: number) {
    const ctx = this.ctx
    const p = this.iso(l.gx + 0.5, l.gy + 0.5)
    ctx.fillStyle = '#3a2a1e'
    ctx.fillRect(p.x - 1.5, p.y - 10, 3, 10)
    ctx.fillStyle = mix('#173a2b', '#3f8a5f', day)
    ctx.beginPath()
    ctx.arc(p.x, p.y - 18, 10, 0, Math.PI * 2)
    ctx.fill()
  }

  private cables(s: GameStatePublic, t: number, motion: boolean) {
    const ctx = this.ctx
    for (const c of s.contracts) {
      if (c.status !== 'active') continue
      const from = LOTS.find((l) => l.id === (c.provider === 'rival' ? 'rival_plant' : c.generatorId))
      const to = LOTS.find((l) => l.id === c.businessId)
      if (!from || !to) continue
      const a = this.lotTop(from)
      const b = this.lotTop(to)
      const mid = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 40 }
      const color = c.provider === 'rival' ? '#f26f6f' : '#47e4c2'
      ctx.strokeStyle = c.provider === 'rival' ? 'rgba(242,111,111,0.45)' : 'rgba(71,228,194,0.5)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.quadraticCurveTo(mid.x, mid.y, b.x, b.y)
      ctx.stroke()
      // travelling pulses
      const n = 3
      for (let i = 0; i < n; i++) {
        const u = motion ? (t / 900 + i / n) % 1 : (i + 0.5) / n
        const x = (1 - u) * (1 - u) * a.x + 2 * (1 - u) * u * mid.x + u * u * b.x
        const y = (1 - u) * (1 - u) * a.y + 2 * (1 - u) * u * mid.y + u * u * b.y
        ctx.fillStyle = color
        ctx.shadowColor = color
        ctx.shadowBlur = 10
        ctx.beginPath()
        ctx.arc(x, y, 3, 0, Math.PI * 2)
        ctx.fill()
        ctx.shadowBlur = 0
      }
    }
  }

  private effectsDraw(t: number) {
    const ctx = this.ctx
    const now = performance.now()
    this.effects = this.effects.filter((e) => now - e.t0 < 1800)
    for (const e of this.effects) {
      const p = (now - e.t0) / 1800
      if (e.kind === 'burst') {
        ctx.strokeStyle = `rgba(71,228,194,${1 - p})`
        ctx.strokeStyle = e.color ? e.color : ctx.strokeStyle
        ctx.globalAlpha = 1 - p
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.arc(e.x, e.y + 10, 10 + p * 60, 0, Math.PI * 2)
        ctx.stroke()
        ctx.globalAlpha = 1
      } else if (e.kind === 'fail') {
        ctx.fillStyle = `rgba(242,111,111,${0.5 * (1 - p)})`
        ctx.beginPath()
        ctx.arc(e.x, e.y + 10, 30 + p * 20, 0, Math.PI * 2)
        ctx.fill()
      } else {
        ctx.globalAlpha = 1 - p
        ctx.font = '800 13px Outfit, system-ui'
        ctx.fillStyle = e.color ?? '#fff'
        ctx.textAlign = 'center'
        ctx.fillText(e.text ?? '', e.x, e.y - p * 40)
        ctx.textAlign = 'start'
        ctx.globalAlpha = 1
      }
    }
    void t
  }
}
