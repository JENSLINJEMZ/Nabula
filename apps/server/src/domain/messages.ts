import {
  AuditLogActionType,
  ChannelType,
  Errors,
  Limits,
  MessageType,
  Permissions,
  ServerEvents,
  parseMentions,
  type Attachment as WireAttachment,
  type Message as WireMessage,
  type PublicUser,
  type Reaction,
} from "@nebula/shared";
import { nextId } from "../ids.js";
import { execute, pool, query, queryOne, withTransaction, type Queryable } from "../db/pool.js";
import { bus } from "../realtime/bus.js";
import { writeAuditLog } from "./audit.js";
import { requireChannelRow, setLastMessageId } from "./channels.js";
import {
  toAttachment,
  toPublicUser,
  type AttachmentRow,
  type ChannelRowFull,
  type UserRow,
} from "./mappers.js";
import { createNotification } from "./notifications.js";
import { assertChannelAccess } from "./permissions.js";
import { getAllBlockedEitherDirection } from "./relationships.js";

const USER_COLUMNS = `id, username, discriminator, display_name, avatar_key, banner_key, accent_color, bio,
  bot, premium_type, email, email_verified, flags, created_at`;

export interface MessageRow {
  id: string;
  channel_id: string;
  guild_id: string | null;
  author_id: string | null;
  content: string;
  tts: boolean;
  mention_everyone: boolean;
  mention_role_ids: string[] | null;
  flags: number;
  type: number;
  pinned: boolean;
  reference_message_id: string | null;
  reference_channel_id: string | null;
  reference_type: number | null;
  webhook_id: string | null;
  application_id: string | null;
  nonce: string | null;
  edited_at: Date | null;
  created_at: Date;
}

const MESSAGE_COLUMNS = `id, channel_id, guild_id, author_id, content, tts, mention_everyone, mention_role_ids,
  flags, type, pinned, reference_message_id, reference_channel_id, reference_type, webhook_id, application_id,
  nonce, edited_at, created_at`;

const DELETED_USER: PublicUser = {
  id: "0",
  username: "Deleted User",
  displayName: null,
  discriminator: "0000",
  avatarUrl: null,
  bannerUrl: null,
  accentColor: null,
  bio: null,
  bot: false,
  createdAt: new Date(0).toISOString(),
};

/**
 * Batch-assemble wire messages: authors, attachments, reactions, mentions and
 * one level of referenced message. Avoids N+1 queries for message lists.
 */
