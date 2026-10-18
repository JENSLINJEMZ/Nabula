import {
  AuditLogActionType,
  ChannelType,
  Errors,
  Limits,
  Permissions,
  ServerEvents,
} from "@nebula/shared";
import { nextId } from "../ids.js";
import { execute, query, queryOne } from "../db/pool.js";
import { bus } from "../realtime/bus.js";
import { writeAuditLog } from "./audit.js";
import { requireChannelRow, slugifyChannelName } from "./channels.js";
import { toChannel, type ChannelRowFull } from "./mappers.js";
import { assertChannelAccess, loadMemberContext } from "./permissions.js";

const CHANNEL_COLUMNS = `id, guild_id, type, name, topic, position, parent_id, nsfw, rate_limit_per_user,
  user_limit, bitrate, last_message_id, owner_id, default_auto_archive_duration, thread_message_count,
  dm_closed, created_at`;

export interface CreateThreadInput {
  name: string;
  type?: typeof ChannelType.PUBLIC_THREAD | typeof ChannelType.PRIVATE_THREAD;
  /** When created from a message, the message becomes the thread starter. */
  messageId?: string | null;
  autoArchiveDuration?: number;
}

/**
 * Create a thread under a text/announcement channel. Authorization mirrors
 * Discord: PUBLIC_THREAD needs CREATE_PUBLIC_THREADS, PRIVATE_THREAD needs
 * CREATE_PRIVATE_THREADS.
 */
export async function createThread(parentChannelId: string, creatorId: string, input: CreateThreadInput) {
  const parent = await requireChannelRow(parentChannelId);
  if (
    parent.type !== ChannelType.GUILD_TEXT &&
    parent.type !== ChannelType.GUILD_ANNOUNCEMENT &&
    parent.type !== ChannelType.GUILD_FORUM
  ) {
    throw Errors.VALIDATION_FAILED(undefined, "Threads can only be created in text, announcement or forum channels.");
  }
  if (!parent.guild_id) throw Errors.VALIDATION_FAILED(undefined, "Threads require a guild channel.");

  const threadType = input.type ?? ChannelType.PUBLIC_THREAD;
  const required =
    threadType === ChannelType.PRIVATE_THREAD ? Permissions.CREATE_PRIVATE_THREADS : Permissions.CREATE_PUBLIC_THREADS;

  const ctx = await loadMemberContext(parent.guild_id, creatorId);
  // Effective channel permission check (overwrites may remove thread creation).
  const access = await assertChannelAccess(parentChannelId, creatorId, Permissions.VIEW_CHANNEL);
  if (((ctx.basePermissions | access.permissions) & required) !== required) {
    throw Errors.MISSING_PERMISSIONS({ permission: required === Permissions.CREATE_PUBLIC_THREADS ? "CREATE_PUBLIC_THREADS" : "CREATE_PRIVATE_THREADS" });
  }

  const name = slugifyChannelName(input.name) || "thread";
  const autoArchive = Limits.AUTO_ARCHIVE_DURATIONS.includes(
    (input.autoArchiveDuration ?? 1440) as (typeof Limits.AUTO_ARCHIVE_DURATIONS)[number],
  )
    ? input.autoArchiveDuration ?? 1440
    : 1440;

  const id = nextId();
  const row = await queryOne<ChannelRowFull>(
    `INSERT INTO channels (id, guild_id, type, name, position, parent_id, owner_id,
                           thread_archive_timestamp, default_auto_archive_duration)
     VALUES ($1, $2, $3, $4, 0, $5, $6, now() + ($7::int * interval '1 minute'), $7::int)
     RETURNING ${CHANNEL_COLUMNS}`,
    [id, parent.guild_id, threadType, name, parentChannelId, creatorId, autoArchive],
  );
  if (!row) throw Errors.INTERNAL(undefined, "Failed to create thread");

  await execute(`INSERT INTO thread_members (thread_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
    id,
    creatorId,
  ]);

  if (input.messageId) {
    const message = await queryOne<{ id: string; channel_id: string }>(
      `SELECT id, channel_id FROM messages WHERE id = $1 AND deleted_at IS NULL`,
      [input.messageId],
    );
    if (!message || message.channel_id !== parentChannelId) {
      throw Errors.VALIDATION_FAILED({ field: "messageId" }, "Thread starter message must be in the parent channel.");
    }
    await execute(
      `UPDATE messages SET flags = flags | 32, reference_channel_id = $2, type = 21 WHERE id = $1`,
      [input.messageId, id],
    );
    // Mirror the promoted thread-starter message to the parent channel so
    // clients render the "Thread" affordance without a reload. Dynamic import
    // avoids a static cycle (messages.ts -> channels.ts -> threads.ts).
    const { assembleMessages, getMessageRow } = await import("./messages.js");
    const starterRow = await getMessageRow(input.messageId);
    if (starterRow) {
      const assembled = (await assembleMessages(creatorId, [starterRow]))[0];
      if (assembled) bus().toChannel(parentChannelId, ServerEvents.MESSAGE_UPDATE, assembled);
    }
  }

  await writeAuditLog({
    guildId: parent.guild_id,
    actionType: AuditLogActionType.CHANNEL_CREATE,
    actorId: creatorId,
    targetId: id,
    changes: [{ key: "type", newValue: "thread" }],
  });

  const channel = toChannel(row, { permissions: access.permissions });
  bus().toGuild(parent.guild_id, ServerEvents.CHANNEL_CREATE, channel);
  return channel;
}

export async function listThreadsForChannel(channelId: string, userId: string) {
  const parent = await requireChannelRow(channelId);
  if (!parent.guild_id) return [];
  await assertChannelAccess(channelId, userId, Permissions.VIEW_CHANNEL);

  const rows = await query<ChannelRowFull>(
    `SELECT ${CHANNEL_COLUMNS} FROM channels
      WHERE parent_id = $1 AND type IN (11, 12)
      ORDER BY COALESCE(last_message_id, id) DESC LIMIT 100`,
    [channelId],
  );

  const ctx = await loadMemberContext(parent.guild_id, userId);
  const visible: ChannelRowFull[] = [];
  for (const row of rows) {
    if (row.type === ChannelType.PRIVATE_THREAD) {
      const member = await queryOne(`SELECT 1 FROM thread_members WHERE thread_id = $1 AND user_id = $2`, [
        row.id,
        userId,
      ]);
      if (!member && row.owner_id !== userId) continue;
    }
    visible.push(row);
  }
  const { computeChannelsWithPermissions } = await import("./channels.js");
  return computeChannelsWithPermissions(ctx, visible);
}

export async function joinThread(threadId: string, userId: string) {
  const thread = await requireChannelRow(threadId);
  if (thread.type !== ChannelType.PUBLIC_THREAD && thread.type !== ChannelType.PRIVATE_THREAD) {
    throw Errors.VALIDATION_FAILED(undefined, "That channel is not a thread.");
  }
  await assertChannelAccess(threadId, userId, Permissions.VIEW_CHANNEL);
  await execute(`INSERT INTO thread_members (thread_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
    threadId,
    userId,
  ]);
  await execute(`UPDATE channels SET thread_archived = FALSE WHERE id = $1`, [threadId]);
  return thread;
}

