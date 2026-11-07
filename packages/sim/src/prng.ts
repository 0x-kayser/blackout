/**
 * Seeded PRNG (sfc32) whose 4x uint32 state lives inside the game state, so
 * seed + actions fully determine every draw. Never use Math.random in the sim.
 */
export type RngState = [number, number, number, number];

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

export function seedRng(seed: number): RngState {
  const sm = splitmix32(seed);
  const st: RngState = [sm(), sm(), sm(), sm()];
  for (let i = 0; i < 12; i++) nextU32(st);
  return st;
}

/** Advances `st` in place and returns a uint32. */
export function nextU32(st: RngState): number {
  let [a, b, c, d] = st;
  const t = (((a + b) >>> 0) + d) >>> 0;
  d = (d + 1) >>> 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) >>> 0;
  c = ((c << 21) | (c >>> 11)) >>> 0;
  c = (c + t) >>> 0;
  st[0] = a >>> 0;
  st[1] = b >>> 0;
  st[2] = c;
  st[3] = d;
  return t;
}

/** Uniform integer in [0, n). */
export function rngInt(st: RngState, n: number): number {
  if (n <= 0) return 0;
  return nextU32(st) % n;
}

export function rngRange(st: RngState, lo: number, hi: number): number {
  return lo + rngInt(st, hi - lo + 1);
}

export function rngPick<T>(st: RngState, items: readonly T[]): T {
  return items[rngInt(st, items.length)];
}

/** Deterministic Fisher-Yates on a copy. */
export function rngShuffle<T>(st: RngState, items: readonly T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rngInt(st, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
