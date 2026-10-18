import { test, expect, type Page } from "@playwright/test";
import { openApp, openGeneral, trackErrors } from "./helpers";

/** Hover a message row and click one of its toolbar actions. */
async function messageAction(page: Page, contains: string, title: string): Promise<void> {
  const row = page.locator('[id^="msg-"]', { hasText: contains }).last();
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.getByTitle(title).click({ force: true });
}

test.describe("Nebula web app — threads", () => {
  test("create a thread from a message, post in it, close it and deep-link it", async ({ page }) => {
    const errors = trackErrors(page, "threads: ");
    const failed: string[] = [];
    page.on("response", (res) => {
      if (res.status() >= 400) failed.push(`${res.status()} ${res.request().method()} ${res.url()}`);
    });

    await openApp(page);
    await openGeneral(page);

    const seed = `thread-seed-${Date.now()}`;
    await page.locator("textarea").first().fill(seed);
    await page.locator("textarea").first().press("Enter");
    await expect(page.locator('[id^="msg-"]', { hasText: seed }).last()).toBeVisible();

    // Create a thread rooted at that message.
    await messageAction(page, seed, "Create thread");

    const panel = page.locator('aside[aria-label="Thread"]');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/channels\/\d+\/\d+\/threads\/\d+$/);
    const threadUrl = page.url();

    // Post inside the thread (it has its own composer).
    const reply = `thread-reply-${Date.now()}`;
    const threadComposer = panel.locator('textarea[aria-label="Message thread"]');
    await threadComposer.fill(reply);
    await threadComposer.press("Enter");
    await expect(panel.locator('[id^="msg-"]', { hasText: reply }).last()).toBeVisible({ timeout: 15_000 });
    // The whole journey must be free of failed API calls.
    expect(failed).toEqual([]);

    // A deep link (reload) restores the open thread.
    await page.reload();
    const panelAfter = page.locator('aside[aria-label="Thread"]');
    await expect(panelAfter).toBeVisible({ timeout: 20_000 });
    await expect(panelAfter.locator('[id^="msg-"]', { hasText: reply }).last()).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(threadUrl);

    // Closing returns to the parent channel.
    await panelAfter.getByRole("button", { name: "Close thread" }).click();
    await expect(page).not.toHaveURL(/\/threads\//, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/channels\/\d+\/\d+$/);

    expect(errors).toEqual([]);
  });
});
