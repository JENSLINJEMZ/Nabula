import {
  ALL_PERMISSIONS,
  AuditLogActionType,
  ChannelType,
  Errors,
  Limits,
  MessageType,
  Permissions,
  applyImplicitPermissions,
  computeChannelPermissions,
  deserializePermissions,
  serializePermissions,
  validateChannelName,
  type Channel as WireChannel,
  type PermissionOverwrite,
  type ServerEventName,
} from "@nebula/shared";
import { nextId } from "../ids.js";
import { execute, query, queryOne, withTransaction, type Queryable } from "../db/pool.js";
import { bus } from "../realtime/bus.js";
import { writeAuditLog } from "./audit.js";
import {
  toChannel,
  toOverwrite,
  toPublicUser,
  type ChannelRowFull,
  type UserRow,
} from "./mappers.js";
import {
  assertCanGrantPermissions,
  loadMemberContext,
  type MemberContext,
} from "./permissions.js";
import { isBlockedBetween } from "./relationships.js";

const CHANNEL_COLUMNS = `id, guild_id, type, name, topic, position, parent_id, nsfw, rate_limit_per_user,
  user_limit, bitrate, last_message_id, owner_id, default_auto_archive_duration, thread_message_count,
  dm_closed, created_at`;

export function slugifyChannelName(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_\-.]+/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, Limits.CHANNEL_NAME_MAX);
}