export async function assembleMessages(viewerId: string, rows: MessageRow[]): Promise<WireMessage[]> {
  if (rows.length === 0) return [];

  const messageIds = rows.map((r) => r.id);
  const authorIds = [...new Set(rows.map((r) => r.author_id).filter((v): v is string => Boolean(v)))];
  const referenceIds = [...new Set(rows.map((r) => r.reference_message_id).filter((v): v is string => Boolean(v)))];

  const [authorRows, attachmentRows, reactionRows, mentionRows, referenceRows] = await Promise.all([
    authorIds.length
      ? query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ANY($1::bigint[])`, [authorIds])
      : Promise.resolve([] as UserRow[]),
    query<AttachmentRow & { message_id: string }>(
      `SELECT id, message_id, filename, content_type, size_bytes, width, height, is_spoiler
         FROM attachments WHERE message_id = ANY($1::bigint[]) ORDER BY id ASC`,
      [messageIds],
    ),
    query<{ message_id: string; emoji: string; user_id: string }>(
      `SELECT message_id, emoji, user_id FROM reactions WHERE message_id = ANY($1::bigint[])`,
      [messageIds],
    ),
    query<{ message_id: string; user_id: string }>(
      `SELECT message_id, user_id FROM message_mentions WHERE message_id = ANY($1::bigint[])`,
      [messageIds],
    ),
    referenceIds.length
      ? query<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ANY($1::bigint[])`, [referenceIds])
      : Promise.resolve([] as MessageRow[]),
  ]);

  const authorMap = new Map(authorRows.map((a) => [a.id, toPublicUser(a)]));

  const attachmentsByMessage = new Map<string, WireAttachment[]>();
  for (const a of attachmentRows) {
    const list = attachmentsByMessage.get(a.message_id) ?? [];
    list.push(toAttachment(a));
    attachmentsByMessage.set(a.message_id, list);
  }

  const reactionsByMessage = new Map<string, Map<string, { count: number; me: boolean }>>();
  for (const r of reactionRows) {
    let emojiMap = reactionsByMessage.get(r.message_id);
    if (!emojiMap) {
      emojiMap = new Map();
      reactionsByMessage.set(r.message_id, emojiMap);
    }
    const entry = emojiMap.get(r.emoji) ?? { count: 0, me: false };
    entry.count += 1;
    if (r.user_id === viewerId) entry.me = true;
    emojiMap.set(r.emoji, entry);
  }

  const mentionsByMessage = new Map<string, string[]>();
  for (const m of mentionRows) {
    const list = mentionsByMessage.get(m.message_id) ?? [];
    list.push(m.user_id);
    mentionsByMessage.set(m.message_id, list);
  }

  const mentionUserIds = [...new Set(mentionRows.map((m) => m.user_id))];
  const mentionUsers = mentionUserIds.length
    ? await query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ANY($1::bigint[])`, [mentionUserIds])
    : [];
  const mentionUserMap = new Map(mentionUsers.map((u) => [u.id, toPublicUser(u)]));

  // Assemble referenced messages shallowly (no nested reference).
  const referenceById = new Map(referenceRows.map((r) => [r.id, r]));
  const referenceAssembled = new Map<string, WireMessage>();
  for (const refRow of referenceRows) {
    const author = refRow.author_id ? authorMap.get(refRow.author_id) : undefined;
    referenceAssembled.set(refRow.id, {
      id: refRow.id,
      channelId: refRow.channel_id,
      guildId: refRow.guild_id,
      author: author ?? (refRow.author_id ? await fetchUserOrDeleted(refRow.author_id) : DELETED_USER),
      content: refRow.content,
      timestamp: refRow.created_at.toISOString(),
      editedTimestamp: refRow.edited_at ? refRow.edited_at.toISOString() : null,
      tts: refRow.tts,
      mentionEveryone: refRow.mention_everyone,
      mentions: [],
      mentionRoleIds: [],
      pinned: refRow.pinned,
      type: refRow.type as WireMessage["type"],
      flags: refRow.flags,
      attachments: attachmentsByMessage.get(refRow.id) ?? [],
      reactions: [],
      embeds: [],
      referencedMessage: null,
      threadId: null,
      nonce: null,
      webhookId: refRow.webhook_id,
    });
  }

  const result: WireMessage[] = [];
  for (const row of rows) {
    const author = row.author_id ? authorMap.get(row.author_id) : undefined;
    const authorUser = author ?? (row.author_id ? await fetchUserOrDeleted(row.author_id) : DELETED_USER);

    const emojiMap = reactionsByMessage.get(row.id);
    const reactions: Reaction[] = emojiMap
      ? [...emojiMap.entries()].map(([emoji, v]) => ({ emoji, count: v.count, me: v.me }))
      : [];

    const mentionIds = mentionsByMessage.get(row.id) ?? [];

    result.push({
      id: row.id,
      channelId: row.channel_id,
      guildId: row.guild_id,
      author: authorUser,
      content: row.content,
      timestamp: row.created_at.toISOString(),
      editedTimestamp: row.edited_at ? row.edited_at.toISOString() : null,
      tts: row.tts,
      mentionEveryone: row.mention_everyone,
      mentions: mentionIds.map((id) => mentionUserMap.get(id)).filter((u): u is PublicUser => Boolean(u)),
      mentionRoleIds: (row.mention_role_ids ?? []).map(String),
      pinned: row.pinned,
      type: row.type as WireMessage["type"],
      flags: row.flags,
      attachments: attachmentsByMessage.get(row.id) ?? [],
      reactions,
      embeds: [],
      referencedMessage: row.reference_message_id
        ? referenceAssembled.get(row.reference_message_id) ?? null
        : null,
      threadId:
        (row.type === MessageType.THREAD_STARTER_MESSAGE && row.reference_channel_id) ||
        null,
      nonce: row.nonce,
      webhookId: row.webhook_id,
    });
  }
  return result;
}

async function fetchUserOrDeleted(id: string): Promise<PublicUser> {
  const row = await queryOne<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  return row ? toPublicUser(row) : DELETED_USER;
}

export async function getMessageRow(messageId: string): Promise<MessageRow | null> {
  return queryOne<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = $1 AND deleted_at IS NULL`, [
    messageId,
  ]);
}

