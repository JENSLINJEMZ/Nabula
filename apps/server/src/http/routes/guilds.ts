import { z } from "zod";
import { ChannelType, Errors, Limits, Permissions, deserializePermissions } from "@nebula/shared";
import type { FastifyInstance } from "fastify";
import {
  createGuild,
  deleteGuild,
  getGuildView,
  leaveGuild,
  listGuildMembers,
  listGuildsForUser,
  transferOwnership,
  updateGuild,
} from "../../domain/guilds.js";
import { createChannel, listGuildChannelsForUser } from "../../domain/channels.js";
import { createRole, deleteRole, listGuildRoles, setMemberRoles, updateRole } from "../../domain/roles.js";
import { createInvite, deleteInvite, listGuildInvites, previewInvite } from "../../domain/invites.js";
import {
  banMember,
  getAuditLog,
  kickMember,
  listBans,
  setMemberNickname,
  timeoutMember,
  unbanMember,
} from "../../domain/moderation.js";
import { toGuild, toRole } from "../../domain/mappers.js";
import { loadMemberContext } from "../../domain/permissions.js";
import { currentUserId, requireAuth } from "../auth.js";

const Id = z.string().regex(/^\d{1,20}$/);
const IdSchema = z.object({ id: Id });

export async function registerGuildRoutes(app: FastifyInstance): Promise<void> {
  // Invite preview is intentionally public (no session required).
  app.get("/api/invites/:code", async (request, reply) => {
    const { code } = z.object({ code: z.string().min(1).max(32) }).parse(request.params);
    return reply.send(await previewInvite(code));
  });

  app.register(async (authed) => {
    authed.addHook("preHandler", requireAuth);

    // ---- Guilds ----
    authed.get("/api/guilds", async (request, reply) => {
      const userId = currentUserId(request);
      return reply.send({ guilds: await listGuildsForUser(userId) });
    });

    authed.post("/api/guilds", async (request, reply) => {
      const userId = currentUserId(request);
      const body = z
        .object({ name: z.string().min(1).max(Limits.GUILD_NAME_MAX), description: z.string().max(300).optional() })
        .strict()
        .parse(request.body);
      const guild = await createGuild(userId, body);
      return reply.status(201).send({ guild: toGuild(guild) });
    });

    authed.get("/api/guilds/:id", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      const userId = currentUserId(request);
      return reply.send(await getGuildView(id, userId));
    });

    authed.patch("/api/guilds/:id", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      const userId = currentUserId(request);
      const body = z
        .object({
          name: z.string().min(1).max(Limits.GUILD_NAME_MAX).optional(),
          description: z.string().max(300).nullable().optional(),
          systemChannelId: Id.nullable().optional(),
        })
        .strict()
        .parse(request.body);
      const guild = await updateGuild(id, userId, body);
      return reply.send({ guild: toGuild(guild) });
    });

    authed.delete("/api/guilds/:id", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      await deleteGuild(id, currentUserId(request));
      return reply.status(204).send();
    });

    authed.post("/api/guilds/:id/leave", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      await leaveGuild(id, currentUserId(request));
      return reply.status(204).send();
    });

    authed.post("/api/guilds/:id/transfer-ownership", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      const body = z.object({ userId: Id }).parse(request.body);
      await transferOwnership(id, currentUserId(request), body.userId);
      return reply.status(204).send();
    });

    authed.get("/api/guilds/:id/members", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      const query = z.object({ limit: z.coerce.number().int().min(1).max(1000).optional() }).parse(request.query);
      return reply.send({ members: await listGuildMembers(id, currentUserId(request), query.limit ?? 100) });
    });

    authed.get("/api/guilds/:id/channels", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      return reply.send({ channels: await listGuildChannelsForUser(id, currentUserId(request)) });
    });

    authed.post("/api/guilds/:id/channels", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      const body = z
        .object({
          type: z.number().int(),
          name: z.string().min(1).max(Limits.CHANNEL_NAME_MAX),
          parentId: Id.nullable().optional(),
          topic: z.string().max(Limits.CHANNEL_TOPIC_MAX).nullable().optional(),
          nsfw: z.boolean().optional(),
          rateLimitPerUser: z.number().int().min(0).max(Limits.SLOWMODE_MAX_SECONDS).optional(),
          bitrate: z.number().int().optional(),
          userLimit: z.number().int().min(0).max(Limits.VOICE_USER_LIMIT_MAX).optional(),
        })
        .strict()
        .parse(request.body);
      const channel = await createChannel(id, currentUserId(request), {
        type: body.type as ChannelType,
        name: body.name,
        parentId: body.parentId ?? null,
        topic: body.topic ?? null,
        nsfw: body.nsfw,
        rateLimitPerUser: body.rateLimitPerUser,
        bitrate: body.bitrate,
        userLimit: body.userLimit,
      });
      return reply.status(201).send({ channel });
    });

    // ---- Roles ----
    authed.get("/api/guilds/:id/roles", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      await loadMemberContext(id, currentUserId(request));
      return reply.send({ roles: await listGuildRoles(id) });
    });

    authed.post("/api/guilds/:id/roles", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      const body = z
        .object({
          name: z.string().min(1).max(100),
          color: z.number().int().min(0).max(0xffffff).optional(),
          hoist: z.boolean().optional(),
          mentionable: z.boolean().optional(),
          permissions: z.string().regex(/^\d+$/).optional(),
        })
        .strict()
        .parse(request.body);
      const role = await createRole(id, currentUserId(request), {
        name: body.name,
        color: body.color,
        hoist: body.hoist,
        mentionable: body.mentionable,
        permissions: body.permissions ? deserializePermissions(body.permissions) : 0n,
      });
      return reply.status(201).send({ role });
    });

    authed.patch("/api/guilds/:id/roles/:roleId", async (request, reply) => {
      const { id, roleId } = z.object({ id: Id, roleId: Id }).parse(request.params);
      const body = z
        .object({
          name: z.string().min(1).max(100).optional(),
          color: z.number().int().min(0).max(0xffffff).optional(),
          hoist: z.boolean().optional(),
          mentionable: z.boolean().optional(),
          permissions: z.string().regex(/^\d+$/).optional(),
          position: z.number().int().optional(),
        })
        .strict()
        .parse(request.body);
      const role = await updateRole(id, roleId, currentUserId(request), {
        ...body,
        permissions: body.permissions ? deserializePermissions(body.permissions) : undefined,
      });
      return reply.send({ role });
    });

    authed.delete("/api/guilds/:id/roles/:roleId", async (request, reply) => {
      const { id, roleId } = z.object({ id: Id, roleId: Id }).parse(request.params);
      await deleteRole(id, roleId, currentUserId(request));
      return reply.status(204).send();
    });

    authed.put("/api/guilds/:id/members/:userId/roles", async (request, reply) => {
      const { id, userId } = z.object({ id: Id, userId: Id }).parse(request.params);
      const body = z.object({ roles: z.array(Id).max(250) }).parse(request.body);
      await setMemberRoles(id, userId, body.roles, currentUserId(request));
      return reply.status(204).send();
    });

    authed.get("/api/guilds/:id/members/:userId/roles", async (request, reply) => {
      const { id, userId } = z.object({ id: Id, userId: Id }).parse(request.params);
      await loadMemberContext(id, currentUserId(request));
      const { getMemberRoleIds } = await import("../../domain/roles.js");
      return reply.send({ roles: await getMemberRoleIds(id, userId) });
    });

    // ---- Moderation ----
    authed.post("/api/guilds/:id/members/:userId/kick", async (request, reply) => {
      const { id, userId } = z.object({ id: Id, userId: Id }).parse(request.params);
      const body = z.object({ reason: z.string().max(512).optional() }).optional().parse(request.body);
      await kickMember(id, userId, currentUserId(request), body?.reason ?? null);
      return reply.status(204).send();
    });

    authed.put("/api/guilds/:id/bans/:userId", async (request, reply) => {
      const { id, userId } = z.object({ id: Id, userId: Id }).parse(request.params);
      const body = z
        .object({ reason: z.string().max(512).optional(), deleteMessageSeconds: z.number().int().min(0).max(604800).optional() })
        .optional()
        .parse(request.body);
      await banMember(id, userId, currentUserId(request), body ?? {});
      return reply.status(204).send();
    });

    authed.delete("/api/guilds/:id/bans/:userId", async (request, reply) => {
      const { id, userId } = z.object({ id: Id, userId: Id }).parse(request.params);
      await unbanMember(id, userId, currentUserId(request));
      return reply.status(204).send();
    });

    authed.get("/api/guilds/:id/bans", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      return reply.send({ bans: await listBans(id, currentUserId(request)) });
    });

    authed.patch("/api/guilds/:id/members/:userId", async (request, reply) => {
      const { id, userId } = z.object({ id: Id, userId: Id }).parse(request.params);
      const body = z
        .object({
          nickname: z.string().max(Limits.DISPLAY_NAME_MAX).nullable().optional(),
          timeoutSeconds: z.number().int().min(0).max(Limits.TIMEOUT_MAX_MINUTES * 60).optional(),
          reason: z.string().max(512).optional(),
        })
        .strict()
        .parse(request.body);
      const actor = currentUserId(request);
      if (body.nickname !== undefined) await setMemberNickname(id, userId, actor, body.nickname);
      if (body.timeoutSeconds !== undefined) await timeoutMember(id, userId, actor, body.timeoutSeconds, body.reason ?? null);
      return reply.status(204).send();
    });

    authed.get("/api/guilds/:id/audit-logs", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      const query = z
        .object({
          limit: z.coerce.number().int().min(1).max(100).optional(),
          before: Id.optional(),
          actionType: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(request.query);
      return reply.send({
        entries: await getAuditLog(id, currentUserId(request), {
          limit: query.limit ?? 50,
          before: query.before ?? null,
          actionType: query.actionType ?? null,
        }),
      });
    });

    // ---- Invites ----
    authed.post("/api/channels/:channelId/invites", async (request, reply) => {
      const { channelId } = z.object({ channelId: Id }).parse(request.params);
      const body = z
        .object({
          maxAge: z.number().int().min(0).max(Limits.INVITE_MAX_AGE_MAX).optional(),
          maxUses: z.number().int().min(0).max(Limits.INVITE_MAX_USES_MAX).optional(),
          temporary: z.boolean().optional(),
          guildId: Id.optional(),
        })
        .parse(request.body ?? {});
      // Resolve the owning guild from the channel rather than trusting the body.
      const { requireChannelRow } = await import("../../domain/channels.js");
      const channel = await requireChannelRow(channelId);
      if (!channel.guild_id) throw Errors.VALIDATION_FAILED(undefined, "Invites require a guild channel.");
      const invite = await createInvite(channel.guild_id, channelId, currentUserId(request), body);
      return reply.status(201).send({ invite });
    });

    authed.post("/api/invites/:code", async (request, reply) => {
      const { code } = z.object({ code: z.string().min(1).max(32) }).parse(request.params);
      const result = await (await import("../../domain/invites.js")).acceptInvite(code, currentUserId(request));
      return reply.send(result);
    });

    authed.get("/api/guilds/:id/invites", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      return reply.send({ invites: await listGuildInvites(id, currentUserId(request)) });
    });

    authed.delete("/api/invites/:code", async (request, reply) => {
      const { code } = z.object({ code: z.string().min(1).max(32) }).parse(request.params);
      await deleteInvite(code, currentUserId(request));
      return reply.status(204).send();
    });

    // Convenience: current member context (used by the client to gate UI).
    authed.get("/api/guilds/:id/permissions", async (request, reply) => {
      const { id } = IdSchema.parse(request.params);
      const ctx = await loadMemberContext(id, currentUserId(request));
      return reply.send({
        permissions: ctx.basePermissions.toString(),
        isOwner: ctx.isOwner,
        highestRolePosition: ctx.highestRolePosition === Number.MAX_SAFE_INTEGER ? null : ctx.highestRolePosition,
        isTimedOut: ctx.isTimedOut,
      });
    });

    void Permissions;
    void toRole;
  });
}
