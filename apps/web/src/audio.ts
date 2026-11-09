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
 * "Grid at Dusk": generated in the browser (no audio files, nothing copyrighted). A slow lo-fi groove at 88 BPM:
 * electric-piano chords (Fmaj7 – Am7 – Dm9 – B♭maj7), a round sub bass, a soft kick and swung hats, and a sparse
 * pentatonic melody with an echo. It follows the grid: when the region is short of power or dark it shifts to
 * "tense" (minor-key chords, a driving bass, busier drums, a brighter filter) and drifts back once the lights hold.
 * Scheduled a bar ahead with a lookahead timer so it stays in time when the tab is busy.
 */
export type MusicMood = 'calm' | 'tense'
const BPM = 88
const BEAT = 60 / BPM
const BAR = BEAT * 4
// MIDI note numbers. Calm: Fmaj7, Am7, Dm9, Bbmaj7. Tense: Dm, Bb, Gm, A (the A major pulls back to Dm).
const PROG: Record<MusicMood, number[][]> = {
  calm: [
    [53, 57, 60, 64],
    [57, 60, 64, 67],
    [50, 57, 60, 64],
    [46, 53, 57, 62],
  ],
  tense: [
    [50, 53, 57, 62],
    [46, 50, 53, 58],
    [43, 50, 55, 58],
    [45, 49, 52, 57],
  ],
}
// a melody per bar (scale degrees of F major pentatonic, -1 = rest), on eighth notes
const PENTA = [65, 67, 69, 72, 74, 77, 79, 81]
const MELODY: number[][] = [
  [-1, -1, 4, -1, 3, -1, 2, -1],
  [-1, 2, -1, 3, -1, -1, 1, -1],
  [-1, -1, -1, 2, 1, -1, 0, -1],
  [-1, -1, 3, -1, -1, 4, -1, -1],
  [5, -1, 4, -1, 3, -1, -1, -1],
  [-1, -1, 2, 3, -1, 2, -1, -1],
  [-1, 1, -1, 2, -1, -1, 0, -1],
  [-1, -1, -1, -1, -1, -1, -1, -1],
]
const midi = (n: number) => 440 * 2 ** ((n - 69) / 12)

interface Music {
  master: GainNode
  filter: BiquadFilterNode
  echo: GainNode
  noise: AudioBuffer
  timer: number
  nextBar: number
  bar: number
  mood: MusicMood
}
let music: Music | null = null
let wantedMood: MusicMood = 'calm'

function noiseBuffer(c: AudioContext): AudioBuffer {
  const b = c.createBuffer(1, Math.floor(c.sampleRate * 0.5), c.sampleRate)
  const d = b.getChannelData(0)
  let x = 12345
  for (let i = 0; i < d.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    d[i] = (x / 0x7fffffff) * 2 - 1
  }
  return b
}

/** One electric-piano note: a sine with a bell-like overtone, quick attack, long soft decay. */
function keys(c: AudioContext, out: AudioNode, n: number, t: number, len: number, vel: number) {
  for (const [mult, gain, decay] of [[1, vel, len], [2, vel * 0.22, len * 0.35], [3.01, vel * 0.06, len * 0.15]] as const) {
    const o = c.createOscillator()
    const g = c.createGain()
    o.type = 'sine'
    o.frequency.value = midi(n) * mult
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay)
    o.connect(g).connect(out)
    o.start(t)
    o.stop(t + decay + 0.05)
  }
}

function kick(c: AudioContext, out: AudioNode, t: number, vel: number) {
  const o = c.createOscillator()
  const g = c.createGain()
  o.frequency.setValueAtTime(130, t)
  o.frequency.exponentialRampToValueAtTime(42, t + 0.16)
  g.gain.setValueAtTime(vel, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32)
  o.connect(g).connect(out)
  o.start(t)
  o.stop(t + 0.34)
}

function hiss(m: Music, c: AudioContext, t: number, len: number, vel: number, type: BiquadFilterType, freq: number) {
  const src = c.createBufferSource()
  src.buffer = m.noise
  const f = c.createBiquadFilter()
  f.type = type
  f.frequency.value = freq
  const g = c.createGain()
  g.gain.setValueAtTime(vel, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + len)
  src.connect(f).connect(g).connect(m.master)
  src.start(t, Math.random() * 0.3)
  src.stop(t + len + 0.02)
}