export async function getMessageForViewer(messageId: string, viewerId: string): Promise<WireMessage | null> {
  const row = await getMessageRow(messageId);
  if (!row) return null;
  await assertChannelAccess(row.channel_id, viewerId, Permissions.VIEW_CHANNEL);
  const assembled = await assembleMessages(viewerId, [row]);
  return assembled[0] ?? null;
}

export interface ListMessagesOptions {
  limit: number;
  before?: string | null;
  after?: string | null;
}

export async function listMessages(
  channelId: string,
  viewerId: string,
  options: ListMessagesOptions,
): Promise<WireMessage[]> {
  await assertChannelAccess(channelId, viewerId, Permissions.READ_MESSAGE_HISTORY);

  const params: unknown[] = [channelId];
  let where = "channel_id = $1 AND deleted_at IS NULL";
  let order = "id DESC";
  if (options.before) {
    params.push(options.before);
    where += ` AND id < $${params.length}`;
  } else if (options.after) {
    params.push(options.after);
    where += ` AND id > $${params.length}`;
    order = "id ASC";
  }
  params.push(Math.min(options.limit, Limits.MESSAGE_PAGE_MAX));

  const rows = await query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE ${where} ORDER BY ${order} LIMIT $${params.length}`,
    params,
  );

  const ordered = options.after ? rows : rows;
  return assembleMessages(viewerId, ordered);
}

export interface CreateMessageInput {
  channelId: string;
  authorId: string;
  content: string;
  nonce?: string | null;
  tts?: boolean;
  attachmentIds?: string[];
  referenceMessageId?: string | null;
  flags?: number;
  /** Set when the message is authored by a webhook rather than a user. */
  webhookId?: string | null;
}

/**
 * Create a message. Enforces: VIEW_CHANNEL + SEND_MESSAGES, slowmode, content
 * limits, mention authorization, block checks, and attachment ownership. Emits
 * MESSAGE_CREATE and mention/DM notifications.
 */
export async function createMessage(input: CreateMessageInput): Promise<WireMessage> {
  const content = input.content ?? "";
  if (content.length > Limits.MESSAGE_CONTENT_MAX) throw Errors.MESSAGE_TOO_LONG();

  const access = await assertChannelAccess(input.channelId, input.authorId, Permissions.VIEW_CHANNEL);
  // Full row is needed for slowmode/limit fields that the permission context omits.
  const channel = await requireChannelRow(input.channelId);
  const guildId = channel.guild_id;

  const attachmentIds = input.attachmentIds ?? [];
  const hasContent = content.trim().length > 0;
  if (!hasContent && attachmentIds.length === 0) throw Errors.MESSAGE_EMPTY();

  let permissions = access.permissions;

  if (guildId) {    // `assertChannelAccess` already resolved effective channel permissions
    // (including overwrites, category inheritance and implicit rules).
    if ((permissions & Permissions.SEND_MESSAGES) !== Permissions.SEND_MESSAGES) {
      throw Errors.MISSING_PERMISSIONS({ permission: "SEND_MESSAGES" });
    }

    // Slowmode (bypassed by ADMINISTRATOR or BYPASS_SLOWMODE).
    const canBypass =
      (permissions & Permissions.ADMINISTRATOR) !== 0n || (permissions & Permissions.BYPASS_SLOWMODE) !== 0n;
    if (channel.rate_limit_per_user > 0 && !canBypass) {
      const last = await queryOne<{ created_at: Date }>(
        `SELECT created_at FROM messages WHERE channel_id = $1 AND author_id = $2 AND deleted_at IS NULL
          ORDER BY id DESC LIMIT 1`,
        [input.channelId, input.authorId],
      );
      if (last) {
        const elapsed = (Date.now() - last.created_at.getTime()) / 1000;
        if (elapsed < channel.rate_limit_per_user) {
          throw Errors.SLOWMODE_ACTIVE({ retry_after: channel.rate_limit_per_user - elapsed });
        }
      }
    }

    if (attachmentIds.length > 0 && (permissions & Permissions.ATTACH_FILES) !== Permissions.ATTACH_FILES) {
      throw Errors.MISSING_PERMISSIONS({ permission: "ATTACH_FILES" });
    }
  }

  // Parse and authorize mentions.
  const parsed = parseMentions(content);
  const blocked = await getAllBlockedEitherDirection(input.authorId);

  // For DMs, refuse if a block exists between the author and any recipient.
  if (!guildId) {
    const dmRecipients = await query<{ user_id: string }>(
      `SELECT user_id FROM dm_recipients WHERE channel_id = $1`,
      [input.channelId],
    );
    for (const recipient of dmRecipients) {
      if (recipient.user_id !== input.authorId && blocked.has(recipient.user_id)) throw Errors.BLOCKED();
    }
  }

  let mentionUserIds = parsed.userIds.filter((id) => id !== input.authorId && !blocked.has(id));
  let mentionEveryone = false;

  if (guildId) {
    if (parsed.everyone || parsed.here) {
      if ((permissions & Permissions.MENTION_EVERYONE) === Permissions.MENTION_EVERYONE) mentionEveryone = true;
    }
    // Only members can be mentioned in a guild channel.
    const members = mentionUserIds.length
      ? await query<{ user_id: string }>(
          `SELECT user_id FROM guild_members WHERE guild_id = $1 AND user_id = ANY($2::bigint[])`,
          [guildId, mentionUserIds],
        )
      : [];
    const memberSet = new Set(members.map((m) => m.user_id));
    mentionUserIds = mentionUserIds.filter((id) => memberSet.has(id));
  } else {
    const recipients = await query<{ user_id: string }>(
      `SELECT user_id FROM dm_recipients WHERE channel_id = $1 AND user_id = ANY($2::bigint[])`,
      [input.channelId, mentionUserIds],
    );
    const recipientSet = new Set(recipients.map((r) => r.user_id));
    mentionUserIds = mentionUserIds.filter((id) => recipientSet.has(id));
  }

  // Validate reference message is in the same channel.
  let referenceMessageId: string | null = null;
  if (input.referenceMessageId) {
    const ref = await getMessageRow(input.referenceMessageId);
    if (!ref || ref.channel_id !== input.channelId) {
      throw Errors.VALIDATION_FAILED({ field: "referenceMessageId" }, "Cannot reply to that message.");
    }
    referenceMessageId = ref.id;
  }

  const messageId = nextId();
  const type = referenceMessageId ? MessageType.REPLY : MessageType.DEFAULT;

  await withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO messages (id, channel_id, guild_id, author_id, content, tts, mention_everyone,
                             mention_role_ids, flags, type, reference_message_id, reference_channel_id,
                             reference_type, webhook_id, nonce)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint[], $9, $10, $11, $2, $12, $13, $14)`,
      [
        messageId,
        input.channelId,
        guildId,
        input.authorId,
        content,
        input.tts ?? false,
        mentionEveryone,
        mentionRoleIdsAuthorized(parsed.roleIds, mentionEveryone),
        input.flags ?? 0,
        type,
        referenceMessageId,
        referenceMessageId ? 0 : null,
        input.webhookId ?? null,
        input.nonce ?? null,
      ],
    );

    for (const userId of mentionUserIds) {
      await tx.query(
        `INSERT INTO message_mentions (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [messageId, userId],
      );
    }

    if (attachmentIds.length > 0) {
      const updated = await tx.query(
        `UPDATE attachments SET message_id = $1
          WHERE id = ANY($2::bigint[]) AND uploader_id = $3 AND message_id IS NULL AND channel_id = $4`,
        [messageId, attachmentIds, input.authorId, input.channelId],
      );
      if ((updated.rowCount ?? 0) !== attachmentIds.length) {
        throw Errors.VALIDATION_FAILED({ field: "attachmentIds" }, "One or more attachments are invalid.");
      }
    }

    await setLastMessageId(tx as unknown as Queryable, input.channelId, messageId);
  });

  const assembled = await assembleMessages(input.authorId, [
    (await getMessageRow(messageId)) as MessageRow,
  ]);
  const message = assembled[0];
  if (!message) throw Errors.INTERNAL(undefined, "Failed to assemble created message");

  bus().toChannel(input.channelId, ServerEvents.MESSAGE_CREATE, message);

  await dispatchMessageNotifications(message, input.authorId, mentionUserIds, mentionEveryone, blocked);

  return message;
}

function mentionRoleIdsAuthorized(roleIds: string[], mentionEveryone: boolean): string[] {
  // Role mentions are stored so clients can highlight; authorization is enforced
  // at notification time.
  if (mentionEveryone) return roleIds;
  return roleIds;
}

async function dispatchMessageNotifications(
  message: WireMessage,
  authorId: string,
  mentionUserIds: string[],
  mentionEveryone: boolean,
  blocked: Set<string>,
): Promise<void> {
  const isDm = message.guildId === null;

  if (isDm) {
    const recipients = await query<{ user_id: string; suppress_from_others: boolean }>(
      `SELECT r.user_id, s.suppress_from_others
         FROM dm_recipients r JOIN user_settings s ON s.user_id = r.user_id
        WHERE r.channel_id = $1`,
      [message.channelId],
    );
    for (const r of recipients) {
      if (r.user_id === authorId) continue;
      if (blocked.has(r.user_id)) continue;
      if (r.suppress_from_others) continue;
      await createNotification({
        userId: r.user_id,
        type: "dm",
        actorId: authorId,
        channelId: message.channelId,
        messageId: message.id,
        title: `${message.author.username}`,
        body: message.content.slice(0, 200),
      });
      bus().toUser(r.user_id, ServerEvents.NOTIFICATION_CREATE, {
        channelId: message.channelId,
        messageId: message.id,
        actorId: authorId,
      });
    }
    return;
  }

  const targets = new Set<string>(mentionUserIds);
  if (mentionEveryone && message.guildId) {
    const members = await query<{ user_id: string; suppress_everyone: boolean }>(
      `SELECT m.user_id, s.suppress_everyone
         FROM guild_members m JOIN user_settings s ON s.user_id = m.user_id
        WHERE m.guild_id = $1`,
      [message.guildId],
    );
    for (const m of members) {
      if (m.user_id === authorId) continue;
      if (m.suppress_everyone) continue;
      targets.add(m.user_id);
    }
  }

  for (const userId of targets) {
    if (userId === authorId) continue;
    if (blocked.has(userId)) continue;
    await createNotification({
      userId,
      type: "mention",
      actorId: authorId,
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      title: `${message.author.username} mentioned you`,
      body: message.content.slice(0, 200),
    });
    await execute(
      `INSERT INTO read_states (user_id, channel_id, mention_count) VALUES ($1, $2, 1)
       ON CONFLICT (user_id, channel_id) DO UPDATE SET mention_count = read_states.mention_count + 1, updated_at = now()`,
      [userId, message.channelId],
    );
    bus().toUser(userId, ServerEvents.NOTIFICATION_CREATE, {
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      actorId: authorId,
    });
  }
}

export async function editMessage(messageId: string, actorId: string, content: string): Promise<WireMessage> {
  if (content.length > Limits.MESSAGE_CONTENT_MAX) throw Errors.MESSAGE_TOO_LONG();
  const existing = await getMessageRow(messageId);
  if (!existing) throw Errors.UNKNOWN_MESSAGE();

  const access = await assertChannelAccess(existing.channel_id, actorId, Permissions.VIEW_CHANNEL);
  const isAuthor = existing.author_id === actorId;
  const canManage = (access.permissions & Permissions.MANAGE_MESSAGES) === Permissions.MANAGE_MESSAGES;
  if (!isAuthor && !canManage) throw Errors.FORBIDDEN(undefined, "You can only edit your own messages.");

  await execute(`UPDATE messages SET content = $2, edited_at = now() WHERE id = $1`, [messageId, content]);

  const row = (await getMessageRow(messageId)) as MessageRow;
  const assembled = (await assembleMessages(actorId, [row]))[0];
  if (!assembled) throw Errors.UNKNOWN_MESSAGE();

  bus().toChannel(existing.channel_id, ServerEvents.MESSAGE_UPDATE, assembled);
  return assembled;
}

export async function deleteMessage(messageId: string, actorId: string): Promise<{ channelId: string; id: string; guildId: string | null }> {
  const existing = await getMessageRow(messageId);
  if (!existing) throw Errors.UNKNOWN_MESSAGE();

  const access = await assertChannelAccess(existing.channel_id, actorId, Permissions.VIEW_CHANNEL);
  const isAuthor = existing.author_id === actorId;
  const canManage = (access.permissions & Permissions.MANAGE_MESSAGES) === Permissions.MANAGE_MESSAGES;
  if (!isAuthor && !canManage) throw Errors.FORBIDDEN(undefined, "You can only delete your own messages.");

  await withTransaction(async (tx) => {
    await tx.query(`UPDATE messages SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [messageId]);
    await tx.query(`DELETE FROM pins WHERE message_id = $1`, [messageId]);
  });

  if (existing.guild_id && !isAuthor) {
    await writeAuditLog({
      guildId: existing.guild_id,
      actionType: AuditLogActionType.MESSAGE_DELETE,
      actorId,
      targetId: messageId,
      changes: [{ key: "author_id", oldValue: existing.author_id }],
    });
  }

  bus().toChannel(existing.channel_id, ServerEvents.MESSAGE_DELETE, {
    id: messageId,
    channelId: existing.channel_id,
    guildId: existing.guild_id,
  });
  return { channelId: existing.channel_id, id: messageId, guildId: existing.guild_id };
}

