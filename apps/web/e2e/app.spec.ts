import { test, expect } from "@playwright/test";
import { openApp, openGeneral, trackErrors } from "./helpers";

test.describe("Nebula web app — core journeys", () => {
  test("login screen rejects wrong credentials and toggles to register", async ({ context }) => {
    // The project pre-authenticates this context, so clear cookies to get a
    // genuinely logged-out session.
    await context.clearCookies();
    const page = await context.newPage();
    await page.goto("/");

    await expect(page.locator("#username")).toBeVisible();
    await expect(page.locator("#password")).toBeVisible();
    await expect(page.locator("#password")).toBeVisible();

    // Wrong password surfaces an inline error and stays on the auth screen.
    await page.locator("#username").fill("nebula_alice");
    await page.locator("#password").fill("definitely-not-the-password");
    await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 10_000 });

    // Toggle to the register form reveals the optional invite field.
    await page.getByRole("button", { name: "Register", exact: true }).click();
    await expect(page.locator("#invite")).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toHaveText(/create account/i);

    await context.close();
  });

  test("login → guild → channels → send a markdown message", async ({ page }) => {
    const errors = trackErrors(page);
    await openApp(page);
    await openGeneral(page);

    const unique = `e2e-${Date.now()}`;
    const composer = page.locator("textarea").first();
    await composer.fill(`Hello **Nebula** and \`inline code\` — ${unique} https://example.com`);
    await composer.press("Enter");

    // The rendered message row (not the composer) contains the text.
    await expect(page.locator('[id^="msg-"]', { hasText: unique }).first()).toBeVisible();
    await expect(page.locator("strong").first()).toBeVisible();
    await expect(page.locator("code").first()).toBeVisible();
    await expect(page.locator('a[href="https://example.com"]').first()).toBeVisible();
    // The composer clears once the send resolves.
    await expect(composer).toHaveValue("");

    expect(errors).toEqual([]);
  });

  test("user settings modal: profile + sessions", async ({ page }) => {
    await openApp(page);
    await openGeneral(page);

    await page.getByLabel("User settings").first().click();
    const dialog = page.getByRole("dialog", { name: "User settings" });
    await expect(dialog).toBeVisible();

    await page.getByRole("button", { name: "profile", exact: true }).click();
    await expect(page.getByText("Display name")).toBeVisible();

    await page.getByRole("button", { name: "sessions", exact: true }).click();
    await expect(page.getByText(/signed in on the following/i)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("server settings modal: all management tabs", async ({ page }) => {
    await openApp(page);
    await openGeneral(page);

    await page.getByLabel("Server settings").first().click();
    const dialog = page.getByRole("dialog", { name: "Server settings" });
    await expect(dialog).toBeVisible();

    for (const tab of ["roles", "members", "invites", "bans", "audit"]) {
      await page.getByRole("button", { name: tab, exact: true }).click();
      await expect(dialog).toBeVisible();
    }

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("channel settings modal opens from the channel menu", async ({ page }) => {
    await openApp(page);
    await openGeneral(page);

    // The channel context menu button appears on hover of the row.
    const row = page.locator("div.group\\/row", { hasText: "general" }).first();
    await row.hover();
    await row.getByTitle("Channel options").click({ force: true });
    await page.getByText("Edit channel", { exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Channel settings" });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("search panel opens and queries messages", async ({ page }) => {
    await openApp(page);
    await openGeneral(page);

    await page.getByLabel("Search").first().click();
    await expect(page.getByRole("dialog", { name: "Search messages" })).toBeVisible();
    await page.getByPlaceholder(/search/i).first().fill("Nebula");
    await page.waitForTimeout(800);
    await page.keyboard.press("Escape");
  });

  test("join a voice channel with real getUserMedia", async ({ page }) => {
    await openApp(page);
    await openGeneral(page);

    await page.getByText("General", { exact: true }).first().click();
    await expect(page.getByText("Voice connected")).toBeVisible({ timeout: 20_000 });

    // Disconnect cleanly.
    await page.getByTitle("Disconnect voice").first().click().catch(() => {});
  });
});
