# BLACKOUT — Storyline & Hackathon Pitch: *The Twin Squeeze of 2026*

**Track:** NEAR Hackathon (`nearhackathon.com`) — *Games With Real Economies*  
**Core Thesis:** *Every Light Changes the Economy.* A real-world geopolitical and climate simulation where macro shocks—**Persian Gulf / Strait of Hormuz shipping disruptions** and **COP31 sovereign carbon mandates**—propagate through autonomous NPC balance sheets, NEP-245 commodity markets, and two playable scales of the same power grid.

> **Fiction note.** The Hormuz disruption, the "COP31 Sovereign Grid Accord" and every named person and company here are a fictional scenario inspired by real 2026 events. Figures such as "7.5 million barrels per day" describe the story's world, not a verified statistic. The game uses a bundled U.S. EIA Brent price series for fuel prices.

---

## 1. The World Backstory: Why Vesper Went Dark

It is **November 2026**. The Vesper Region—seven interconnected load centres stretching from the container cranes of Harbor Port and the furnaces of Ivanova Steel to St. Aurelia General Hospital and Halcyon Data Center—is caught in a historic **Twin Squeeze**:

1. **The Strait of Hormuz & Gulf Supply Shock (The Fuel Squeeze):**  
   Escalating conflict and maritime interdictions around the Strait of Hormuz have shut in over 7.5 million barrels per day of Gulf crude and forced LNG and diesel tankers to reroute around the Cape of Good Hope. Brent crude surges past $100/bbl, war-risk insurance spikes, and fuel deliveries into Vesper Harbour arrive late, thin, and fiercely rationed.
2. **The COP31 Sovereign Grid Accord (The Carbon Squeeze):**  
   At the exact same moment, nations at **COP31** ratify the binding *2026 Sovereign Grid Accord*. Emergency fossil-fuel waivers are terminated: regional regulators tighten daily carbon permit caps by 30%, impose a mandatory **+25% compliance surcharge** on unpermitted thermal emissions, and require **98% grid reliability** to unlock sovereign transition financing.

### The Collapse of VoltLine Energy
For twenty years, Vesper relied on a single debt-fuelled monopoly: **VoltLine Energy**, run by **Victor Lane**. Victor bet his company on cheap imported gas and **₡15,000,000 in variable-rate bank debt** from Vesper Savings and Meridian Capital.

When the **Hormuz shipping blockade** doubled LNG replacement costs in the exact same week that the **COP31 Carbon Floor** took effect, VoltLine's balance sheet snapped. Unable to pay both fuel importers and bank interest, Victor deferred maintenance on the 132 kV Eastside transmission line and left his aging Southgate turbine to trip. Spot prices hit the **₡5,000/MWh** market cap, and **Residential East plunged into a blackout**.

---

## 2. Joining the Two Halves: One Continuous Story Across Two Scales

