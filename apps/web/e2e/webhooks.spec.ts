import { test, expect, request as apiRequest, type APIRequestContext, type Page } from "@playwright/test";
import { openApp, openGeneral, trackErrors, AUTH, BASE } from "./helpers";

/**
 * Channel webhooks.
 *
 * Management is exercised through the channel-settings UI. Delivery is exercised
 * against the public token endpoint, which is authenticated by the token alone,
 * so it is called from a cookie-less request context. Embed handling is verified
 * to never dereference a URL: Nebula has no outbound fetch path, so an embed URL
 * pointing at a non-routable address is stored verbatim and returned instantly.
 */

/* ------------------------------------------------------------------ helpers */

/** The double-submit CSRF token stored in the readable companion cookie. */
async function csrfToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  return cookies.find((c) => c.name === "nebula_csrf")?.value ?? "";
}

/** Authenticated JSON request that shares the page's session cookies. */
async function authed<T = Record<string, unknown>>(
  page: Page,
  method: string,
  path: string,
  data?: unknown,
): Promise<{ status: number; body: T; text: string }> {
  const csrf = await csrfToken(page);
  const res = await page.request.fetch(`${BASE}${path}`, {
    method,
    headers: { "x-csrf-token": csrf },
    data,
  });
  const text = await res.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = {} as T;
  }
  return { status: res.status(), body, text };
}

/** Create a throwaway text channel in the seeded guild; returns its id. */
async function createIsolatedChannel(page: Page): Promise<{ guildId: string; channelId: string }> {
  const guilds = await authed<{ guilds: Array<{ id: string; name: string }> }>(page, "GET", "/api/guilds");
  const guild = guilds.body.guilds.find((g) => g.name === "Nebula Labs")!;
  const res = await authed<{ channel: { id: string } }>(page, "POST", `/api/guilds/${guild.id}/channels`, {
    type: 0,
    name: `e2e-hooks-${Date.now().toString(36)}`,
  });
  expect(res.status, res.text).toBe(201);
  return { guildId: guild.id, channelId: res.body.channel.id };
}

/** Create a webhook through the authenticated API; returns id + one-time token. */
async function createWebhook(page: Page, channelId: string, name: string) {
  const res = await authed<{ webhook: { id: string; tokenPrefix: string }; token: string }>(
    page,
    "POST",
    `/api/channels/${channelId}/webhooks`,
    { name },
  );
  expect(res.status, res.text).toBe(201);
  return { webhookId: res.body.webhook.id, token: res.body.token, prefix: res.body.webhook.tokenPrefix };
}

/** Deliver a payload to the public endpoint from a cookie-less context. */
async function deliver(
  webhookId: string,
  token: string,
  data: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  // Explicitly cookie-less: the public endpoint is a bearer-token capability and
  // must not carry (or require) the caller's session/CSRF cookies.
  const ctx: APIRequestContext = await apiRequest.newContext({
    baseURL: BASE,
    storageState: { cookies: [], origins: [] },
  });
  try {
    const res = await ctx.post(`/api/webhooks/${webhookId}/${token}`, { data, headers });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: res.status(), body, text };
  } finally {
    await ctx.dispose();
  }
}

async function deleteChannel(page: Page, channelId: string): Promise<void> {
  await authed(page, "DELETE", `/api/channels/${channelId}`);
}