export async function requireChannelRow(channelId: string): Promise<ChannelRowFull> {
  const row = await queryOne<ChannelRowFull>(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = $1`, [channelId]);
  if (!row) throw Errors.UNKNOWN_CHANNEL();
  return row;
}

interface OverwriteRow {
  channel_id: string;
  target_id: string;
  type: number;
  allow: string;
  deny: string;
}

function toOverwriteModel(row: OverwriteRow): PermissionOverwrite {
  return {
    targetId: row.target_id,
    type: row.type === 1 ? 1 : 0,
    allow: deserializePermissions(row.allow),
    deny: deserializePermissions(row.deny),
  };
}

/**
 * Compute permissions for many channels at once. Batch-loads overwrites to
 * avoid N+1 queries, then applies Discord's resolution per channel including
 * category inheritance and thread-parent inheritance, and implicit rules.
 */
export async function computeChannelsWithPermissions(
  ctx: MemberContext,
  channels: ChannelRowFull[],
): Promise<WireChannel[]> {
  const allChannelIds = new Set<string>();
  for (const c of channels) {
    allChannelIds.add(c.id);
    if (c.parent_id) allChannelIds.add(c.parent_id);
  }

  const overwriteRows = allChannelIds.size
    ? await query<OverwriteRow>(
        `SELECT channel_id, target_id, type, allow, deny FROM channel_overwrites WHERE channel_id = ANY($1::bigint[])`,
        [[...allChannelIds]],
      )
    : [];

  const byChannel = new Map<string, OverwriteRow[]>();
  for (const row of overwriteRows) {
    const list = byChannel.get(row.channel_id) ?? [];
    list.push(row);
    byChannel.set(row.channel_id, list);
  }

  const channelById = new Map(channels.map((c) => [c.id, c]));
  const result: WireChannel[] = [];

  for (const channel of channels) {
    // Threads resolve against their parent.
    let permChannelId = channel.id;
    if (
      (channel.type === ChannelType.PUBLIC_THREAD || channel.type === ChannelType.PRIVATE_THREAD) &&
      channel.parent_id
    ) {
      permChannelId = channel.parent_id;
    }

    const own = (byChannel.get(permChannelId) ?? []).map(toOverwriteModel);
    const defined = new Set(own.map((o) => o.targetId));

    let merged = own;
    const permChannel = channelById.get(permChannelId) ?? channel;
    if (permChannel.parent_id && permChannel.type !== ChannelType.GUILD_CATEGORY) {
      const inherited = (byChannel.get(permChannel.parent_id) ?? [])
        .filter((r) => !defined.has(r.target_id))
        .map(toOverwriteModel);
      merged = [...own, ...inherited];
    }

    let permissions = computeChannelPermissions({
      basePermissions: ctx.basePermissions,
      everyoneRoleId: ctx.everyoneRoleId,
      memberRoleIds: ctx.memberRoleIds,
      memberId: ctx.userId,
      overwrites: merged,
    });

    const isVoice = channel.type === ChannelType.GUILD_VOICE || channel.type === ChannelType.GUILD_STAGE_VOICE;
    permissions = applyImplicitPermissions(permissions, isVoice);

    if (channel.type !== ChannelType.GUILD_CATEGORY && (permissions & Permissions.VIEW_CHANNEL) !== Permissions.VIEW_CHANNEL) {
      continue;
    }

    result.push(
      toChannel(channel, {
        overwrites: (byChannel.get(channel.id) ?? []).map(toOverwrite),
        permissions,
      }),
    );
  }

  return result;
}

export async function listGuildChannelsForUser(guildId: string, userId: string): Promise<WireChannel[]> {
  const ctx = await loadMemberContext(guildId, userId);
  const channels = await query<ChannelRowFull>(
    `SELECT ${CHANNEL_COLUMNS} FROM channels WHERE guild_id = $1 ORDER BY position ASC, id ASC`,
    [guildId],
  );
  return computeChannelsWithPermissions(ctx, channels);
}

/**
 * Drop private threads the user cannot see (not a member, not the owner). Used
 * by the realtime gateway so that channel-room fan-out never reaches users who
 * lack access to a private thread.
 */
export async function filterAccessibleThreads(userId: string, channels: WireChannel[]): Promise<WireChannel[]> {
  const privateThreads = channels.filter((c) => c.type === ChannelType.PRIVATE_THREAD);
  if (privateThreads.length === 0) return channels;
  const rows = await query<{ thread_id: string }>(
    `SELECT thread_id FROM thread_members WHERE user_id = $1 AND thread_id = ANY($2::bigint[])`,
    [userId, privateThreads.map((c) => c.id)],
  );
  const memberOf = new Set(rows.map((r) => r.thread_id));
  return channels.filter(
    (c) => c.type !== ChannelType.PRIVATE_THREAD || memberOf.has(c.id) || c.ownerId === userId,
  );
}

export async function listGuildChannels(guildId: string): Promise<ChannelRowFull[]> {
  return query<ChannelRowFull>(
    `SELECT ${CHANNEL_COLUMNS} FROM channels WHERE guild_id = $1 ORDER BY position ASC, id ASC`,
    [guildId],
  );
}

export async function getChannelView(channelId: string, userId: string): Promise<WireChannel | null> {
  const row = await requireChannelRow(channelId);
  if (row.guild_id === null) {
    const recipient = await queryOne(`SELECT 1 FROM dm_recipients WHERE channel_id = $1 AND user_id = $2`, [
      channelId,
      userId,
    ]);
    if (!recipient) return null;
    return toChannel(row, { permissions: ALL_PERMISSIONS, recipients: await listDmRecipients(channelId) });
  }
  const ctx = await loadMemberContext(row.guild_id, userId);
  const views = await computeChannelsWithPermissions(ctx, [row]);
  return views[0] ?? null;
}

export interface CreateChannelInput {
  type: ChannelType;
  name: string;
  parentId?: string | null;
  topic?: string | null;
  nsfw?: boolean;
  rateLimitPerUser?: number;
  bitrate?: number;
  userLimit?: number;
  position?: number;
}

export async function createChannel(
  guildId: string,
  actorId: string,
  input: CreateChannelInput,
): Promise<WireChannel> {
  const ctx = await loadMemberContext(guildId, actorId);
  if ((ctx.basePermissions & Permissions.MANAGE_CHANNELS) !== Permissions.MANAGE_CHANNELS) {
    throw Errors.MISSING_PERMISSIONS({ permission: "MANAGE_CHANNELS" });
  }

  const allowedTypes: number[] = [
    ChannelType.GUILD_TEXT,
    ChannelType.GUILD_VOICE,
    ChannelType.GUILD_CATEGORY,
    ChannelType.GUILD_ANNOUNCEMENT,
    ChannelType.GUILD_STAGE_VOICE,
    ChannelType.GUILD_FORUM,
  ];
  if (!allowedTypes.includes(input.type)) {
    throw Errors.VALIDATION_FAILED({ field: "type" }, "Unsupported channel type.");
  }

  let parentId: string | null = input.parentId ?? null;
  if (parentId) {
    const parent = await requireChannelRow(parentId);
    if (parent.guild_id !== guildId) throw Errors.VALIDATION_FAILED({ field: "parentId" });
    if (parent.type !== ChannelType.GUILD_CATEGORY) {
      throw Errors.VALIDATION_FAILED({ field: "parentId" }, "Parent must be a category.");
    }
  }

  const isCategory = input.type === ChannelType.GUILD_CATEGORY;
  const rawName = validateChannelName(input.name);
  if (!rawName) throw Errors.VALIDATION_FAILED({ field: "name" }, "Invalid channel name.");
  const name = isCategory ? rawName : slugifyChannelName(rawName);
  if (!name) throw Errors.VALIDATION_FAILED({ field: "name" }, "Channel name is empty after normalisation.");

  if (parentId) {
    const countRow = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM channels WHERE parent_id = $1`,
      [parentId],
    );
    if (Number(countRow?.count ?? 0) >= Limits.CHANNELS_MAX_PER_CATEGORY) {
      throw Errors.VALIDATION_FAILED(undefined, "This category has reached its channel limit.");
    }
  }

  const positionRow = await queryOne<{ next: number }>(
    `SELECT COALESCE(MAX(position), -1) + 1 AS next FROM channels WHERE guild_id = $1 AND parent_id IS NOT DISTINCT FROM $2`,
    [guildId, parentId],
  );
  const position = input.position ?? positionRow?.next ?? 0;
  const id = nextId();

  const row = await queryOne<ChannelRowFull>(
    `INSERT INTO channels (id, guild_id, type, name, topic, position, parent_id, nsfw, rate_limit_per_user,
                           bitrate, user_limit, owner_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${CHANNEL_COLUMNS}`,
    [
      id,
      guildId,
      input.type,
      name,
      input.topic ?? null,
      position,
      parentId,
      input.nsfw ?? false,
      input.rateLimitPerUser ?? 0,
      input.bitrate ?? 64000,
      input.userLimit ?? 0,
      actorId,
    ],
  );
  if (!row) throw Errors.INTERNAL(undefined, "Failed to create channel");

  await writeAuditLog({
    guildId,
    actionType: AuditLogActionType.CHANNEL_CREATE,
    actorId,
    targetId: id,
    changes: [{ key: "name", newValue: name }],
  });

  return toChannel(row);
}

