import { test, expect } from "@playwright/test";
import { openApp, openGeneral, trackErrors, AUTH, BASE } from "./helpers";

/**
 * Message forwarding: alice forwards a channel message into her DM with bob
 * from the hover action, the copy carries a "Forwarded" attribution and lands
 * in bob's conversation.
 */
test.describe("Nebula web app — message forwarding", () => {
  test("forwards a message from a channel into a DM", async ({ page, browser }) => {
    const bobCtx = await browser.newContext({ storageState: AUTH.bob, baseURL: BASE });
    const bob = await bobCtx.newPage();
    const errors = [...trackErrors(page, "[alice] "), ...trackErrors(bob, "[bob] ")];

    await openApp(page);

    // Make sure a 1:1 DM with Bob exists so it is offered as a target.
    await page.locator('button[title="Direct messages"]').click();
    await page.getByRole("button", { name: "Bob", exact: true }).first().click();
    await expect(page).toHaveURL(/\/channels\/@me\/\d+$/, { timeout: 15_000 });
    const dmUrl = page.url();

    // Post the message to forward in #general.
    await openGeneral(page);
    const content = `forward-me-${Date.now()}`;
    await page.locator("textarea").first().fill(content);
    await page.locator("textarea").first().press("Enter");
    const source = page.locator('[id^="msg-"]', { hasText: content }).last();
    await expect(source).toBeVisible({ timeout: 15_000 });

    // Hover → Forward → pick the Bob DM → send the copy.
    await source.scrollIntoViewIfNeeded();
    await source.hover();
    await source.getByTitle("Forward").click({ force: true });

    const modal = page.getByRole("dialog", { name: "Forward message" });
    await expect(modal).toBeVisible();
    // Exact accessible name: label + "Direct messages" category — a group DM
    // that happens to contain only Bob is listed under "Group DMs" instead.
    await modal.getByRole("button", { name: "Bob Direct messages", exact: true }).click();
    await modal.getByRole("button", { name: "Forward", exact: true }).click();

    await expect(page.getByText(/Forwarded to 1 conversation/)).toBeVisible({ timeout: 15_000 });
    await expect(modal).toBeHidden();

    // The copy is in the DM and labelled as forwarded.
    await page.goto(dmUrl);
    const copy = page.locator('[id^="msg-"]', { hasText: content }).last();
    await expect(copy).toBeVisible({ timeout: 20_000 });
    await expect(copy.getByText("Forwarded", { exact: true })).toBeVisible();

    // Bob sees it in his conversation with Alice.
    await openApp(bob);
    await bob.locator('button[title="Direct messages"]').click();
    await bob.getByRole("button", { name: "Alice", exact: true }).first().click();
    await expect(bob.locator('[id^="msg-"]', { hasText: content }).last()).toBeVisible({ timeout: 15_000 });

    expect(errors).toEqual([]);
    await bobCtx.close();
  });
});