export async function leaveThread(threadId: string, userId: string) {
  const thread = await requireChannelRow(threadId);
  if (thread.owner_id === userId) {
    throw Errors.FORBIDDEN(undefined, "The thread owner cannot leave their own thread.");
  }
  await execute(`DELETE FROM thread_members WHERE thread_id = $1 AND user_id = $2`, [threadId, userId]);
}

export async function archiveThread(threadId: string, actorId: string, archived = true) {
  const thread = await requireChannelRow(threadId);
  if (!thread.guild_id) throw Errors.UNKNOWN_CHANNEL();
  const ctx = await loadMemberContext(thread.guild_id, actorId);
  const isOwner = thread.owner_id === actorId;
  const canManage = (ctx.basePermissions & Permissions.MANAGE_THREADS) === Permissions.MANAGE_THREADS;
  if (!isOwner && !canManage) throw Errors.MISSING_PERMISSIONS({ permission: "MANAGE_THREADS" });

  await execute(
    `UPDATE channels SET thread_archived = $2, thread_archive_timestamp = now() WHERE id = $1`,
    [threadId, archived],
  );
  const updated = await requireChannelRow(threadId);
  const channel = toChannel(updated);
  bus().toGuild(thread.guild_id, ServerEvents.CHANNEL_UPDATE, channel);
  return channel;
}

export async function getThreadMembers(threadId: string) {
  const rows = await query<{ user_id: string; join_timestamp: Date }>(
    `SELECT user_id, join_timestamp FROM thread_members WHERE thread_id = $1 ORDER BY join_timestamp ASC LIMIT 100`,
    [threadId],
  );
  return rows.map((r) => ({ userId: r.user_id, joinTimestamp: r.join_timestamp.toISOString() }));
}