Instead of treating the **2D Classic City (`/city`)** and the **3D Regional Grid (`/`)** as separate games, *BLACKOUT* unites them into **two acts of the same crisis**:

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  ACT I: STREET LEVEL (/city)                ACT II: REGIONAL COMMAND (/)         │
│  "Mama Ade's Shed & The Microgrid"   ───►   "Emergency Shift 01 & The 7 Nodes"   │
│  • 1× 5 kW diesel generator                 • 120 MW Kestrel OCGT + 160 MWh batt │
│  • 44 local shops (Cold Room, Bakery,       • 7 districts, 6 high-voltage lines  │
│    Dr. Imani's Pharmacy, Night Clinic)      • 9 autonomous NEP-245 merchants     │
│  • Real 2026 EIA Brent crude series         • Merit-order nodal market clearing  │
│  • 9 character-driven story chapters        • 4 Operating Permits + COP31 drills │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Act I — Street Level (`/city`): *Mama Ade's Shed*
When the regional grid first fractures under the Gulf oil shock, you start in the back alley of Market Quarter. **Mama Ade** lends you a shed, a 5 kW diesel generator, and 20 litres of fuel: *"Keep this street lit. The shops will pay for power they can afford."*
* You answer 30-second outage calls from **Tunde** (Cold Room), **Rosa** (Sunrise Bakery), **Dr. Imani** (Corner Pharmacy), and **Kai** (Byte Cyber Café).
* Every morning, diesel merchants reprice from their own stock and the **real 2026 U.S. EIA Brent crude dataset** (annotated with the April, June, and October 2026 Strait of Hormuz STEO reports).
* Across **9 story chapters** (*First Light* $\rightarrow$ *Storm Season* $\rightarrow$ *Grid Independent*), you expand from a street generator into a 7-district neighborhood utility, proving that solar + battery storage can survive both Victor Lane's price wars and COP31 permit squeezes.

### Act II — Regional Command (`/`): *Emergency Shift 01*
Your success on the streets catches the attention of the **Vesper Energy Regulator**. With VoltLine defaulting on its reserve obligations and Residential East dark at dusk (18:30), the Regulator seizes the idle **120 MW Kestrel Peaker**, pairs it with the **Eastside Battery**, grants you **₡300,000** in starter capital, and hands you an emergency **Independent Generator Permit**.
* **First Night Rescue (3 Steps):**
  1. **Restore the homes:** Discharge the Eastside Battery to light up Tomás Rivera's neighborhood in Residential East.
  2. **Dispatch Kestrel:** Spin up your 120 MW open-cycle gas turbine to close the regional shortfall.
  3. **Build your first reserve:** Construct an emergency peaker in Residential East before the battery drains overnight.
* **The 4-Permit Campaign Route:**
  1. **Permit 1 — Independent Generator (*"First Light"*):** Survive Emergency Shift 01 as the Hormuz tanker delay hits Vesper Harbour.
  2. **Permit 2 — Regional Producer (*"Win a place in the market"* — 3,000 MWh):** Break the import trap. Deliver 3,000 MWh to keep Marta Ivanova's steel mill and Rosa Delgado's container port running, unlocking 250 MW Combined-Cycle (CCGT) and 200 MW solar farms.
  3. **Permit 3 — System Partner (*"Hold the line"* — 15,000 MWh & ≥97% Reliability):** Navigate the **COP31 Carbon Accord**. Balance Ruth Adeyemi's carbon permits and Prof. Lena Brandt's renewable certificates while protecting St. Aurelia Hospital and Halcyon Data Center at 97%+ reliability.
  4. **Permit 4 — Grid Anchor (*"Become the reserve"* — 45,000 MWh & ≥98% Reliability):** Achieve **Energy Sovereignty**. Acquire VoltLine's distressed power plants as Victor Lane defaults, upgrade congested transmission corridors, and hold 98% regional reliability against any global shock.

---

## 3. How Real-World Geopolitics & COP31 Drive the On-Chain Economy

In *BLACKOUT*, news stories never hardcode a price. Instead, every event in [`news.ts`](../packages/sim/src/town/news.ts) multiplies a physical flow (`imports`, `demand`, `supply`, or `outside` benchmark price), and the single readable formula in [`merchantPricing.ts`](../packages/sim/src/town/merchantPricing.ts) (`stock factor × demand factor × margin`) does the rest:

| Real-World Macro Driver | Breaking News in Vesper | Causal Chain in the Simulation & NEAR Economy |
| :--- | :--- | :--- |
| **Strait of Hormuz Tanker Rerouting** | *LNG tanker delayed by Strait rerouting & harbour fog* | **Ingrid Halvorsen's** (`ingrid`) LNG imports drop to `×0.15` $\rightarrow$ her tank drains $\rightarrow$ gas price climbs $\rightarrow$ gas turbines cost more per MWh $\rightarrow$ evening nodal power prices spike across Vesper. |
| **Gulf Crude & Diesel Shock** | *Gulf shipping shock: tanker convoy rerouted* | Diesel imports fall to `×0.25`. **Chioma Okafor** (`chioma`) hoards inventory and adds a +25% squeeze markup; **Dayo** (`dayo`) and **Old Man Kettle** (`kettle`) ration buyers. |
| **COP31 Carbon Ratification** | *COP31 carbon floor: regulator tightens permit cap 25%* | Reference price for `permit:carbon` rises `×1.25` at **Ruth Adeyemi's** (`ruth`) counter. Thermal plants without permits pay a +25% penalty, funding the Regulator's **Reliability Tenders**. |
| **COP31 Net-Zero Corporate Mandate** | *COP31 green mandate: corporate buyers rush for certificates* | Outside corporate demand for `certificate:renewable` jumps `×2.5` at **Prof. Lena Brandt's** (`lena`) desk. Players running solar farms sell certificates into the rally. |
| **Certificate Glut & Merchant Insolvency** | *Sunny week: rooftop & utility solar flood the green desk* | Outside supply jumps `×5`. If players dump certificates faster than firms buy them, Lena's price crashes and **her cash runs out** $\rightarrow$ **her shop closes** until a player invests capital to reopen her for a share of daily dividends. |
| **Energy Stagflation & Steel Feedback Loop** | *Blackouts or >₡170/MWh power at Industrial South* | **Marta Ivanova** curtails furnaces at *Ivanova Steel Works* $\rightarrow$ her brother **Pavel Ivanov's** (`pavel`) steel yard receives less local steel $\rightarrow$ `material:steel` rises up to +60% $\rightarrow$ every new power plant and transmission upgrade costs more to build. |

---

## 4. Cast of Autonomous Economic Agents

Every counterparty you trade with or supply has its own cash, inventory, policy, and (in the Testnet economy) its own account under `vesper-econ.blackout-kay.testnet`:

### Vesper Market Merchants (NEP-245 Commodities)
* **Ingrid Halvorsen** (*Harbor LNG Terminal* — `fuel:natural-gas`): Deep tanks, slow ships, thin margins. Vulnerable to Hormuz and harbour shipping delays.
* **Bayo Northcott** (*Northline Pipeline* — `fuel:natural-gas`): Cheapest gas in Vesper until his pipeline pressure drops below 20%—then he rations hard.
* **Old Man Kettle** (*Kettle Fuels* — `fuel:diesel`): Buys cheap, sells dear, always keeps a drum in reserve.
* **Dayo Swift** (*Swift Tankers* — `fuel:diesel`): High-turnover spot trader who restocks fast and undercuts on volume.
* **Chioma Okafor** (*Okafor & Daughters* — `fuel:diesel`): Opportunistic hoarder—accumulates on dips and charges a steep premium the moment a Gulf supply shock hits.
* **Prof. Lena Brandt** (*Greenline Desk* — `certificate:renewable`): Buys MWh green certificates from solar producers and sells them to corporations meeting COP31 mandates.
* **Ruth Adeyemi** (*Vesper Carbon Counter* — `permit:carbon`): Arbitrages the regulator's COP31 carbon auctions over the counter.
* **Pavel Ivanov** (*Ivanov Steel Yard* — `material:steel`): Sells structural steel from his sister Marta's mill; required for 40% of every power plant's construction cost.
* **Nkechi Sparks** (*Sparks & Sons* — `part:turbine`): Emergency turbine repair kits (`part:turbine`) to bring tripped generators back online immediately.

### Regional Load Centres & Counterparties
* **Victor Lane** (*VoltLine Energy*): Legacy rival utility carrying ₡15M in debt. Adapts offer markups, mothballs plants when cash falls below interest coverage, and lists plants (**NEP-171 NFTs**) for distressed sale.
* **Marta Ivanova** (*Ivanova Steel Works* — 180 MW, 2,400 workers): Anchor industrial load whose output directly governs regional construction costs.
* **Dr. Nadia Petrov** (*St. Aurelia General Hospital* — 45 MW, 2,100 staff): Critical load with the highest value of lost load (₡20,000/MWh); shed last in any emergency.
* **Priya Raman** (*Halcyon Data Center* — 160 MW): 24/7 flat load in Tech Corridor where every dark interval costs ₡18,500 in SLA penalties.
* **Rosa Delgado** (*Vesper Container Port* — 70 MW) & **Sven Aalto** (*Harbor Cold Chain* — 40 MW): Keep fuel and food imports moving through the harbour.
* **Amara Obi** (*Central City Commerce* — 220 MW, 14,000 workers) & **Tomás Rivera** (*Residential East Households* — 230 MW): When factories lay off workers during blackouts, household wage income falls, reducing commercial revenue across Central City.
