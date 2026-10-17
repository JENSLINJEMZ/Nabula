import { test, expect } from "@playwright/test";
import { openApp, openGeneral, trackErrors } from "./helpers";

/**
 * Client-side routing (react-router-dom). The URL is the single source of
 * truth for the active location, so deep links, refreshes and browser
 * history navigation all resolve to the correct view.
 */
test.describe("Nebula web app — client routing", () => {
  test("navigating the UI updates the URL, and a deep link restores the view", async ({ page }) => {
    const errors = trackErrors(page, "routing: ");
    await openApp(page);

    // Home (friends) is the canonical landing route.
    await expect(page).toHaveURL(/\/channels\/@me$/);

    await openGeneral(page);
    await expect(page).toHaveURL(/\/channels\/\d+\/\d+$/);
    const channelUrl = page.url();

    // A full reload (deep link) must land back in the same channel, not on home.
    await page.reload();
    await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(channelUrl);

    expect(errors).toEqual([]);
  });

  test("browser back/forward traverse the view history", async ({ page }) => {
    await openApp(page);
    await openGeneral(page);

    // Go home via the rail; that is a history entry.
    await page.locator('button[title="Direct messages"]').click();
    await expect(page).toHaveURL(/\/channels\/@me$/, { timeout: 10_000 });

    // Back returns to the channel view (a guild + channel URL).
    await page.goBack();
    await expect(page).toHaveURL(/\/channels\/\d+\/\d+$/, { timeout: 10_000 });
    await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });

    // Forward returns to home.
    await page.goForward();
    await expect(page).toHaveURL(/\/channels\/@me$/, { timeout: 10_000 });
  });

  test("a direct-message deep link opens the DM", async ({ page }) => {
    await openApp(page);
    await openGeneral(page);
    await page.locator('button[title="Direct messages"]').click();
    await page.locator("button", { hasText: "Bob" }).first().click();
    await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/channels\/@me\/\d+$/);
    const dmUrl = page.url();

    // Reload the DM deep link directly.
    await page.reload();
    await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(dmUrl);
  });

  test("unknown routes render the 404 view", async ({ page }) => {
    await page.goto("/definitely/not/a/nebula/route");
    await expect(page.getByText("404")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("drifted out of orbit")).toBeVisible();
    // The recovery link returns to the app.
    await page.getByRole("link", { name: /back to nebula/i }).click();
    await expect(page).toHaveURL(/\/channels\/@me$/, { timeout: 10_000 });
  });
});