export interface UpdateChannelInput {
  name?: string;
  topic?: string | null;
  nsfw?: boolean;
  rateLimitPerUser?: number;
  bitrate?: number;
  userLimit?: number;
  parentId?: string | null;
  position?: number;
}

export async function updateChannel(
  guildId: string,
  channelId: string,
  actorId: string,
  input: UpdateChannelInput,
): Promise<ChannelRowFull> {
  const ctx = await loadMemberContext(guildId, actorId);
  if ((ctx.basePermissions & Permissions.MANAGE_CHANNELS) !== Permissions.MANAGE_CHANNELS) {
    throw Errors.MISSING_PERMISSIONS({ permission: "MANAGE_CHANNELS" });
  }
  const existing = await requireChannelRow(channelId);
  if (existing.guild_id !== guildId) throw Errors.UNKNOWN_CHANNEL();

  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (input.name !== undefined) {
    const isCategory = existing.type === ChannelType.GUILD_CATEGORY;
    const rawName = validateChannelName(input.name);
    if (!rawName) throw Errors.VALIDATION_FAILED({ field: "name" });
    const name = isCategory ? rawName : slugifyChannelName(rawName);
    if (!name) throw Errors.VALIDATION_FAILED({ field: "name" });
    sets.push(`name = $${i++}`);
    params.push(name);
  }
  if (input.topic !== undefined) {
    if (input.topic !== null && input.topic.length > Limits.CHANNEL_TOPIC_MAX) {
      throw Errors.VALIDATION_FAILED({ field: "topic" }, "Topic is too long.");
    }
    sets.push(`topic = $${i++}`);
    params.push(input.topic);
  }
  if (input.nsfw !== undefined) {
    sets.push(`nsfw = $${i++}`);
    params.push(input.nsfw);
  }
  if (input.rateLimitPerUser !== undefined) {
    if (input.rateLimitPerUser < 0 || input.rateLimitPerUser > Limits.SLOWMODE_MAX_SECONDS) {
      throw Errors.VALIDATION_FAILED({ field: "rateLimitPerUser" });
    }
    sets.push(`rate_limit_per_user = $${i++}`);
    params.push(input.rateLimitPerUser);
  }
  if (input.bitrate !== undefined) {
    sets.push(`bitrate = $${i++}`);
    params.push(Math.min(Math.max(input.bitrate, 8000), 384000));
  }
  if (input.userLimit !== undefined) {
    if (input.userLimit < 0 || input.userLimit > Limits.VOICE_USER_LIMIT_MAX) {
      throw Errors.VALIDATION_FAILED({ field: "userLimit" });
    }
    sets.push(`user_limit = $${i++}`);
    params.push(input.userLimit);
  }
  if (input.parentId !== undefined) {
    sets.push(`parent_id = $${i++}`);
    params.push(input.parentId);
  }
  if (input.position !== undefined) {
    sets.push(`position = $${i++}`);
    params.push(input.position);
  }

  if (sets.length === 0) return existing;
  sets.push(`updated_at = now()`);
  params.push(guildId, channelId);

  const row = await queryOne<ChannelRowFull>(
    `UPDATE channels SET ${sets.join(", ")} WHERE guild_id = $${i} AND id = $${i + 1} RETURNING ${CHANNEL_COLUMNS}`,
    params,
  );
  if (!row) throw Errors.UNKNOWN_CHANNEL();

  await writeAuditLog({
    guildId,
    actionType: AuditLogActionType.CHANNEL_UPDATE,
    actorId,
    targetId: channelId,
    changes: [{ key: "name", oldValue: existing.name, newValue: row.name }],
  });

  return row;
}

