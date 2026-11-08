/**
 * Event catalog.
 *  - FICTIONAL_TEMPLATES: seeded game scenarios, always labelled fictional. Neutral economic
 *    wording only; no violence, casualties or real actors.
 *  - HISTORICAL_ANNOTATIONS: bundled, primary-source (eia.gov) notes placed on the Brent replay at
 *    their publication week. Their price impact is ALREADY in the Brent data, so they carry
 *    logistics/caution effects only (no price multiplier) — a stated game-model assumption.
 */
import { ingestExternalEvent, type ExternalEvent, type WorldCategory, type WorldModifiers } from "./types.ts";

export interface FictionalTemplate {
  templateId: string;
  category: WorldCategory;
  headline: string;
  explanation: string;
  assumption: string;
  region: string;
  effects: Partial<WorldModifiers>;
  minDays: number;
  maxDays: number;
  weight: number;
}

export const FICTIONAL_TEMPLATES: FictionalTemplate[] = [
  {
    templateId: "hormuz_disruption",
    category: "shipping",
    headline: "Shipping disruption in the Strait of Hormuz (fictional scenario)",
    explanation: "Tanker traffic through a key Gulf strait slows sharply in this scenario. Fuel importers expect thinner, later deliveries.",
    assumption: "Vesper City's importer can ship 55% less diesel, deliveries take 1 extra day, merchants want 35% more safety stock, and imported fuel costs 15% more.",
    region: "Gulf shipping lanes",
    effects: { importCapacityBps: -5_500, leadTimeDays: 1, cautionBps: 3_500, logisticsCostBps: 1_500 },
    minDays: 2,
    maxDays: 3,
    weight: 2,
  },
  {
    templateId: "refinery_outage",
    category: "refinery",
    headline: "Regional refinery maintenance cuts diesel output (fictional scenario)",
    explanation: "A large refinery serving the region goes offline for unplanned maintenance.",
    assumption: "Import capacity −25% and refining premium +10% while it is offline.",
    region: "Coastal refinery",
    effects: { importCapacityBps: -2_500, logisticsCostBps: 1_000, cautionBps: 1_000 },
    minDays: 1,
    maxDays: 2,
    weight: 2,
  },
  {
    templateId: "opec_increase",
    category: "production",
    headline: "Producers announce higher output (fictional scenario)",
    explanation: "A producer group raises its production targets; traders expect more crude on the water.",
    assumption: "Import capacity +20%, import cost −10%, merchants hold 15% less safety stock.",
    region: "Global crude supply",
    effects: { importCapacityBps: 2_000, logisticsCostBps: -1_000, cautionBps: -1_500 },
    minDays: 2,
    maxDays: 3,
    weight: 2,
  },
  {
    templateId: "tanker_delays",
    category: "shipping",
    headline: "Port congestion delays fuel tankers (fictional scenario)",
    explanation: "Queues at the regional fuel terminal lengthen.",
    assumption: "Deliveries take 1 extra day; import capacity −20%.",
    region: "Vesper City fuel terminal",
    effects: { leadTimeDays: 1, importCapacityBps: -2_000 },
    minDays: 1,
    maxDays: 2,
    weight: 2,
  },
  {
    templateId: "inventory_build",
    category: "inventory",
    headline: "Fuel inventories build up (fictional scenario)",
    explanation: "Storage tanks fill as demand softens.",
    assumption: "Import cost −6%; merchants hold 20% less safety stock.",
    region: "Regional storage",
    effects: { logisticsCostBps: -600, cautionBps: -2_000 },
    minDays: 1,
    maxDays: 2,
    weight: 2,
  },
  {
    templateId: "heatwave",
    category: "weather",
    headline: "Heatwave over Vesper City (fictional scenario)",
    explanation: "Air conditioners and freezers strain the failing grid; shoppers stay out late.",
    assumption: "Grid outages last 1 hour longer; shopper demand +15%.",
    region: "Vesper City",
    effects: { gridStressHours: 1, demandBps: 1_500 },
    minDays: 1,
    maxDays: 2,
    weight: 2,
  },
  {
    templateId: "cool_spell",
    category: "weather",
    headline: "Mild weather eases the load (fictional scenario)",
    explanation: "Cooler days reduce demand for cooling and late opening.",
    assumption: "Shopper demand −8%.",
    region: "Vesper City",
    effects: { demandBps: -800 },
    minDays: 1,
    maxDays: 2,
    weight: 1,
  },
  {
    templateId: "solar_shortage",
    category: "renewables",
    headline: "Solar panel supply chain squeezed (fictional scenario)",
    explanation: "Panel and battery components are back-ordered worldwide.",
    assumption: "Solar and battery prices +35%.",
    region: "Equipment suppliers",
    effects: { solarCostBps: 3_500 },
    minDays: 2,
    maxDays: 3,
    weight: 1,
  },
  {
    templateId: "solar_glut",
    category: "renewables",
    headline: "Cheap solar panels flood the market (fictional scenario)",
    explanation: "Manufacturers clear inventory at a discount.",
    assumption: "Solar and battery prices −25%.",
    region: "Equipment suppliers",
    effects: { solarCostBps: -2_500 },
    minDays: 2,
    maxDays: 3,
    weight: 1,
  },
  {
    templateId: "carbon_tightening",
    category: "policy",
    headline: "Vesper City council tightens the carbon cap (fictional local policy)",
    explanation: "Inspired by international climate talks, the city's own council issues fewer permits. This is a fictional municipal rule.",
    assumption: "Daily permit supply −30%.",
    region: "Vesper City council",
    effects: { permitSupplyBps: -3_000 },
    minDays: 2,
    maxDays: 3,
    weight: 1,
  },
  {
    templateId: "carbon_relief",
    category: "policy",
    headline: "Council releases extra permits for the season (fictional local policy)",
    explanation: "A one-off release to help businesses through the outage crisis.",
    assumption: "Daily permit supply +25%.",
    region: "Vesper City council",
    effects: { permitSupplyBps: 2_500 },
    minDays: 1,
    maxDays: 2,
    weight: 1,
  },
  {
    templateId: "shipping_recovery",
    category: "recovery",
    headline: "Shipping lanes recover (fictional scenario)",
    explanation: "Tanker schedules normalise and freight rates ease.",
    assumption: "Import capacity +30%; merchants hold 25% less safety stock; import cost −5%.",
    region: "Global shipping",
    effects: { importCapacityBps: 3_000, cautionBps: -2_500, logisticsCostBps: -500 },
    minDays: 2,
    maxDays: 3,
    weight: 1,
  },
];

