import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateSync } from "otplib";
import { execute } from "../src/db/pool.js";
import { TestClient, useTestServer, waitFor } from "./helpers";

/**
 * Milestone 1 — account security integration tests.
 *
 * Exercises the real HTTP server against the isolated test database:
 * change password, email verification, password reset, TOTP two-factor
 * authentication, recovery codes and cross-HTTP/realtime session revocation.
 *
 * Email is never sent: with no SMTP_URL configured in tests, the server
 * captures each message as an `.eml` file under MAIL_DEV_DIR, which these tests
 * read to obtain the single-use link (the documented safe test method).
 */
const ctx = useTestServer();
const MAIL_DIR = process.env.MAIL_DEV_DIR ?? "/tmp/opencode/nebula-test-mail";

async function readLastEmailFor(recipient: string): Promise<string> {
  const files = (await readdir(MAIL_DIR)).filter((f) => f.endsWith(".eml")).sort();
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const content = await readFile(join(MAIL_DIR, files[i]!), "utf8");
    if (content.includes(`To: ${recipient}`)) return content;
  }
  throw new Error(`No captured email for ${recipient}`);
}

function extractToken(eml: string): string {
  const match = eml.match(/token=([A-Za-z0-9_-]+)/);
  if (!match?.[1]) throw new Error("No token found in captured email");
  return match[1];
}

function totpNow(secret: string): string {
  return generateSync({ secret });
}

/** Register a fresh account with a verified-email-ready address. */
async function registerWithEmail(client: TestClient, email: string) {
  const username = `sec_${Math.random().toString(36).slice(2, 10)}`.slice(0, 24);
  const password = `Str0ng-${Math.random().toString(36).slice(2, 10)}!a`;
  const res = await client.post<{ user: { id: string }; csrfToken: string }>("/api/auth/register", {
    username,
    password,
    email,
  });
  expect(res.status).toBe(201);
  client.csrfToken = res.body.csrfToken;
  client.userId = res.body.user.id;
  client.username = username;
  return { username, password, userId: res.body.user.id, email };
}

