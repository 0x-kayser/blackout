/**
 * Vesper Market: who trades what. Quantities are whole units (MMBtu, L, t, MWh certificates, t steel, kits);
 * money is cc. One town tick = 5 town minutes = 1 real second; 288 ticks = one town day.
 */
import type { ItemId } from "@blackout/shared";

export const TICKS_PER_DAY = 288;
export const EPOCH_TICKS = 72;
/** A merchant with less than this share of a day's fixed costs in cash closes its shop. */
export const CLOSE_BELOW_DAY_BPS = 2_000;
/** Credits (in days of fixed costs) a closed shop needs to reopen. */
export const REOPEN_DAYS = 3;
/** If nobody invests, outside investors reopen a shop after this many days closed. */
export const RESCUE_AFTER_DAYS = 2;
/** Merchants won't buy more of an item once they hold this many times their target. */
export const WAREHOUSE_FULL_X = 4;
/** Share of cash above the cushion paid out as dividends each day. */
export const DIVIDEND_BPS = 4_000;

/**
 * Fixed Vesper endowment for resources that can be depleted. Day 0 stock is available at genesis; later lots are
 * already part of the endowment and only move from sealed deposits into the market reserve on schedule.
 * Renewable certificates are deliberately excluded: they are produced by solar generation.
 */
export const RESOURCE_ENDOWMENT: Partial<Record<ItemId, { total: number; deposits: { day: number; quantity: number; name: string }[] }>> = {
  "fuel:natural-gas": { total: 25_000_000, deposits: [{ day: 0, quantity: 11_250_000, name: "Harbor gas caverns" }, { day: 90, quantity: 5_000_000, name: "East seam" }, { day: 210, quantity: 8_750_000, name: "Deep Vesper reserve" }] },
  "fuel:diesel": { total: 75_000_000, deposits: [{ day: 0, quantity: 33_750_000, name: "Port fuel tanks" }, { day: 90, quantity: 15_000_000, name: "Inland depot" }, { day: 210, quantity: 26_250_000, name: "Sealed strategic stock" }] },
  "permit:carbon": { total: 900_000, deposits: [{ day: 0, quantity: 405_000, name: "Initial carbon allowance" }, { day: 90, quantity: 180_000, name: "Midyear allowance" }, { day: 210, quantity: 315_000, name: "Final allowance" }] },
  "material:steel": { total: 180_000, deposits: [{ day: 0, quantity: 81_000, name: "Port steel stock" }, { day: 90, quantity: 36_000, name: "Eastern mill stock" }, { day: 210, quantity: 63_000, name: "Reclaimed city steel" }] },
  "part:turbine": { total: 5_000, deposits: [{ day: 0, quantity: 2_250, name: "Workshop parts" }, { day: 90, quantity: 1_000, name: "Port spares" }, { day: 210, quantity: 1_750, name: "Reclaimed turbine kits" }] },
};

export const reserveAvailableAccount = (item: ItemId) => `reserve:${item}:available`;
export const reserveSealedAccount = (item: ItemId, day: number) => `reserve:${item}:sealed:${day}`;
export const reserveRemainingAt = (item: ItemId, balances: Record<string, number>): number => Object.entries(balances)
  .filter(([account]) => account === reserveAvailableAccount(item) || account.startsWith(`reserve:${item}:sealed:`))
  .reduce((sum, [, amount]) => sum + amount, 0);

export interface MerchantItemConfig {
  item: ItemId;
  sells: boolean;
  buys: boolean;
  target: number;
  startBps: number;
  /** Units the merchant imports per day (at 92% of the reference price) when below target. */
  importPerDay: number;
  /** Units outside customers buy from the merchant per day. */
  npcDemandPerDay: number;
  /** Units outside producers sell to the merchant per day. */
  npcSupplyPerDay: number;
  markupBps: number;
  /** How far under its own price it buys back. */
  spreadBps: number;
}

export interface MerchantConfig {
  merchantId: string;
  name: string;
  person: string;
  face: string;
  /** One sentence: how this merchant behaves (shown on the shop). */
  personality: string;
  /** Rule switches read by merchantPricing.ts. */
  traits: { hoarder?: boolean; rations?: boolean };
  chainName: string;
  cashCc: number;
  fixedCcPerDay: number;
  items: MerchantItemConfig[];
}