function scheduleBar(m: Music, c: AudioContext, start: number) {
  const tense = m.mood === 'tense'
  const chord = PROG[m.mood][m.bar % 4]
  const swing = BEAT * 0.09
  const eighth = (i: number) => start + i * (BEAT / 2) + (i % 2 ? swing : 0)

  // chords: on the one, and a lighter stab on the "and" of two
  for (const n of chord) {
    keys(c, m.filter, n, start, BAR * 0.9, tense ? 0.05 : 0.06)
    keys(c, m.filter, n + 12, eighth(3), BEAT * 1.4, 0.022)
  }
  // bass: round sine on the root; tense drives eighth notes
  const root = chord[0] - 12
  const hits = tense ? [0, 1, 2, 3, 4, 5, 6, 7] : [0, 3, 6]
  for (const i of hits) {
    const t = eighth(i)
    const o = c.createOscillator()
    const g = c.createGain()
    o.type = tense ? 'triangle' : 'sine'
    o.frequency.value = midi(root + (tense && i % 4 === 3 ? 12 : 0))
    const len = tense ? BEAT * 0.45 : BEAT * 1.2
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(tense ? 0.16 : 0.2, t + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, t + len)
    o.connect(g).connect(m.master)
    o.start(t)
    o.stop(t + len + 0.03)
  }
  // drums: kick, swung hats, a soft snare on two and four
  for (const b of tense ? [0, 1.5, 2, 3.5] : [0, 2.5]) kick(c, m.master, start + b * BEAT, tense ? 0.5 : 0.42)
  for (let i = 0; i < 8; i++) hiss(m, c, eighth(i), 0.05, i % 2 ? 0.03 : 0.045, 'highpass', 7_000)
  if (tense) for (let i = 0; i < 8; i++) hiss(m, c, eighth(i) + BEAT / 4, 0.03, 0.018, 'highpass', 9_000)
  for (const b of [1, 3]) hiss(m, c, start + b * BEAT, tense ? 0.16 : 0.12, tense ? 0.09 : 0.05, 'bandpass', 1_800)
  // melody with an echo; silent while tense except a warning figure on the A chord
  const line = tense ? (m.bar % 4 === 3 ? [7, -1, 6, -1, 5, -1, 4, -1] : MELODY[7]) : MELODY[m.bar % MELODY.length]
  line.forEach((deg, i) => {
    if (deg < 0) return
    const t = eighth(i)
    const o = c.createOscillator()
    const g = c.createGain()
    o.type = 'triangle'
    o.frequency.value = midi(tense ? PENTA[deg] - 3 : PENTA[deg])
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.06, t + 0.015)
    g.gain.exponentialRampToValueAtTime(0.0001, t + BEAT * 0.9)
    o.connect(g)
    g.connect(m.master)
    g.connect(m.echo)
    o.start(t)
    o.stop(t + BEAT)
  })
}

/** Starts the loop. Must be called from a click (or after `unlockAudio` ran in one). */
export function startMusic(): void {
  if (music || !unlockAudio() || !ctx) return
  const c = ctx
  const master = c.createGain()
  master.gain.value = 0.0001
  master.gain.linearRampToValueAtTime(0.55, c.currentTime + 2.5)
  const comp = c.createDynamicsCompressor()
  comp.threshold.value = -18
  comp.ratio.value = 3
  master.connect(comp).connect(c.destination)
  const filter = c.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 1_600
  filter.Q.value = 0.5
  filter.connect(master)
  // a dotted-eighth echo for the melody
  const delay = c.createDelay(1)
  delay.delayTime.value = BEAT * 0.75
  const feedback = c.createGain()
  feedback.gain.value = 0.32
  const echo = c.createGain()
  echo.gain.value = 0.5
  echo.connect(delay)
  delay.connect(feedback).connect(delay)
  delay.connect(master)
  const m: Music = { master, filter, echo, noise: noiseBuffer(c), timer: 0, nextBar: c.currentTime + 0.1, bar: 0, mood: wantedMood }
  music = m
  const tick = () => {
    if (c.state !== 'running') return
    while (m.nextBar < c.currentTime + 1.2) {
      // the mood changes on a phrase boundary (every four bars) so it never lurches mid-phrase
      if (m.bar % 4 === 0 && m.mood !== wantedMood) m.mood = wantedMood
      scheduleBar(m, c, m.nextBar)
      m.filter.frequency.setTargetAtTime(m.mood === 'tense' ? 3_200 : 1_300 + 400 * ((m.bar % 4) / 3), m.nextBar, 1.2)
      m.nextBar += BAR
      m.bar += 1
    }
  }
  tick()
  m.timer = window.setInterval(tick, 250)
}

/** Calm while the lights hold, tense during a shortfall or blackout. Takes effect at the next phrase. */
export function setMusicMood(mood: MusicMood): void {
  wantedMood = mood
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
