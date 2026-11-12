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
  /** Weather stories: the cloud cover the sky moves to while they run (cuts solar output, firmPolicy.ts). */
  cloudPct?: number;
}

export const NEWS_EVERY: [number, number] = [35, 65];
export const NEWS_LASTS: [number, number] = [70, 130];
export const NEWS_MAX_ACTIVE = 2;

export const STORIES: NewsStory[] = [
  {
    storyId: "tanker-delayed",
    headline: "Hormuz rerouting & harbour fog delay LNG tanker",
    detail: "Delayed in Gulf shipping lanes and held outside Vesper harbour, Ingrid's LNG imports drop to almost nothing. Her gas gets dearer as her tanks drain.",
    tone: "warn",
    effects: [{ item: "fuel:natural-gas", merchants: ["ingrid"], imports: 0.15 }],
  },
  {
    storyId: "henry-hub-jump",
    headline: "Global gas benchmark jumps 18% on Strait tensions",
    detail: "Shipping risk in the Strait pushes up the outside reference price every gas seller starts from. Gas turbines across Vesper cost more to run.",
    tone: "warn",
    effects: [{ item: "fuel:natural-gas", merchants: null, outside: 1.18 }],
  },
  {
    storyId: "lng-cargo",
    headline: "Rerouted LNG convoy docks early at Vesper Port",
    detail: "Ingrid receives double her scheduled LNG cargo as convoy escorts clear the strait, and outside prices dip. Cheap gas for anyone who buys now.",
    tone: "good",
    effects: [{ item: "fuel:natural-gas", merchants: ["ingrid"], imports: 2 }, { item: "fuel:natural-gas", merchants: null, outside: 0.88 }],
  },
  {
    storyId: "heat-south",
    headline: "Southern heatwave: regional utilities scramble for gas",
    detail: "Outside buyers are taking twice the usual gas from Ingrid and Bayo to cover air-conditioning load. Their stock falls and the price climbs.",
    tone: "warn",
    effects: [{ item: "fuel:natural-gas", merchants: null, demand: 2 }],
  },
  {
    storyId: "cold-snap",
    headline: "Northern cold snap: backup diesel demand doubles",
    detail: "Outside customers want twice the diesel as heating grids strain. Kettle, Dayo and Chioma are selling faster than they can import.",
    tone: "warn",
    effects: [{ item: "fuel:diesel", merchants: null, demand: 2 }],
  },
  {
    storyId: "drivers-strike",
    headline: "Gulf tanker blockade & port strike cut diesel imports",
    detail: "Delayed crude cargoes and a terminal walkout cut diesel imports to a quarter. Whoever holds diesel now sets the price.",
    tone: "warn",
    effects: [{ item: "fuel:diesel", merchants: null, imports: 0.25 }],
  },
  {
    storyId: "rooftop-glut",
    headline: "Sunny week: COP31 solar boom floods the green desk",
    detail: "Rooftop and co-op solar producers sell Lena five times the usual certificates while fewer firms buy. Certificates get cheap, and Lena's cash runs down buying them.",
    tone: "warn",
    effects: [{ item: "certificate:renewable", merchants: ["lena"], supply: 5, demand: 0.6 }],
  },
  {
    storyId: "green-mandate",
    headline: "COP31 corporate mandate: firms rush for green certificates",
    detail: "Under the new COP31 net-zero disclosure rules, Vesper firms are queueing at Lena's desk for renewable certificates. Sell yours while they're dear.",
    tone: "good",
    effects: [{ item: "certificate:renewable", merchants: ["lena"], demand: 2.5 }],
  },
  {
    storyId: "storm-front",
    headline: "Storm front parks over Vesper",
    detail: "Thick cloud for hours: solar output collapses. Solara Energy will have to buy backup power, and rooftop solar sells Lena fewer certificates.",
    tone: "warn",
    cloudPct: 92,
    effects: [{ item: "certificate:renewable", merchants: ["lena"], supply: 0.3 }],
  },
  {
    storyId: "clear-skies",
    headline: "Clear skies all week boost renewable generation",
    detail: "Solar farms run flat out; Solara needs less backup and rooftops send Lena twice the certificates.",
    tone: "good",
    cloudPct: 5,
    effects: [{ item: "certificate:renewable", merchants: ["lena"], supply: 2 }],
  },
  {
    storyId: "carbon-up",
    headline: "COP31 carbon floor: regulator tightens permit price +25%",
    detail: "Following the COP31 Sovereign Grid Accord, carbon permits cost 25% more at auction. Every tonne your plants burn without a permit costs 25% extra too.",
    tone: "warn",
    effects: [{ item: "permit:carbon", merchants: null, outside: 1.25 }],
  },
  {
    storyId: "steel-strike",
    headline: "Maritime freight surge & port strike hit steel deliveries",
    detail: "Pavel's deliveries fall to a third and world steel is 20% dearer. Every new power plant and transmission upgrade costs more to build.",
    tone: "warn",
    effects: [{ item: "material:steel", merchants: ["pavel"], imports: 0.33, outside: 1.2 }],
  },
  {
    storyId: "turbine-recall",
    headline: "Global supply crunch hits gas turbine spares",
    detail: "Plant operators are rushing to Nkechi for spare kits as shipping delays bite, and her upstream supplier wants 30% more for them.",
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
