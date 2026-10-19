import { test, expect } from "@playwright/test";
import { openApp, openGeneral, trackErrors, AUTH, BASE } from "./helpers";

/**
 * First-party slash commands.
 *
 * The composer surfaces command metadata from the server, completes the
 * highlighted entry with Tab/arrow keys, and hands the raw line to the
 * server-side parser on submit. Informational commands reply ephemerally
 * (only the invoker sees the result); content commands post a normal message.
 */
test.describe("Nebula web app — slash commands", () => {
  test("autocomplete filters, keyboard-selects, completes and shows the empty state", async ({ page }) => {
    const errors = trackErrors(page, "slash-menu: ");
    await openApp(page);
    await openGeneral(page);

    const composer = page.locator("textarea").first();
    const menuItem = page.locator('li[role="button"]');

    await composer.click();
    await composer.fill("/");
    await expect(menuItem.first()).toBeVisible();
    expect(await menuItem.count()).toBeGreaterThan(1);

    // Typing narrows the list to the matching command.
    await composer.fill("/he");
    await expect(menuItem).toHaveCount(1);
    await expect(menuItem.first()).toContainText("/help");

    // Arrow keys move the selection; Tab completes the highlighted command and
    // leaves a trailing space so arguments can be typed.
    await composer.fill("/");
    await composer.press("ArrowDown");
    await composer.press("ArrowDown");
    await composer.press("Tab");
    await expect(composer).toHaveValue("/shrug ");

    // Escape dismisses the menu while the draft is unchanged.
    await composer.fill("/pin");
    await expect(menuItem.first()).toBeVisible();
    await composer.press("Escape");
    await expect(menuItem.first()).toBeHidden();

    // An unknown prefix yields no matches (empty state, no menu).
    await composer.fill("/zzzzzz");
    await expect(menuItem).toHaveCount(0);

    await composer.fill("");
    expect(errors).toEqual([]);
  });

  test("runs informational commands and shows the result only to the invoker", async ({ page, browser }) => {
    const bobCtx = await browser.newContext({ storageState: AUTH.bob, baseURL: BASE });
    const bob = await bobCtx.newPage();
    const errors = [...trackErrors(page, "[alice] "), ...trackErrors(bob, "[bob] ")];

    await openApp(page);
    await openApp(bob);
    await openGeneral(page);
    await openGeneral(bob);

    const composer = page.locator("textarea").first();
    await composer.fill("/ping");
    await composer.press("Enter");
    await expect(page.getByTestId("command-result").filter({ hasText: "Pong" })).toBeVisible();

    // Ephemeral: the reply is not a channel message and the other member never
    // receives it.
    await expect(page.locator('[id^="msg-"]', { hasText: "Pong" })).toHaveCount(0);
    await expect(bob.getByTestId("command-result")).toHaveCount(0);

    // A second informational command lists the registry, restricted to what the
    // invoker may use.
    await composer.fill("/help");
    await composer.press("Enter");
    await expect(page.getByTestId("command-result").filter({ hasText: "Available commands:" })).toBeVisible();

    expect(errors).toEqual([]);
    await bob.close();
  });

  test("surfaces safe errors for invalid arguments, unknown commands and permission denials", async ({
    page,
    browser,
  }) => {
    const bobCtx = await browser.newContext({ storageState: AUTH.bob, baseURL: BASE });
    const bob = await bobCtx.newPage();
    const errors = [...trackErrors(page, "[alice] "), ...trackErrors(bob, "[bob] ")];

    await openApp(page);
    await openGeneral(page);
    const composer = page.locator("textarea").first();

    // Missing required argument: the first Enter completes, the second submits.
    await composer.fill("/me");
    await composer.press("Enter");
    await composer.press("Enter");
    await expect(page.getByRole("alert")).toContainText(/action text|usage/i);

    // A non-integer where an integer is required.
    await composer.fill("/slowmode not-a-number");
    await composer.press("Enter");
    await expect(page.getByRole("alert")).toContainText(/integer/i);

    // An unknown command is rejected by the server, never executed client-side.
    await composer.fill("/definitely-not-real");
    await composer.press("Enter");
    await expect(page.getByRole("alert")).toContainText(/unknown command/i);

    // A regular member may read the topic but may not change it.
    await openApp(bob);
    await openGeneral(bob);
    const bobComposer = bob.locator("textarea").first();
    const forbidden = `sneaky-topic-${Date.now()}`;
    await bobComposer.fill(`/topic ${forbidden}`);
    await bobComposer.press("Enter");
    await expect(bob.getByRole("alert")).toContainText(/permission/i);

    await bobComposer.fill("/topic");
    await bobComposer.press("Enter");
    const readBack = bob.getByTestId("command-result").filter({ hasText: /topic/i });
    await expect(readBack).toBeVisible();
    await expect(readBack).not.toContainText(forbidden);

    expect(errors).toEqual([]);
    await bob.close();
  });

  test("changes the topic with permission and creates an interactive poll", async ({ page, browser }) => {
    const bobCtx = await browser.newContext({ storageState: AUTH.bob, baseURL: BASE });
    const bob = await bobCtx.newPage();

    await openApp(page);
    await openGeneral(page);
    await openApp(bob);
    await openGeneral(bob);

    const composer = page.locator("textarea").first();

    // Authorized topic change (alice owns the guild).
    const topic = `e2e-topic-${Date.now()}`;
    await composer.fill(`/topic ${topic}`);
    await composer.press("Enter");
    await expect(page.getByTestId("command-result").filter({ hasText: /topic updated/i })).toBeVisible();

    await composer.fill("/topic");
    await composer.press("Enter");
    await expect(page.getByTestId("command-result").filter({ hasText: topic })).toBeVisible();

    // Poll: posts a message and seeds the vote reactions as the invoker.
    const question = `Best pet? ${Date.now()}`;
    await composer.fill(`/poll ${question} | Cats | Dogs`);
    await composer.press("Enter");

    const poll = page.locator('[id^="msg-"]', { hasText: question }).last();
    await expect(poll).toBeVisible();
    await expect(poll).toContainText("Cats");
    await expect(poll).toContainText("Dogs");

    const voteButton = poll.locator("button[aria-pressed]").filter({ hasText: "1️⃣" });
    await expect(voteButton.locator("span").nth(1)).toHaveText("1");

    // Another member votes; the tally increments in realtime for the author.
    const bobPoll = bob.locator('[id^="msg-"]', { hasText: question }).last();
    await expect(bobPoll).toBeVisible({ timeout: 15_000 });
    const bobVote = bobPoll.locator("button[aria-pressed]").filter({ hasText: "1️⃣" });
    await bobVote.click();
    await expect(voteButton.locator("span").nth(1)).toHaveText("2", { timeout: 15_000 });

    // Tidy the topic so repeated runs stay predictable.
    await composer.fill("/topic clear");
    await composer.press("Enter");
    await expect(page.getByTestId("command-result").filter({ hasText: /topic cleared/i })).toBeVisible();

    await bob.close();
  });
});