export const MERCHANTS: readonly MerchantConfig[] = [
  {
    merchantId: "ingrid", name: "Harbor LNG Terminal", person: "Ingrid Halvorsen", face: "👩🏼‍✈️", chainName: "ingrid",
    personality: "Deep tanks, slow ships, thin margins. Rarely runs dry.", traits: {},
    cashCc: 9_000_000, fixedCcPerDay: 2_400_000,
    items: [{ item: "fuel:natural-gas", sells: true, buys: true, target: 60_000, startBps: 7_000, importPerDay: 70_000, npcDemandPerDay: 55_000, npcSupplyPerDay: 0, markupBps: 800, spreadBps: 1_200 }],
  },
  {
    merchantId: "bayo", name: "Northline Pipeline", person: "Bayo Northcott", face: "👨🏿‍💼", chainName: "bayo",
    personality: "Cheapest gas in town until his pipe runs low, then he rations hard.", traits: { rations: true },
    cashCc: 4_000_000, fixedCcPerDay: 750_000,
    items: [{ item: "fuel:natural-gas", sells: true, buys: false, target: 25_000, startBps: 6_000, importPerDay: 30_000, npcDemandPerDay: 24_000, npcSupplyPerDay: 0, markupBps: 300, spreadBps: 0 }],
  },
  {
    merchantId: "kettle", name: "Kettle Fuels", person: "Old Man Kettle", face: "👴🏻", chainName: "kettle",
    personality: "Buys cheap, sells dear, always has a drum somewhere.", traits: {},
    cashCc: 3_000_000, fixedCcPerDay: 700_000,
    items: [{ item: "fuel:diesel", sells: true, buys: true, target: 120_000, startBps: 7_000, importPerDay: 90_000, npcDemandPerDay: 80_000, npcSupplyPerDay: 0, markupBps: 2_200, spreadBps: 3_000 }],
  },
  {
    merchantId: "dayo", name: "Swift Tankers", person: "Dayo Swift", face: "🧑🏾‍✈️", chainName: "dayo",
    personality: "Restocks in hours and undercuts everyone to move volume.", traits: {},
    cashCc: 2_500_000, fixedCcPerDay: 650_000,
    items: [{ item: "fuel:diesel", sells: true, buys: true, target: 80_000, startBps: 5_000, importPerDay: 140_000, npcDemandPerDay: 110_000, npcSupplyPerDay: 0, markupBps: 900, spreadBps: 1_500 }],
  },
  {
    merchantId: "chioma", name: "Okafor & Daughters", person: "Chioma Okafor", face: "👩🏾‍💼", chainName: "chioma",
    personality: "Hoards when it's cheap and charges a premium the moment anyone else runs short.", traits: { hoarder: true },
    cashCc: 3_500_000, fixedCcPerDay: 420_000,
    items: [{ item: "fuel:diesel", sells: true, buys: true, target: 150_000, startBps: 8_000, importPerDay: 60_000, npcDemandPerDay: 45_000, npcSupplyPerDay: 0, markupBps: 1_200, spreadBps: 1_000 }],
  },
  {
    merchantId: "lena", name: "Greenline Desk", person: "Prof. Lena Brandt", face: "👩🏻‍🏫", chainName: "lena",
    personality: "Buys renewable certificates from producers and sells them to companies. Keeps buying as long as she has cash.", traits: {},
    cashCc: 2_500_000, fixedCcPerDay: 220_000,
    items: [{ item: "certificate:renewable", sells: true, buys: true, target: 2_500, startBps: 6_000, importPerDay: 0, npcDemandPerDay: 1_200, npcSupplyPerDay: 700, markupBps: 1_000, spreadBps: 2_500 }],
  },
  {
    merchantId: "ruth", name: "Vesper Carbon Counter", person: "Ruth Adeyemi", face: "👩🏾‍⚖️", chainName: "ruth",
    personality: "Buys permits at the regulator's auction and sells them over the counter.", traits: {},
    cashCc: 3_000_000, fixedCcPerDay: 1_000_000,
    items: [{ item: "permit:carbon", sells: true, buys: true, target: 6_000, startBps: 6_000, importPerDay: 3_200, npcDemandPerDay: 3_000, npcSupplyPerDay: 0, markupBps: 800, spreadBps: 1_500 }],
  },
  {
    merchantId: "pavel", name: "Ivanov Steel Yard", person: "Pavel Ivanov", face: "👨🏻‍🏭", chainName: "pavel",
    personality: "Sells steel from his sister's mill. When the mill slows, so do his deliveries.", traits: {},
    cashCc: 6_000_000, fixedCcPerDay: 1_000_000,
    items: [{ item: "material:steel", sells: true, buys: true, target: 6_000, startBps: 7_000, importPerDay: 800, npcDemandPerDay: 600, npcSupplyPerDay: 0, markupBps: 1_000, spreadBps: 3_000 }],
  },
  {
    merchantId: "nkechi", name: "Sparks & Sons", person: "Nkechi Sparks", face: "👩🏾‍🔧", chainName: "nkechi",
    personality: "Turbine parts at any hour. Dear when everyone's plants are tripping.", traits: {},
    cashCc: 3_000_000, fixedCcPerDay: 500_000,
    items: [{ item: "part:turbine", sells: true, buys: true, target: 60, startBps: 7_000, importPerDay: 18, npcDemandPerDay: 16, npcSupplyPerDay: 0, markupBps: 1_500, spreadBps: 4_000 }],
  },
];

/** Reference prices (cc per unit) from the world inputs: what the item costs outside Vesper. */
export function referenceCc(item: ItemId, world: { gasUsdPerMMBtu: number; brentUsdPerBbl: number; carbonUsdPerT: number }): number {
  switch (item) {
    case "fuel:natural-gas":
      return Math.round(world.gasUsdPerMMBtu * 100);
    case "fuel:diesel":
      return Math.round((world.brentUsdPerBbl / 159) * 1.45 * 100);
    case "permit:carbon":
      return Math.round(world.carbonUsdPerT * 100);
    case "certificate:renewable":
      return 800;
    case "material:steel":
      return 25_000;
    case "part:turbine":
      return 250_000;
  }
}

/** Bot companies that trade in fast-forward ("Watch a week"). */
export const BOTS = [
  { botId: "greenfield", name: "Greenfield Solar Co.", strategy: "Floods the green desk with certificates from day 2" },
  { botId: "pemberton", name: "Pemberton Power", strategy: "Buys gas when it's cheap, sells into squeezes" },
  { botId: "ndlovu", name: "Ndlovu Grid", strategy: "Builds every half day; invests in shops that close" },
  { botId: "lakeside", name: "Lakeside Light", strategy: "Buys its diesel and permits every day, no tricks" },
] as const;