export async function deleteChannel(
  guildId: string,
  channelId: string,
  actorId: string,
): Promise<ChannelRowFull> {
  const ctx = await loadMemberContext(guildId, actorId);
  if ((ctx.basePermissions & Permissions.MANAGE_CHANNELS) !== Permissions.MANAGE_CHANNELS) {
    throw Errors.MISSING_PERMISSIONS({ permission: "MANAGE_CHANNELS" });
  }
  const existing = await requireChannelRow(channelId);
  if (existing.guild_id !== guildId) throw Errors.UNKNOWN_CHANNEL();

  await execute(`DELETE FROM channels WHERE id = $1`, [channelId]);
  await writeAuditLog({
    guildId,
    actionType: AuditLogActionType.CHANNEL_DELETE,
    actorId,
    targetId: channelId,
    changes: [{ key: "name", oldValue: existing.name }],
  });
  return existing;
}

export async function listChannelOverwrites(channelId: string) {
  const rows = await query<OverwriteRow>(
    `SELECT channel_id, target_id, type, allow, deny FROM channel_overwrites WHERE channel_id = $1`,
    [channelId],
  );
  return rows.map(toOverwrite);
}

export interface UpsertOverwriteInput {
  targetId: string;
  type: 0 | 1;
  allow: bigint;
  deny: bigint;
}

