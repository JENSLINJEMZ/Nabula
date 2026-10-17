import { z } from "zod";
import { Errors, Limits, Permissions } from "@nebula/shared";
import type { FastifyInstance } from "fastify";
import {
  bulkDeleteMessages,
  createMessage,
  deleteMessage,
  editMessage,
  getMessageForViewer,
  getReadStates,
  listMessages,
  pinMessage,
  removeAllReactions,
  searchMessages,
  unpinMessage,
} from "../../domain/messages.js";
import { assertChannelAccess } from "../../domain/permissions.js";
import { currentUserId, requireAuth } from "../auth.js";

const Id = z.string().regex(/^\d{1,20}$/);
const IdSchema = z.object({ id: Id });

export async function registerMessageRoutes(app: FastifyInstance): Promise<void> {
  app.register(async (authed) => {
    authed.addHook("preHandler", requireAuth);

    authed.get("/api/channels/:id/messages", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      const query = z
        .object({
          limit: z.coerce.number().int().min(1).max(Limits.MESSAGE_PAGE_MAX).optional(),
          before: Id.optional(),
          after: Id.optional(),
        })
        .refine((v) => !(v.before && v.after), { message: "before and after are mutually exclusive" })
        .parse(request.query);

      const messages = await listMessages(id, currentUserId(request), {
        limit: query.limit ?? 50,
        before: query.before ?? null,
        after: query.after ?? null,
      });
      // Ascending order for the client; the query returns newest-first.
      messages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      return reply.send({ messages });
    });

    authed.get("/api/channels/:id/messages/:messageId", async (request, reply) => {
      const { messageId } = z.object({ id: Id, messageId: Id }).parse(request.params);
      const message = await getMessageForViewer(messageId, currentUserId(request));
      if (!message) throw Errors.UNKNOWN_MESSAGE();
      return reply.send({ message });
    });

    authed.post("/api/channels/:id/messages", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      const body = z
        .object({
          content: z.string().max(Limits.MESSAGE_CONTENT_MAX).optional(),
          nonce: z.string().max(64).optional(),
          tts: z.boolean().optional(),
          attachmentIds: z.array(Id).max(Limits.ATTACHMENTS_MAX_PER_MESSAGE).optional(),
          referenceMessageId: Id.nullable().optional(),
        })
        .strict()
        .parse(request.body ?? {});

      const message = await createMessage({
        channelId: id,
        authorId: currentUserId(request),
        content: body.content ?? "",
        nonce: body.nonce ?? null,
        tts: body.tts,
        attachmentIds: body.attachmentIds,
        referenceMessageId: body.referenceMessageId ?? null,
      });
      return reply.status(201).send({ message });
    });

    authed.patch("/api/messages/:messageId", async (request, reply) => {
      const { messageId } = z.object({ messageId: Id }).parse(request.params);
      const body = z.object({ content: z.string().min(1).max(Limits.MESSAGE_CONTENT_MAX) }).strict().parse(request.body);
      const message = await editMessage(messageId, currentUserId(request), body.content);
      return reply.send({ message });
    });

    authed.delete("/api/messages/:messageId", async (request, reply) => {
      const { messageId } = z.object({ messageId: Id }).parse(request.params);
      await deleteMessage(messageId, currentUserId(request));
      return reply.status(204).send();
    });

    authed.post("/api/channels/:id/messages/bulk-delete", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      const body = z.object({ messageIds: z.array(Id).min(1).max(100) }).parse(request.body);
      await bulkDeleteMessages(id, currentUserId(request), body.messageIds);
      return reply.status(204).send();
    });

    authed.delete("/api/messages/:messageId/reactions", async (request, reply) => {
      const { messageId } = z.object({ messageId: Id }).parse(request.params);
      await removeAllReactions(messageId, currentUserId(request));
      return reply.status(204).send();
    });

    authed.put("/api/messages/:messageId/pin", async (request, reply) => {
      const { messageId } = z.object({ messageId: Id }).parse(request.params);
      await pinMessage(messageId, currentUserId(request));
      return reply.status(204).send();
    });

    authed.delete("/api/messages/:messageId/pin", async (request, reply) => {
      const { messageId } = z.object({ messageId: Id }).parse(request.params);
      await unpinMessage(messageId, currentUserId(request));
      return reply.status(204).send();
    });

    authed.get("/api/search", async (request, reply) => {
      const query = z
        .object({
          q: z.string().min(1).max(200),
          guildId: Id.optional(),
          channelId: Id.optional(),
          authorId: Id.optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        })
        .parse(request.query);
      const messages = await searchMessages(currentUserId(request), {
        q: query.q,
        guildId: query.guildId ?? null,
        channelId: query.channelId ?? null,
        authorId: query.authorId ?? null,
        limit: query.limit ?? 25,
      });
      return reply.send({ messages, total: messages.length });
    });

    authed.get("/api/users/@me/read-states", async (request, reply) => {
      return reply.send({ readStates: await getReadStates(currentUserId(request)) });
    });

    // Expose a channel's computed permissions for the current user (used to gate
    // the composer, voice join button, etc.).
    authed.get("/api/channels/:id/permissions", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      const access = await assertChannelAccess(id, currentUserId(request), Permissions.VIEW_CHANNEL);
      return reply.send({ permissions: access.permissions.toString(), isDm: access.isDm });
    });
  });
}
