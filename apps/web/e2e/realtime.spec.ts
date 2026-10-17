import { test, expect, request as apiRequest, type Page } from "@playwright/test";
import { openApp, openGeneral, trackErrors, AUTH, BASE } from "./helpers";

/** Hover a message row and click one of its hover-revealed action buttons. */
async function messageAction(page: Page, contains: string, title: string): Promise<void> {
  const row = page.locator('[id^="msg-"]', { hasText: contains }).last();
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.getByTitle(title).click({ force: true });
}

test.describe("Nebula realtime & social journeys", () => {
  test("two clients exchange messages, typing, edits and deletes in realtime", async ({ page, browser }) => {
    const bobCtx = await browser.newContext({ storageState: AUTH.bob, baseURL: BASE });
    const bob = await bobCtx.newPage();
    const errors = [...trackErrors(page, "[alice] "), ...trackErrors(bob, "[bob] ")];

    await openApp(page); // alice (default storage state)
    await openApp(bob);
    await openGeneral(page);
    await openGeneral(bob);

    // Alice → Bob
    const fromAlice = `rt-alice-${Date.now()}`;
    await page.locator("textarea").first().fill(fromAlice);
    await page.locator("textarea").first().press("Enter");
    await expect(bob.getByText(fromAlice, { exact: false })).toBeVisible({ timeout: 15_000 });

    // Bob → Alice
    const fromBob = `rt-bob-${Date.now()}`;
    await bob.locator("textarea").first().fill(fromBob);
    await bob.locator("textarea").first().press("Enter");
    await expect(page.getByText(fromBob, { exact: false })).toBeVisible({ timeout: 15_000 });

    // Typing indicator propagates.
    await page.locator("textarea").first().type("typing a moment", { delay: 40 });
    await expect(bob.getByText("is typing", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await page.locator("textarea").first().fill("");

    // Edit propagates.
    const edited = `${fromAlice} (edited)`;
    await messageAction(page, fromAlice, "Edit message");
    await page.locator("input.input").last().fill(edited);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(bob.getByText(edited, { exact: false })).toBeVisible({ timeout: 15_000 });

    // Delete propagates.
    await messageAction(page, "(edited)", "Delete message");
    await expect(bob.getByText(edited, { exact: false })).toHaveCount(0, { timeout: 15_000 });

    expect(errors).toEqual([]);

    await bobCtx.close();
  });

  test("direct message from the friends list is delivered", async ({ page }) => {
    await openApp(page);
    await openGeneral(page);
    await page.locator('button[title="Direct messages"]').click();

    await page.locator("button", { hasText: "Bob" }).first().click();
    await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

    const dm = `dm-${Date.now()}`;
    await page.locator("textarea").first().fill(dm);
    await page.locator("textarea").first().press("Enter");
    await expect(page.locator('[id^="msg-"]', { hasText: dm }).first()).toBeVisible();
  });

  test("add a friend by username search (idempotent)", async ({ page }) => {
    // Register a unique throwaway user so the search result is never pre-existing.
    // Clear inherited cookies: otherwise the seeded session cookie rides along and
    // the server rejects the CSRF-less POST with 403 INVALID_CSRF.
    const api = await apiRequest.newContext({
      baseURL: process.env.NEBULA_API_URL ?? "http://localhost:4000",
    });
    await api.clearCookies();
    const throwaway = `e2e${Date.now().toString(36)}`;
    const reg = await api.post("/api/auth/register", {
      data: { username: throwaway, password: "Zq7$vLm2Np8x!Rk4w" },
    });
    if (!reg.ok()) {
      throw new Error(`throwaway register failed ${reg.status()}: ${await reg.text()}`);
    }
    await api.dispose();

    await openApp(page);
    await openGeneral(page);
    await page.locator('button[title="Direct messages"]').click();
    await page.getByText("Pending", { exact: false }).first().click();

    await page.getByLabel("Add a friend by username").fill(throwaway);
    const result = page.locator(`button:has-text("@${throwaway}")`).first();
    await expect(result).toBeVisible({ timeout: 10_000 });

    // Count-based so repeated runs (which accumulate outgoing requests) stay green.
    const outgoingBefore = await page.getByText("Outgoing friend request", { exact: false }).count();
    await result.click();
    await expect(page.getByText("Outgoing friend request", { exact: false })).toHaveCount(outgoingBefore + 1, {
      timeout: 10_000,
    });
  });

  test("upload an attachment and render its media link", async ({ page }) => {
    await openApp(page);
    await openGeneral(page);

    await page.locator('input[type="file"]').setInputFiles({
      name: "note.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(`Nebula attachment ${Date.now()}`),
    });
    await expect(page.getByText("note.txt", { exact: false }).first()).toBeVisible({ timeout: 15_000 });

    await page.locator("textarea").first().fill("here is a file");
    await page.locator("textarea").first().press("Enter");
    await expect(page.locator('a[href*="/media/"]').first()).toBeVisible({ timeout: 15_000 });
  });
});
