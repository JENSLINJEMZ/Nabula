import { createHmac } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * Milestone 1 — end-to-end account-security journeys.
 *
 * Drives the real UI (React + Vite dev server) against the real API. There is
 * no SMTP server: when SMTP_URL is unset the server captures each email as an
 * `.eml` file under MAIL_DEV_DIR, and this spec reads the single-use link from
 * disk — the documented local-testing method. Nothing here is mocked.
 */
const MAIL_DIR_CANDIDATES = [
  process.env.MAIL_DEV_DIR,
  "/tmp/opencode/nebula-e2e-mail",
  resolve(process.cwd(), "../server/data/mail"),
].filter((dir): dir is string => Boolean(dir));

function uniqueUser(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 24);
}

/** Newest captured email addressed to `recipient`, searched across candidates. */
async function readCapturedEmail(recipient: string, sinceMs: number): Promise<string> {
  for (const dir of MAIL_DIR_CANDIDATES) {
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".eml"));
    } catch {
      continue;
    }
    const ordered = (
      await Promise.all(
        files.map(async (file) => ({ file, mtime: (await stat(join(dir, file))).mtimeMs })),
      )
    )
      .filter((entry) => entry.mtime >= sinceMs - 2_000)
      .sort((a, b) => b.mtime - a.mtime);

    for (const entry of ordered) {
      const content = await readFile(join(dir, entry.file), "utf8");
      if (content.includes(`To: ${recipient}`)) return content;
    }
  }
  throw new Error(`No captured email for ${recipient} (looked in ${MAIL_DIR_CANDIDATES.join(", ")})`);
}

function extractToken(eml: string): string {
  const match = eml.match(/token=([A-Za-z0-9_-]+)/);
  if (!match?.[1]) throw new Error("No token found in captured email");
  return match[1];
}

// ---- Minimal RFC 6238 TOTP so the spec does not depend on the server's lib ---

function base32Decode(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of secret.replace(/=+$/, "").toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(secret: string, atMs = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const hmac = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;
  return String(code % 1_000_000).padStart(6, "0");
}

async function openSettings(page: Page, tab: "account" | "security"): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "User settings" });
  // The modal may already be open from a previous step; re-clicking the dock
  // button in that state is not reliable, so only open it when it is closed.
  if (!(await dialog.isVisible())) {
    await page.getByLabel("User settings").first().click();
  }
  await expect(dialog).toBeVisible();
  // The account tab renders with a friendlier label than its internal key.
  const label = tab === "account" ? "My account" : tab;
  await dialog.getByRole("button", { name: label, exact: true }).click();
}

/**
 * Fresh accounts have no guilds, so "Nebula Labs" is not a valid signed-in
 * marker here; the user dock's settings button is present for every session.
 */
async function expectSignedIn(page: Page): Promise<void> {
  await expect(page.getByLabel("User settings").first()).toBeVisible({ timeout: 20_000 });
}

async function register(
  page: Page,
  options: { username: string; password: string; email?: string },
): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await page.locator("#username").fill(options.username);
  await page.locator("#password").fill(options.password);
  if (options.email) await page.locator("#email").fill(options.email);
  await page.locator('button[type="submit"]').click();
  await expectSignedIn(page);
}

async function logout(page: Page): Promise<void> {
  await openSettings(page, "account");
  await page
    .getByRole("dialog", { name: "User settings" })
    .getByRole("button", { name: /log out/i })
    .click();
  await expect(page.locator("#username")).toBeVisible({ timeout: 10_000 });
}

async function login(page: Page, username: string, password: string): Promise<void> {
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator('button[type="submit"]').click();
}

