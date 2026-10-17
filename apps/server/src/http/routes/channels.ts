import { z } from "zod";
import { ChannelType, Errors, Limits, deserializePermissions } from "@nebula/shared";
import type { FastifyInstance } from "fastify";
import {
  closeDmChannel,
  deleteChannel,
  deleteChannelOverwrite,
  getChannelView,
  listChannelOverwrites,
  updateChannel,
  upsertChannelOverwrite,
} from "../../domain/channels.js";
import {
  archiveThread,
  createThread,
  getThreadMembers,
  joinThread,
  leaveThread,
  listThreadsForChannel,
} from "../../domain/threads.js";
import { addReaction, listPinnedMessages, markChannelRead, removeReaction } from "../../domain/messages.js";
import { bus } from "../../realtime/bus.js";
import { ServerEvents } from "@nebula/shared";
import { currentUserId, requireAuth } from "../auth.js";

const Id = z.string().regex(/^\d{1,20}$/);
const IdSchema = z.object({ id: Id });

export async function registerChannelRoutes(app: FastifyInstance): Promise<void> {
  app.register(async (authed) => {
    authed.addHook("preHandler", requireAuth);

    authed.get("/api/channels/:id", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      const channel = await getChannelView(id, currentUserId(request));
      if (!channel) throw Errors.CHANNEL_NOT_ACCESSIBLE();
      return reply.send({ channel });
    });

    authed.patch("/api/channels/:id", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      const body = z
        .object({
          name: z.string().min(1).max(Limits.CHANNEL_NAME_MAX).optional(),
          topic: z.string().max(Limits.CHANNEL_TOPIC_MAX).nullable().optional(),
          nsfw: z.boolean().optional(),
          rateLimitPerUser: z.number().int().min(0).max(Limits.SLOWMODE_MAX_SECONDS).optional(),
          bitrate: z.number().int().optional(),
          userLimit: z.number().int().min(0).max(Limits.VOICE_USER_LIMIT_MAX).optional(),
          parentId: Id.nullable().optional(),
          position: z.number().int().optional(),
        })
        .strict()
        .parse(request.body);

      const { requireChannelRow } = await import("../../domain/channels.js");
      const existing = await requireChannelRow(id);
      if (!existing.guild_id) {
        if (existing.type === ChannelType.GROUP_DM) {
          await closeDmChannel(id, currentUserId(request));
          return reply.status(204).send();
        }
        throw Errors.UNKNOWN_CHANNEL();
      }
      const row = await updateChannel(existing.guild_id, id, currentUserId(request), body);
      const view = await getChannelView(id, currentUserId(request));
      bus().toGuild(existing.guild_id, ServerEvents.CHANNEL_UPDATE, view);
      return reply.send({ channel: view ?? row });
    });

    authed.delete("/api/channels/:id", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      const { requireChannelRow } = await import("../../domain/channels.js");
      const existing = await requireChannelRow(id);
      if (!existing.guild_id) throw Errors.UNKNOWN_CHANNEL();
      await deleteChannel(existing.guild_id, id, currentUserId(request));
      bus().toGuild(existing.guild_id, ServerEvents.CHANNEL_DELETE, { id, guildId: existing.guild_id });
      return reply.status(204).send();
    });

    authed.get("/api/channels/:id/overwrites", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      await getChannelView(id, currentUserId(request));
      return reply.send({ overwrites: await listChannelOverwrites(id) });
    });

    authed.put("/api/channels/:id/permissions/:targetId", async (request, reply) => {
      const { id, targetId } = z.object({ id: Id, targetId: Id }).parse(request.params);
      const body = z
        .object({
          type: z.union([z.literal(0), z.literal(1)]),
          allow: z.string().regex(/^\d+$/),
          deny: z.string().regex(/^\d+$/),
        })
        .parse(request.body);
      const { requireChannelRow } = await import("../../domain/channels.js");
      const channel = await requireChannelRow(id);
      if (!channel.guild_id) throw Errors.UNKNOWN_CHANNEL();
      await upsertChannelOverwrite(channel.guild_id, id, currentUserId(request), {
        targetId,
        type: body.type,
        allow: deserializePermissions(body.allow),
        deny: deserializePermissions(body.deny),
      });
      return reply.status(204).send();
    });

    authed.delete("/api/channels/:id/permissions/:targetId", async (request, reply) => {
      const { id, targetId } = z.object({ id: Id, targetId: Id }).parse(request.params);
      const { requireChannelRow } = await import("../../domain/channels.js");
      const channel = await requireChannelRow(id);
      if (!channel.guild_id) throw Errors.UNKNOWN_CHANNEL();
      await deleteChannelOverwrite(channel.guild_id, id, targetId, currentUserId(request));
      return reply.status(204).send();
    });

    // ---- Threads ----
    authed.get("/api/channels/:id/threads", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      return reply.send({ threads: await listThreadsForChannel(id, currentUserId(request)) });
    });

    authed.post("/api/channels/:id/threads", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      const body = z
        .object({
          name: z.string().min(1).max(Limits.CHANNEL_NAME_MAX),
          type: z.union([z.literal(11), z.literal(12)]).optional(),
          messageId: Id.nullable().optional(),
          autoArchiveDuration: z.union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)]).optional(),
        })
        .parse(request.body);
      const thread = await createThread(id, currentUserId(request), {
        name: body.name,
        type: body.type as 11 | 12 | undefined,
        messageId: body.messageId ?? null,
        autoArchiveDuration: body.autoArchiveDuration,
      });
      return reply.status(201).send({ thread });
    });

    authed.patch("/api/channels/:id/threads/:threadId", async (request, reply) => {
      const { threadId } = z.object({ id: Id, threadId: Id }).parse(request.params);
      const body = z.object({ archived: z.boolean() }).parse(request.body);
      const channel = await archiveThread(threadId, currentUserId(request), body.archived);
      return reply.send({ thread: channel });
    });

    authed.put("/api/channels/:id/thread-members/@me", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      await joinThread(id, currentUserId(request));
      return reply.status(204).send();
    });

    authed.delete("/api/channels/:id/thread-members/@me", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      await leaveThread(id, currentUserId(request));
      return reply.status(204).send();
    });

    authed.get("/api/channels/:id/thread-members", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      await getChannelView(id, currentUserId(request));
      return reply.send({ members: await getThreadMembers(id) });
    });

    // ---- Typing (transient; never persisted) ----
    authed.post("/api/channels/:id/typing", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      const userId = currentUserId(request);
      const channel = await getChannelView(id, userId);
      if (!channel) throw Errors.CHANNEL_NOT_ACCESSIBLE();
      if (channel.guildId) {
        bus().toGuild(channel.guildId, ServerEvents.TYPING_START, { channelId: id, userId, at: Date.now() });
      } else {
        bus().toChannel(id, ServerEvents.TYPING_START, { channelId: id, userId, at: Date.now() });
      }
      return reply.status(204).send();
    });

    // ---- Pins & read state ----
    authed.get("/api/channels/:id/pins", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      return reply.send({ messages: await listPinnedMessages(id, currentUserId(request)) });
    });

    authed.post("/api/channels/:id/ack", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      const body = z.object({ messageId: Id.nullable().optional() }).optional().parse(request.body ?? {});
      const state = await markChannelRead(id, currentUserId(request), body?.messageId ?? null);
      return reply.send(state);
    });

    authed.put("/api/channels/:id/messages/:messageId/reactions/:emoji/@me", async (request, reply) => {
      const { messageId, emoji } = z
        .object({ id: Id, messageId: Id, emoji: z.string().min(1).max(128) })
        .parse(request.params);
      await addReaction(messageId, currentUserId(request), decodeURIComponent(emoji));
      return reply.status(204).send();
    });

    authed.delete("/api/channels/:id/messages/:messageId/reactions/:emoji/@me", async (request, reply) => {
      const { messageId, emoji } = z
        .object({ id: Id, messageId: Id, emoji: z.string().min(1).max(128) })
        .parse(request.params);
      await removeReaction(messageId, currentUserId(request), decodeURIComponent(emoji));
      return reply.status(204).send();
    });
  });
}
