import { z } from "zod";
import { Errors, Limits, Permissions, ServerEvents } from "@nebula/shared";
import type { FastifyInstance } from "fastify";
import { env } from "../../config.js";
import {
  getAttachmentRow,
  readKeyedBlob,
  readAttachmentBytes,
  saveAttachment,
  saveKeyedBlob,
  sniffMimeType,
} from "../../domain/storage.js";
import { assertChannelAccess } from "../../domain/permissions.js";
import { updateProfile, getUserById, toPublicUser } from "../../domain/users.js";
import {
  createWebhook,
  deleteWebhook,
  executeWebhook,
  listChannelWebhooks,
  listWebhookDeliveries,
  rotateWebhookToken,
  testWebhook,
  updateWebhook,
} from "../../domain/webhooks.js";
import { emitInteractionResult, invokeCommand, listCommands, parseCommandContent } from "../../domain/slashCommands.js";
import { listNotifications, markNotificationsRead, unreadNotificationCount } from "../../domain/notifications.js";
import { joinVoiceChannel, leaveVoice, updateVoiceState } from "../../domain/voice.js";
import { requireChannelRow } from "../../domain/channels.js";
import { bus } from "../../realtime/bus.js";
import { currentUserId, requireAuth } from "../auth.js";

const Id = z.string().regex(/^\d{1,20}$/);
const IdSchema = z.object({ id: Id });

const ALLOWED_IMAGE_AVATAR = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function contentTypeForBuffer(buffer: Buffer): string {
  return sniffMimeType(buffer, null) ?? "application/octet-stream";
}