export async function upsertChannelOverwrite(
  guildId: string,
  channelId: string,
  actorId: string,
  input: UpsertOverwriteInput,
): Promise<void> {
  const ctx = await loadMemberContext(guildId, actorId);
  if ((ctx.basePermissions & Permissions.MANAGE_ROLES) !== Permissions.MANAGE_ROLES) {
    throw Errors.MISSING_PERMISSIONS({ permission: "MANAGE_ROLES" });
  }
  assertCanGrantPermissions(ctx, input.allow);

  const channel = await requireChannelRow(channelId);
  if (channel.guild_id !== guildId) throw Errors.UNKNOWN_CHANNEL();
  if (input.type === 0) {
    const role = await queryOne(`SELECT 1 FROM roles WHERE guild_id = $1 AND id = $2`, [guildId, input.targetId]);
    if (!role) throw Errors.UNKNOWN_ROLE();
  } else {
    const member = await queryOne(`SELECT 1 FROM guild_members WHERE guild_id = $1 AND user_id = $2`, [
      guildId,
      input.targetId,
    ]);
    if (!member) throw Errors.NOT_GUILD_MEMBER();
  }
  if ((input.allow & input.deny) !== 0n) {
    throw Errors.VALIDATION_FAILED(undefined, "A permission cannot be both allowed and denied.");
  }

  await execute(
    `INSERT INTO channel_overwrites (channel_id, target_id, type, allow, deny)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (channel_id, target_id) DO UPDATE
       SET allow = EXCLUDED.allow, deny = EXCLUDED.deny, type = EXCLUDED.type`,
    [channelId, input.targetId, input.type, serializePermissions(input.allow), serializePermissions(input.deny)],
  );

  await writeAuditLog({
    guildId,
    actionType: AuditLogActionType.CHANNEL_OVERWRITE_UPDATE,
    actorId,
    targetId: channelId,
    changes: [{ key: "overwrite", newValue: { targetId: input.targetId, allow: input.allow.toString(), deny: input.deny.toString() } }],
  });

  // Channel visibility may have changed for many members.
  bus().refreshGuild?.(guildId);
}

export async function deleteChannelOverwrite(
  guildId: string,
  channelId: string,
  targetId: string,
  actorId: string,
): Promise<void> {
  const ctx = await loadMemberContext(guildId, actorId);
  if ((ctx.basePermissions & Permissions.MANAGE_ROLES) !== Permissions.MANAGE_ROLES) {
    throw Errors.MISSING_PERMISSIONS({ permission: "MANAGE_ROLES" });
  }
  const channel = await requireChannelRow(channelId);
  if (channel.guild_id !== guildId) throw Errors.UNKNOWN_CHANNEL();

  await execute(`DELETE FROM channel_overwrites WHERE channel_id = $1 AND target_id = $2`, [channelId, targetId]);
  await writeAuditLog({
    guildId,
    actionType: AuditLogActionType.CHANNEL_OVERWRITE_DELETE,
    actorId,
    targetId: channelId,
    changes: [{ key: "targetId", oldValue: targetId }],
  });
  bus().refreshGuild?.(guildId);
}

// ---------------------------------------------------------------------------
// Direct messages
// ---------------------------------------------------------------------------

export async function listDmRecipients(channelId: string) {
  const rows = await query<UserRow>(
    `SELECT u.id, u.username, u.discriminator, u.display_name, u.avatar_key, u.banner_key, u.accent_color,
            u.bio, u.bot, u.premium_type, u.email, u.email_verified, u.flags, u.created_at
       FROM dm_recipients r JOIN users u ON u.id = r.user_id
      WHERE r.channel_id = $1 ORDER BY r.joined_at ASC`,
    [channelId],
  );
  return rows.map(toPublicUser);
}

/**
 * Fan out a DM channel change to every recipient: emit `eventFor(userId)` to
 * each user's room (so sidebars refresh live) and keep their connected sockets
 * subscribed to the channel room (so messages arrive in realtime without
 * waiting for a reconnect).
 */
export async function notifyDmRecipients(
  channelId: string,
  eventFor: (userId: string) => ServerEventName,
  buildPayload: () => unknown,
): Promise<void> {
  const recipients = await listDmRecipients(channelId);
  if (recipients.length === 0) return;
  const payload = buildPayload();
  for (const recipient of recipients) {
    bus().toUser(recipient.id, eventFor(recipient.id), payload);
    await bus().joinUserToChannel(recipient.id, channelId);
  }
}

