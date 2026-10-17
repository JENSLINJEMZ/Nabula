import {
  AuditLogActionType,
  ChannelType,
  DEFAULT_EVERYONE_PERMISSIONS,
  Errors,
  Limits,
  Permissions,
  validateGuildName,
} from "@nebula/shared";
import { nextId } from "../ids.js";
import { execute, query, queryOne, txQuery, withTransaction } from "../db/pool.js";
import { bus } from "../realtime/bus.js";
import { writeAuditLog } from "./audit.js";
import { listGuildChannelsForUser } from "./channels.js";
import {
  toGuild,
  toGuildMember,
  toPresence,
  toPublicUser,
  type GuildRow,
  type PresenceRow,
  type UserRow,
} from "./mappers.js";
import { assertMemberPermission, loadMemberContext } from "./permissions.js";
import { createEveryoneRole, listGuildRoles } from "./roles.js";
import { slugifyChannelName } from "./channels.js";

export interface CreateGuildInput {
  name: string;
  iconKey?: string | null;
  description?: string | null;
}

/**
 * Create a guild and its default structure atomically: guild row, @everyone role
 * whose id equals the guild id, owner membership, two categories each with a
 * starter channel, and storage accounting.
 */
export async function createGuild(ownerId: string, input: CreateGuildInput): Promise<GuildRow> {
  const name = validateGuildName(input.name);
  if (!name) throw Errors.VALIDATION_FAILED({ field: "name" }, "Invalid guild name.");

  const owned = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM guild_members WHERE user_id = $1`,
    [ownerId],
  );
  if (Number(owned?.count ?? 0) >= Limits.GUILDS_MAX_PER_USER) {
    throw Errors.VALIDATION_FAILED(undefined, "You have joined the maximum number of guilds.");
  }

  const guildId = nextId();

  return withTransaction(async (tx) => {
    const inserted = await txQuery<GuildRow>(
      tx,
      `INSERT INTO guilds (id, name, icon_key, owner_id, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, icon_key, owner_id, description, system_channel_id, rules_channel_id, features, created_at`,
      [guildId, name, input.iconKey ?? null, ownerId, input.description ?? null],
    );
    const guild = inserted[0];
    if (!guild) throw Errors.INTERNAL(undefined, "Failed to create guild");

    await createEveryoneRole(tx, guildId, DEFAULT_EVERYONE_PERMISSIONS);

    await txQuery(
      tx,
      `INSERT INTO guild_members (guild_id, user_id, is_owner) VALUES ($1, $2, TRUE)`,
      [guildId, ownerId],
    );
    await txQuery(tx, `INSERT INTO guild_storage (guild_id, used_bytes) VALUES ($1, 0)`, [guildId]);

    const textCategoryId = nextId();
    const voiceCategoryId = nextId();
    const generalId = nextId();
    const generalVoiceId = nextId();

    await txQuery(
      tx,
      `INSERT INTO channels (id, guild_id, type, name, position, owner_id)
       VALUES ($1, $2, $3, $4, 0, $5), ($6, $2, $3, $7, 1, $5)`,
      [textCategoryId, guildId, ChannelType.GUILD_CATEGORY, "Text Channels", ownerId, voiceCategoryId, "Voice Channels"],
    );
    await txQuery(
      tx,
      `INSERT INTO channels (id, guild_id, type, name, position, parent_id, topic, owner_id)
       VALUES ($1, $2, $3, $4, 0, $5, $6, $7)`,
      [
        generalId,
        guildId,
        ChannelType.GUILD_TEXT,
        "general",
        textCategoryId,
        `Welcome to ${name}!`,
        ownerId,
      ],
    );
    await txQuery(
      tx,
      `INSERT INTO channels (id, guild_id, type, name, position, parent_id, owner_id)
       VALUES ($1, $2, $3, $4, 0, $5, $6)`,
      [generalVoiceId, guildId, ChannelType.GUILD_VOICE, "General", voiceCategoryId, ownerId],
    );

    await txQuery(tx, `UPDATE guilds SET system_channel_id = $2 WHERE id = $1`, [guildId, generalId]);
    guild.system_channel_id = generalId;

    await writeAuditLog({ guildId, actionType: AuditLogActionType.GUILD_UPDATE, actorId: ownerId, targetId: guildId }, tx);

    return guild;
  });
}

export async function getGuildRow(guildId: string): Promise<GuildRow | null> {
  return queryOne<GuildRow>(
    `SELECT g.id, g.name, g.icon_key, g.owner_id, g.description, g.system_channel_id, g.rules_channel_id,
            g.features, g.created_at,
            (SELECT COUNT(*)::text FROM guild_members m WHERE m.guild_id = g.id) AS member_count
       FROM guilds g WHERE g.id = $1`,
    [guildId],
  );
}

export async function getGuildView(guildId: string, userId: string) {
  const row = await getGuildRow(guildId);
  if (!row) throw Errors.UNKNOWN_GUILD();
  // Membership is required to view a guild at all.
  await loadMemberContext(guildId, userId);
  const [roles, channels] = await Promise.all([
    listGuildRoles(guildId),
    listGuildChannelsForUser(guildId, userId),
  ]);
  return { guild: toGuild(row), roles, channels };
}

/** Lightweight guild list for the client's guild rail. */
export async function listGuildsForUser(userId: string) {
  const rows = await query<GuildRow>(
    `SELECT g.id, g.name, g.icon_key, g.owner_id, g.description, g.system_channel_id, g.rules_channel_id,
            g.features, g.created_at,
            (SELECT COUNT(*)::text FROM guild_members m WHERE m.guild_id = g.id) AS member_count,
            (SELECT COUNT(*)::text FROM guild_members m JOIN presence p ON p.user_id = m.user_id
              WHERE m.guild_id = g.id AND p.status <> 'offline') AS presence_count
       FROM guilds g
       JOIN guild_members gm ON gm.guild_id = g.id AND gm.user_id = $1
      ORDER BY g.id ASC`,
    [userId],
  );
  return rows.map(toGuild);
}

export async function isGuildMember(guildId: string, userId: string): Promise<boolean> {
  const row = await queryOne(`SELECT 1 FROM guild_members WHERE guild_id = $1 AND user_id = $2`, [guildId, userId]);
  return Boolean(row);
}

export async function listGuildMembers(guildId: string, actorId: string, limit = 100) {
  // Any member may view the member list (VIEW_CHANNEL is required to be in the guild).
  await loadMemberContext(guildId, actorId);

  const rows = await query<{
    guild_id: string;
    user_id: string;
    nickname: string | null;
    joined_at: Date;
    timeout_until: Date | null;
    is_owner: boolean;
  }>(
    `SELECT guild_id, user_id, nickname, joined_at, timeout_until, is_owner
       FROM guild_members WHERE guild_id = $1
      ORDER BY is_owner DESC, joined_at ASC
      LIMIT $2`,
    [guildId, Math.min(limit, 1000)],
  );

  const userIds = rows.map((r) => r.user_id);
  if (userIds.length === 0) return [];

  const userRows = await query<UserRow>(
    `SELECT id, username, discriminator, display_name, avatar_key, banner_key, accent_color, bio, bot,
            premium_type, email, email_verified, flags, created_at
       FROM users WHERE id = ANY($1::bigint[])`,
    [userIds],
  );
  const userMap = new Map(userRows.map((u) => [u.id, u]));

  const presenceRows = await query<PresenceRow>(
    `SELECT user_id, status, custom_status, activities, updated_at FROM presence WHERE user_id = ANY($1::bigint[])`,
    [userIds],
  );
  const presenceMap = new Map(presenceRows.map((p) => [p.user_id, toPresence(p)]));

  const roleRows = await query<{ user_id: string; role_id: string }>(
    `SELECT user_id, role_id FROM member_roles WHERE guild_id = $1 AND user_id = ANY($2::bigint[])`,
    [guildId, userIds],
  );
  const rolesByUser = new Map<string, string[]>();
  for (const r of roleRows) {
    const list = rolesByUser.get(r.user_id) ?? [];
    list.push(r.role_id);
    rolesByUser.set(r.user_id, list);
  }

  return rows.map((r) => {
    const u = userMap.get(r.user_id);
    return toGuildMember(r, {
      user: u ? toPublicUser(u) : undefined,
      presence: presenceMap.get(r.user_id),
      roles: rolesByUser.get(r.user_id) ?? [],
    });
  });
}

export async function addGuildMember(guildId: string, userId: string): Promise<void> {
  await execute(
    `INSERT INTO guild_members (guild_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [guildId, userId],
  );
  bus().refreshGuild?.(guildId);
}

export async function leaveGuild(guildId: string, userId: string): Promise<void> {
  const member = await queryOne<{ is_owner: boolean }>(
    `SELECT is_owner FROM guild_members WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId],
  );
  if (!member) throw Errors.NOT_GUILD_MEMBER();
  if (member.is_owner) {
    throw Errors.LAST_OWNER(undefined, "Transfer ownership or delete the guild before leaving.");
  }
  await execute(`DELETE FROM guild_members WHERE guild_id = $1 AND user_id = $2`, [guildId, userId]);
  bus().refreshGuild?.(guildId);
}

export async function updateGuild(
  guildId: string,
  actorId: string,
  input: { name?: string; iconKey?: string | null; description?: string | null; systemChannelId?: string | null },
): Promise<GuildRow> {
  const ctx = await loadMemberContext(guildId, actorId);
  assertMemberPermission(ctx, Permissions.MANAGE_GUILD);

  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (input.name !== undefined) {
    const name = validateGuildName(input.name);
    if (!name) throw Errors.VALIDATION_FAILED({ field: "name" });
    sets.push(`name = $${i++}`);
    params.push(name);
  }
  if (input.iconKey !== undefined) {
    sets.push(`icon_key = $${i++}`);
    params.push(input.iconKey);
  }
  if (input.description !== undefined) {
    sets.push(`description = $${i++}`);
    params.push(input.description);
  }
  if (input.systemChannelId !== undefined) {
    sets.push(`system_channel_id = $${i++}`);
    params.push(input.systemChannelId);
  }

  if (sets.length === 0) {
    const row = await getGuildRow(guildId);
    if (!row) throw Errors.UNKNOWN_GUILD();
    return row;
  }
  sets.push(`updated_at = now()`);
  params.push(guildId);

  const row = await queryOne<GuildRow>(
    `UPDATE guilds SET ${sets.join(", ")} WHERE id = $${i} RETURNING id, name, icon_key, owner_id, description,
      system_channel_id, rules_channel_id, features, created_at`,
    params,
  );
  if (!row) throw Errors.UNKNOWN_GUILD();

  await writeAuditLog({
    guildId,
    actionType: AuditLogActionType.GUILD_UPDATE,
    actorId,
    targetId: guildId,
  });
  return row;
}

/** Delete a guild (owner only). Cascades remove all dependent rows. */
export async function deleteGuild(guildId: string, actorId: string): Promise<void> {
  const row = await queryOne<{ owner_id: string }>(`SELECT owner_id FROM guilds WHERE id = $1`, [guildId]);
  if (!row) throw Errors.UNKNOWN_GUILD();
  if (row.owner_id !== actorId) throw Errors.FORBIDDEN(undefined, "Only the guild owner can delete it.");
  await execute(`DELETE FROM guilds WHERE id = $1`, [guildId]);
}

export async function transferOwnership(guildId: string, actorId: string, newOwnerId: string): Promise<void> {
  const row = await queryOne<{ owner_id: string }>(`SELECT owner_id FROM guilds WHERE id = $1`, [guildId]);
  if (!row) throw Errors.UNKNOWN_GUILD();
  if (row.owner_id !== actorId) throw Errors.FORBIDDEN(undefined, "Only the guild owner can transfer ownership.");
  const target = await queryOne(`SELECT 1 FROM guild_members WHERE guild_id = $1 AND user_id = $2`, [
    guildId,
    newOwnerId,
  ]);
  if (!target) throw Errors.NOT_GUILD_MEMBER();

  await withTransaction(async (tx) => {
    await txQuery(tx, `UPDATE guilds SET owner_id = $2 WHERE id = $1`, [guildId, newOwnerId]);
    await txQuery(tx, `UPDATE guild_members SET is_owner = FALSE WHERE guild_id = $1 AND user_id = $2`, [
      guildId,
      actorId,
    ]);
    await txQuery(tx, `UPDATE guild_members SET is_owner = TRUE WHERE guild_id = $1 AND user_id = $2`, [
      guildId,
      newOwnerId,
    ]);
  });

  await writeAuditLog({
    guildId,
    actionType: AuditLogActionType.GUILD_UPDATE,
    actorId,
    targetId: newOwnerId,
    changes: [{ key: "owner_id", oldValue: actorId, newValue: newOwnerId }],
  });
}

export { slugifyChannelName };
