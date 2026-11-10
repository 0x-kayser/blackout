import type { WorldSnapshot } from "@blackout/shared";
import { CHALLENGE_SNAPSHOT } from "./config.ts";

export type RegionChallengeCondition = "disruption" | "recovery" | "demand_surge" | "carbon_tightening" | "solar_boom";

interface RegionChallenge {
  name: string;
  description: string;
  input: Pick<WorldSnapshot, "gasUsdPerMMBtu" | "brentUsdPerBbl" | "carbonUsdPerT" | "tempC" | "cloudPct" | "windKph">;
}

/** Fixed weekly opening conditions for the regional power challenge. */
export const REGION_CHALLENGES: Record<RegionChallengeCondition, RegionChallenge> = {
  disruption: {
    name: "Fuel supply shock",
    description: "Gas and diesel-linked crude open sharply higher, with weak wind and heavy cloud. Protect cash and keep a reserve before the next outage.",
    input: { gasUsdPerMMBtu: 6.2, brentUsdPerBbl: 108, carbonUsdPerT: 38, tempC: 35, cloudPct: 55, windKph: 8 },
  },
  recovery: {
    name: "Recovery window",
    description: "Fuel opens below its usual cost and demand is moderate. Use the margin to repair, refuel, or improve reliability before the next seeded incident.",
    input: { gasUsdPerMMBtu: 3.0, brentUsdPerBbl: 65, carbonUsdPerT: 32, tempC: 27, cloudPct: 45, windKph: 20 },
  },
  demand_surge: {
    name: "Heatwave demand surge",
    description: "A 41°C opening drives cooling demand while fuel is elevated. Cover the evening peak without exhausting your cash or fuel reserve.",
    input: { gasUsdPerMMBtu: 4.2, brentUsdPerBbl: 78, carbonUsdPerT: 32, tempC: 41, cloudPct: 10, windKph: 10 },
  },
  carbon_tightening: {
    name: "Carbon cost squeeze",
    description: "Carbon opens at $128/t and fuel is elevated. Compare the cost of gas and diesel against low-carbon supply, then keep reliability above the permit threshold.",
    input: { gasUsdPerMMBtu: 4.5, brentUsdPerBbl: 82, carbonUsdPerT: 128, tempC: 31, cloudPct: 20, windKph: 14 },
  },
  solar_boom: {
    name: "Clear-sky fuel crunch",
    description: "Expensive fuel and carbon meet a clear, windy opening. Solar and storage can protect the margin, but evening reliability still depends on dispatch and reserves.",
    input: { gasUsdPerMMBtu: 5.2, brentUsdPerBbl: 95, carbonUsdPerT: 80, tempC: 29, cloudPct: 5, windKph: 25 },
  },
};

export function regionChallengeSnapshot(condition: RegionChallengeCondition): WorldSnapshot {
  const challenge = REGION_CHALLENGES[condition];
  return {
    ...CHALLENGE_SNAPSHOT,
    ...challenge.input,
    sources: [{
      field: "all",
      provider: `BLACKOUT weekly challenge fixture: ${challenge.name}`,
      url: "",
      observedAt: CHALLENGE_SNAPSHOT.capturedAt,
    }],
  };
}
