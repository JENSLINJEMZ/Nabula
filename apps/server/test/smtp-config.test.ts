import { describe, expect, it } from "vitest";
import { resolveSmtpSettings, smtpConfigured, smtpSettings, type SmtpSettings } from "../src/config.js";

/**
 * SMTP relay resolution (`resolveSmtpSettings`).
 *
 * The relay can be described with a single `SMTP_URL` or with discrete
 * `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`. These tests pin down the
 * precedence rules — and, importantly, that no relay is resolved while the
 * suites run: the test config blanks every SMTP variable so mail always goes to
 * the on-disk capture, never to a developer's real credentials.
 */

function settings(input: Partial<Record<"SMTP_URL" | "SMTP_HOST" | "SMTP_PORT" | "SMTP_USER" | "SMTP_PASS", string>>): SmtpSettings | null {
  return resolveSmtpSettings({
    SMTP_URL: input.SMTP_URL,
    SMTP_HOST: input.SMTP_HOST,
    SMTP_PORT: input.SMTP_PORT ? Number(input.SMTP_PORT) : undefined,
    SMTP_USER: input.SMTP_USER,
    SMTP_PASS: input.SMTP_PASS,
  });
}

describe("SMTP relay resolution", () => {
  it("is not configured in the test environment", () => {
    // Regression guard: apps/server/.env is loaded by config.ts, so the test
    // config must blank every SMTP variable or suite mail would hit a real relay.
    expect(smtpConfigured).toBe(false);
    expect(smtpSettings).toBeNull();
  });

  it("reports unconfigured when nothing is set", () => {
    expect(settings({})).toBeNull();
    expect(settings({ SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASS: "p" })).toBeNull();
  });

  it("reads host, port and credentials from SMTP_URL alone", () => {
    expect(settings({ SMTP_URL: "smtp://user:pass@example.test:2525" })).toEqual({
      host: "example.test",
      port: 2525,
      secure: false,
      user: "user",
      pass: "pass",
    });
  });

  it("reads the discrete variables when no URL is set", () => {
    expect(
      settings({ SMTP_HOST: "smtp.example.test", SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASS: "p" }),
    ).toEqual({ host: "smtp.example.test", port: 587, secure: false, user: "u", pass: "p" });
  });

  it("defaults the port to 587 (465 for smtps) and derives implicit TLS", () => {
    expect(settings({ SMTP_HOST: "smtp.example.test" })).toEqual({
      host: "smtp.example.test",
      port: 587,
      secure: false,
      user: undefined,
      pass: undefined,
    });
    expect(settings({ SMTP_URL: "smtps://user:pass@example.test" })).toEqual({
      host: "example.test",
      port: 465,
      secure: true,
      user: "user",
      pass: "pass",
    });
    expect(settings({ SMTP_HOST: "smtp.example.test", SMTP_PORT: "465" })?.secure).toBe(true);
  });

  it("uses SMTP_URL for host/port and the discrete variables for credentials", () => {
    // The documented combination: a URL without embedded credentials plus
    // SMTP_USER/SMTP_PASS kept in separate variables.
    expect(
      settings({ SMTP_URL: "smtp://sandbox.example.test:2525", SMTP_HOST: "ignored.example.test", SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASS: "p" }),
    ).toEqual({ host: "sandbox.example.test", port: 2525, secure: false, user: "u", pass: "p" });
  });

  it("prefers credentials embedded in SMTP_URL over the discrete variables", () => {
    expect(
      settings({ SMTP_URL: "smtp://url-user:url-pass@example.test:587", SMTP_USER: "field-user", SMTP_PASS: "field-pass" }),
    ).toMatchObject({ user: "url-user", pass: "url-pass" });
  });

  it("leaves auth unset when no credentials are available", () => {
    const resolved = settings({ SMTP_HOST: "smtp.example.test", SMTP_PORT: "25" });
    expect(resolved).toMatchObject({ host: "smtp.example.test", port: 25 });
    expect(resolved?.user).toBeUndefined();
  });

  it("decodes percent-encoded credentials from the URL", () => {
    expect(settings({ SMTP_URL: "smtp://user%40corp:p%40ss%3Aword@example.test:587" })).toMatchObject({
      user: "user@corp",
      pass: "p@ss:word",
    });
  });
});
