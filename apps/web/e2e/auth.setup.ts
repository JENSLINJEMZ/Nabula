import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { test as setup, expect } from "@playwright/test";
import { SEED_PASSWORD, SEED_USER } from "./helpers";

/**
 * Authenticate once per seeded user and persist the session cookies.
 *
 * The dev server enforces a login rate limit (20/min). Driving the login form
 * in every test (≈13 logins per run) trips it on back-to-back runs, so we log
 * in exactly twice here and every other spec reuses the saved storage state.
 */
const ACCOUNTS = [
  { name: "alice", username: SEED_USER.alice, file: "e2e/.auth/alice.json" },
  { name: "bob", username: SEED_USER.bob, file: "e2e/.auth/bob.json" },
] as const;

for (const account of ACCOUNTS) {
  setup(`authenticate as ${account.name}`, async ({ page }) => {
    mkdirSync(dirname(account.file), { recursive: true });

    await page.goto("/");
    await page.locator("#username").fill(account.username);
    await page.locator("#password").fill(SEED_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('button[title="Nebula Labs"]')).toBeVisible({ timeout: 20_000 });

    await page.context().storageState({ path: account.file });
  });
}