test.describe("account security", () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeEach(async ({ browser }) => {
    // A fresh, isolated session (the default project ships alice's storage
    // state, which newContext may inherit in this Playwright version).
    context = await browser.newContext();
    await context.clearCookies();
    page = await context.newPage();
  });

  test.afterEach(async () => {
    await context.close();
  });

  test("verify email, then change password and sign back in", async () => {
    const username = uniqueUser("e2e_sec");
    const email = `${username}@example.test`;
    const original = "Original-pass-123";
    const updated = "Updated-pass-456";
    const startedAt = Date.now();

    await register(page, { username, password: original, email });

    // The verification email is sent at registration; the settings screen
    // reflects the unverified state.
    await openSettings(page, "security");
    await expect(page.getByTestId("email-status")).toContainText("not yet verified");

    const token = extractToken(await readCapturedEmail(email, startedAt));
    await page.goto(`/verify-email?token=${encodeURIComponent(token)}`);
    await expect(page.getByTestId("verify-success")).toBeVisible();

    await page.goto("/");
    await expectSignedIn(page);
    await openSettings(page, "security");
    await expect(page.getByTestId("email-status")).toContainText("verified");

    // Change password.
    await page.getByLabel("Current password").fill(original);
    await page.getByLabel("New password", { exact: true }).fill(updated);
    await page.getByLabel("Confirm new password").fill(updated);
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByTestId("security-success")).toContainText(/password updated/i);

    // The old password is rejected, the new one works.
    await logout(page);
    await login(page, username, original);
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 10_000 });
    await page.locator("#password").fill(updated);
    await page.locator('button[type="submit"]').click();
    await expectSignedIn(page);
  });

  test("forgot password → reset via emailed link → sign in", async () => {
    const username = uniqueUser("e2e_reset");
    const email = `${username}@example.test`;
    const original = "Original-pass-123";
    const updated = "Reset-pass-789";
    const startedAt = Date.now();

    await register(page, { username, password: original, email });
    await logout(page);

    await page.goto("/forgot-password");
    await page.locator("#forgot-email").fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByTestId("forgot-success")).toBeVisible();

    const token = extractToken(await readCapturedEmail(email, startedAt));
    await page.goto(`/reset-password?token=${encodeURIComponent(token)}`);
    await page.getByLabel("New password", { exact: true }).fill(updated);
    await page.getByLabel("Confirm new password").fill(updated);
    await page.getByRole("button", { name: "Reset password" }).click();
    await expect(page.getByTestId("reset-success")).toBeVisible();

    await page.getByRole("link", { name: "Go to sign in" }).click();
    await login(page, username, updated);
    await expectSignedIn(page);
  });

  test("enable 2FA, sign in with a TOTP code, then with a recovery code", async () => {
    const username = uniqueUser("e2e_mfa");
    const password = "Mfa-pass-123456";

    await register(page, { username, password });

    await openSettings(page, "security");
    await expect(page.getByTestId("mfa-status")).toContainText("Disabled");
    await page.getByLabel("Password to begin 2FA enrollment").fill(password);
    await page.getByRole("button", { name: "Set up 2FA" }).click();

    await expect(page.getByTestId("mfa-enrollment")).toBeVisible();
    const manualKey = (await page.getByTestId("mfa-manual-key").innerText()).match(/[A-Z2-7]{16,}/)?.[0];
    expect(manualKey).toBeTruthy();

    await page.getByLabel("Authenticator code").fill(totp(manualKey!));
    await page.getByRole("button", { name: "Verify and enable" }).click();
    await expect(page.getByTestId("recovery-codes")).toBeVisible();
    const recoveryCodes = await page.getByTestId("recovery-codes").locator("li").allInnerTexts();
    expect(recoveryCodes).toHaveLength(10);

    // Log in with the authenticator code.
    await logout(page);
    await login(page, username, password);
    await expect(page.locator("#mfa-code")).toBeVisible({ timeout: 10_000 });
    await page.locator("#mfa-code").fill(totp(manualKey!));
    await page.getByRole("button", { name: "Verify and sign in" }).click();
    await expectSignedIn(page);

    // Log in with a recovery code instead.
    await logout(page);
    await login(page, username, password);
    await expect(page.locator("#mfa-code")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Use a recovery code" }).click();
    await page.locator("#mfa-recovery").fill(recoveryCodes[0]!);
    await page.getByRole("button", { name: "Verify and sign in" }).click();
    await expectSignedIn(page);
  });
});
