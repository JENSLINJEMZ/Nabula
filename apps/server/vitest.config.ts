import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    hookTimeout: 60_000,
    testTimeout: 60_000,
    // Integration tests share one Postgres database; run serially to avoid
    // cross-test interference on the same tables.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    env: {
      NODE_ENV: "test",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://nebula:nebula@127.0.0.1:55432/nebula_test",
      SESSION_SECRET: "test-only-session-secret-with-plenty-of-entropy-1234567890",
      TOTP_ENCRYPTION_KEY: "test-only-totp-encryption-key-with-plenty-of-entropy-0987654321",
      MAIL_DEV_DIR: "/tmp/opencode/nebula-test-mail",
      // Email must always go to the on-disk capture during tests: the
      // developer's apps/server/.env (SMTP_URL / SMTP_HOST / …) is loaded by
      // config.ts and must never route suite mail to a real relay. A blank
      // value counts as unset (see config.ts), so mail stays captured.
      SMTP_URL: "",
      SMTP_HOST: "",
      SMTP_PORT: "",
      SMTP_USER: "",
      SMTP_PASS: "",
      SMTP_FROM: "Nebula <no-reply@nebula.test>",
      PUBLIC_WEB_ORIGIN: "http://localhost:51999",
      COOKIE_SECURE: "false",
      RATE_LIMIT_DISABLED: "true",
      STORAGE_LOCAL_DIR: "/tmp/opencode/nebula-test-uploads",
      LOG_LEVEL: "error",
    },
  },
});