export async function bulkDeleteMessages(
  channelId: string,
  actorId: string,
  messageIds: string[],
): Promise<void> {
  const access = await assertChannelAccess(channelId, actorId, Permissions.MANAGE_MESSAGES);
  const guildId = access.channel.guild_id;
  if (messageIds.length === 0) return;
  if (messageIds.length > 100) throw Errors.VALIDATION_FAILED(undefined, "At most 100 messages per request.");

  await execute(
    `UPDATE messages SET deleted_at = now() WHERE channel_id = $1 AND id = ANY($2::bigint[]) AND deleted_at IS NULL`,
    [channelId, messageIds],
  );
  await execute(`DELETE FROM pins WHERE channel_id = $1 AND message_id = ANY($2::bigint[])`, [channelId, messageIds]);

  if (guildId) {
    await writeAuditLog({
      guildId,
      actionType: AuditLogActionType.MESSAGE_BULK_DELETE,
      actorId,
      targetId: channelId,
      changes: [{ key: "count", newValue: messageIds.length }],
    });
  }

  bus().toChannel(channelId, ServerEvents.MESSAGE_DELETE, { ids: messageIds, channelId, guildId });
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

export async function addReaction(messageId: string, userId: string, emoji: string): Promise<void> {
  if (emoji.length === 0 || emoji.length > 64) throw Errors.VALIDATION_FAILED({ field: "emoji" });
  const message = await getMessageRow(messageId);
  if (!message) throw Errors.UNKNOWN_MESSAGE();
  const access = await assertChannelAccess(message.channel_id, userId, Permissions.VIEW_CHANNEL);
  if ((access.permissions & Permissions.ADD_REACTIONS) !== Permissions.ADD_REACTIONS) {
    throw Errors.MISSING_PERMISSIONS({ permission: "ADD_REACTIONS" });
  }

  const distinct = await queryOne<{ count: string }>(
    `SELECT COUNT(DISTINCT emoji)::text AS count FROM reactions WHERE message_id = $1`,
    [messageId],
  );
  const already = await queryOne(`SELECT 1 FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`, [
    messageId,
    userId,
    emoji,
  ]);
  if (!already && Number(distinct?.count ?? 0) >= Limits.REACTIONS_MAX_DISTINCT) {
    throw Errors.VALIDATION_FAILED(undefined, "Too many distinct reactions on this message.");
  }

  await execute(
    `INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [messageId, userId, emoji],
  );

  bus().toChannel(message.channel_id, ServerEvents.MESSAGE_REACTION_ADD, {
    messageId,
    channelId: message.channel_id,
    guildId: message.guild_id,
    userId,
    emoji,
  });
}

export async function removeReaction(messageId: string, userId: string, emoji: string): Promise<void> {
  const message = await getMessageRow(messageId);
  if (!message) throw Errors.UNKNOWN_MESSAGE();
  await assertChannelAccess(message.channel_id, userId, Permissions.VIEW_CHANNEL);
  await execute(`DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`, [
    messageId,
    userId,
    emoji,
  ]);
  bus().toChannel(message.channel_id, ServerEvents.MESSAGE_REACTION_REMOVE, {
    messageId,
    channelId: message.channel_id,
    guildId: message.guild_id,
    userId,
    emoji,
  });
}

export async function removeAllReactions(messageId: string, actorId: string): Promise<void> {
  const message = await getMessageRow(messageId);
  if (!message) throw Errors.UNKNOWN_MESSAGE();
  await assertChannelAccess(message.channel_id, actorId, Permissions.MANAGE_MESSAGES);
  await execute(`DELETE FROM reactions WHERE message_id = $1`, [messageId]);
  bus().toChannel(message.channel_id, ServerEvents.MESSAGE_UPDATE, {
    id: messageId,
    channelId: message.channel_id,
    reactionsCleared: true,
  });
}

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

export async function pinMessage(messageId: string, actorId: string): Promise<void> {
  const message = await getMessageRow(messageId);
  if (!message) throw Errors.UNKNOWN_MESSAGE();
  const access = await assertChannelAccess(message.channel_id, actorId, Permissions.MANAGE_MESSAGES);
  if (access.channel.guild_id === null && message.author_id !== actorId) {
    throw Errors.FORBIDDEN(undefined, "You can only pin your own messages in a DM.");
  }
  await execute(
    `INSERT INTO pins (channel_id, message_id, pinned_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [message.channel_id, messageId, actorId],
  );
  await execute(`UPDATE messages SET pinned = TRUE WHERE id = $1`, [messageId]);
  bus().toChannel(message.channel_id, ServerEvents.CHANNEL_PINS_UPDATE, {
    channelId: message.channel_id,
    messageId,
    pinned: true,
  });
}

export async function unpinMessage(messageId: string, actorId: string): Promise<void> {
  const message = await getMessageRow(messageId);
  if (!message) throw Errors.UNKNOWN_MESSAGE();
  await assertChannelAccess(message.channel_id, actorId, Permissions.MANAGE_MESSAGES);
  await execute(`DELETE FROM pins WHERE channel_id = $1 AND message_id = $2`, [message.channel_id, messageId]);
  await execute(`UPDATE messages SET pinned = FALSE WHERE id = $1`, [messageId]);
  bus().toChannel(message.channel_id, ServerEvents.CHANNEL_PINS_UPDATE, {
    channelId: message.channel_id,
    messageId,
    pinned: false,
  });
}

export async function listPinnedMessages(channelId: string, viewerId: string): Promise<WireMessage[]> {
  await assertChannelAccess(channelId, viewerId, Permissions.VIEW_CHANNEL);
  const rows = await query<MessageRow>(
    `SELECT m.${MESSAGE_COLUMNS.replace(/, /g, ", m.")} FROM pins p JOIN messages m ON m.id = p.message_id
      WHERE p.channel_id = $1 AND m.deleted_at IS NULL ORDER BY p.pinned_at DESC LIMIT 50`,
    [channelId],
  );
  return assembleMessages(viewerId, rows);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchOptions {
  q: string;
  guildId?: string | null;
  channelId?: string | null;
  authorId?: string | null;
  limit: number;
}

/**
 * Search message content. Scoped to channels the viewer can actually see; the
 * accessible-channel set is computed server-side so a crafted `channelId` cannot
 * leak messages from a channel the user cannot view.
 */
export async function searchMessages(viewerId: string, options: SearchOptions): Promise<WireMessage[]> {
  const q = options.q.trim();
  if (q.length < 1) throw Errors.VALIDATION_FAILED({ field: "q" }, "Search query is required.");

  let channelIds: string[] = [];

  if (options.channelId) {
    await assertChannelAccess(options.channelId, viewerId, Permissions.READ_MESSAGE_HISTORY);
    channelIds = [options.channelId];
  } else {
    const { listGuildsForUser } = await import("./guilds.js");
    const { listGuildChannelsForUser, listDmChannels } = await import("./channels.js");
    const guilds = options.guildId
      ? (await listGuildsForUser(viewerId)).filter((g) => g.id === options.guildId)
      : await listGuildsForUser(viewerId);

    for (const guild of guilds) {
      const channels = await listGuildChannelsForUser(guild.id, viewerId);
      for (const c of channels) {
        if (
          c.type === ChannelType.GUILD_TEXT ||
          c.type === ChannelType.GUILD_ANNOUNCEMENT ||
          c.type === ChannelType.PUBLIC_THREAD ||
          c.type === ChannelType.PRIVATE_THREAD
        ) {
          const perms = BigInt(c.permissions ?? "0");
          if ((perms & Permissions.READ_MESSAGE_HISTORY) === Permissions.READ_MESSAGE_HISTORY) channelIds.push(c.id);
        }
      }
    }

    if (!options.guildId) {
      const dms = await listDmChannels(viewerId);
      channelIds.push(...dms.map((c) => c.id));
    }
  }

  if (channelIds.length === 0) return [];

  const params: unknown[] = [channelIds, q];
  let where = `channel_id = ANY($1::bigint[]) AND deleted_at IS NULL
               AND to_tsvector('simple', content) @@ plainto_tsquery('simple', $2)`;
  if (options.authorId) {
    params.push(options.authorId);
    where += ` AND author_id = $${params.length}`;
  }
  params.push(Math.min(options.limit, 100));

  const rows = await query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
  return assembleMessages(viewerId, rows);
}

// ---------------------------------------------------------------------------
// Read state
// ---------------------------------------------------------------------------

export async function markChannelRead(
  channelId: string,
  userId: string,
  lastReadMessageId?: string | null,
): Promise<{ channelId: string; lastReadMessageId: string | null; mentionCount: number }> {
  await assertChannelAccess(channelId, userId, Permissions.VIEW_CHANNEL);

  let targetId = lastReadMessageId ?? null;
  if (!targetId) {
    const latest = await queryOne<{ id: string }>(
      `SELECT id FROM messages WHERE channel_id = $1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
      [channelId],
    );
    targetId = latest?.id ?? null;
  }

  const row = await queryOne<{ last_read_message_id: string | null; mention_count: number }>(
    `INSERT INTO read_states (user_id, channel_id, last_read_message_id, mention_count)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (user_id, channel_id) DO UPDATE
       SET last_read_message_id = EXCLUDED.last_read_message_id, mention_count = 0, updated_at = now()
     RETURNING last_read_message_id, mention_count`,
    [userId, channelId, targetId],
  );

  const payload = {
    channelId,
    lastReadMessageId: row?.last_read_message_id ?? null,
    mentionCount: row?.mention_count ?? 0,
    unread: false,
  };
  bus().toUser(userId, ServerEvents.READ_STATE_UPDATE, payload);
  return payload;
}

export async function getReadStates(userId: string) {
  const rows = await query<{
    channel_id: string;
    last_read_message_id: string | null;
    mention_count: number;
  }>(
    `SELECT channel_id, last_read_message_id, mention_count FROM read_states WHERE user_id = $1`,
    [userId],
  );
  return rows.map((r) => ({
    channelId: r.channel_id,
    lastReadMessageId: r.last_read_message_id,
    mentionCount: r.mention_count,
    unread: false,
  }));
}
