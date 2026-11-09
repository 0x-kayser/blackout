/**
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
 *  VESPER MARKET NEWS — what happens outside the market, and exactly what each story does to it.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Every 35–65 ticks (under a minute of play) a story breaks, unless two are already running. A story lasts 70–130
 * ticks. While it runs it multiplies one or more of a merchant's real flows:
 *
 *   imports   what the merchant can bring in from outside          (a delayed tanker: ×0.15)
 *   demand    what outside customers buy from it                   (a cold snap: ×2)
 *   supply    what outside producers sell to it                    (a sunny week of rooftop solar: ×5)
 *   outside   the outside reference price every factor starts from (Henry Hub jumps: ×1.18)
 *
 * Nothing is set directly: stock and recent demand move, and the price rule in merchantPricing.ts does the rest.
 * The price tooltip names the story, so "why is gas dear?" always has an answer. Gas and diesel prices then flow into
 * every power region (fuelled plants cost more to run), so a tanker delay shows up in your evening power price.
 *
 * Stories are drawn from their own seeded stream, so the same town seed always tells the same news.
 */
import type { ItemId } from "@blackout/shared";

export interface NewsEffect {
  item: ItemId;
  /** Merchants affected; null = everyone trading this item. */
  merchants: string[] | null;
  imports?: number;
  demand?: number;
  supply?: number;
  outside?: number;
}

export interface NewsStory {
  storyId: string;
  headline: string;
  detail: string;
  tone: "warn" | "good";
  effects: NewsEffect[];
}

export const NEWS_EVERY: [number, number] = [35, 65];
export const NEWS_LASTS: [number, number] = [70, 130];
export const NEWS_MAX_ACTIVE = 2;

export const STORIES: NewsStory[] = [
  {
    storyId: "tanker-delayed",
    headline: "LNG tanker stuck outside Vesper harbour",
    detail: "Ingrid's imports are down to almost nothing until the fog lifts. Her gas will get dearer as her tanks drain.",
    tone: "warn",
    effects: [{ item: "fuel:natural-gas", merchants: ["ingrid"], imports: 0.15 }],
  },
  {
    storyId: "henry-hub-jump",
    headline: "Henry Hub gas jumps 18% overnight",
    detail: "The outside price every gas seller starts from is up. Gas turbines across Vesper cost more to run.",
    tone: "warn",
    effects: [{ item: "fuel:natural-gas", merchants: null, outside: 1.18 }],
  },
  {
    storyId: "lng-cargo",
    headline: "Extra LNG cargo docks early",
    detail: "Ingrid has more gas than she planned for and outside prices dip. Cheap gas for anyone who buys now.",
    tone: "good",
    effects: [{ item: "fuel:natural-gas", merchants: ["ingrid"], imports: 2 }, { item: "fuel:natural-gas", merchants: null, outside: 0.88 }],
  },
  {
    storyId: "heat-south",
    headline: "Heat across the south: everyone wants gas",
    detail: "Outside buyers are taking twice the usual gas from Ingrid and Bayo. Their stock falls and the price climbs.",
    tone: "warn",
    effects: [{ item: "fuel:natural-gas", merchants: null, demand: 2 }],
  },
  {
    storyId: "cold-snap",
    headline: "Cold snap up north: diesel heaters on",
    detail: "Outside customers want twice the diesel. Kettle, Dayo and Chioma are selling faster than they can import.",
    tone: "warn",
    effects: [{ item: "fuel:diesel", merchants: null, demand: 2 }],
  },
  {
    storyId: "drivers-strike",
    headline: "Tanker drivers strike",
    detail: "Diesel imports fall to a quarter. Whoever holds diesel now holds the price.",
    tone: "warn",
    effects: [{ item: "fuel:diesel", merchants: null, imports: 0.25 }],
  },
  {
    storyId: "rooftop-glut",
    headline: "A sunny week: rooftop solar floods the green desk",
    detail: "Households are selling Lena five times the usual certificates and fewer firms are buying. Certificates get cheap, and Lena's cash runs down buying them.",
    tone: "warn",
    effects: [{ item: "certificate:renewable", merchants: ["lena"], supply: 5, demand: 0.6 }],
  },
  {
    storyId: "green-mandate",
    headline: "City hall orders offices to buy green power",
    detail: "Firms are queueing at Lena's desk for certificates. Sell yours while they're dear.",
    tone: "good",
    effects: [{ item: "certificate:renewable", merchants: ["lena"], demand: 2.5 }],
  },
  {
    storyId: "carbon-up",
    headline: "Carbon price up 25% after the regulator's review",
    detail: "Permits cost more everywhere. Every tonne your plants burn without one costs more too.",
    tone: "warn",
    effects: [{ item: "permit:carbon", merchants: null, outside: 1.25 }],
  },
  {
    storyId: "steel-strike",
    headline: "Steelworkers strike at the port",
    detail: "Pavel's deliveries fall to a third and world steel is 20% dearer. Every new plant and line upgrade costs more.",
    tone: "warn",
    effects: [{ item: "material:steel", merchants: ["pavel"], imports: 0.33, outside: 1.2 }],
  },
  {
    storyId: "turbine-recall",
    headline: "Turbine maker recalls a batch of parts",
    detail: "Plant owners are rushing to Nkechi for spare kits, and her supplier wants 30% more for them.",
    tone: "warn",
    effects: [{ item: "part:turbine", merchants: ["nkechi"], demand: 4, outside: 1.3 }],
  },
];

export const storyById = (id: string) => STORIES.find((x) => x.storyId === id);

/** What a story does, in words for the price tooltip. */
export function effectLabel(e: NewsEffect): string {
  const parts: string[] = [];
  const x = (n: number) => `×${n.toFixed(2).replace(/\.?0+$/, "")}`;
  if (e.imports !== undefined) parts.push(`imports ${x(e.imports)}`);
  if (e.demand !== undefined) parts.push(`outside buying ${x(e.demand)}`);
  if (e.supply !== undefined) parts.push(`outside selling ${x(e.supply)}`);
  if (e.outside !== undefined) parts.push(`outside price ${x(e.outside)}`);
  return parts.join(", ");
}
