/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";

const credits = async (page: Page) => {
  const t = await page.getByRole("listitem", { name: /^Credits:/ }).getAttribute("aria-label");
  return Number(t!.replace(/[^0-9.]/g, ""));
};

async function startGuest(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Play now|Start your city|Continue your city/ }).click();
  await expect(page.getByText("POWER REQUESTS")).toBeVisible();
  // New players get the chapter intro after entering the live city.
  const intro = page.locator(".intro-backdrop");
  if (await intro.isVisible()) await intro.getByRole("button", { name: "Skip" }).click();
}

test("new player: guest tutorial restores power and earns credits", async ({ page }) => {
  await startGuest(page);
  // first outage arrives within seconds
  const card = page.locator(".req-card").filter({ hasText: "Cold Room" });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("1.5 kW × 2 h");
  await expect(card).toContainText("8.00 ₡/kWh");
  const before = await credits(page);
  await card.getByRole("button", { name: "Accept" }).click();
  // connect via the generator button on the pending card
  await page.locator(".req-card.pending").getByRole("button", { name: /Shed Diesel/ }).click();
  await expect(page.locator(".toast").filter({ hasText: "Power restored at Cold Room" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".gen-card").first()).toContainText("Serving Cold Room");
  await expect(page.getByRole("img", { name: /City map: \d+ of \d+ businesses powered/ })).toBeVisible();
  // money only arrives as energy is delivered (1.20 credits per second)
  await expect.poll(() => credits(page), { timeout: 15_000 }).toBeGreaterThan(before + 3);
});

test("persistence + reconnection: reload restores the same city without duplicating actions", async ({ page }) => {
  await startGuest(page);
  const card = page.locator(".req-card").filter({ hasText: "Cold Room" });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button", { name: "Accept" }).click();
  await page.locator(".req-card.pending").getByRole("button", { name: /Shed Diesel/ }).click();
  await expect(page.locator(".flow-chip")).toHaveCount(1, { timeout: 10_000 });
  const c1 = await credits(page);
  await page.reload();
  await page.getByRole("button", { name: "Continue your city" }).click();
  await expect(page.getByText("POWER REQUESTS")).toBeVisible();
  // the same contract continues; credits never go backwards and there is still exactly one Cold Room contract
  expect(await credits(page)).toBeGreaterThanOrEqual(c1);
  await expect(page.locator(".flow-chip").filter({ hasText: "Cold Room" })).toHaveCount(1);
  await expect(page.locator(".conn.live")).toBeVisible();
});

test("market: buy reads as delivery; chain records stay in the optional verify panel", async ({ page }) => {
  await startGuest(page);
  await page.getByRole("button", { name: /Market/ }).click();
  const lantern = page.locator(".merchant-card").filter({ hasText: "Lantern" });
  const priceBefore = await lantern.locator("strong").innerText();
  await expect(lantern).toContainText("Stock 30.0 L");
  await lantern.getByRole("button", { name: "Request quote" }).click();
  await expect(lantern).toContainText("Your quote:");
  await lantern.getByRole("button", { name: "Buy fuel" }).click();
  await expect(lantern).toContainText("Purchase complete: 10.0 L");
  await expect(lantern).toContainText("Stock 20.0 L");
  expect(await lantern.locator("strong").innerText()).not.toBe(priceBefore);
  await expect(page.locator(".trade-row").first()).toContainText("delivered");
  await expect(page.getByRole("dialog")).not.toContainText(/NEAR|blockchain|wallet|gas/i);
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: /Verify/ }).click();
  await expect(page.getByRole("dialog")).toContainText("NEAR");
});

test("infrastructure: installing solar adds a real generator to the plant", async ({ page }) => {
  await startGuest(page);
  const before = await credits(page);
  await page.getByRole("button", { name: /Equipment/ }).click();
  await page.locator(".upgrade").filter({ hasText: "Rooftop Solar" }).getByRole("button", { name: /Install/ }).click();
  await expect(page.locator(".upgrade").filter({ hasText: "Rooftop Solar" }).getByRole("button")).toHaveText("Installed");
  await page.keyboard.press("Escape");
  await expect(page.locator(".gen-card").filter({ hasText: "Rooftop Solar" })).toBeVisible();
  expect(await credits(page)).toBeLessThan(before);
});

test("economy lab: same seed reproduces the same trace hash", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Economy Lab" }).click();
  await page.getByRole("button", { name: "Run simulation" }).click();
  const hashA = page.locator(".lab-summary article.a code");
  await expect(hashA).toContainText("trace", { timeout: 30_000 });
  const first = await hashA.innerText();
  await page.getByRole("button", { name: "Run simulation" }).click();
  await expect(hashA).toHaveText(first);
  await expect(page.locator(".lab-chart")).toHaveCount(8);
});

test("mobile: core controls are reachable @mobile", async ({ page }) => {
  await startGuest(page);
  const card = page.locator(".req-card").filter({ hasText: "Cold Room" });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button", { name: "Accept" }).click();
  await page.locator(".req-card.pending").getByRole("button", { name: /Shed Diesel/ }).click();
  await expect(page.locator(".toast").filter({ hasText: "Power restored" })).toBeVisible({ timeout: 10_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("exchange: one city sells to a trader on the shared board while another city buys from it", async ({ page, browser }) => {
  // city A: buy diesel locally, move it to the exchange, sell it fast to a trader
  await startGuest(page);
  await page.getByRole("button", { name: /Market/ }).click();
  const lantern = page.locator(".merchant-card").filter({ hasText: "Lantern" });
  await lantern.getByRole("button", { name: "Request quote" }).click();
  await lantern.getByRole("button", { name: "Buy fuel" }).click();
  await expect(lantern).toContainText("Purchase complete: 10.0 L");
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: /Exchange/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Vesper Fuel Exchange");
  // normal play never mentions the chain
  await expect(dialog).not.toContainText(/[Bb]lockchain|[Ww]allet|gas fee|\bNEAR\b/);
  await dialog.getByRole("button", { name: "Send to warehouse" }).click();
  await expect(dialog.locator(".x-big")).toHaveText("5.0 L", { timeout: 10_000 });
  await dialog.getByRole("button", { name: /^Sell fast/ }).click();
  await dialog.getByRole("button", { name: "Post offer" }).click();
  // a trader discovers the offer on its next decision (one exchange tick = 5 s)
  await expect(dialog.locator(".x-orders li.sold").first()).toContainText(/Sold 5\.0 L/, { timeout: 20_000 });

  // city B, a different player: buys from the same shared board
  const ctxB = await browser.newContext();
  const b = await ctxB.newPage();
  await startGuest(b);
  await b.getByRole("button", { name: /Exchange/ }).click();
  const dB = b.getByRole("dialog");
  await expect(dB.getByRole("button", { name: "Buy" })).toBeEnabled({ timeout: 10_000 });
  await dB.getByRole("button", { name: "Buy" }).click();
  await expect(dB.locator(".x-big")).toHaveText("10.0 L", { timeout: 10_000 });
  await dB.getByRole("button", { name: "Deliver to tank" }).click();
  await expect(dB.locator(".x-big")).toHaveText("5.0 L", { timeout: 10_000 });
  await ctxB.close();
});

