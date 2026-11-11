/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";

async function enterAsGuest(page: Page, takeTour = false) {
  await page.goto("/");
  const title = page.locator(".title-screen");
  await expect(title).toBeVisible({ timeout: 30_000 });
  await expect(title).toContainText("The lights are out in Eastside");
  if (takeTour) {
    await title.getByRole("button", { name: /How to play/ }).click();
    const tour = page.locator(".title-tour");
    await expect(tour.getByRole("heading")).toHaveText("Bring Eastside back");
    await page.screenshot({ path: "/tmp/blackout-product-tour.png" });
    await tour.getByRole("button", { name: /Next/ }).click();
    await expect(tour.getByRole("heading")).toHaveText("Keep power ahead of demand");
    await expect(tour).toContainText("Manage finances");
    await tour.getByRole("button", { name: /Next/ }).click();
    await expect(tour.getByRole("heading")).toHaveText("Trade with living merchants");
    await tour.getByRole("button", { name: /Next/ }).click();
    await expect(tour.getByRole("heading")).toHaveText("Earn permits. Take on the crisis.");
    await tour.getByRole("button", { name: /Got it/ }).click();
    await expect(tour).toHaveCount(0);
  }
  await expect(title.getByRole("button", { name: /Play as guest/ })).toBeVisible();
  await title.getByRole("button", { name: /Play as guest/ }).click();
  await expect(page.locator("canvas")).toBeVisible({ timeout: 30_000 });
}

async function tapMission(page: Page, label: RegExp) {
  const button = page.locator(".mission .mission-action");
  await expect(button).toBeVisible({ timeout: 20_000 });
  await expect(button).toContainText(label);
  await button.click();
}

async function finishFirstOperation(page: Page) {
  const mission = page.locator(".mission");
  await expect(mission).toContainText("Restore the homes", { timeout: 20_000 });
  await tapMission(page, /Restore Eastside/);
  await expect(mission).toContainText("Dispatch Kestrel");
  await tapMission(page, /Start Kestrel/);
  await expect(mission).toContainText("Build your first reserve");
  await tapMission(page, /Build diesel peaker/);
  await expect(mission).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".operation-hud")).toBeVisible();
}

test("guest game: first rescue opens a visible campaign and weekly crisis", async ({ page }) => {
  test.setTimeout(180_000);
  await enterAsGuest(page, true);
  await expect(page.locator(".dock")).toHaveCount(0);
  await finishFirstOperation(page);

  const pulse = page.locator("header.pulse");
  await expect(pulse).toContainText("THE CITY");
  await expect(pulse).toContainText("CASH");
  await expect(pulse.locator(".question")).not.toContainText("Demand");
  await expect(page.locator(".dock button")).toHaveCount(5);
  const gameCopy = await page.locator(".region-app").innerText();
  expect(gameCopy).not.toMatch(/wallet|seed phrase|gas fee|blockchain/i);
  await page.screenshot({ path: "/tmp/blackout-region-after-first-operation.png" });

  await page.locator(".operation-hud").getByRole("button", { name: /View route/ }).click();
  const operations = page.getByRole("dialog", { name: "Campaign" });
  await expect(operations).toBeVisible();
  await expect(operations).toContainText("Win a place in the market");
  await expect(operations).toContainText("Regional Producer");
  await expect(operations.locator(".career-stage")).toHaveCount(4);
  await expect(operations.locator(".career-stage.earned").first()).toContainText("Earned");
  await expect(operations.locator(".career-stage.current")).toContainText("Next permit");
  await expect(operations).toContainText("3,000 MWh");
  await page.screenshot({ path: "/tmp/blackout-campaign.png" });

  await operations.getByRole("button", { name: "Weekly crisis" }).click();
  await expect(page.getByRole("heading", { name: "Weekly crisis drill" })).toBeVisible();
  const startRun = page.getByRole("button", { name: /Start this week’s run/ });
  await expect(startRun).toBeVisible();
  await startRun.click();
  await expect(operations).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".operation-hud")).toContainText("THIS WEEK’S CRISIS");
  await expect(page.locator(".pulse")).toContainText("weekly crisis");
});

