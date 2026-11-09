/// <reference lib="dom" />
import { expect, test } from "@playwright/test";

// The full first session in the regional game (§61): world → crisis → decision → physical response →
// economic consequence → progression, then Verify and the Economy Lab.
/** Taps a first-minute button once the camera has flown to it (the button rides on the world while it moves). */
async function tapMission(page: import("@playwright/test").Page, label: string) {
  const b = page.locator(".mission-btn", { hasText: label });
  await expect(b).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(2_200);
  await expect(b).toBeInViewport();
  await b.dispatchEvent("click");
}

/** Right after the first minute the game asks for a company name; the journeys answer it. */
async function nameCompany(page: import("@playwright/test").Page, name = "Kestrel Energy") {
  const card = page.locator(".name-company");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole("textbox", { name: "Company name" }).fill(name);
  await card.getByRole("button", { name: "That's us" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator(".company-chip")).toHaveText(name);
}

test("region: three taps to learn, then the whole game", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await expect(page.locator("canvas")).toBeVisible({ timeout: 30_000 });
  // world first, one problem, one button: nothing else to read
  const mission = page.locator(".mission");
  await expect(mission).toContainText("Residential East is dark", { timeout: 20_000 });
  await expect(page.locator(".node-chip", { hasText: "LIGHTS OUT" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".dock")).toHaveCount(0);
  const hud = await page.locator(".region-app").innerText();
  expect(hud).not.toMatch(/\b(wallet|seed phrase|gas fee|tx hash|NEAR|blockchain)\b/i);

  // tap 1: the battery
  await tapMission(page, "Send power");
  await expect(page.locator(".celebrate")).toContainText("Lights back on");
  await expect(mission).toContainText("The region is short of power");
  // tap 2: the turbine
  await tapMission(page, "Start turbine");
  await expect(mission).toContainText("won’t last all night", { timeout: 10_000 });
  // tap 3: build
  await tapMission(page, "Build diesel plant");
  await expect(page.locator(".celebrate")).toContainText("you run the power company");
  await expect(mission).toHaveCount(0);

  // now the full game opens up: the five-number pulse, the dock, and one next move
  const pulse = page.locator("header.pulse");
  for (const m of ["DEMAND", "AVAILABLE", "RESERVE", "SPOT PRICE", "CASH"]) await expect(pulse).toContainText(m);
  await expect(page.locator(".dock button")).toHaveCount(5);
  // name the company: everyone in the market sees it
  await nameCompany(page, "Vesper Light & Power");
  await expect(page.locator(".next-move")).toBeVisible();

  // explain a price
  await page.locator(".node-chip", { hasText: "Central City" }).dispatchEvent("click");
  const inspector = page.locator(".inspector");
  await expect(inspector).toContainText(/Why ₡/);
  await expect(inspector).toContainText("System energy (Central City)");
  await inspector.getByRole("button", { name: "Close inspector" }).click();

  // grid: upgrade a line
  const sheet = page.locator(".sheet");
  await page.locator(".dock").getByRole("button", { name: /GRID/ }).click();
  await sheet.locator(".line-row", { hasText: "Eastside Line" }).getByRole("button", { name: /^\+/ }).click();
  await expect(sheet).toContainText(/upgrade started/i);

  // portfolio shows the Plant Assets
  await page.locator(".dock").getByRole("button", { name: /PORTFOLIO/ }).click();
  await expect(sheet).toContainText(/p0000\d Kestrel Peaker/);

  // Verify: inputs and epochs re-hashed in the browser
  await page.getByRole("button", { name: /Settings, account and Verify/ }).click();
  const modal = page.locator(".modal");
  await modal.getByRole("button", { name: "Verify" }).click();
  await expect(modal).toContainText("Real-world inputs");
  await expect(modal.locator(".epochs li").first()).toContainText("✓", { timeout: 60_000 });

  // Economy Lab, out of the primary navigation
  await modal.getByRole("button", { name: "Economy Lab" }).click();
  await modal.getByRole("button", { name: "Run both" }).click();
  await expect(modal.locator(".lab-col")).toHaveCount(2, { timeout: 30_000 });
});

test("market: read a merchant's reasoning, trade, see it in the feed, watch a week", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await expect(page.locator("canvas")).toBeVisible({ timeout: 30_000 });
  for (const label of ["Send power", "Start turbine", "Build diesel plant"]) await tapMission(page, label);
  await expect(page.locator(".dock button")).toHaveCount(5, { timeout: 15_000 });
  await nameCompany(page, "Harbor Volt");

  // the market, with every merchant's wallet and prices
  await page.locator(".dock").getByRole("button", { name: /MARKET/ }).click();
  const sheet = page.locator(".sheet");
  await expect(sheet).toContainText("Vesper Market");
  await expect(sheet.locator(".merchant-card")).toHaveCount(9);
  // the brief: a merchant's reasoning in a tooltip
  await sheet.locator(".merchant-card", { hasText: "Ingrid" }).locator(".why-trigger").first().hover();
  const tip = page.locator(".why-tip");
  await expect(tip).toContainText("Outside price");
  await expect(tip).toContainText(/Stock .* target/);
  await expect(tip).toContainText("margin");

  // trade with a merchant from its shop
  await sheet.locator(".merchant-card", { hasText: "Kettle" }).click();
  const shop = page.locator(".inspector");
  await expect(shop).toContainText("Kettle Fuels");
  await expect(shop).toContainText("Wallet");
  await shop.getByRole("button", { name: "Buy 5,000" }).click();
  await expect(shop).toContainText(/Bought 5,000 L from Old Man Kettle/);
  await expect(shop).toContainText(/You bought 5,000 L/);
  await expect(page.locator(".company-chip")).toHaveText("Harbor Volt");

  // a week of trading in a minute
  await shop.getByRole("button", { name: "Close inspector" }).click();
  await page.locator(".dock").getByRole("button", { name: /MARKET/ }).click();
  await page.locator(".dock").getByRole("button", { name: /MARKET/ }).click();
  await sheet.getByRole("button", { name: /Watch a week/ }).click();
  const watch = page.locator(".modal.watch");
  await expect(watch).toContainText("Market day", { timeout: 30_000 });
  await expect(watch.locator(".ff-shop")).toHaveCount(9);
  await watch.getByRole("button", { name: "Skip to the end" }).click();
  await expect(watch).toContainText("The bots after a week");
  await expect(watch).toContainText(/closed|reopens/);
});

test("region on a phone: dock and bottom-sheet inspector @mobile", async ({ page }) => {
  test.skip(page.viewportSize()!.width > 760, "phone layout only");
  await page.goto("/");
  await expect(page.locator("canvas")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".mission")).toBeVisible({ timeout: 20_000 });
  for (const label of ["Send power", "Start turbine", "Build diesel plant"]) await tapMission(page, label);
  await expect(page.locator(".dock button")).toHaveCount(5, { timeout: 15_000 });
  await page.locator(".name-company").getByRole("button", { name: "Later" }).click();
  await page.locator(".node-chip", { hasText: "Hospital District" }).click({ force: true });
  const insp = page.locator(".inspector");
  await expect(insp).toBeVisible();
  const box = (await insp.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x).toBeLessThan(20);
  expect(box.width).toBeGreaterThan(vp.width - 40);
  // no horizontal scroll
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