/** Open the channel-settings dialog for #general and scroll to the section. */
async function openChannelSettings(page: Page) {
  const row = page.locator("div.group\\/row", { hasText: "general" }).first();
  await row.hover();
  await row.getByTitle("Channel options").click({ force: true });
  await page.getByText("Edit channel", { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Channel settings" });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByText("Webhooks", { exact: true }).scrollIntoViewIfNeeded();
  return dialog;
}

/* -------------------------------------------------------------------- tests */

test.describe("Nebula web app — webhooks", () => {
  test("manages a webhook lifecycle from the channel settings UI", async ({ page }) => {
    const errors = trackErrors(page, "wh-ui: ");
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.accept();
    });

    await openApp(page);
    await openGeneral(page);
    const dialog = await openChannelSettings(page);

    const name = `e2e-hook-${Date.now().toString(36)}`;
    await dialog.getByPlaceholder("Webhook name").fill(name);
    await dialog.getByRole("button", { name: /Create/ }).click();

    // The token is revealed exactly once, in the create banner.
    await expect(dialog.getByText("New token (only shown once)")).toBeVisible({ timeout: 10_000 });
    const token = (await dialog.locator("code").first().textContent())?.trim() ?? "";
    expect(token.length).toBeGreaterThan(20);

    // The webhook is listed exposing only its prefix — never the secret.
    const row = dialog.locator("li", { hasText: name }).first();
    await expect(row).toBeVisible();
    await expect(row).not.toContainText(token);
    await expect(row).toContainText(`${token.slice(0, 8)}…`);

    // Dismissing removes the secret from the DOM ("shown once").
    await dialog.getByRole("button", { name: "Dismiss" }).click();
    await expect(dialog.locator("code")).toHaveCount(0);

    // Details panel → rotate issues a brand-new token.
    await row.getByRole("button", { name: "Details" }).click();
    await expect(dialog.getByRole("button", { name: /Rotate/ })).toBeVisible();
    await dialog.getByRole("button", { name: /Rotate/ }).click();
    await expect(dialog.getByText("New token (only shown once)")).toBeVisible();
    const rotated = (await dialog.locator("code").first().textContent())?.trim() ?? "";
    expect(rotated).not.toBe(token);

    // Disable → Enable round-trip.
    await dialog.getByRole("button", { name: "Disable" }).click();
    await expect(dialog.getByRole("button", { name: "Enable" })).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole("button", { name: "Enable" }).click();
    await expect(dialog.getByRole("button", { name: "Disable" })).toBeVisible({ timeout: 10_000 });

    // "Send test" delivers through the stored secret without revealing it.
    await dialog.getByRole("button", { name: /Send test/ }).click();
    await expect.poll(() => dialogs.some((m) => /Test delivery sent/i.test(m)), { timeout: 10_000 }).toBe(true);

    // Delete (behind a confirmation dialog) removes it.
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(dialog.locator("li", { hasText: name })).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test("delivers an authenticated payload exactly once and de-duplicates replays", async ({ page }) => {
    await openApp(page);
    const { guildId, channelId } = await createIsolatedChannel(page);
    try {
      const { webhookId, token } = await createWebhook(page, channelId, "delivery-bot");
      await page.goto(`/channels/${guildId}/${channelId}`);
      await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });

      const content = `hook-msg-${Date.now().toString(36)}`;
      const key = `idem-${Date.now().toString(36)}`;
      const first = await deliver(
        webhookId,
        token,
        { content, username: "Deploy Bot", embeds: [{ title: "Build", description: "green", color: 0x00ff88 }] },
        { "x-idempotency-key": key },
      );
      const replay = await deliver(webhookId, token, { content, username: "Deploy Bot" }, { "x-idempotency-key": key });

      expect(first.status, first.text).toBe(201);
      expect(first.body.duplicate).toBe(false);
      // The replay returns the original message, not a duplicate post.
      expect(replay.status, replay.text).toBe(200);
      expect(replay.body.duplicate).toBe(true);

      const row = page.locator('[id^="msg-"]', { hasText: content });
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      await expect(row.first()).toContainText("Deploy Bot");
      // The embed is rendered client-side from stored fields.
      await expect(row.first().getByTestId("message-embed")).toContainText("Build");
    } finally {
      await deleteChannel(page, channelId);
    }
  });

  test("validates secrets, payload shape, size and embeds", async ({ page }) => {
    await openApp(page);
    const { channelId } = await createIsolatedChannel(page);
    try {
      const { webhookId, token } = await createWebhook(page, channelId, "validation-bot");

      const badSecret = await deliver(webhookId, "x".repeat(40), { content: "nope" });
      expect(badSecret.status).toBe(401);

      const malformedType = await deliver(webhookId, token, { content: 123 });
      expect(malformedType.status).toBe(400);

      const unknownField = await deliver(webhookId, token, { content: "x", unexpected: true });
      expect(unknownField.status).toBe(400);

      const empty = await deliver(webhookId, token, {});
      expect(empty.status).toBe(400);

      const oversized = await deliver(webhookId, token, { content: "a".repeat(2001) });
      expect(oversized.status).toBe(400);

      const tooManyEmbeds = await deliver(webhookId, token, {
        embeds: Array.from({ length: 11 }, (_, i) => ({ description: `e${i}` })),
      });
      expect(tooManyEmbeds.status).toBe(400);

      const badUrl = await deliver(webhookId, token, { embeds: [{ title: "x", url: "file:///etc/passwd" }] });
      expect(badUrl.status).toBe(400);

      // The destination is bound to the webhook's channel: a caller cannot
      // redirect it, and a forged/unknown id is not found.
      const crossChannel = await deliver(webhookId, token, { content: "x", channelId: "123456789012345678" });
      expect(crossChannel.status).toBe(400);
      const unknownHook = await deliver("999999999999999999", token, { content: "x" });
      expect(unknownHook.status).toBe(404);

      const ok = await deliver(webhookId, token, { content: "valid" });
      expect(ok.status, ok.text).toBe(201);
    } finally {
      await deleteChannel(page, channelId);
    }
  });

  test("supports rename and stops delivery after rotation, disable and delete", async ({ page }) => {
    await openApp(page);
    const { guildId, channelId } = await createIsolatedChannel(page);
    try {
      const { webhookId, token } = await createWebhook(page, channelId, "revoke-bot");

      // Edit: rename is supported by the API (the UI exposes avatar/disable only).
      const rename = await authed<{ webhook: { name: string } }>(
        page,
        "PATCH",
        `/api/guilds/${guildId}/webhooks/${webhookId}`,
        { name: "renamed-bot" },
      );
      expect(rename.status).toBe(200);
      expect(rename.body.webhook.name).toBe("renamed-bot");

      // Rotate: the previous secret stops working immediately.
      const rot = await authed<{ token: string }>(page, "POST", `/api/guilds/${guildId}/webhooks/${webhookId}/rotate`);
      expect(rot.status).toBe(200);
      const newToken = rot.body.token;
      expect(newToken).not.toBe(token);
      expect((await deliver(webhookId, token, { content: "old" })).status).toBe(401);
      expect((await deliver(webhookId, newToken, { content: "new" })).status).toBe(201);

      // Disable → refused while disabled, works again once enabled.
      await authed(page, "PATCH", `/api/guilds/${guildId}/webhooks/${webhookId}`, { disabled: true });
      expect((await deliver(webhookId, newToken, { content: "off" })).status).toBe(403);
      await authed(page, "PATCH", `/api/guilds/${guildId}/webhooks/${webhookId}`, { disabled: false });
      expect((await deliver(webhookId, newToken, { content: "on" })).status).toBe(201);

      // Delete → the endpoint is gone.
      expect((await authed(page, "DELETE", `/api/guilds/${guildId}/webhooks/${webhookId}`)).status).toBe(204);
      expect((await deliver(webhookId, newToken, { content: "gone" })).status).toBe(404);

      // Lifecycle actions are recorded in the guild audit log (create/update/delete).
      const audit = await authed<{ entries: Array<{ actionType: number; targetId: string }> }>(
        page,
        "GET",
        `/api/guilds/${guildId}/audit-logs`,
      );
      const actions = audit.body.entries.filter((e) => e.targetId === webhookId).map((e) => e.actionType);
      expect(actions).toContain(50);
      expect(actions).toContain(51);
      expect(actions).toContain(52);
    } finally {
      await deleteChannel(page, channelId);
    }
  });

  test("never exposes the secret through list or delivery-history responses", async ({ page }) => {
    await openApp(page);
    const { guildId, channelId } = await createIsolatedChannel(page);
    try {
      const { webhookId, token } = await createWebhook(page, channelId, "secret-probe");

      const list = await authed(page, "GET", `/api/channels/${channelId}/webhooks`);
      expect(list.status).toBe(200);
      expect(list.text).not.toContain(token);
      expect(list.text).not.toContain("token_hash");
      expect(list.text).not.toContain("signing_secret");

      const delivery = await deliver(webhookId, token, { content: "secret-probe" });
      expect(delivery.status).toBe(201);
      expect(JSON.stringify(delivery.body)).not.toContain(token);

      const history = await authed(page, "GET", `/api/guilds/${guildId}/webhooks/${webhookId}/deliveries`);
      expect(history.status).toBe(200);
      expect(history.text).toContain(webhookId);
      expect(history.text).not.toContain(token);
      expect(history.text).not.toContain("token_hash");
    } finally {
      await deleteChannel(page, channelId);
    }
  });

  test("enforces the per-webhook delivery rate limit", async ({ page }) => {
    await openApp(page);
    const { channelId } = await createIsolatedChannel(page);
    let ctx: APIRequestContext | undefined;
    try {
      const { webhookId, token } = await createWebhook(page, channelId, "burst-bot");
      ctx = await apiRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });

      const statuses: number[] = [];
      for (let i = 0; i < 31; i++) {
        const res = await ctx.post(`/api/webhooks/${webhookId}/${token}`, { data: { content: `burst ${i}` } });
        statuses.push(res.status());
        await res.text();
      }

      expect(statuses.slice(0, 30).every((s) => s === 201)).toBe(true);
      expect(statuses[30]).toBe(429);
    } finally {
      await ctx?.dispose();
      await deleteChannel(page, channelId);
    }
  });

  test("rejects webhook management without MANAGE_WEBHOOKS", async ({ page, browser }) => {
    await openApp(page);
    const { guildId, channelId } = await createIsolatedChannel(page);
    try {
      const { webhookId } = await createWebhook(page, channelId, "owner-only");

      const bobCtx = await browser.newContext({ storageState: AUTH.bob, baseURL: BASE });
      const bob = await bobCtx.newPage();
      try {
        expect((await authed(bob, "POST", `/api/channels/${channelId}/webhooks`, { name: "nope" })).status).toBe(403);
        expect((await authed(bob, "GET", `/api/channels/${channelId}/webhooks`)).status).toBe(403);
        expect((await authed(bob, "POST", `/api/guilds/${guildId}/webhooks/${webhookId}/rotate`)).status).toBe(403);
        expect((await authed(bob, "DELETE", `/api/guilds/${guildId}/webhooks/${webhookId}`)).status).toBe(403);
        expect((await authed(bob, "POST", `/api/guilds/${guildId}/webhooks/${webhookId}/execute`)).status).toBe(403);
      } finally {
        await bobCtx.close();
      }
    } finally {
      await deleteChannel(page, channelId);
    }
  });

  test("stores embed URLs without dereferencing them (no SSRF)", async ({ page }) => {
    await openApp(page);
    const { channelId } = await createIsolatedChannel(page);
    try {
      const { webhookId, token } = await createWebhook(page, channelId, "ssrf-probe");

      // A non-routable address: if the server fetched it, this request would
      // stall or fail. It must return immediately with the URL stored as data.
      const started = Date.now();
      const res = await deliver(webhookId, token, {
        embeds: [{ title: "probe", description: "not fetched", url: "http://10.255.255.1/steal", color: 0xff0000 }],
      });
      const elapsed = Date.now() - started;

      expect(res.status, res.text).toBe(201);
      expect(JSON.stringify(res.body)).toContain("http://10.255.255.1/steal");
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await deleteChannel(page, channelId);
    }
  });
});
