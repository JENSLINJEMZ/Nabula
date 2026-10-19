import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests for the Nebula web client.
 *
 * The suite drives real Chromium against the running dev stack. Both the API
 * and the web server are started on demand (or reused if already running).
 * The database must be migrated and seeded first:
 *
 *   npm run db:migrate && npm run seed
 *
 * Voice tests use Chromium's fake media devices, so microphone permission is
 * granted without a physical device.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.NEBULA_WEB_URL ?? "http://localhost:5173",
    trace: "retain-on-failure",
    video: "off",
    permissions: ["microphone"],
    launchOptions: {
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    },
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: "e2e/.auth/alice.json" },
      dependencies: ["setup"],
    },
  ],
  webServer: [
    {
      command: "npm run dev",
      cwd: "../server",
      url: "http://localhost:4000/api/health",
      reuseExistingServer: true,
      timeout: 60_000,
      env: {
        ...process.env,
        // The suite drives many browser journeys as one authenticated user,
        // which exceeds the default 600 req/min global budget and throttles the
        // later specs. The limiter stays active (just with headroom); its
        // behaviour is asserted by the server's security integration tests.
        RATE_LIMIT_MAX: process.env.RATE_LIMIT_MAX ?? "5000",
        // Account-security tests read captured emails from disk instead of a
        // real SMTP server (see apps/server/src/mail/mailer.ts). Absolute so
        // the Playwright worker can find it regardless of its cwd.
        MAIL_DEV_DIR: process.env.MAIL_DEV_DIR ?? "/tmp/opencode/nebula-e2e-mail",
        // Specs read verification/reset links from that disk capture, so the
        // e2e server must never use a real relay configured in the developer's
        // apps/server/.env. Blank counts as unset (see apps/server/src/config.ts).
        SMTP_URL: "",
        SMTP_HOST: "",
        SMTP_PORT: "",
        SMTP_USER: "",
        SMTP_PASS: "",
      },
    },
    {
      command: "npm run dev",
      url: "http://localhost:5173",
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