describe("Account security", () => {
  describe("change password", () => {
    it("rejects an unauthenticated change", async () => {
      const anon = new TestClient(ctx.url);
      const res = await anon.post("/api/auth/password/change", {
        currentPassword: "whatever",
        newPassword: "New-Str0ng-pass1",
      });
      expect(res.status).toBe(401);
    });

    it("rejects a wrong current password and keeps the old one working", async () => {
      const client = new TestClient(ctx.url);
      const { username, password } = await registerWithEmail(client, `${Date.now()}a@example.test`);

      const wrong = await client.post("/api/auth/password/change", {
        currentPassword: "definitely-not-it",
        newPassword: "New-Str0ng-pass1",
      });
      expect(wrong.status).toBe(401);

      // The old password still works on a fresh login.
      const fresh = new TestClient(ctx.url);
      await fresh.login(username, password);
    });

    it("changes the password, keeps the current session and revokes the others", async () => {
      const client = new TestClient(ctx.url);
      const { username, password } = await registerWithEmail(client, `${Date.now()}b@example.test`);

      // A second device/session for the same account.
      const other = new TestClient(ctx.url);
      await other.login(username, password);
      const otherBefore = await other.get("/api/auth/me");
      expect(otherBefore.status).toBe(200);

      const changed = await client.post<{ ok: boolean; revokedSessions: number }>("/api/auth/password/change", {
        currentPassword: password,
        newPassword: "Brand-New-pass-99",
      });
      expect(changed.status).toBe(200);
      expect(changed.body.revokedSessions).toBeGreaterThanOrEqual(1);

      // Current session survives; the other device is signed out.
      expect((await client.get("/api/auth/me")).status).toBe(200);
      const otherAfter = await other.get("/api/auth/me");
      expect(otherAfter.body).toMatchObject({ user: null });

      // Old password no longer logs in; the new one does.
      const oldLogin = new TestClient(ctx.url);
      const oldRes = await oldLogin.post("/api/auth/login", { username, password });
      expect(oldRes.status).toBe(401);
      const newLogin = new TestClient(ctx.url);
      await newLogin.login(username, "Brand-New-pass-99");
    });
  });

  describe("email verification", () => {
    it("verifies a captured token, then rejects replay", async () => {
      const client = new TestClient(ctx.url);
      const email = `verify-${Date.now()}@example.test`;
      await registerWithEmail(client, email);

      const eml = await readLastEmailFor(email);
      const token = extractToken(eml);

      const verified = await client.post<{ ok: boolean; user: { emailVerified: boolean } }>("/api/auth/email/verify", {
        token,
      });
      expect(verified.status).toBe(200);
      expect(verified.body.user.emailVerified).toBe(true);

      // Single-use: the same token cannot be redeemed again.
      const replay = await client.post("/api/auth/email/verify", { token });
      expect(replay.status).toBe(400);
      expect(replay.body).toMatchObject({ error: { code: "TOKEN_INVALID" } });
    });

    it("rejects an expired verification token", async () => {
      const client = new TestClient(ctx.url);
      const email = `verify-exp-${Date.now()}@example.test`;
      await registerWithEmail(client, email);
      const token = extractToken(await readLastEmailFor(email));

      await execute(`UPDATE email_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [
        client.userId,
      ]);

      const res = await client.post("/api/auth/email/verify", { token });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: { code: "TOKEN_INVALID" } });
    });

    it("requires authentication to request a resend and rate-limits nothing in test config", async () => {
      const anon = new TestClient(ctx.url);
      expect((await anon.post("/api/auth/email/verify-request")).status).toBe(401);

      const client = new TestClient(ctx.url);
      const email = `resend-${Date.now()}@example.test`;
      await registerWithEmail(client, email);
      const first = extractToken(await readLastEmailFor(email));

      const resend = await client.post("/api/auth/email/verify-request");
      expect(resend.status).toBe(202);

      const second = extractToken(await readLastEmailFor(email));
      expect(second).not.toBe(first);

      // Issuing a new token invalidates the previous one.
      const oldToken = await client.post("/api/auth/email/verify", { token: first });
      expect(oldToken.status).toBe(400);
      const newToken = await client.post("/api/auth/email/verify", { token: second });
      expect(newToken.status).toBe(200);
    });
  });

  describe("password reset", () => {
    it("answers generically for unknown and known addresses (no enumeration)", async () => {
      const anon = new TestClient(ctx.url);
      const unknown = await anon.post<{ ok: boolean; message: string }>("/api/auth/password/forgot", {
        email: `nobody-${Date.now()}@example.test`,
      });
      expect(unknown.status).toBe(202);

      const client = new TestClient(ctx.url);
      const email = `reset-${Date.now()}@example.test`;
      const { username, password } = await registerWithEmail(client, email);
      const known = await anon.post<{ ok: boolean; message: string }>("/api/auth/password/forgot", { email });
      expect(known.status).toBe(202);
      expect(known.body.message).toBe(unknown.body.message);

      // The reset link actually works and invalidates the reset token.
      const token = extractToken(await readLastEmailFor(email));
      const reset = await client.post("/api/auth/password/reset", { token, newPassword: "Reset-pass-1234" });
      expect(reset.status).toBe(200);

      const replay = await client.post("/api/auth/password/reset", { token, newPassword: "Reset-pass-5678" });
      expect(replay.status).toBe(400);

      // Old password is dead, new password works.
      const oldLogin = new TestClient(ctx.url);
      expect((await oldLogin.post("/api/auth/login", { username, password })).status).toBe(401);
      const newLogin = new TestClient(ctx.url);
      await newLogin.login(username, "Reset-pass-1234");
    });

    it("revokes every existing session after a successful reset", async () => {
      const client = new TestClient(ctx.url);
      const email = `reset-sessions-${Date.now()}@example.test`;
      const { username, password } = await registerWithEmail(client, email);
      const other = new TestClient(ctx.url);
      await other.login(username, password);

      await new TestClient(ctx.url).post("/api/auth/password/forgot", { email });
      const token = extractToken(await readLastEmailFor(email));

      const anon = new TestClient(ctx.url);
      expect((await anon.post("/api/auth/password/reset", { token, newPassword: "Reset-pass-9999" })).status).toBe(200);

      // Neither pre-existing session survives.
      expect((await client.get("/api/auth/me")).body).toMatchObject({ user: null });
      expect((await other.get("/api/auth/me")).body).toMatchObject({ user: null });
    });

    it("rejects an expired reset token", async () => {
      const client = new TestClient(ctx.url);
      const email = `reset-exp-${Date.now()}@example.test`;
      await registerWithEmail(client, email);
      await new TestClient(ctx.url).post("/api/auth/password/forgot", { email });
      const token = extractToken(await readLastEmailFor(email));

      await execute(`UPDATE email_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [
        client.userId,
      ]);
      const res = await new TestClient(ctx.url).post("/api/auth/password/reset", {
        token,
        newPassword: "Reset-pass-2222",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("two-factor authentication (TOTP)", () => {
    it("enrolls, activates with a valid code, and returns single-use recovery codes", async () => {
      const client = new TestClient(ctx.url);
      const { password } = await registerWithEmail(client, `mfa-${Date.now()}@example.test`);

      // Password re-authentication is required to start enrollment.
      const badEnroll = await client.post("/api/auth/2fa/enroll", { password: "wrong-password" });
      expect(badEnroll.status).toBe(401);

      const enroll = await client.post<{ secret: string; uri: string; qrDataUrl: string }>("/api/auth/2fa/enroll", {
        password,
      });
      expect(enroll.status).toBe(200);
      expect(enroll.body.uri).toContain("otpauth://totp/");
      expect(enroll.body.qrDataUrl).toContain("data:image/png;base64,");

      // A wrong code does not activate.
      const badActivate = await client.post("/api/auth/2fa/activate", { code: "000000" });
      expect(badActivate.status).toBe(400);

      const activate = await client.post<{ recoveryCodes: string[] }>("/api/auth/2fa/activate", {
        code: totpNow(enroll.body.secret),
      });
      expect(activate.status).toBe(200);
      expect(activate.body.recoveryCodes).toHaveLength(10);

      // Self now reports 2FA enabled.
      const self = await client.get<{ user: { mfaEnabled: boolean } }>("/api/auth/me");
      expect(self.body.user.mfaEnabled).toBe(true);
    });

    it("requires a second factor at login once enabled, and accepts TOTP", async () => {
      const client = new TestClient(ctx.url);
      const { username, password } = await registerWithEmail(client, `mfa-login-${Date.now()}@example.test`);
      const enroll = await client.post<{ secret: string }>("/api/auth/2fa/enroll", { password });
      await client.post("/api/auth/2fa/activate", { code: totpNow(enroll.body.secret) });

      // Password alone no longer issues a session.
      const loginClient = new TestClient(ctx.url);
      const login = await loginClient.post<{ mfaRequired: boolean; challengeToken: string }>("/api/auth/login", {
        username,
        password,
      });
      expect(login.status).toBe(200);
      expect(login.body.mfaRequired).toBe(true);
      expect(loginClient.cookies.size).toBe(0);

      // Bad code rejected (and does not consume the challenge); the correct
      // code then issues the session from the same challenge.
      const bad = await loginClient.post("/api/auth/login/2fa", {
        challengeToken: login.body.challengeToken,
        code: "000000",
      });
      expect(bad.status).toBe(400);

      const ok = await loginClient.post<{ user: { id: string }; csrfToken: string }>("/api/auth/login/2fa", {
        challengeToken: login.body.challengeToken,
        code: totpNow(enroll.body.secret),
      });
      expect(ok.status).toBe(200);
      loginClient.csrfToken = ok.body.csrfToken;
      expect((await loginClient.get("/api/auth/me")).status).toBe(200);

      // A spent challenge cannot be replayed.
      const replay = await new TestClient(ctx.url).post("/api/auth/login/2fa", {
        challengeToken: login.body.challengeToken,
        code: totpNow(enroll.body.secret),
      });
      expect(replay.status).toBe(400);
    });

    it("accepts a recovery code exactly once", async () => {
      const client = new TestClient(ctx.url);
      const { username, password } = await registerWithEmail(client, `mfa-recovery-${Date.now()}@example.test`);
      const enroll = await client.post<{ secret: string }>("/api/auth/2fa/enroll", { password });
      const activate = await client.post<{ recoveryCodes: string[] }>("/api/auth/2fa/activate", {
        code: totpNow(enroll.body.secret),
      });
      const recoveryCode = activate.body.recoveryCodes[0]!;

      async function loginWithRecovery() {
        const c = new TestClient(ctx.url);
        const login = await c.post<{ challengeToken: string }>("/api/auth/login", { username, password });
        const res = await c.post("/api/auth/login/2fa", {
          challengeToken: login.body.challengeToken,
          recoveryCode,
        });
        return { status: res.status, client: c, csrfToken: (res.body as { csrfToken?: string }).csrfToken };
      }

      const first = await loginWithRecovery();
      expect(first.status).toBe(200);
      if (first.csrfToken) first.client.csrfToken = first.csrfToken;

      // The same code is now exhausted.
      const replay = await loginWithRecovery();
      expect(replay.status).toBe(400);
    });

    it("cannot be disabled without reauthentication and a valid factor", async () => {
      const client = new TestClient(ctx.url);
      const { password } = await registerWithEmail(client, `mfa-disable-${Date.now()}@example.test`);
      const enroll = await client.post<{ secret: string }>("/api/auth/2fa/enroll", { password });
      await client.post("/api/auth/2fa/activate", { code: totpNow(enroll.body.secret) });

      // Wrong password refused.
      expect(
        (
          await client.post("/api/auth/2fa/disable", {
            password: "nope",
            code: totpNow(enroll.body.secret),
          })
        ).status,
      ).toBe(401);

      // Wrong factor refused.
      expect(
        (await client.post("/api/auth/2fa/disable", { password, code: "000000" })).status,
      ).toBe(400);

      // Correct password + code disables it.
      const disabled = await client.post("/api/auth/2fa/disable", {
        password,
        code: totpNow(enroll.body.secret),
      });
      expect(disabled.status).toBe(200);
      expect((await client.get<{ user: { mfaEnabled: boolean } }>("/api/auth/me")).body.user.mfaEnabled).toBe(false);
    });

    it("rejects enrolling when 2FA is already enabled", async () => {
      const client = new TestClient(ctx.url);
      const { password } = await registerWithEmail(client, `mfa-dup-${Date.now()}@example.test`);
      const enroll = await client.post<{ secret: string }>("/api/auth/2fa/enroll", { password });
      await client.post("/api/auth/2fa/activate", { code: totpNow(enroll.body.secret) });
      const again = await client.post("/api/auth/2fa/enroll", { password });
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ error: { code: "MFA_ALREADY_ENABLED" } });
    });
  });

  describe("session revocation across HTTP and realtime", () => {
    it("drops the live socket and the HTTP session when a session is revoked", async () => {
      const client = new TestClient(ctx.url);
      const { username, password } = await registerWithEmail(client, `sess-${Date.now()}@example.test`);
      const other = new TestClient(ctx.url);
      await other.login(username, password);

      const socket = await client.socket();
      const revoked = waitFor(socket, "SESSION_REVOKED");
      const disconnected = new Promise<void>((resolve) => socket.once("disconnect", () => resolve()));

      // Find and revoke this client's session from the other device.
      const sessions = await other.get<{ sessions: Array<{ id: string; current: boolean }> }>("/api/auth/sessions");
      const target = sessions.body.sessions.find((s) => !s.current);
      expect(target).toBeDefined();
      const res = await other.del(`/api/auth/sessions/${target!.id}`);
      expect(res.status).toBe(204);

      await revoked;
      await disconnected;
      expect((await client.get("/api/auth/me")).body).toMatchObject({ user: null });
    });
  });
});