/**
 * Wire view of a DM channel without a membership check — for building mutation
 * responses and fan-out payloads for users other than the actor (including
 * users the actor just removed, who can no longer "view" the channel).
 */
export async function getDmChannelView(channelId: string): Promise<WireChannel | null> {
  const row = await requireChannelRow(channelId);
  if (row.guild_id !== null) return null;
  return toChannel(row, { permissions: ALL_PERMISSIONS, recipients: await listDmRecipients(channelId) });
}

/** Find or create the 1:1 DM channel between two users. */
export async function getOrCreateDmChannel(userAId: string, userBId: string): Promise<ChannelRowFull> {
  if (userAId === userBId) throw Errors.CANNOT_DM_SELF();

  // A block in either direction prevents starting a conversation.
  if (await isBlockedBetween(userAId, userBId)) throw Errors.BLOCKED();

  const existing = await queryOne<ChannelRowFull>(
    `SELECT ${CHANNEL_COLUMNS.split(",")
      .map((c) => `c.${c.trim()}`)
      .join(", ")}
       FROM channels c
      WHERE c.type = 1
        AND (SELECT COUNT(*) FROM dm_recipients r WHERE r.channel_id = c.id) = 2
        AND EXISTS (SELECT 1 FROM dm_recipients r WHERE r.channel_id = c.id AND r.user_id = $1)
        AND EXISTS (SELECT 1 FROM dm_recipients r WHERE r.channel_id = c.id AND r.user_id = $2)
      LIMIT 1`,
    [userAId, userBId],
  );
  if (existing) {
    await execute(`UPDATE channels SET dm_closed = FALSE WHERE id = $1`, [existing.id]);
    return existing;
  }

  return withTransaction(async (tx) => {
    const id = nextId();
    const inserted = await tx.query<ChannelRowFull>(
      `INSERT INTO channels (id, guild_id, type, dm_closed) VALUES ($1, NULL, 1, FALSE) RETURNING ${CHANNEL_COLUMNS}`,
      [id],
    );
    await tx.query(`INSERT INTO dm_recipients (channel_id, user_id) VALUES ($1, $2), ($1, $3)`, [
      id,
      userAId,
      userBId,
    ]);
    const row = inserted.rows[0];
    if (!row) throw Errors.INTERNAL(undefined, "Failed to create DM channel");
    return row;
  });
}

export async function createGroupDm(ownerId: string, userIds: string[]): Promise<ChannelRowFull> {
  const unique = [...new Set([ownerId, ...userIds])];
  if (unique.length < 2) throw Errors.VALIDATION_FAILED(undefined, "A group DM needs at least two people.");
  if (unique.length > 10) throw Errors.VALIDATION_FAILED(undefined, "Group DMs support at most 10 people.");
  await assertUsersExist(unique);
  await assertNoBlockedPairs(unique);

  return withTransaction(async (tx) => {
    const id = nextId();
    const inserted = await tx.query<ChannelRowFull>(
      `INSERT INTO channels (id, guild_id, type, owner_id) VALUES ($1, NULL, 3, $2) RETURNING ${CHANNEL_COLUMNS}`,
      [id, ownerId],
    );
    for (const userId of unique) {
      await tx.query(`INSERT INTO dm_recipients (channel_id, user_id) VALUES ($1, $2)`, [id, userId]);
    }
    const row = inserted.rows[0];
    if (!row) throw Errors.INTERNAL(undefined, "Failed to create group DM");
    return row;
  });
}

async function isDmRecipient(channelId: string, userId: string): Promise<boolean> {
  const row = await queryOne(`SELECT 1 FROM dm_recipients WHERE channel_id = $1 AND user_id = $2`, [
    channelId,
    userId,
  ]);
  return Boolean(row);
}

/** Throw UNKNOWN_USER when any of the given user ids does not exist. */
async function assertUsersExist(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const rows = await query<{ id: string }>(`SELECT id FROM users WHERE id = ANY($1::bigint[])`, [userIds]);
  if (rows.length !== new Set(userIds).size) throw Errors.UNKNOWN_USER();
}

