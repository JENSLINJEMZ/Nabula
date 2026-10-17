import { z } from "zod";
import { Errors, Limits } from "@nebula/shared";
import type { FastifyInstance } from "fastify";
import { execute } from "../../db/pool.js";
import { getOrCreateDmChannel, listDmChannels, createGroupDm, listDmRecipients } from "../../domain/channels.js";
import {
  getNotificationSettings,
  getUserSettings,
  updateNotificationSettings,
  updateUserSettings,
} from "../../domain/notifications.js";
import {
  acceptFriendRequest,
  blockUser,
  listRelationships,
  removeRelationship,
  sendFriendRequest,
  unblockUser,
} from "../../domain/relationships.js";
import { createReport } from "../../domain/moderation.js";
import {
  getPresenceMap,
  getUserById,
  getUserPresence,
  searchUsers,
  setPresence,
  toPublicUser,
  updateProfile,
} from "../../domain/users.js";
import { currentUserId, requireAuth } from "../auth.js";

const IdSchema = z.object({ id: z.string().regex(/^\d{1,20}$/) });

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/api/users/@me", async (request, reply) => {
    const userId = currentUserId(request);
    const row = await getUserById(userId);
    if (!row) throw Errors.UNKNOWN_USER();
    const presence = await getUserPresence(userId);
    return reply.send({ user: toPublicUser(row), presence });
  });

  app.patch("/api/users/@me", async (request, reply) => {
    const userId = currentUserId(request);
    const body = z
      .object({
        displayName: z.string().max(Limits.DISPLAY_NAME_MAX).nullable().optional(),
        bio: z.string().max(190).nullable().optional(),
        accentColor: z.number().int().min(0).max(0xffffff).nullable().optional(),
        email: z.string().email().max(254).nullable().optional(),
      })
      .strict()
      .parse(request.body);

    const row = await updateProfile(userId, body);
    return reply.send({ user: toPublicUser(row) });
  });

  app.get("/api/users/search", async (request, reply) => {
    const viewerId = currentUserId(request);
    const { q } = z.object({ q: z.string().min(1).max(50) }).parse(request.query);
    const rows = await searchUsers(q, viewerId, 10);
    return reply.send({ users: rows.map(toPublicUser) });
  });

  app.get("/api/users/:id", async (request, reply) => {
    const { id } = IdSchema.parse(request.params);
    const row = await getUserById(id);
    if (!row) throw Errors.UNKNOWN_USER();
    const viewerId = currentUserId(request);
    const presenceMap = await getPresenceMap([id]);
    // Presence is only exposed to users who share a guild or are friends; for
    // simplicity we expose status but never private fields.
    void viewerId;
    return reply.send({ user: toPublicUser(row), presence: presenceMap.get(id) ?? null });
  });

  app.get("/api/users/@me/settings", async (request, reply) => {
    const userId = currentUserId(request);
    return reply.send({ settings: await getUserSettings(userId) });
  });

  app.patch("/api/users/@me/settings", async (request, reply) => {
    const userId = currentUserId(request);
    const body = z
      .object({
        theme: z.enum(["dark", "light"]).optional(),
        messageDisplay: z.enum(["cozy", "compact"]).optional(),
        reducedMotion: z.boolean().optional(),
        fontScale: z.number().min(0.8).max(1.5).optional(),
        locale: z.string().min(2).max(20).optional(),
      })
      .strict()
      .parse(request.body);
    return reply.send({ settings: await updateUserSettings(userId, body) });
  });

  app.get("/api/users/@me/notification-settings", async (request, reply) => {
    const userId = currentUserId(request);
    return reply.send({ settings: await getNotificationSettings(userId) });
  });

  app.patch("/api/users/@me/notification-settings", async (request, reply) => {
    const userId = currentUserId(request);
    const body = z
      .object({
        desktop: z.boolean().optional(),
        sounds: z.boolean().optional(),
        suppressEveryone: z.boolean().optional(),
        suppressRoles: z.boolean().optional(),
        suppressFromOthers: z.boolean().optional(),
      })
      .strict()
      .parse(request.body);
    return reply.send({ settings: await updateNotificationSettings(userId, body) });
  });

  app.put("/api/users/@me/presence", async (request, reply) => {
    const userId = currentUserId(request);
    const body = z
      .object({
        status: z.enum(["online", "idle", "dnd", "offline"]),
        customStatus: z.string().max(128).nullable().optional(),
        activities: z.array(z.record(z.unknown())).max(5).optional(),
      })
      .strict()
      .parse(request.body);
    await setPresence(userId, body.status, body.customStatus ?? null, body.activities ?? []);
    const presence = await getUserPresence(userId);
    const { bus } = await import("../../realtime/bus.js");
    const { ServerEvents } = await import("@nebula/shared");
    bus().toUser(userId, ServerEvents.PRESENCE_UPDATE, presence);
    return reply.send({ presence });
  });

  // ---- Relationships (friends / blocks) ----

  app.get("/api/users/@me/relationships", async (request, reply) => {
    const userId = currentUserId(request);
    return reply.send({ relationships: await listRelationships(userId) });
  });

  app.post("/api/users/@me/relationships", async (request, reply) => {
    const userId = currentUserId(request);
    const body = z.object({ userId: z.string().regex(/^\d{1,20}$/) }).parse(request.body);
    const result = await sendFriendRequest(userId, body.userId);
    return reply.status(result === "accepted" ? 200 : 201).send({ result });
  });

  app.put("/api/users/@me/relationships/:id", async (request, reply) => {
    const userId = currentUserId(request);
    const { id } = IdSchema.parse(request.params);
    await acceptFriendRequest(userId, id);
    return reply.status(204).send();
  });

  app.delete("/api/users/@me/relationships/:id", async (request, reply) => {
    const userId = currentUserId(request);
    const { id } = IdSchema.parse(request.params);
    await removeRelationship(userId, id);
    return reply.status(204).send();
  });

  app.put("/api/users/@me/relationships/:id/block", async (request, reply) => {
    const userId = currentUserId(request);
    const { id } = IdSchema.parse(request.params);
    await blockUser(userId, id);
    return reply.status(204).send();
  });

  app.delete("/api/users/@me/relationships/:id/block", async (request, reply) => {
    const userId = currentUserId(request);
    const { id } = IdSchema.parse(request.params);
    await unblockUser(userId, id);
    return reply.status(204).send();
  });

  // ---- Direct messages ----

  app.get("/api/users/@me/channels", async (request, reply) => {
    const userId = currentUserId(request);
    return reply.send({ channels: await listDmChannels(userId) });
  });

  app.post("/api/users/@me/channels", async (request, reply) => {
    const userId = currentUserId(request);
    const body = z
      .object({
        recipientId: z.string().regex(/^\d{1,20}$/).optional(),
        recipients: z.array(z.string().regex(/^\d{1,20}$/)).max(9).optional(),
      })
      .parse(request.body);

    if (body.recipients && body.recipients.length > 0) {
      const channel = await createGroupDm(userId, body.recipients);
      const recipients = await listDmRecipients(channel.id);
      return reply.status(201).send({ channel: { ...channel, recipients } });
    }
    if (!body.recipientId) throw Errors.VALIDATION_FAILED(undefined, "recipientId or recipients is required.");

    const channel = await getOrCreateDmChannel(userId, body.recipientId);
    const recipients = await listDmRecipients(channel.id);
    return reply.status(201).send({ channel: { ...channel, recipients } });
  });

  app.post("/api/reports", async (request, reply) => {
    const userId = currentUserId(request);
    const body = z
      .object({
        targetUserId: z.string().regex(/^\d{1,20}$/).optional(),
        guildId: z.string().regex(/^\d{1,20}$/).optional(),
        messageId: z.string().regex(/^\d{1,20}$/).optional(),
        category: z.string().min(1).max(32),
        reason: z.string().max(1000).optional(),
      })
      .parse(request.body);
    await createReport({ reporterId: userId, ...body });
    return reply.status(204).send();
  });

  app.get("/api/users/:id/presence", async (request, reply) => {
    const { id } = IdSchema.parse(request.params);
    const presence = await getUserPresence(id);
    return reply.send({ presence });
  });

  app.get("/api/health/db", async (_request, reply) => {
    const row = await execute("SELECT 1");
    return reply.send({ ok: row === 0 || row >= 0 });
  });
}