test("registered player can sign in, reach the game, and sign out", async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto("/");
  const title = page.locator(".title-screen");
  await expect(title).toBeVisible({ timeout: 30_000 });
  await title.getByRole("button", { name: /Continue with email/ }).click();
  await title.getByLabel("Email address").fill(`judge-${Date.now()}@blackout.test`);
  await title.getByRole("button", { name: /Send my sign-in code/ }).click();
  const code = (await title.locator(".dev-code").innerText()).trim();
  await title.getByLabel("Six-digit code").fill(code);
  await title.getByRole("button", { name: /^Sign in$/ }).click();
  await expect(title).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator(".mission")).toBeVisible({ timeout: 20_000 });

  await page.locator(".account-menu summary").click();
  const account = page.locator(".account-popover");
  await expect(account).toContainText("Progress saved to your account");
  await account.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator(".title-screen")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(page.locator(".title-screen").getByRole("button", { name: /Continue with Google|Continue with email/ }).first()).toBeVisible();
});

test("the game dock opens clear Power, Build, Map and Company panels", async ({ page }) => {
  await enterAsGuest(page);
  await finishFirstOperation(page);
  const panels = [
    ["Manage your power plants", "Power plants"],
    ["Build and upgrade plants", "Build your grid"],
    ["Explore the city map and power lines", "Grid map"],
    ["Open company finances and assets", "Your company"],
  ] as const;
  for (const [control, panel] of panels) {
    await page.locator(".dock").getByRole("button", { name: control }).click();
    const dialog = page.getByRole("dialog", { name: panel });
    await expect(dialog).toBeVisible();
    await expect(page.locator("canvas")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Open settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings and account" });
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Economy Lab" }).click();
  await expect(settings.getByRole("button", { name: "Run both" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
});

test("merchant trading shows a quote before the player confirms a purchase", async ({ page }) => {
  test.setTimeout(150_000);
  await enterAsGuest(page);
  await finishFirstOperation(page);
  await page.locator(".dock").getByRole("button", { name: "Open the Vesper Market" }).click();
  const market = page.getByRole("dialog", { name: "market" });
  const ruth = market.locator(".merchant-card").filter({ hasText: "Ruth" });
  await expect(ruth).toBeVisible();
  await ruth.click();

  const merchant = page.getByRole("complementary", { name: "Merchant" });
  const permits = merchant.locator(".item-row").filter({ hasText: "Carbon permit" });
  await expect(permits).toBeVisible();
  await permits.getByRole("button", { name: "Review buy" }).click();
  await expect(permits).toContainText("Review purchase");
  await expect(permits).toContainText("Cash after");
  await permits.getByRole("button", { name: /Confirm buy/ }).click();
  await expect(merchant).toContainText(/Bought 20 t CO₂ from/, { timeout: 15_000 });
  await expect(merchant).toContainText("Latest trades here");
  await merchant.getByRole("button", { name: "Close inspector" }).click();
  await expect(merchant).toHaveCount(0);
  await market.getByRole("button", { name: /Watch a week of trading/ }).click();
  const replay = page.getByRole("dialog", { name: "Watch a week" });
  await expect(replay.locator(".ff-shop")).toHaveCount(9, { timeout: 30_000 });
  await replay.getByRole("button", { name: "Skip to the end" }).click();
  await expect(replay).toContainText("The bots after a week");
});

test("market and account controls remain reachable on a phone @mobile", async ({ page }) => {
  await enterAsGuest(page);
  await finishFirstOperation(page);
  await page.locator(".dock").getByRole("button", { name: "Open the Vesper Market" }).click();
  const market = page.getByRole("dialog", { name: "market" });
  await expect(market).toContainText("Vesper Market");
  await expect(market.locator(".merchant-card")).toHaveCount(9);
  await expect(page.locator(".toasts")).toBeHidden();
  await expect(page.locator(".feed-btn")).toBeHidden();
  await page.screenshot({ path: "/tmp/blackout-market-mobile.png" });
  await page.keyboard.press("Escape");
  await page.locator(".account-menu summary").click();
  await expect(page.locator(".account-popover")).toContainText("Sign out");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
