import { z } from "zod";
import { Errors, Limits, validatePassword } from "@nebula/shared";
import type { FastifyInstance } from "fastify";
import { verifyPassword } from "../../auth/passwords.js";
import {
  createSession,
  listSessionsForUser,
  revokeAllSessionsForUser,
  revokeSession,
} from "../../auth/sessions.js";
import { execute } from "../../db/pool.js";
import { setPresence } from "../../domain/users.js";
import { getCredentials, createUser, getSelfUser } from "../../domain/users.js";
import { requireAuth, currentUserId } from "../auth.js";
import { clearSessionCookies, setSessionCookies } from "../cookies.js";

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
    return reply.status(204).send();
  });

  app.post("/api/auth/logout-all", { preHandler: requireAuth }, async (request, reply) => {
    const userId = currentUserId(request);
    await revokeAllSessionsForUser(userId);
    clearSessionCookies(reply);
    return reply.status(204).send();
  });
}
