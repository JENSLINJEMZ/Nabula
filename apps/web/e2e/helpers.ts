import { expect, type Page } from "@playwright/test";

/** Password derived by the seed script: `Seed-${sha256(SESSION_SECRET + ":seed").slice(0,20)}!9`. */
export const SEED_PASSWORD = process.env.NEBULA_SEED_PASSWORD ?? "Seed-11ed58c6676b9f932843!9";

export const SEED_USER = {
  alice: "nebula_alice",
  bob: "nebula_bob",
  carol: "nebula_carol",
} as const;

/** Storage-state files written by `e2e/auth.setup.ts`. */
export const AUTH = {
  alice: "e2e/.auth/alice.json",
  bob: "e2e/.auth/bob.json",
} as const;

/** Web dev-server origin (raw `browser.newContext()` does not inherit `use.baseURL`). */
export const BASE = process.env.NEBULA_WEB_URL ?? "http://localhost:5173";

/**
 * Navigate to the app using the pre-authenticated session (the default project
 * loads alice's storage state; other users pass an explicit context) and wait
 * for the app shell to render.
 */
export async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator('button[title="Nebula Labs"]')).toBeVisible({ timeout: 20_000 });
}

/** Open the seeded "Nebula Labs" guild and its #general text channel. */
export async function openGeneral(page: Page): Promise<void> {
  await page.locator('button[title="Nebula Labs"]').first().click();
  await page.getByText("general", { exact: true }).first().click();
  await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
}

/** Collect console + page errors so a test can assert a clean console. */
export function trackErrors(page: Page, label = ""): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`${label}${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`${label}${err.message}`));
  return errors;
}
