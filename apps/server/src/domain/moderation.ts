import {
  AuditLogActionType,
  Errors,
  Limits,
  Permissions,
} from "@nebula/shared";
import { execute, query, queryOne, withTransaction, txQuery } from "../db/pool.js";
import { bus } from "../realtime/bus.js";
import { ServerEvents } from "@nebula/shared";
import { writeAuditLog, listAuditLog } from "./audit.js";
import { assertHierarchy, highestRolePositionOfMember, loadMemberContext } from "./permissions.js";
import { getBlockedIds } from "./relationships.js";

/**
 * Moderation operations. Every action:
 *   1. requires the caller to hold the relevant permission,
 *   2. enforces role hierarchy against the target,
 *   3. is recorded in the audit log, and
 *   4. fans out a realtime event.
 */

async function requireGuildMemberRow(guildId: string, userId: string) {
  const row = await queryOne<{ is_owner: boolean }>(
    `SELECT is_owner FROM guild_members WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId],
  );
  if (!row) throw Errors.NOT_GUILD_MEMBER();
  return row;
}

export async function kickMember(
  guildId: string,
  targetUserId: string,
  actorId: string,
  reason?: string | null,
): Promise<void> {
  const ctx = await loadMemberContext(guildId, actorId);
  if ((ctx.basePermissions & Permissions.KICK_MEMBERS) !== Permissions.KICK_MEMBERS) {
    throw Errors.MISSING_PERMISSIONS({ permission: "KICK_MEMBERS" });
  }
  const target = await requireGuildMemberRow(guildId, targetUserId);
  if (targetUserId === actorId) throw Errors.VALIDATION_FAILED(undefined, "You cannot kick yourself.");
  if (target.is_owner) throw Errors.HIERARCHY_VIOLATION({ reason: "cannot kick the guild owner" });
  assertHierarchy(ctx, await highestRolePositionOfMember(guildId, targetUserId));

  await execute(`DELETE FROM guild_members WHERE guild_id = $1 AND user_id = $2`, [guildId, targetUserId]);
  await execute(`DELETE FROM voice_states WHERE guild_id = $1 AND user_id = $2`, [guildId, targetUserId]);

  await writeAuditLog({
    guildId,
    actionType: AuditLogActionType.MEMBER_KICK,
    actorId,
    targetId: targetUserId,
    reason: reason ?? null,
  });
  bus().toGuild(guildId, ServerEvents.GUILD_MEMBER_REMOVE, { guildId, userId: targetUserId, kicked: true });
  bus().toUser(targetUserId, ServerEvents.GUILD_DELETE, { guildId });
}

export async function banMember(
  guildId: string,
  targetUserId: string,
  actorId: string,
  options: { reason?: string | null; deleteMessageSeconds?: number } = {},
): Promise<void> {
  const ctx = await loadMemberContext(guildId, actorId);
  if ((ctx.basePermissions & Permissions.BAN_MEMBERS) !== Permissions.BAN_MEMBERS) {
    throw Errors.MISSING_PERMISSIONS({ permission: "BAN_MEMBERS" });
  }
  const guild = await queryOne<{ owner_id: string }>(`SELECT owner_id FROM guilds WHERE id = $1`, [guildId]);
  if (!guild) throw Errors.UNKNOWN_GUILD();
  if (guild.owner_id === targetUserId) throw Errors.HIERARCHY_VIOLATION({ reason: "cannot ban the guild owner" });
  if (targetUserId === actorId) throw Errors.VALIDATION_FAILED(undefined, "You cannot ban yourself.");

  const targetMember = await queryOne<{ is_owner: boolean }>(
    `SELECT is_owner FROM guild_members WHERE guild_id = $1 AND user_id = $2`,
    [guildId, targetUserId],
  );
  if (targetMember) {
    assertHierarchy(ctx, await highestRolePositionOfMember(guildId, targetUserId));
  }

  await withTransaction(async (tx) => {
    await txQuery(
      tx,
      `INSERT INTO guild_bans (guild_id, user_id, moderator_id, reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET moderator_id = EXCLUDED.moderator_id, reason = EXCLUDED.reason`,
      [guildId, targetUserId, actorId, options.reason ?? null],
    );
    await txQuery(tx, `DELETE FROM guild_members WHERE guild_id = $1 AND user_id = $2`, [guildId, targetUserId]);
    await txQuery(tx, `DELETE FROM voice_states WHERE guild_id = $1 AND user_id = $2`, [guildId, targetUserId]);
    if (options.deleteMessageSeconds && options.deleteMessageSeconds > 0) {
      await txQuery(
        tx,
        `UPDATE messages SET deleted_at = now()
          WHERE guild_id = $1 AND author_id = $2 AND deleted_at IS NULL
            AND created_at > now() - ($3 || ' seconds')::interval`,
        [guildId, targetUserId, String(Math.min(options.deleteMessageSeconds, 604800))],
      );
    }
  });

  await writeAuditLog({
    guildId,
    actionType: AuditLogActionType.MEMBER_BAN_ADD,
    actorId,
    targetId: targetUserId,
    reason: options.reason ?? null,
  });
  bus().toGuild(guildId, ServerEvents.GUILD_MEMBER_REMOVE, { guildId, userId: targetUserId, banned: true });
  bus().toUser(targetUserId, ServerEvents.GUILD_DELETE, { guildId });
}

export async function unbanMember(guildId: string, targetUserId: string, actorId: string): Promise<void> {
  const ctx = await loadMemberContext(guildId, actorId);
  if ((ctx.basePermissions & Permissions.BAN_MEMBERS) !== Permissions.BAN_MEMBERS) {
    throw Errors.MISSING_PERMISSIONS({ permission: "BAN_MEMBERS" });
  }
  const removed = await execute(`DELETE FROM guild_bans WHERE guild_id = $1 AND user_id = $2`, [
    guildId,
    targetUserId,
  ]);
  if (removed === 0) throw Errors.NOT_FOUND(undefined, "That user is not banned.");
  await writeAuditLog({
    guildId,
    actionType: AuditLogActionType.MEMBER_BAN_REMOVE,
    actorId,
    targetId: targetUserId,
  });
}

export async function listBans(guildId: string, actorId: string) {
  const ctx = await loadMemberContext(guildId, actorId);
  if ((ctx.basePermissions & Permissions.BAN_MEMBERS) !== Permissions.BAN_MEMBERS) {
    throw Errors.MISSING_PERMISSIONS({ permission: "BAN_MEMBERS" });
  }
  const rows = await query<{ user_id: string; reason: string | null; created_at: Date }>(
    `SELECT user_id, reason, created_at FROM guild_bans WHERE guild_id = $1 ORDER BY created_at DESC LIMIT 500`,
    [guildId],
  );
  const userIds = rows.map((r) => r.user_id);
  const users = userIds.length
    ? await query<{ id: string; username: string; discriminator: string; display_name: string | null; avatar_key: string | null }>(
        `SELECT id, username, discriminator, display_name, avatar_key FROM users WHERE id = ANY($1::bigint[])`,
        [userIds],
      )
    : [];
  const map = new Map(users.map((u) => [u.id, u]));
  return rows.map((r) => ({
    userId: r.user_id,
    reason: r.reason,
    createdAt: r.created_at.toISOString(),
    user: map.get(r.user_id)
      ? {
          id: r.user_id,
          username: map.get(r.user_id)!.username,
          discriminator: map.get(r.user_id)!.discriminator,
          displayName: map.get(r.user_id)!.display_name,
          avatarUrl: map.get(r.user_id)!.avatar_key ? `/api/media/avatars/${map.get(r.user_id)!.avatar_key}` : null,
        }
      : null,
  }));
}

export async function timeoutMember(
  guildId: string,
  targetUserId: string,
  actorId: string,
  durationSeconds: number,
  reason?: string | null,
): Promise<{ timeoutUntil: string }> {
  const ctx = await loadMemberContext(guildId, actorId);
  if ((ctx.basePermissions & Permissions.MODERATE_MEMBERS) !== Permissions.MODERATE_MEMBERS) {
    throw Errors.MISSING_PERMISSIONS({ permission: "MODERATE_MEMBERS" });
  }
  if (durationSeconds < 0 || durationSeconds > Limits.TIMEOUT_MAX_MINUTES * 60) {
    throw Errors.VALIDATION_FAILED({ field: "duration" }, "Timeout duration is out of range.");
  }
  const target = await requireGuildMemberRow(guildId, targetUserId);
  if (target.is_owner) throw Errors.HIERARCHY_VIOLATION({ reason: "cannot time out the guild owner" });
  assertHierarchy(ctx, await highestRolePositionOfMember(guildId, targetUserId));

  const until = durationSeconds === 0 ? null : new Date(Date.now() + durationSeconds * 1000);
  await execute(`UPDATE guild_members SET timeout_until = $3 WHERE guild_id = $1 AND user_id = $2`, [
    guildId,
    targetUserId,
    until,
  ]);
  await writeAuditLog({
    guildId,
    actionType: AuditLogActionType.MEMBER_TIMEOUT,
    actorId,
    targetId: targetUserId,
    reason: reason ?? null,
    changes: [{ key: "communication_disabled_until", newValue: until?.toISOString() ?? null }],
  });
  bus().toGuild(guildId, ServerEvents.GUILD_MEMBER_UPDATE, {
    guildId,
    userId: targetUserId,
    timeoutUntil: until?.toISOString() ?? null,
  });
  return { timeoutUntil: until?.toISOString() ?? new Date(0).toISOString() };
}

export async function setMemberNickname(
  guildId: string,
  targetUserId: string,
  actorId: string,
  nickname: string | null,
): Promise<void> {
  const ctx = await loadMemberContext(guildId, actorId);
  const isSelf = targetUserId === actorId;
  const required = isSelf ? Permissions.CHANGE_NICKNAME : Permissions.MANAGE_NICKNAMES;
  if ((ctx.basePermissions & required) !== required) {
    throw Errors.MISSING_PERMISSIONS({ permission: isSelf ? "CHANGE_NICKNAME" : "MANAGE_NICKNAMES" });
  }
  const target = await requireGuildMemberRow(guildId, targetUserId);
  if (!isSelf) {
    if (target.is_owner) throw Errors.HIERARCHY_VIOLATION({});
    assertHierarchy(ctx, await highestRolePositionOfMember(guildId, targetUserId));
  }
  const clean = nickname === null ? null : nickname.trim().slice(0, Limits.DISPLAY_NAME_MAX) || null;
  await execute(`UPDATE guild_members SET nickname = $3 WHERE guild_id = $1 AND user_id = $2`, [
    guildId,
    targetUserId,
    clean,
  ]);
  await writeAuditLog({
    guildId,
    actionType: AuditLogActionType.MEMBER_UPDATE,
    actorId,
    targetId: targetUserId,
    changes: [{ key: "nick", newValue: clean }],
  });
  bus().toGuild(guildId, ServerEvents.GUILD_MEMBER_UPDATE, {
    guildId,
    userId: targetUserId,
    nickname: clean,
  });
}

export async function getAuditLog(
  guildId: string,
  actorId: string,
  options: { limit: number; before?: string | null; actionType?: number | null },
) {
  const ctx = await loadMemberContext(guildId, actorId);
  if ((ctx.basePermissions & Permissions.VIEW_AUDIT_LOG) !== Permissions.VIEW_AUDIT_LOG) {
    throw Errors.MISSING_PERMISSIONS({ permission: "VIEW_AUDIT_LOG" });
  }
  return listAuditLog(guildId, options);
}

/** Report a user/message. Stored for human review; never auto-enforced. */
export async function createReport(input: {
  reporterId: string;
  targetUserId?: string | null;
  guildId?: string | null;
  messageId?: string | null;
  category: string;
  reason?: string | null;
}): Promise<void> {
  const allowed = new Set(["harassment", "spam", "self_harm", "violence", "nsfw", "other"]);
  if (!allowed.has(input.category)) throw Errors.VALIDATION_FAILED({ field: "category" });

  // Blocked users cannot report each other (prevents report-spam loops).
  if (input.targetUserId) {
    const blocked = await getBlockedIds(input.reporterId);
    if (blocked.has(input.targetUserId)) throw Errors.BLOCKED();
  }

  const { nextId } = await import("../ids.js");
  await execute(
    `INSERT INTO reports (id, reporter_id, target_user_id, guild_id, message_id, category, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      nextId(),
      input.reporterId,
      input.targetUserId ?? null,
      input.guildId ?? null,
      input.messageId ?? null,
      input.category,
      input.reason?.slice(0, 1000) ?? null,
    ],
  );
}
