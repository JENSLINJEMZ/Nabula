import { createHash, randomBytes } from "node:crypto";
import { AuditLogActionType, Errors, Permissions, ServerEvents } from "@nebula/shared";
import { nextId } from "../ids.js";
import { execute, query, queryOne, withTransaction, txQuery } from "../db/pool.js";
import { bus } from "../realtime/bus.js";
import { writeAuditLog } from "./audit.js";
import { requireChannelRow, setLastMessageId } from "./channels.js";
import { assembleMessages, getMessageRow, type MessageRow } from "./messages.js";
import { loadMemberContext, tryChannelAccess } from "./permissions.js";
import { createUser } from "./users.js";

export interface WebhookRow {
  id: string;
  guild_id: string | null;
  channel_id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  avatar_key: string | null;
  creator_id: string | null;
  bot_user_id?: string | null;
  created_at: Date;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateWebhookToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Create a webhook. A dedicated bot user is created to author its messages so
 * rendering (author name/avatar) is consistent with normal messages. The raw
 * token is returned exactly once; only its SHA-256 is stored.
 */
export async function createWebhook(
  guildId: string,
  channelId: string,
  actorId: string,
  input: { name: string; avatarKey?: string | null },
): Promise<{ webhook: WebhookRow; token: string }> {
  const ctx = await loadMemberContext(guildId, actorId);
  if ((ctx.basePermissions & Permissions.MANAGE_WEBHOOKS) !== Permissions.MANAGE_WEBHOOKS) {
    throw Errors.MISSING_PERMISSIONS({ permission: "MANAGE_WEBHOOKS" });
  }
  const channel = await requireChannelRow(channelId);
  if (channel.guild_id !== guildId) throw Errors.UNKNOWN_CHANNEL();

  const name = input.name.trim().slice(0, 80) || "webhook";
  const token = generateWebhookToken();

  const botUser = await createUser({
    username: `${name.replace(/[^A-Za-z0-9_.]/g, "_").slice(0, 20) || "webhook"}bot`,
    password: randomBytes(24).toString("hex"),
    bot: true,
    displayName: name,
  });

  const webhookId = nextId();
  const row = await queryOne<WebhookRow>(
    `INSERT INTO webhooks (id, guild_id, channel_id, name, token_hash, token_prefix, avatar_key, creator_id, bot_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, guild_id, channel_id, name, token_hash, token_prefix, avatar_key, creator_id, created_at`,
    [webhookId, guildId, channelId, name, hashToken(token), token.slice(0, 8), input.avatarKey ?? null, actorId, botUser.id],
  );
  if (!row) throw Errors.INTERNAL(undefined, "Failed to create webhook");

  await writeAuditLog({
    guildId,
    actionType: AuditLogActionType.WEBHOOK_CREATE,
    actorId,
    targetId: webhookId,
    changes: [{ key: "name", newValue: name }],
  });

  return { webhook: row, token };
}

export async function listChannelWebhooks(guildId: string, channelId: string, actorId: string) {
  const ctx = await loadMemberContext(guildId, actorId);
  if ((ctx.basePermissions & Permissions.MANAGE_WEBHOOKS) !== Permissions.MANAGE_WEBHOOKS) {
    throw Errors.MISSING_PERMISSIONS({ permission: "MANAGE_WEBHOOKS" });
  }
  const rows = await query<WebhookRow>(
    `SELECT id, guild_id, channel_id, name, token_hash, token_prefix, avatar_key, creator_id, created_at
       FROM webhooks WHERE guild_id = $1 AND channel_id = $2 ORDER BY created_at ASC`,
    [guildId, channelId],
  );
  // Never expose the token hash.
  return rows.map((r) => ({ ...r, token_hash: "" }));
}

export async function deleteWebhook(guildId: string, webhookId: string, actorId: string) {
  const ctx = await loadMemberContext(guildId, actorId);
  if ((ctx.basePermissions & Permissions.MANAGE_WEBHOOKS) !== Permissions.MANAGE_WEBHOOKS) {
    throw Errors.MISSING_PERMISSIONS({ permission: "MANAGE_WEBHOOKS" });
  }
  const webhook = await queryOne<{ bot_user_id: string | null }>(
    `SELECT bot_user_id FROM webhooks WHERE id = $1 AND guild_id = $2`,
    [webhookId, guildId],
  );
  if (!webhook) throw Errors.NOT_FOUND(undefined, "Unknown webhook.");

  await withTransaction(async (tx) => {
    await txQuery(tx, `DELETE FROM webhooks WHERE id = $1`, [webhookId]);
    if (webhook.bot_user_id) {
      // Disable rather than delete: historical messages reference this author.
      await txQuery(tx, `UPDATE users SET disabled = TRUE, disabled_reason = 'webhook_removed' WHERE id = $1`, [
        webhook.bot_user_id,
      ]);
    }
  });

  await writeAuditLog({
    guildId,
    actionType: AuditLogActionType.WEBHOOK_DELETE,
    actorId,
    targetId: webhookId,
  });
}

export async function resolveWebhook(webhookId: string, token: string): Promise<WebhookRow & { bot_user_id: string }> {
  if (!token || token.length < 20) throw Errors.UNAUTHENTICATED(undefined, "Invalid webhook token.");
  const row = await queryOne<WebhookRow & { bot_user_id: string | null }>(
    `SELECT id, guild_id, channel_id, name, token_hash, token_prefix, avatar_key, creator_id, bot_user_id, created_at
       FROM webhooks WHERE id = $1`,
    [webhookId],
  );
  if (!row || !row.bot_user_id) throw Errors.NOT_FOUND(undefined, "Unknown webhook.");
  const provided = Buffer.from(hashToken(token));
  const stored = Buffer.from(row.token_hash);
  if (provided.length !== stored.length) throw Errors.UNAUTHENTICATED(undefined, "Invalid webhook token.");
  const { timingSafeEqual } = await import("node:crypto");
  if (!timingSafeEqual(provided, stored)) throw Errors.UNAUTHENTICATED(undefined, "Invalid webhook token.");
  return { ...row, bot_user_id: row.bot_user_id };
}

export interface ExecuteWebhookInput {
  content: string;
  username?: string | null;
  tts?: boolean;
  threadId?: string | null;
}

/**
 * Execute a webhook. Authorization is the token itself (bearer capability), so no
 * user permission check applies — but the webhook's channel must still exist and
 * the token must match.
 */
export async function executeWebhook(webhookId: string, token: string, input: ExecuteWebhookInput) {
  const webhook = await resolveWebhook(webhookId, token);
  const content = (input.content ?? "").slice(0, 2000);
  if (!content.trim()) throw Errors.MESSAGE_EMPTY();

  await requireChannelRow(webhook.channel_id);

  const messageId = nextId();
  await withTransaction(async (tx) => {
    await txQuery(
      tx,
      `INSERT INTO messages (id, channel_id, guild_id, author_id, content, tts, webhook_id, flags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
      [messageId, webhook.channel_id, webhook.guild_id, webhook.bot_user_id, content, input.tts ?? false, webhookId],
    );
    await setLastMessageId(tx as never, webhook.channel_id, messageId);
  });

  const row = (await getMessageRow(messageId)) as MessageRow;
  const assembled = (await assembleMessages(webhook.bot_user_id, [row]))[0];
  if (!assembled) throw Errors.INTERNAL(undefined, "Failed to assemble webhook message");

  const payload = input.username ? { ...assembled, webhookName: input.username } : assembled;
  bus().toChannel(webhook.channel_id, ServerEvents.MESSAGE_CREATE, payload);
  return payload;
}

/** Used to verify a viewer may see a webhook's channel before listing. */
export async function assertWebhookChannelVisible(channelId: string, userId: string) {
  const access = await tryChannelAccess(channelId, userId);
  if (!access) throw Errors.CHANNEL_NOT_ACCESSIBLE();
  return access;
}

export { execute as _execute };
