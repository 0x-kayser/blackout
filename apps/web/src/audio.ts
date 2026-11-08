/**
 * Tiny synthesized sound cues (no audio files).
 *
 * Browsers only let a page play sound once the audio engine has been started from a user gesture
 * (a click or tap). So the engine is created and resumed by `unlockAudio()`, which runs when the player
 * turns sound on and on the first tap of every visit; cues that fire before that are skipped silently.
 */
export type Cue = 'restore' | 'coin' | 'siren' | 'ping' | 'fail' | 'test'

let ctx: AudioContext | null = null

const create = (): AudioContext | null => {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    return AC ? new AC() : null
  } catch {
    return null
  }
}

/** Must run inside a click/tap handler. Safe to call repeatedly. */
export function unlockAudio(): boolean {
  ctx ??= create()
  if (!ctx) return false
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  return true
}

/** Resumes the engine on the first tap of a visit (needed after reloads when sound was already on). */
export function unlockOnFirstGesture(): () => void {
  const onGesture = () => {
    unlockAudio()
    remove()
  }
  const remove = () => {
    window.removeEventListener('pointerdown', onGesture)
    window.removeEventListener('keydown', onGesture)
  }
  window.addEventListener('pointerdown', onGesture)
  window.addEventListener('keydown', onGesture)
  return remove
}

// [from Hz, to Hz, start offset s, length s, wave]
const CUES: Record<Cue, [number, number, number, number, OscillatorType][]> = {
  restore: [[523, 784, 0, 0.22, 'sine'], [784, 1046, 0.12, 0.3, 'sine']],
  coin: [[988, 988, 0, 0.09, 'square'], [1319, 1319, 0.08, 0.25, 'square']],
  siren: [[880, 560, 0, 0.3, 'triangle'], [880, 560, 0.32, 0.3, 'triangle'], [880, 560, 0.64, 0.3, 'triangle']],
  ping: [[1175, 1175, 0, 0.12, 'sine']],
  fail: [[330, 165, 0, 0.35, 'sawtooth']],
  test: [[523, 523, 0, 0.12, 'sine'], [659, 659, 0.1, 0.12, 'sine'], [784, 784, 0.2, 0.25, 'sine']],
}
const VOLUME: Record<OscillatorType, number> = { sine: 0.18, triangle: 0.14, square: 0.06, sawtooth: 0.07, custom: 0.1 }

export function playCue(cue: Cue): void {
  if (!ctx || ctx.state !== 'running') return
  try {
    for (const [from, to, at, len, wave] of CUES[cue]) {
      const t = ctx.currentTime + at
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = wave
      o.frequency.setValueAtTime(from, t)
      if (to !== from) o.frequency.exponentialRampToValueAtTime(to, t + len)
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(VOLUME[wave], t + 0.015)
      g.gain.exponentialRampToValueAtTime(0.0001, t + len)
      o.connect(g).connect(ctx.destination)
      o.start(t)
      o.stop(t + len + 0.02)
    }
  } catch {
    /* audio unavailable */
  }
}

/** Turn sound on from a click: start the engine, then play a short confirmation so the player knows it works. */
export async function enableSound(): Promise<void> {
  if (!unlockAudio() || !ctx) return
  try {
    await ctx.resume()
  } catch {
    return
  }
  playCue('test')
}

// ---------------------------------------------------------------- background music
/**
 * "Night Shift": a generated synthwave loop (no audio files, nothing copyrighted). A minor-key progression
 * (Am – F – C – G) at 84 BPM: a filtered pad, a pulsing bass and a soft arpeggio. Scheduled slightly ahead
 * with a lookahead timer so it stays in time even when the tab is busy.
 */
const BPM = 84
const BEAT = 60 / BPM
const CHORDS: number[][] = [
  [57, 60, 64], // A minor
  [53, 57, 60], // F major
  [48, 52, 55], // C major
  [55, 59, 62], // G major
]
const midi = (n: number) => 440 * 2 ** ((n - 69) / 12)

let music: { master: GainNode; filter: BiquadFilterNode; timer: number; nextBar: number; bar: number } | null = null