const RAW_HISTORICAL: unknown[] = [
  {
    id: "eia-steo-2026-04",
    category: "shipping",
    headline: "EIA: limited flows through the Strait of Hormuz; Gulf crude output shut in",
    explanation:
      "EIA's April 2026 outlook estimated about 7.5 million b/d of Gulf crude production shut in during March and said full restoration of flows through the strait would take months. Brent averaged $103/b in March.",
    assumption: "Game model: Vesper City's importer receives 50% less diesel capacity, deliveries take 1 extra day, merchants hold 30% more safety stock. No extra price multiplier — the Brent replay already contains the price move.",
    region: "Strait of Hormuz",
    sourceTitle: "EIA press release, April 7, 2026 (Short-Term Energy Outlook)",
    sourceUrl: "https://www.eia.gov/pressroom/releases/press586.php",
    publishedAt: "2026-04-07",
    durationDays: 7,
    effects: { importCapacityBps: -5_000, leadTimeDays: 1, cautionBps: 3_000 },
  },
  {
    id: "eia-steo-2026-06",
    category: "demand",
    headline: "EIA: Hormuz effectively closed near term; lower global demand limits price increases",
    explanation:
      "EIA's June 2026 outlook said the strait was effectively closed in the near term, Middle East output was down by over 11 million b/d, OECD inventories were the lowest since 2003, and 2026 global oil consumption was 1.1 million b/d below 2025.",
    assumption: "Game model: import capacity −55%, deliveries +1 day, merchants hold 35% more safety stock. No extra price multiplier.",
    region: "Strait of Hormuz / global demand",
    sourceTitle: "EIA press release, June 9, 2026 (Short-Term Energy Outlook)",
    sourceUrl: "https://www.eia.gov/pressroom/releases/press589.php",
    publishedAt: "2026-06-09",
    durationDays: 4,
    effects: { importCapacityBps: -5_500, leadTimeDays: 1, cautionBps: 3_500 },
  },
  {
    id: "eia-steo-2026-10",
    category: "recovery",
    headline: "EIA: crude shut-ins easing; bypass pipeline flows partially resumed",
    explanation:
      "EIA's October 2026 outlook reported shut-ins falling from 10.9 million b/d at the May peak to 4.8 million b/d in September, a Brent spot peak of $131/b on September 15 after a pipeline disruption, and partial resumption of bypass pipeline flows from September 22.",
    assumption: "Game model: import capacity still −25% and merchants hold 10% more safety stock while supply recovers. No extra price multiplier.",
    region: "Gulf supply routes",
    sourceTitle: "EIA Short-Term Energy Outlook, October 6, 2026 — Global oil markets",
    sourceUrl: "https://www.eia.gov/outlooks/steo/report/global_oil.php",
    publishedAt: "2026-10-06",
    durationDays: 4,
    effects: { importCapacityBps: -2_500, cautionBps: 1_000 },
  },
];

/** Bundled data goes through the same validator as any external payload. */
export const HISTORICAL_ANNOTATIONS: ExternalEvent[] = RAW_HISTORICAL.map((raw) => {
  const r = ingestExternalEvent(raw);
  if (!r.ok) throw new Error(`invalid bundled historical event: ${r.reason}`);
  return r.event;
});

/** Economy Lab conditions and weekly challenges: fixed, reproducible schedules. */
export const PRESETS: Record<string, { name: string; description: string; schedule: { templateId: string; day: number; days: number }[] }> = {
  calm: { name: "Normal market", description: "No world events.", schedule: [] },
  disruption: { name: "Fuel supply disruption", description: "A Strait of Hormuz shipping disruption (fictional) from day 2 for 3 days.", schedule: [{ templateId: "hormuz_disruption", day: 2, days: 3 }] },
  recovery: {
    name: "Disruption then recovery",
    description: "Disruption on days 2–3, then shipping lanes recover on days 4–6.",
    schedule: [
      { templateId: "hormuz_disruption", day: 2, days: 2 },
      { templateId: "shipping_recovery", day: 4, days: 3 },
    ],
  },
  demand_surge: {
    name: "Higher customer demand",
    description: "Back-to-back heatwaves on days 2–5.",
    schedule: [
      { templateId: "heatwave", day: 2, days: 2 },
      { templateId: "heatwave", day: 4, days: 2 },
    ],
  },
  carbon_tightening: { name: "Carbon-policy tightening", description: "Vesper City cuts permit supply 30% from day 2 to 6 (fictional).", schedule: [{ templateId: "carbon_tightening", day: 2, days: 5 }] },
  solar_boom: { name: "Renewable investment wave", description: "Solar and battery prices −25% from day 2 to 6.", schedule: [{ templateId: "solar_glut", day: 2, days: 5 }] },
};
export type PresetId = keyof typeof PRESETS;