export async function registerMiscRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------ public
  // Webhook execution is authenticated by the token path segment, not a session.
  app.post("/api/webhooks/:webhookId/:token", async (request, reply) => {
    const { webhookId, token } = z
      .object({ webhookId: Id, token: z.string().min(20).max(200) })
      .parse(request.params);
    const body = z
      .object({
        content: z.string().max(Limits.MESSAGE_CONTENT_MAX).optional(),
        username: z.string().max(80).nullable().optional(),
        tts: z.boolean().optional(),
        embeds: z.array(z.unknown()).max(Limits.EMBEDS_MAX_PER_MESSAGE).optional(),
      })
      .strict()
      .parse(request.body ?? {});
    // Idempotency: a repeated key returns the original message instead of
    // posting a duplicate.
    const headerKey = request.headers["x-idempotency-key"];
    const idempotencyKey = typeof headerKey === "string" ? headerKey.slice(0, 128) : null;
    const result = await executeWebhook(webhookId, token, { ...body, idempotencyKey });
    return reply
      .status(result.duplicate ? 200 : 201)
      .send({ message: result.message, duplicate: result.duplicate });
  });

  app.get("/api/health", async (_request, reply) => {
    const { pingDatabase } = await import("../../db/pool.js");
    const { listVoiceStates } = await import("../../domain/voice.js");
    void listVoiceStates;
    const db = await pingDatabase();
    return reply.status(db ? 200 : 503).send({
      ok: db,
      storage: env.STORAGE_DRIVER,
      time: new Date().toISOString(),
    });
  });

  // Media is served through authorization-checked dynamic routes.
  app.get("/api/media/attachments/:id/:filename", async (request, reply) => {
    const { id } = IdSchema.parse(request.params);
    const userId = request.auth?.userId ?? null;

    const row = await getAttachmentRow(id);
    if (!row) throw Errors.NOT_FOUND(undefined, "Unknown attachment.");
    if (!row.channel_id) throw Errors.CHANNEL_NOT_ACCESSIBLE();
    if (!userId) throw Errors.UNAUTHENTICATED();
    await assertChannelAccess(row.channel_id, userId, Permissions.VIEW_CHANNEL);

    const buffer = await readAttachmentBytes(row);
    const type = row.content_type ?? contentTypeForBuffer(buffer);
    return reply
      .header("Content-Type", type)
      .header("Content-Length", String(buffer.length))
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, max-age=3600")
      .header("Content-Disposition", `inline; filename="${encodeURIComponent(row.filename)}"`)
      .send(buffer);
  });

  for (const prefix of ["avatars", "icons", "banners"] as const) {
    app.get(`/api/media/${prefix}/:key`, async (request, reply) => {
      const { key } = z.object({ key: z.string().min(1).max(300) }).parse(request.params);
      // Keys are stored either as `<prefix>/<name>` or as a bare `<name>`; accept
      // both so a caller cannot be tripped up by the storage convention.
      const storageKey = key.startsWith(`${prefix}/`) ? key : `${prefix}/${key}`;
      try {
        const buffer = await readKeyedBlob(storageKey);
        return reply
          .header("Content-Type", contentTypeForBuffer(buffer))
          .header("Content-Length", String(buffer.length))
          .header("X-Content-Type-Options", "nosniff")
          .header("Cache-Control", "public, max-age=86400, immutable")
          .send(buffer);
      } catch {
        throw Errors.NOT_FOUND(undefined, "Unknown media.");
      }
    });
  }

  app.register(async (authed) => {
    authed.addHook("preHandler", requireAuth);

    // ---------------------------------------------------------- attachments
    authed.post("/api/channels/:id/attachments", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      const userId = currentUserId(request);
      const channel = await requireChannelRow(id);
      const access = await assertChannelAccess(id, userId, Permissions.VIEW_CHANNEL);
      if (channel.guild_id && (access.permissions & Permissions.ATTACH_FILES) !== Permissions.ATTACH_FILES) {
        throw Errors.MISSING_PERMISSIONS({ permission: "ATTACH_FILES" });
      }

      const file = await request.file({ limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1 } });
      if (!file) throw Errors.VALIDATION_FAILED(undefined, "No file provided.");
      const buffer = await file.toBuffer();
      const isSpoiler = /^SPOILER_/.test(file.filename ?? "");

      const attachment = await saveAttachment({
        buffer,
        filename: file.filename ?? "file",
        declaredContentType: file.mimetype ?? null,
        uploaderId: userId,
        channelId: id,
        guildId: channel.guild_id,
        isSpoiler,
      });

      return reply.status(201).send({
        attachment: {
          id: attachment.id,
          filename: attachment.filename,
          contentType: attachment.content_type,
          size: Number(attachment.size_bytes),
          width: attachment.width,
          height: attachment.height,
          isSpoiler: attachment.is_spoiler,
          url: `/api/media/attachments/${attachment.id}/${encodeURIComponent(attachment.filename)}`,
        },
      });
    });

    // ---------------------------------------------------------- profile media
    authed.post("/api/users/@me/avatar", async (request, reply) => {
      const userId = currentUserId(request);
      const file = await request.file({ limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1 } });
      if (!file) throw Errors.VALIDATION_FAILED(undefined, "No file provided.");
      const buffer = await file.toBuffer();
      const type = sniffMimeType(buffer, file.mimetype ?? null);
      if (!type || !ALLOWED_IMAGE_AVATAR.has(type)) throw Errors.UNSUPPORTED_MEDIA_TYPE();
      const ext = type === "image/png" ? ".png" : type === "image/gif" ? ".gif" : type === "image/webp" ? ".webp" : ".jpg";
      const key = await saveKeyedBlob("avatars", buffer, ext);
      const row = await updateProfile(userId, { avatarKey: key });
      const self = toPublicUser(row);
      bus().toUser(userId, ServerEvents.PRESENCE_UPDATE, { userId, updatedAt: new Date().toISOString() });
      return reply.send({ user: self });
    });

    authed.post("/api/guilds/:id/icon", async (request, reply) => {
      const { id } = z.object({ id: Id }).parse(request.params);
      const userId = currentUserId(request);
      const { loadMemberContext } = await import("../../domain/permissions.js");
      const ctx = await loadMemberContext(id, userId);
      if ((ctx.basePermissions & Permissions.MANAGE_GUILD) !== Permissions.MANAGE_GUILD) {
        throw Errors.MISSING_PERMISSIONS({ permission: "MANAGE_GUILD" });
      }
      const file = await request.file({ limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1 } });
      if (!file) throw Errors.VALIDATION_FAILED(undefined, "No file provided.");
      const buffer = await file.toBuffer();
      const type = sniffMimeType(buffer, file.mimetype ?? null);
      if (!type || !ALLOWED_IMAGE_AVATAR.has(type)) throw Errors.UNSUPPORTED_MEDIA_TYPE();
      const ext = type === "image/png" ? ".png" : type === "image/gif" ? ".gif" : type === "image/webp" ? ".webp" : ".jpg";
      const key = await saveKeyedBlob("icons", buffer, ext);
      const { updateGuild } = await import("../../domain/guilds.js");
      const guild = await updateGuild(id, userId, { iconKey: key });
      return reply.send({ guild });
    });

    // ---------------------------------------------------------------- webhooks
    authed.get("/api/channels/:id/webhooks", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      const channel = await requireChannelRow(id);
      if (!channel.guild_id) throw Errors.UNKNOWN_CHANNEL();
      return reply.send({ webhooks: await listChannelWebhooks(channel.guild_id, id, currentUserId(request)) });
    });

    authed.post("/api/channels/:id/webhooks", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      const body = z.object({ name: z.string().min(1).max(80) }).parse(request.body);
      const channel = await requireChannelRow(id);
      if (!channel.guild_id) throw Errors.UNKNOWN_CHANNEL();
      const result = await createWebhook(channel.guild_id, id, currentUserId(request), body);
      return reply.status(201).send({
        webhook: { ...result.webhook, token_hash: undefined },
        token: result.token,
      });
    });

    authed.delete("/api/guilds/:id/webhooks/:webhookId", async (request, reply) => {
      const { id, webhookId } = z.object({ id: Id, webhookId: Id }).parse(request.params);
      await deleteWebhook(id, webhookId, currentUserId(request));
      return reply.status(204).send();
    });

    authed.patch("/api/guilds/:id/webhooks/:webhookId", async (request, reply) => {
      const { id, webhookId } = z.object({ id: Id, webhookId: Id }).parse(request.params);
      const body = z
        .object({ name: z.string().min(1).max(80).optional(), disabled: z.boolean().optional() })
        .strict()
        .parse(request.body ?? {});
      const webhook = await updateWebhook(id, webhookId, currentUserId(request), body);
      return reply.send({ webhook });
    });

    // Rotate the token: the new token is returned exactly once.
    authed.post("/api/guilds/:id/webhooks/:webhookId/rotate", async (request, reply) => {
      const { id, webhookId } = z.object({ id: Id, webhookId: Id }).parse(request.params);
      const result = await rotateWebhookToken(id, webhookId, currentUserId(request));
      return reply.send({ webhook: result.webhook, token: result.token });
    });

    // Permission-checked test delivery: verifies the destination without ever
    // revealing the stored token to the caller.
    authed.post("/api/guilds/:id/webhooks/:webhookId/execute", async (request, reply) => {
      const { id, webhookId } = z.object({ id: Id, webhookId: Id }).parse(request.params);
      const result = await testWebhook(id, webhookId, currentUserId(request));
      return reply.status(201).send({ message: result.message, duplicate: result.duplicate });
    });

    authed.get("/api/guilds/:id/webhooks/:webhookId/deliveries", async (request, reply) => {
      const { id, webhookId } = z.object({ id: Id, webhookId: Id }).parse(request.params);
      const query = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }).parse(request.query);
      const deliveries = await listWebhookDeliveries(id, webhookId, currentUserId(request), {
        limit: query.limit ?? 25,
      });
      return reply.send({ deliveries });
    });

    authed.post("/api/guilds/:id/webhooks/:webhookId/avatar", async (request, reply) => {
      const { id, webhookId } = z.object({ id: Id, webhookId: Id }).parse(request.params);
      const userId = currentUserId(request);
      const { loadMemberContext } = await import("../../domain/permissions.js");
      const ctx = await loadMemberContext(id, userId);
      if ((ctx.basePermissions & Permissions.MANAGE_WEBHOOKS) !== Permissions.MANAGE_WEBHOOKS) {
        throw Errors.MISSING_PERMISSIONS({ permission: "MANAGE_WEBHOOKS" });
      }
      const file = await request.file({ limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1 } });
      if (!file) throw Errors.VALIDATION_FAILED(undefined, "No file provided.");
      const buffer = await file.toBuffer();
      const type = sniffMimeType(buffer, file.mimetype ?? null);
      if (!type || !ALLOWED_IMAGE_AVATAR.has(type)) throw Errors.UNSUPPORTED_MEDIA_TYPE();
      const ext = type === "image/png" ? ".png" : type === "image/gif" ? ".gif" : type === "image/webp" ? ".webp" : ".jpg";
      const key = await saveKeyedBlob("avatars", buffer, ext);
      const webhook = await updateWebhook(id, webhookId, userId, { avatarKey: key });
      return reply.send({ webhook });
    });

    // ------------------------------------------------------------- commands
    authed.get("/api/commands", async (request, reply) => {
      const query = z.object({ guildId: Id.optional() }).parse(request.query);
      return reply.send({ commands: await listCommands(query.guildId ?? null) });
    });

    authed.post("/api/interactions", async (request, reply) => {
      const userId = currentUserId(request);
      const body = z
        .object({
          name: z.string().min(1).max(32).optional(),
          content: z.string().min(1).max(Limits.MESSAGE_CONTENT_MAX).optional(),
          channelId: Id,
          invocationId: z.string().max(64).optional(),
          args: z.record(z.union([z.string(), z.number()])).optional(),
        })
        .strict()
        .parse(request.body);

      // The raw command line is parsed server-side; a client may also submit
      // structured args (e.g. from the autocomplete UI). Either way the server
      // validates the arguments against the registry before executing.
      let name: string;
      let args: Record<string, string | number | undefined>;
      if (body.content !== undefined) {
        const parsed = parseCommandContent(body.content);
        name = parsed.name;
        args = parsed.args;
      } else if (body.name !== undefined) {
        name = body.name;
        args = body.args ?? {};
      } else {
        throw Errors.VALIDATION_FAILED({ field: "content" }, "Provide a command line or a command name.");
      }

      const result = await invokeCommand({
        name,
        args,
        channelId: body.channelId,
        userId,
        invocationId: body.invocationId,
      });
      if (result.ephemeral) emitInteractionResult(userId, result);
      return reply.send({ result });
    });

    // ---------------------------------------------------------- notifications
    authed.get("/api/users/@me/notifications", async (request, reply) => {
      const userId = currentUserId(request);
      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(100).optional(), before: Id.optional() })
        .parse(request.query);
      const [notifications, unread] = await Promise.all([
        listNotifications(userId, { limit: query.limit ?? 50, before: query.before ?? null }),
        unreadNotificationCount(userId),
      ]);
      return reply.send({ notifications, unread });
    });

    authed.post("/api/users/@me/notifications/ack", async (request, reply) => {
      const userId = currentUserId(request);
      const body = z.object({ ids: z.array(Id).max(500).optional() }).optional().parse(request.body ?? {});
      const updated = await markNotificationsRead(userId, body?.ids);
      return reply.send({ updated });
    });

    // ------------------------------------------------------------------ voice
    // Voice *media* is negotiated peer-to-peer over WebRTC; the server's job is
    // presence + signalling (see the gateway VOICE_SIGNAL relay).
    authed.post("/api/channels/:id/voice/join", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      const userId = currentUserId(request);
      const body = z
        .object({ selfMute: z.boolean().optional(), selfDeaf: z.boolean().optional(), selfVideo: z.boolean().optional() })
        .optional()
        .parse(request.body ?? {});
      const channel = await requireChannelRow(id);
      const result = await joinVoiceChannel({
        guildId: channel.guild_id,
        channelId: id,
        userId,
        sessionId: `rest:${userId}`,
        selfMute: body?.selfMute,
        selfDeaf: body?.selfDeaf,
        selfVideo: body?.selfVideo,
      });
      return reply.send(result);
    });

    authed.patch("/api/users/@me/voice-state", async (request, reply) => {
      const userId = currentUserId(request);
      const body = z
        .object({
          selfMute: z.boolean().optional(),
          selfDeaf: z.boolean().optional(),
          selfStream: z.boolean().optional(),
          selfVideo: z.boolean().optional(),
        })
        .strict()
        .parse(request.body);
      return reply.send({ state: await updateVoiceState(userId, body) });
    });

    authed.delete("/api/users/@me/voice-state", async (request, reply) => {
      await leaveVoice(currentUserId(request));
      return reply.status(204).send();
    });
  });
}
