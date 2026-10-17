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
    },
    {
      command: "npm run dev",
      url: "http://localhost:5173",
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
