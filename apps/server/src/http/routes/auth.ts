import { z } from "zod";
import { Errors, Limits, validatePassword } from "@nebula/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyPassword } from "../../auth/passwords.js";
import {
  createSession,
  listSessionsForUser,
  revokeAllSessionsForUser,
  revokeSession,
} from "../../auth/sessions.js";
import { execute, queryOne } from "../../db/pool.js";
import { setPresence } from "../../domain/users.js";
import { getCredentials, createUser, getSelfUser } from "../../domain/users.js";
import { smtpConfigured } from "../../config.js";
import { MailNotConfiguredError } from "../../mail/mailer.js";
import { requireAuth, currentUserId } from "../auth.js";
import { clearSessionCookies, setSessionCookies } from "../cookies.js";
import { disconnectSession, disconnectUserSessions } from "../../realtime/sessionSockets.js";
import {
  activateMfa,
  cancelMfaEnrollment,
  changePassword,
  countUnusedRecoveryCodes,
  createMfaChallenge,
  consumeMfaChallenge,
  disableMfa,
  regenerateRecoveryCodes,
  requestPasswordReset,
  resetPasswordWithToken,
  revokeOtherSessions,
  sendVerificationEmail,
  startMfaEnrollment,
  verifyEmailWithToken,
} from "../../domain/accountSecurity.js";

const RegisterSchema = z.object({
  username: z.string().min(Limits.USERNAME_MIN).max(Limits.USERNAME_MAX),
  password: z.string().min(Limits.PASSWORD_MIN).max(Limits.PASSWORD_MAX),
  email: z.string().email().max(254).optional().nullable(),
  displayName: z.string().min(1).max(Limits.DISPLAY_NAME_MAX).optional().nullable(),
  inviteCode: z.string().min(1).max(32).optional().nullable(),
});

const LoginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(Limits.PASSWORD_MAX),
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/auth/register",
    // Mass-registration limiter; generous enough for legitimate signups.
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (request, reply) => {
    const body = RegisterSchema.parse(request.body);
    const passwordCheck = validatePassword(body.password);
    if (!passwordCheck.ok) throw Errors.VALIDATION_FAILED({ field: "password" }, passwordCheck.reason);

    const user = await createUser({
      username: body.username,
      password: body.password,
      email: body.email ?? null,
      displayName: body.displayName ?? null,
    });

    // Optional: auto-join a guild via invite code supplied at registration.
    if (body.inviteCode) {
      try {
        const { acceptInvite } = await import("../../domain/invites.js");
        await acceptInvite(body.inviteCode, user.id);
      } catch {
        // A bad invite code must not fail registration.
      }
    }

    const session = await createSession({
      userId: user.id,
      ip: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
      clientName: "web",
    });
    setSessionCookies(reply, session);
    await setPresence(user.id, "online", null);

    // Best-effort verification email at signup; failure never blocks signup
    // (the user can resend from settings).
    if (user.email) {
      try {
        await sendVerificationEmail(user.id, user.email, {
          ip: request.ip,
          userAgent: request.headers["user-agent"] ?? null,
        });
      } catch {
        // SMTP unavailable — surfaced to the user via the settings screen.
      }
    }

    const self = await getSelfUser(user.id);
    return reply.status(201).send({ user: self, csrfToken: session.csrfToken });
  });

  app.post(
    "/api/auth/login",
    // A tight per-IP limit blunts credential stuffing without harming normal use.
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = LoginSchema.parse(request.body);
      const record = await getCredentials(body.username);

      // Always run a hash comparison to keep timing uniform, even for unknown users.
      const passwordOk = record
        ? await verifyPassword(body.password, { hash: record.password_hash, salt: record.password_salt })
        : false;
      if (!record || !passwordOk) throw Errors.INVALID_CREDENTIALS();
      if (record.disabled) throw Errors.ACCOUNT_SUSPENDED(undefined, "This account has been suspended.");

      // 2FA: when enabled, the password is only the first factor. Issue a
      // short-lived challenge instead of a session; the client exchanges a
      // valid TOTP code (or recovery code) for the real session.
      const mfa = await queryOne<{ mfa_enabled: boolean }>(
        `SELECT mfa_enabled FROM users WHERE id = $1`,
        [record.id],
      );
      if (mfa?.mfa_enabled) {
        const challengeToken = await createMfaChallenge(record.id);
        return reply.status(200).send({ mfaRequired: true, challengeToken });
      }

      const session = await createSession({
        userId: record.id,
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
        clientName: "web",
      });
      setSessionCookies(reply, session);
      await setPresence(record.id, "online", null);

      const self = await getSelfUser(record.id);
      return reply.send({ user: self, csrfToken: session.csrfToken });
    },
  );

  app.post("/api/auth/logout", { preHandler: requireAuth }, async (request, reply) => {
    if (request.auth) await revokeSession(request.auth.session.id);
    clearSessionCookies(reply);
    return reply.status(204).send();
  });

  app.get("/api/auth/me", async (request, reply) => {
    if (!request.auth) return reply.status(200).send({ user: null });
    const self = await getSelfUser(request.auth.userId);
    return reply.send({ user: self, sessionId: request.auth.session.id });
  });

  app.get("/api/auth/sessions", { preHandler: requireAuth }, async (request, reply) => {
    const userId = currentUserId(request);
    const sessions = await listSessionsForUser(userId, request.auth!.session.id);
    return reply.send({ sessions });
  });

  app.delete("/api/auth/sessions/:id", { preHandler: requireAuth }, async (request, reply) => {
    const userId = currentUserId(request);
    const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(request.params);
    const owned = await execute(
      `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [id, userId],
    );
    if (owned === 0) throw Errors.NOT_FOUND(undefined, "Unknown session.");
    // Kill any live realtime connection bound to the revoked session.
    await disconnectSession(id);
    return reply.status(204).send();
  });

  app.post("/api/auth/logout-all", { preHandler: requireAuth }, async (request, reply) => {
    const userId = currentUserId(request);
    await revokeAllSessionsForUser(userId);
    await disconnectUserSessions(userId);
    clearSessionCookies(reply);
    return reply.status(204).send();
  });

  // -------------------------------------------------------------------------
  // Milestone 1 — account security
  // -------------------------------------------------------------------------

  /** Complete a login once the second factor has been verified. */
  async function issueSession(request: FastifyRequest, reply: FastifyReply, userId: string) {
    const session = await createSession({
      userId,
      ip: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
      clientName: "web",
    });
    setSessionCookies(reply, session);
    await setPresence(userId, "online", null);
    const self = await getSelfUser(userId);
    return { user: self, csrfToken: session.csrfToken };
  }

  // ---- Change password ----

  app.post(
    "/api/auth/password/change",
    {
      preHandler: requireAuth,
      // Guards against online password brute-forcing via this endpoint.
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const userId = currentUserId(request);
      const body = z
        .object({
          currentPassword: z.string().min(1).max(Limits.PASSWORD_MAX),
          newPassword: z.string().min(Limits.PASSWORD_MIN).max(Limits.PASSWORD_MAX),
        })
        .parse(request.body);

      const meta = { ip: request.ip, userAgent: request.headers["user-agent"] ?? null };
      const { revokedSessions } = await changePassword(
        userId,
        body.currentPassword,
        body.newPassword,
        request.auth!.session.id,
        meta,
      );
      return reply.send({ ok: true, revokedSessions });
    },
  );

  // ---- Email verification ----

  app.post(
    "/api/auth/email/verify-request",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 3, timeWindow: "5 minutes" } },
    },
    async (request, reply) => {
      const userId = currentUserId(request);
      const row = await queryOne<{ email: string | null; email_verified: boolean }>(
        `SELECT email, email_verified FROM users WHERE id = $1`,
        [userId],
      );
      if (!row?.email) throw Errors.EMAIL_NOT_SET();
      if (row.email_verified) {
        throw Errors.CONFLICT(undefined, "This email address is already verified.");
      }
      if (!smtpConfigured && process.env.NODE_ENV === "production") throw Errors.MAIL_NOT_CONFIGURED();
      await sendVerificationEmail(userId, row.email, {
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });
      return reply.status(202).send({ ok: true });
    },
  );

  app.post(
    "/api/auth/email/verify",
    // The link arrives by email; the user may open it while signed out.
    { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      const body = z.object({ token: z.string().min(1).max(256) }).parse(request.body);
      await verifyEmailWithToken(body.token, {
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });
      // If the user is signed in, refresh their cached self so the UI updates.
      if (request.auth) {
        const self = await getSelfUser(request.auth.userId);
        return reply.send({ ok: true, user: self });
      }
      return reply.send({ ok: true });
    },
  );

  // ---- Forgot / reset password ----

  app.post(
    "/api/auth/password/forgot",
    {
      // IP-scoped limiter blunts email-bombing and enumeration sweeps.
      config: { rateLimit: { max: 5, timeWindow: "10 minutes" } },
    },
    async (request, reply) => {
      const body = z.object({ email: z.string().email().max(254) }).parse(request.body);
      if (!smtpConfigured && process.env.NODE_ENV === "production") throw Errors.MAIL_NOT_CONFIGURED();
      try {
        await requestPasswordReset(body.email, {
          ip: request.ip,
          userAgent: request.headers["user-agent"] ?? null,
        });
      } catch (error) {
        if (error instanceof MailNotConfiguredError) throw Errors.MAIL_NOT_CONFIGURED();
        throw error;
      }
      // Anti-enumeration: the same generic answer whether or not the address
      // has an account.
      return reply.status(202).send({
        ok: true,
        message: "If an account exists for that address, a reset link has been sent.",
      });
    },
  );

  app.post(
    "/api/auth/password/reset",
    { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      const body = z
        .object({
          token: z.string().min(1).max(256),
          newPassword: z.string().min(Limits.PASSWORD_MIN).max(Limits.PASSWORD_MAX),
        })
        .parse(request.body);
      const { userId } = await resetPasswordWithToken(body.token, body.newPassword, {
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });
      // Every pre-existing session was revoked; if the caller held one, drop it.
      if (request.auth?.userId === userId) clearSessionCookies(reply);
      return reply.send({ ok: true });
    },
  );

  // ---- Two-factor authentication (TOTP) ----

  app.post(
    "/api/auth/2fa/enroll",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 10, timeWindow: "5 minutes" } },
    },
    async (request, reply) => {
      const userId = currentUserId(request);
      const body = z.object({ password: z.string().min(1).max(Limits.PASSWORD_MAX) }).parse(request.body);
      const result = await startMfaEnrollment(userId, body.password, {
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });
      // The otpauth URI doubles as the manual setup key path; the raw Base32
      // secret is included for authenticator apps that want to paste it.
      return reply.send(result);
    },
  );

  app.post(
    "/api/auth/2fa/enroll/cancel",
    { preHandler: requireAuth },
    async (request, reply) => {
      await cancelMfaEnrollment(currentUserId(request));
      return reply.status(204).send();
    },
  );

  app.post(
    "/api/auth/2fa/activate",
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = currentUserId(request);
      const body = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(request.body);
      const { recoveryCodes } = await activateMfa(userId, body.code, {
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });
      // Enabling 2FA is a sensitive event: keep the current session but drop
      // any others so a hijacked session cannot outlive the hardening.
      await revokeOtherSessions(userId, request.auth!.session.id);
      return reply.send({ ok: true, recoveryCodes });
    },
  );

  app.post(
    "/api/auth/2fa/disable",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 10, timeWindow: "5 minutes" } },
    },
    async (request, reply) => {
      const userId = currentUserId(request);
      const body = z
        .object({
          password: z.string().min(1).max(Limits.PASSWORD_MAX),
          code: z.string().regex(/^\d{6}$/).optional(),
          recoveryCode: z.string().min(8).max(32).optional(),
        })
        .refine((b) => b.code !== undefined || b.recoveryCode !== undefined, {
          message: "Provide a TOTP code or a recovery code.",
        })
        .parse(request.body);
      await disableMfa(userId, body.password, { code: body.code, recoveryCode: body.recoveryCode }, {
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });
      return reply.send({ ok: true });
    },
  );

  app.post(
    "/api/auth/2fa/recovery-codes",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 5, timeWindow: "5 minutes" } },
    },
    async (request, reply) => {
      const userId = currentUserId(request);
      const body = z
        .object({
          password: z.string().min(1).max(Limits.PASSWORD_MAX),
          code: z.string().regex(/^\d{6}$/).optional(),
          recoveryCode: z.string().min(8).max(32).optional(),
        })
        .refine((b) => b.code !== undefined || b.recoveryCode !== undefined, {
          message: "Provide a TOTP code or a recovery code.",
        })
        .parse(request.body);
      const recoveryCodes = await regenerateRecoveryCodes(
        userId,
        body.password,
        { code: body.code, recoveryCode: body.recoveryCode },
        { ip: request.ip, userAgent: request.headers["user-agent"] ?? null },
      );
      return reply.send({ recoveryCodes });
    },
  );

  /** Current account-security state for the settings UI. */
  app.get("/api/auth/2fa", { preHandler: requireAuth }, async (request, reply) => {
    const userId = currentUserId(request);
    const row = await queryOne<{ mfa_enabled: boolean }>(
      `SELECT mfa_enabled FROM users WHERE id = $1`,
      [userId],
    );
    const recoveryCodesRemaining = row?.mfa_enabled ? await countUnusedRecoveryCodes(userId) : 0;
    return reply.send({ mfaEnabled: row?.mfa_enabled ?? false, recoveryCodesRemaining });
  });

  // ---- Second-factor login ----

  app.post(
    "/api/auth/login/2fa",
    // Tight limit: this is the brute-force surface for stolen passwords.
    { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      const body = z
        .object({
          challengeToken: z.string().min(16).max(256),
          code: z.string().regex(/^\d{6}$/).optional(),
          recoveryCode: z.string().min(8).max(32).optional(),
        })
        .refine((b) => b.code !== undefined || b.recoveryCode !== undefined, {
          message: "Provide a TOTP code or a recovery code.",
        })
        .parse(request.body);

      const result = await consumeMfaChallenge(
        body.challengeToken,
        { code: body.code, recoveryCode: body.recoveryCode },
        { ip: request.ip, userAgent: request.headers["user-agent"] ?? null },
      );
      if (!result) throw Errors.INVALID_MFA_CODE(undefined, "That code is not valid or has expired.");

      const session = await issueSession(request, reply, result.userId);
      return reply.send({
        user: session.user,
        csrfToken: session.csrfToken,
        usedRecoveryCode: result.usedRecoveryCode,
      });
    },
  );
}
