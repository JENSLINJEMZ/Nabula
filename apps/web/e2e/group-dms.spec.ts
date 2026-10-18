import { test, expect } from "@playwright/test";
import { openApp, trackErrors, AUTH, BASE } from "./helpers";

/**
 * Group DMs: alice creates a group with bob through the modal, sends a
 * message, bob sees the group appear in his sidebar in realtime, opens it and
 * leaves — which closes the group and navigates both clients home.
 */
test.describe("Nebula web app — group DMs", () => {
  test("create, realtime delivery, and leaving a group DM", async ({ page, browser }) => {
    const bobCtx = await browser.newContext({ storageState: AUTH.bob, baseURL: BASE });
    const bob = await bobCtx.newPage();
    const errors = [...trackErrors(page, "[alice] "), ...trackErrors(bob, "[bob] ")];

    /* ---------------------------------------------------- alice creates */

    await openApp(page);
    await page.locator('button[title="Direct messages"]').click();
    await expect(page).toHaveURL(/\/channels\/@me$/);

    await page.locator('button[title="Create group DM"]').click();
    const modal = page.getByRole("dialog", { name: "New group DM" });
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "Bob", exact: true }).click({ timeout: 15_000 });
    await modal.getByRole("button", { name: "Create DM" }).click();

    await expect(page).toHaveURL(/\/channels\/@me\/\d+$/);
    // "Add people" only exists on group DMs — proves this is a group, not a 1:1.
    await expect(page.getByTitle("Add people")).toBeVisible();
    await expect(page.getByTitle("Leave group DM")).toBeVisible();

    const message = `group-hello-${Date.now()}`;
    await page.locator("textarea").first().fill(message);
    await page.locator("textarea").first().press("Enter");
    await expect(page.getByText(message, { exact: false })).toBeVisible({ timeout: 15_000 });

    // Alice's sidebar labels the group distinctly from a 1:1 DM.
    await page.getByRole("button", { name: "dms", exact: true }).click();
    const aliceGroupRow = page.getByRole("button", { name: "Bob (group DM)" });
    await expect(aliceGroupRow).toHaveCount(1);

    /* ------------------------------------------------------- bob sees it */

    await openApp(bob);
    await bob.locator('button[title="Direct messages"]').click();
    await expect(bob).toHaveURL(/\/channels\/@me$/);
    await bob.getByRole("button", { name: "dms", exact: true }).click();

    // The group appears in bob's sidebar without a reload: realtime CHANNEL_CREATE.
    const bobGroupRow = bob.getByRole("button", { name: "Alice (group DM)" });
    await expect(bobGroupRow).toBeVisible({ timeout: 15_000 });

    // Opening it loads the conversation; group-only controls confirm the type.
    await bobGroupRow.click();
    await expect(bob.getByText(message, { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(bob.getByTitle("Leave group DM")).toBeVisible();

    /* --------------------------------------------------- bob leaves (closes) */

    bob.once("dialog", (dialog) => void dialog.accept());
    await bob.getByTitle("Leave group DM").click();
    await expect(bob).toHaveURL(/\/channels\/@me$/);
    await expect(bob.getByRole("button", { name: "Alice (group DM)" })).toHaveCount(0);

    // Alice receives CHANNEL_DELETE in realtime and is navigated home too.
    await expect(page).toHaveURL(/\/channels\/@me$/, { timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Bob (group DM)" })).toHaveCount(0);

    expect(errors).toEqual([]);
    await bobCtx.close();
  });
});
