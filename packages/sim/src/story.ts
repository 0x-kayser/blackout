/**
 * Story chapters for Vesper City. Each chapter completes from REAL game state (never a timer),
 * emits a CHAPTER_COMPLETED event with a short character beat, and grants a bounded,
 * non-monetary reward: +2% reputation and +5% loyalty from the character's business.
 * No credits or resources are ever created here.
 */
import { emit, type Ctx, type SimState } from "./state.ts";

export interface Character {
  id: string;
  name: string;
  role: string;
  businessId: string | null;
}

export const CHARACTERS: Record<string, Character> = {
  ade: { id: "ade", name: "Mama Ade", role: "runs the corner shop and lent you the generator shed", businessId: "corner_shop" },
  tunde: { id: "tunde", name: "Tunde", role: "owns the Cold Room and its very nervous freezers", businessId: "cold_room" },
  rosa: { id: "rosa", name: "Rosa", role: "bakes before dawn at Sunrise Bakery", businessId: "bakery" },
  imani: { id: "imani", name: "Dr. Imani", role: "keeps vaccines cold at the Corner Pharmacy", businessId: "pharmacy" },
  kai: { id: "kai", name: "Kai", role: "runs Byte Cyber Café and hates downtime", businessId: "cyber_cafe" },
  lina: { id: "lina", name: "Lina", role: "sells diesel at Lantern Corner Fuel", businessId: null },
  victor: { id: "victor", name: "Victor Lane", role: "runs VoltLine, the rival power company", businessId: null },
};

export interface Chapter {
  id: string;
  title: string;
  goal: string;
  character: string;
  beat: string;
  done: (s: SimState) => boolean;
}

const t = (s: SimState) => s.totals;

export const CHAPTERS: Chapter[] = [
  {
    id: "first_light",
    title: "First Light",
    goal: "Restore power to the Cold Room.",
    character: "tunde",
    beat: "The compressors kick back in. Tunde leans on the counter and laughs: “You kept the cold room running. Same time tomorrow?”",
    done: (s) => (t(s).servicesStarted ?? 0) >= 1,
  },
  {
    id: "open_for_business",
    title: "Open for Business",
    goal: "Complete 5 power contracts.",
    character: "ade",
    beat: "Mama Ade pins your number to the noticeboard: “Five shops say you showed up. Around here, that's a reputation.”",
    done: (s) => (t(s).contractsCompleted ?? 0) >= 5,
  },
  {
    id: "fuel_run",
    title: "Fuel Run",
    goal: "Buy diesel from a merchant.",
    character: "lina",
    beat: "Lina chalks your name on her board. “My price follows my stock and demand. Watch it when my tank runs low.”",
    done: (s) => (t(s).dieselPurchases ?? 0) >= 1,
  },
  {
    id: "rival_in_town",
    title: "A Rival in Town",
    goal: "VoltLine starts competing for your customers.",
    character: "victor",
    beat: "A red van parks across the street. Victor Lane tips his cap: “Miss a call and I will take it. Nothing personal. Just business.”",
    done: (s) => s.rival.contractsWon >= 1 || s.day >= 2,
  },
  {
    id: "storm_season",
    title: "Storm Season",
    goal: "Complete 3 contracts while a world event is shaking the market.",
    character: "ade",
    beat: "“The market is rough,” says Mama Ade, “but my lights stayed on. That is what people will remember.”",
    done: (s) => (t(s).contractsDuringEvents ?? 0) >= 3,
  },
  {
    id: "sun_on_the_rooftops",
    title: "Sun on the Rooftops",
    goal: "Install rooftop solar.",
    character: "imani",
    beat: "Dr. Imani watches the panels go up. “When the sun is up, we have another source of power.”",
    done: (s) => s.player.upgradesOwned.includes("solar_2kw"),
  },
  {
    id: "bigger_grid",
    title: "Bigger Grid",
    goal: "Reach 10 kW of generating capacity.",
    character: "kai",
    beat: "Kai streams the switch-on to his customers: “Ten kilowatts. We could run a tournament on this.”",
    done: (s) => s.player.generatorIds.reduce((a, id) => a + s.generators[id].ratedW, 0) >= 10_000,
  },
  {
    id: "night_shift",
    title: "The Night Shift",
    goal: "Unlock Hospital Row.",
    character: "imani",
    beat: "The Night Clinic's director calls: “Dr. Imani says you have the capacity to serve Hospital Row. We need reliable power after dark.”",
    done: (s) => s.districts.hospital_row?.unlocked === true,
  },
  {
    id: "grid_independent",
    title: "Grid Independent",
    goal: "Complete 3 contracts powered by solar and battery alone.",
    character: "rosa",
    beat: "Rosa's ovens ran on stored sunshine. “Three contracts without diesel. You did it.”",
    done: (s) => (t(s).solarContractsCompleted ?? 0) >= 3,
  },
];

export function storyTick(s: SimState, ctx: Ctx): void {
  s.story ??= { completed: [] };
  for (const ch of CHAPTERS) {
    if (s.story.completed.includes(ch.id) || !ch.done(s)) continue;
    s.story.completed.push(ch.id);
    const who = CHARACTERS[ch.character];
    s.player.reputationBps = Math.min(10_000, s.player.reputationBps + 200);
    if (who.businessId && s.businesses[who.businessId]) {
      const b = s.businesses[who.businessId];
      b.loyaltyBps = Math.min(10_000, b.loyaltyBps + 500);
    }
    emit(s, ctx, "CHAPTER_COMPLETED", ["player", `character:${who.id}`], `Chapter complete: ${ch.title}. ${ch.beat}`, {
      chapterId: ch.id,
      title: ch.title,
      character: who.name,
      beat: ch.beat,
      reward: who.businessId ? `+2% reputation, +5% loyalty from ${s.businesses[who.businessId]?.name}` : "+2% reputation",
    });
  }
}
