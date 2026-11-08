import { describe, expect, it } from "vitest";
import { runReplay } from "../src/replay.ts";
import { closeGoalsDay, ensureGoals, goalsForView, goalsTick, streakMultiplierBps } from "../src/goals.ts";
import { ACC, bal, sumAsset } from "../src/ledger.ts";
import { newCtx } from "../src/state.ts";
import { toPublic } from "../src/view.ts";
import { newRun } from "./helpers.ts";

describe("daily goals and streaks", () => {
  it("rotates three goals per day without randomness; the Exchange goal appears only in a player's continuous city", () => {
    const play = newRun(1, { mode: "play" }).s;
    const demo = newRun(1, { mode: "guest_demo" }).s;
    const kinds = (s: typeof play) => ensureGoals(s).items.map((g) => g.kind);
    expect(kinds(play)).toEqual(["lit", "serve", "exchange_sell"]);
    expect(kinds(demo)).not.toContain("exchange_sell");
    expect(kinds(demo)).not.toContain("code_red"); // no Code Red goal on day 1
    expect(toPublic(play).goals).toMatchObject({ day: 1, streak: 0, rewardMultiplierBps: 10_000 });
    // the public view never mutates the run
    const fresh = newRun(2, { mode: "play" }).s;
    toPublic(fresh);
    expect(fresh.goals).toBeUndefined();
  });

  it("pays a finished goal once from the City Council and keeps the ledger balanced", () => {
    const { s } = newRun(3, { mode: "play" });
    const g = ensureGoals(s);
    const sell = g.items.find((x) => x.kind === "exchange_sell")!;
    const before = bal(s, "credits_cc", ACC.player);
    g.exchangeSales = 1;
    const ctx = newCtx(s);
    goalsTick(s, ctx);
    goalsTick(s, ctx);
    expect(sell.done).toBe(true);
    expect(bal(s, "credits_cc", ACC.player)).toBe(before + sell.rewardCc);
    expect(ctx.events.filter((e) => e.type === "GOAL_COMPLETED")).toHaveLength(1);
    expect(sumAsset(s, "credits_cc")).toBe(0);
  });

  it("grows the streak only when all three goals are done, and the streak raises rewards", () => {
    const { s } = newRun(4, { mode: "play" });
    const g = ensureGoals(s);
    g.items.forEach((x) => (x.done = true));
    closeGoalsDay(s, newCtx(s));
    expect(g.streak).toBe(1);
    expect(streakMultiplierBps(g.streak)).toBe(11_000);
    g.items[0].done = false;
    const ctx = newCtx(s);
    closeGoalsDay(s, ctx);
    expect(g.streak).toBe(0);
    expect(g.bestStreak).toBe(1);
    expect(ctx.events[0].explanation).toMatch(/Streak lost after 1 day/);
    expect(goalsForView(s).rewardMultiplierBps).toBe(10_000);
    expect(streakMultiplierBps(99)).toBe(15_000);
  });
});

describe("Code Red emergencies", () => {
  it("arrive from day 2 at double pay with no haggling and a short timer; missing one costs reputation", () => {
    const t = runReplay({ seed: 424242, policyId: "diesel", days: 4 });
    const called = t.events.filter((e) => e.type === "CODE_RED_CALLED");
    expect(called.length).toBeGreaterThan(0);
    expect(called.every((e) => e.day >= 2)).toBe(true);
    for (const e of called) {
      const req = t.events.find((x) => x.type === "CUSTOMER_REQUESTED" && x.data.requestId === e.data.requestId)!;
      expect(req.data.offerRateCcPerKwh).toBe(e.data.offerRateCcPerKwh);
      expect((req.data.deadlineTick as number) - req.tick).toBe(7);
    }
    const missed = t.events.filter((e) => e.type === "CODE_RED_MISSED");
    for (const m of missed) expect(m.data.reputationPenaltyBps).toBe(150);
    // the same seed always produces the same emergencies
    const again = runReplay({ seed: 424242, policyId: "diesel", days: 4 });
    expect(again.events.filter((e) => e.type === "CODE_RED_CALLED").map((e) => e.data.requestId)).toEqual(called.map((e) => e.data.requestId));
  });
});