function scheduleBar(m: NonNullable<typeof music>, c: AudioContext, start: number, bar: number) {
  const chord = CHORDS[bar % CHORDS.length]
  const barLen = BEAT * 4
  // pad: two slightly detuned saws per note, slow attack and release
  for (const n of chord) {
    for (const detune of [-6, 6]) {
      const o = c.createOscillator()
      const g = c.createGain()
      o.type = 'sawtooth'
      o.frequency.value = midi(n)
      o.detune.value = detune
      g.gain.setValueAtTime(0.0001, start)
      g.gain.linearRampToValueAtTime(0.05, start + 0.6)
      g.gain.setValueAtTime(0.05, start + barLen - 0.4)
      g.gain.linearRampToValueAtTime(0.0001, start + barLen + 0.3)
      o.connect(g).connect(m.filter)
      o.start(start)
      o.stop(start + barLen + 0.35)
    }
  }
  // bass: root an octave down, eighth-note pulse
  const root = chord[0] - 12
  for (let i = 0; i < 8; i++) {
    const t = start + i * (BEAT / 2)
    const o = c.createOscillator()
    const g = c.createGain()
    o.type = 'triangle'
    o.frequency.value = midi(root)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(i % 2 === 0 ? 0.22 : 0.12, t + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, t + BEAT / 2 - 0.02)
    o.connect(g).connect(m.master)
    o.start(t)
    o.stop(t + BEAT / 2)
  }
  // arpeggio: chord tones an octave up, every other bar a little busier
  const pattern = bar % 2 === 0 ? [0, 1, 2, 1] : [0, 1, 2, 3, 2, 1, 0, 2]
  const step = barLen / pattern.length
  pattern.forEach((k, i) => {
    const n = (chord[k] ?? chord[0] + 12) + 12
    const t = start + i * step
    const o = c.createOscillator()
    const g = c.createGain()
    o.type = 'sine'
    o.frequency.value = midi(n)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.07, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + step * 1.6)
    o.connect(g).connect(m.master)
    o.start(t)
    o.stop(t + step * 1.7)
  })
}

/** Starts the loop. Must be called from a click (or after `unlockAudio` ran in one). */
export function startMusic(): void {
  if (music || !unlockAudio() || !ctx) return
  const c = ctx
  const master = c.createGain()
  master.gain.value = 0.0001
  master.gain.linearRampToValueAtTime(0.5, c.currentTime + 2.5)
  const filter = c.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 900
  filter.Q.value = 0.7
  filter.connect(master)
  master.connect(c.destination)
  const m = { master, filter, timer: 0, nextBar: c.currentTime + 0.1, bar: 0 }
  music = m
  const tick = () => {
    if (c.state !== 'running') return
    while (m.nextBar < c.currentTime + 1.2) {
      scheduleBar(m, c, m.nextBar, m.bar)
      // the pad filter breathes slowly across the progression
      m.filter.frequency.setTargetAtTime(700 + 500 * ((m.bar % 4) / 3), m.nextBar, 1.5)
      m.nextBar += BEAT * 4
      m.bar += 1
    }
  }
  tick()
  m.timer = window.setInterval(tick, 250)
}

export function stopMusic(): void {
  if (!music || !ctx) return
  const m = music
  music = null
  window.clearInterval(m.timer)
  m.master.gain.cancelScheduledValues(ctx.currentTime)
  m.master.gain.setValueAtTime(m.master.gain.value, ctx.currentTime)
  m.master.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.8)
  window.setTimeout(() => m.master.disconnect(), 1_000)
}

export const musicPlaying = () => !!music

// ---------------------------------------------------------------- only while the player is on the page
let pausedByPage = false
const awayFromPage = () => document.hidden || !document.hasFocus()

/** Silences everything (music and cues) whenever the tab is hidden or the window loses focus; resumes on return. */
export function bindAudioToPage(): () => void {
  const sync = () => {
    if (!ctx) return
    if (awayFromPage()) {
      if (ctx.state === 'running') {
        pausedByPage = true
        void ctx.suspend().catch(() => undefined)
      }
    } else if (pausedByPage) {
      pausedByPage = false
      void ctx.resume().catch(() => undefined)
    }
  }
  document.addEventListener('visibilitychange', sync)
  window.addEventListener('blur', sync)
  window.addEventListener('focus', sync)
  window.addEventListener('pagehide', sync)
  window.addEventListener('pageshow', sync)
  return () => {
    document.removeEventListener('visibilitychange', sync)
    window.removeEventListener('blur', sync)
    window.removeEventListener('focus', sync)
    window.removeEventListener('pagehide', sync)
    window.removeEventListener('pageshow', sync)
  }
}