/** Throw BLOCKED when any two of the given users have a block in either direction. */
async function assertNoBlockedPairs(userIds: string[]): Promise<void> {
  if (userIds.length < 2) return;
  const row = await queryOne<{ blocked: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM relationships
        WHERE type = 2 AND user_id = ANY($1::bigint[]) AND target_id = ANY($1::bigint[])
     ) AS blocked`,
    [userIds],
  );
  if (row?.blocked) throw Errors.BLOCKED();
}

/**
 * Add a user to an existing group DM. Only current recipients may add people,
 * groups are capped at 10 participants, and a block in either direction
 * between the new user and any existing member prevents the add. Realtime
 * fan-out (CHANNEL_CREATE / CHANNEL_UPDATE + room joins) is the caller's job.
 */
export async function addGroupDmRecipient(
  channelId: string,
  actorId: string,
  targetUserId: string,
): Promise<ChannelRowFull> {
  const row = await requireChannelRow(channelId);
  if (row.guild_id !== null || row.type !== ChannelType.GROUP_DM) throw Errors.UNKNOWN_CHANNEL();
  if (!(await isDmRecipient(channelId, actorId))) throw Errors.CHANNEL_NOT_ACCESSIBLE();
  if (targetUserId === actorId) throw Errors.VALIDATION_FAILED(undefined, "You are already in this group DM.");

  const target = await queryOne<{ bot: boolean }>(`SELECT bot FROM users WHERE id = $1`, [targetUserId]);
  if (!target) throw Errors.UNKNOWN_USER();
  if (target.bot) throw Errors.VALIDATION_FAILED(undefined, "Bots cannot be added to group DMs.");
  if (await isDmRecipient(channelId, targetUserId)) {
    throw Errors.VALIDATION_FAILED(undefined, "That user is already in this group DM.");
  }
  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM dm_recipients WHERE channel_id = $1`,
    [channelId],
  );
  if (Number(countRow?.count ?? "0") + 1 > 10) {
    throw Errors.VALIDATION_FAILED(undefined, "Group DMs support at most 10 people.");
  }
  const current = await query<{ user_id: string }>(
    `SELECT user_id FROM dm_recipients WHERE channel_id = $1`,
    [channelId],
  );
  await assertNoBlockedPairs([...current.map((r) => r.user_id), targetUserId]);
  await execute(`INSERT INTO dm_recipients (channel_id, user_id) VALUES ($1, $2)`, [channelId, targetUserId]);
  // Timeline entry so members see who joined and when.
  const { createSystemMessage } = await import("./messages.js");
  await createSystemMessage({
    channelId,
    authorId: actorId,
    type: MessageType.RECIPIENT_ADD,
    content: `added ${await userLabel(targetUserId)}.`,
  });
  return row;
}

export interface RemoveGroupDmResult {
  channel: ChannelRowFull;
  removedUserId: string;
  /** Recipients remaining after the removal (empty when the group closed). */
  memberIds: string[];
  /** True when the group dropped below two participants and was closed for everyone. */
  closed: boolean;
}

/**
 * Remove a participant from a group DM. Anyone may remove themselves (leave);
 * removing somebody else requires ownership. When fewer than two participants
 * would remain, the group is closed for everyone (dm_closed) — messages are
 * preserved but the conversation disappears from every sidebar.
 */
