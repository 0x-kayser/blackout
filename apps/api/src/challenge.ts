/** Weekly challenge: one fixed seed and world condition per ISO week, identical for every player. */
import { PRESETS } from "@blackout/sim";

const ROTATION = ["disruption", "recovery", "demand_surge", "carbon_tightening", "solar_boom"] as const;

export function isoWeek(d = new Date()): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function challengeFor(week: string): { seed: number; condition: (typeof ROTATION)[number]; name: string; description: string } {
  let h = 2166136261;
  for (const ch of `blackout-challenge:${week}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const n = Number(week.slice(-2)) || 0;
  const condition = ROTATION[n % ROTATION.length];
  return { seed: h % 2_000_000_000, condition, name: PRESETS[condition].name, description: PRESETS[condition].description };
}
