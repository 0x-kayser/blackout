/**
 * Daily goals and streaks: three concrete things to aim for every game day, paid by the
 * City Council's emergency fund. Finish all three to grow your streak; every streak day
 * adds 10% to goal rewards (up to +50%). Goals rotate by day (no randomness) and read
 * only facts the engine already tracks, so they never change how the economy behaves.
 */
import { ACC, transfer } from "./ledger.ts";
import { cr, emit, type Ctx, type SimState } from "./state.ts";

export type GoalKind = "earn" | "lit" | "serve" | "code_red" | "exchange_sell";

export interface GoalState {
  goalId: string;
  kind: GoalKind;
  label: string;
  target: number;
  progress: number;
  rewardCc: number;
  done: boolean;
}

export interface GoalsState {
  day: number;
  items: GoalState[];
  streak: number;
  bestStreak: number;
  /** Counters the engine bumps for goals it cannot read from day stats. */
  codeRedsAnswered: number;
  exchangeSales: number;
}

export const STREAK_BONUS_BPS_PER_DAY = 1_000;
export const STREAK_BONUS_MAX_DAYS = 5;

function templates(s: SimState): GoalState[] {
  const d = s.day;
  const earnCc = 15_000 + 5_000 * (d % 3);
  const lit = Math.min(5, 3 + (d % 3));
  const serve = 4 + (d % 3);
  const all: (GoalState | null)[] = [
    { goalId: `d${d}:earn`, kind: "earn", label: `Earn ${cr(earnCc)} credits from customers today`, target: earnCc, progress: 0, rewardCc: 4_000, done: false },
    { goalId: `d${d}:lit`, kind: "lit", label: `Keep ${lit} businesses on your power at once`, target: lit, progress: 0, rewardCc: 3_000, done: false },
    { goalId: `d${d}:serve`, kind: "serve", label: `Finish ${serve} power contracts`, target: serve, progress: 0, rewardCc: 3_000, done: false },
    d >= 2 ? { goalId: `d${d}:code_red`, kind: "code_red", label: "Answer a Code Red call", target: 1, progress: 0, rewardCc: 5_000, done: false } : null,
    s.mode === "play" ? { goalId: `d${d}:exchange_sell`, kind: "exchange_sell", label: "Sell fuel on the Exchange", target: 1, progress: 0, rewardCc: 3_000, done: false } : null,
  ];
  return all.filter((g): g is GoalState => g !== null);
}

function itemsForToday(s: SimState): GoalState[] {
  const pool = templates(s);
  const start = s.day % pool.length;
  return [0, 1, 2].map((i) => pool[(start + i) % pool.length]);
}

/** Read-only view of today's goals (does not touch state; used by the public view). */
export function goalsForView(s: SimState) {
  const g = s.goals;
  const items = g && g.day === s.day ? g.items : itemsForToday(s);
  const streak = g?.streak ?? 0;
  return { day: s.day, items: items.map((x) => ({ ...x })), streak, bestStreak: g?.bestStreak ?? 0, rewardMultiplierBps: streakMultiplierBps(streak) };
}

export function ensureGoals(s: SimState): GoalsState {
  if (!s.goals) s.goals = { day: 0, items: [], streak: 0, bestStreak: 0, codeRedsAnswered: 0, exchangeSales: 0 };
  if (s.goals.day !== s.day) {
    s.goals.items = itemsForToday(s);
    s.goals.day = s.day;
    s.goals.codeRedsAnswered = 0;
    s.goals.exchangeSales = 0;
  }
  return s.goals;
}

export const streakMultiplierBps = (streak: number) => 10_000 + STREAK_BONUS_BPS_PER_DAY * Math.min(streak, STREAK_BONUS_MAX_DAYS);

function playerLitNow(s: SimState): number {
  return Object.values(s.businesses).filter((b) => b.activeContractId && s.contracts[b.activeContractId]?.provider === "player" && s.contracts[b.activeContractId]?.status === "active").length;
}

/** Updates progress and pays any goal that was just reached. Runs every tick and after exchange effects. */
export function goalsTick(s: SimState, ctx: Ctx): void {
  if (s.phase === "finished") return;
  const g = ensureGoals(s);
  for (const item of g.items) {
    if (item.done) continue;
    const now =
      item.kind === "earn" ? s.dayStats.revenueCc
      : item.kind === "lit" ? Math.max(item.progress, playerLitNow(s))
      : item.kind === "serve" ? s.dayStats.contractsCompleted
      : item.kind === "code_red" ? g.codeRedsAnswered
      : g.exchangeSales;
    item.progress = Math.min(item.target, now);
    if (item.progress < item.target) continue;
    item.done = true;
    const reward = Math.floor((item.rewardCc * streakMultiplierBps(g.streak)) / 10_000);
    transfer(s, ctx, "credits_cc", ACC.council, ACC.player, reward, "daily_goal_reward", item.goalId);
    const left = g.items.filter((x) => !x.done).length;
    emit(s, ctx, "GOAL_COMPLETED", ["player", ACC.council], `Goal done: ${item.label}. The City Council pays ${cr(reward)} credits${g.streak ? ` (streak bonus +${Math.min(g.streak, STREAK_BONUS_MAX_DAYS) * 10}%)` : ""}.${left ? ` ${left} to go today.` : " All three done: your streak grows tonight!"}`, {
      goalId: item.goalId, kind: item.kind, rewardCc: reward, remaining: left, streak: g.streak,
    });
  }
}

/** At the end of a game day: all three goals done grows the streak; anything less resets it. */
export function closeGoalsDay(s: SimState, ctx: Ctx): void {
  const g = ensureGoals(s);
  const all = g.items.length > 0 && g.items.every((x) => x.done);
  const before = g.streak;
  g.streak = all ? g.streak + 1 : 0;
  g.bestStreak = Math.max(g.bestStreak, g.streak);
  if (all || before > 0) {
    emit(s, ctx, "STREAK_UPDATED", ["player"], all ? `Day ${s.day} goals complete: ${g.streak}-day streak. Goal rewards are now +${Math.min(g.streak, STREAK_BONUS_MAX_DAYS) * 10}%.` : `Streak lost after ${before} day${before === 1 ? "" : "s"}: not every goal was finished on day ${s.day}.`, {
      streak: g.streak, bestStreak: g.bestStreak, previous: before,
    });
  }
}