export async function removeGroupDmRecipient(
  channelId: string,
  actorId: string,
  targetUserId: string,
): Promise<RemoveGroupDmResult> {
  const row = await requireChannelRow(channelId);
  if (row.guild_id !== null || row.type !== ChannelType.GROUP_DM) throw Errors.UNKNOWN_CHANNEL();
  if (!(await isDmRecipient(channelId, actorId))) throw Errors.CHANNEL_NOT_ACCESSIBLE();
  if (!(await isDmRecipient(channelId, targetUserId))) {
    throw Errors.VALIDATION_FAILED(undefined, "That user is not in this group DM.");
  }
  if (actorId !== targetUserId && row.owner_id !== actorId) {
    throw Errors.MISSING_PERMISSIONS({ permission: "GROUP_DM_OWNER" });
  }

  return withTransaction(async (tx) => {
    await tx.query(`DELETE FROM dm_recipients WHERE channel_id = $1 AND user_id = $2`, [channelId, targetUserId]);
    const remaining = await tx.query<{ user_id: string }>(
      `SELECT user_id FROM dm_recipients WHERE channel_id = $1 ORDER BY joined_at ASC, user_id ASC`,
      [channelId],
    );
    const memberIds = remaining.rows.map((r) => r.user_id);
    let closed = false;
    if (memberIds.length < 2) {
      await tx.query(`UPDATE channels SET dm_closed = TRUE WHERE id = $1`, [channelId]);
      closed = true;
    } else if (row.owner_id === targetUserId) {
      // The owner left: hand ownership to the longest-standing member.
      await tx.query(`UPDATE channels SET owner_id = $2 WHERE id = $1`, [channelId, memberIds[0]]);
    }
    const updated = await tx.query<ChannelRowFull>(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = $1`, [
      channelId,
    ]);
    const channel = updated.rows[0];
    if (!channel) throw Errors.INTERNAL(undefined, "Group DM disappeared while updating it");
    return { channel, removedUserId: targetUserId, memberIds, closed };
  }).then(async (result) => {
    // Timeline entry for a removal, unless the group just closed for everyone
    // (in which case nobody will see the conversation again).
    if (!result.closed) {
      const { createSystemMessage } = await import("./messages.js");
      await createSystemMessage({
        channelId,
        authorId: actorId,
        type: MessageType.RECIPIENT_REMOVE,
        content:
          actorId === targetUserId ? "left the group." : `removed ${await userLabel(targetUserId)}.`,
      });
    }
    return result;
  });
}

/** Display label for a user id (display name, falling back to username). */
async function userLabel(userId: string): Promise<string> {
  const row = await queryOne<{ display_name: string | null; username: string }>(
    `SELECT display_name, username FROM users WHERE id = $1`,
    [userId],
  );
  return row?.display_name ?? row?.username ?? "someone";
}

export async function listDmChannels(userId: string): Promise<WireChannel[]> {
  const rows = await query<ChannelRowFull & { last_created_at: Date | null }>(
    `SELECT ${CHANNEL_COLUMNS.split(",")
      .map((c) => `c.${c.trim()}`)
      .join(", ")}, m.last_created_at
       FROM channels c
       JOIN dm_recipients r ON r.channel_id = c.id AND r.user_id = $1
       LEFT JOIN LATERAL (
         SELECT MAX(created_at) AS last_created_at FROM messages WHERE channel_id = c.id AND deleted_at IS NULL
       ) m ON TRUE
      WHERE c.guild_id IS NULL
        AND c.dm_closed = FALSE
      ORDER BY COALESCE(m.last_created_at, c.created_at) DESC
      LIMIT 200`,
    [userId],
  );

  const out: WireChannel[] = [];
  for (const row of rows) {
    out.push(toChannel(row, { permissions: ALL_PERMISSIONS, recipients: await listDmRecipients(row.id) }));
  }
  return out;
}

export async function closeDmChannel(channelId: string, userId: string): Promise<void> {
  const recipient = await queryOne(`SELECT 1 FROM dm_recipients WHERE channel_id = $1 AND user_id = $2`, [
    channelId,
    userId,
  ]);
  if (!recipient) throw Errors.CHANNEL_NOT_ACCESSIBLE();
  await execute(`UPDATE channels SET dm_closed = TRUE WHERE id = $1`, [channelId]);
}

/** Persist a new last_message_id for a channel (used for sorting/unread). */
export async function setLastMessageId(client: Queryable, channelId: string, messageId: string): Promise<void> {
  await client.query(`UPDATE channels SET last_message_id = $2 WHERE id = $1`, [channelId, messageId]);
}
