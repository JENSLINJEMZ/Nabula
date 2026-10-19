import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  AuditLogActionType,
  Errors,
  Limits,
  Permissions,
  ServerEvents,
  normalizeEmbeds,
  type Embed,
  type Webhook as WireWebhook,
  type WebhookDelivery as WireWebhookDelivery,
} from "@nebula/shared";
import { nextId } from "../ids.js";
import { execute, query, queryOne, withTransaction, txQuery } from "../db/pool.js";
import { bus } from "../realtime/bus.js";
import { writeAuditLog } from "./audit.js";
import { requireChannelRow, setLastMessageId } from "./channels.js";
import { media } from "./mappers.js";
import { assembleMessages, getMessageRow, type MessageRow } from "./messages.js";
import { loadMemberContext, tryChannelAccess } from "./permissions.js";
import { createUser, updateProfile } from "./users.js";

/**
 * Channel webhooks.
 *
 * A webhook is a bearer capability: the token is the credential, so it is never
 * returned after creation/rotation and only its SHA-256 is stored. Message
 * content and embeds are validated before persistence; embeds are never fetched
 * from the network (no outbound HTTP, no SSRF).
 */

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
  disabled: boolean;
  rotated_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}

const WEBHOOK_COLUMNS = `id, guild_id, channel_id, name, token_hash, token_prefix, avatar_key, creator_id,
  bot_user_id, disabled, rotated_at, last_used_at, created_at`;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateWebhookToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Wire projection — never includes the token hash or the raw token. */
export function toWireWebhook(row: WebhookRow): WireWebhook {
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    avatarUrl: row.avatar_key ? media.avatar(row.avatar_key) : null,
    creatorId: row.creator_id,
    disabled: row.disabled,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
    rotatedAt: row.rotated_at ? row.rotated_at.toISOString() : null,
  };
}

async function requireManageWebhooks(guildId: string, actorId: string) {
  const ctx = await loadMemberContext(guildId, actorId);
  if ((ctx.basePermissions & Permissions.MANAGE_WEBHOOKS) !== Permissions.MANAGE_WEBHOOKS) {
    throw Errors.MISSING_PERMISSIONS({ permission: "MANAGE_WEBHOOKS" });
  }
  return ctx;
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
): Promise<{ webhook: WireWebhook; token: string }> {
  await requireManageWebhooks(guildId, actorId);
  const channel = await requireChannelRow(channelId);
  if (channel.guild_id !== guildId) throw Errors.UNKNOWN_CHANNEL();

  const name = input.name.trim().slice(0, 80) || "webhook";
  const token = generateWebhookToken();

  const botUser = await createUser({
    username: `${name.replace(/[^A-Za-z0-9_.]/g, "_").slice(0, 16) || "webhook"}_${randomBytes(4).toString("hex")}`,
    password: randomBytes(24).toString("hex"),
    bot: true,
    displayName: name,
  });
  const botUserId = botUser.id;
  if (input.avatarKey) await updateProfile(botUserId, { avatarKey: input.avatarKey });

  const webhookId = nextId();
  const row = await queryOne<WebhookRow>(
    `INSERT INTO webhooks (id, guild_id, channel_id, name, token_hash, token_prefix, avatar_key, creator_id, bot_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${WEBHOOK_COLUMNS}`,
    [webhookId, guildId, channelId, name, hashToken(token), token.slice(0, 8), input.avatarKey ?? null, actorId, botUserId],
  );
  if (!row) throw Errors.INTERNAL(undefined, "Failed to create webhook");

  await writeAuditLog({
    guildId,
    actionType: AuditLogActionType.WEBHOOK_CREATE,
    actorId,
    targetId: webhookId,
    changes: [{ key: "name", newValue: name }],
  });

  return { webhook: toWireWebhook(row), token };
}

export async function listChannelWebhooks(
  guildId: string,
  channelId: string,
  actorId: string,
): Promise<WireWebhook[]> {
  await requireManageWebhooks(guildId, actorId);
  const rows = await query<WebhookRow>(
    `SELECT ${WEBHOOK_COLUMNS} FROM webhooks
      WHERE guild_id = $1 AND channel_id = $2 ORDER BY created_at ASC`,
    [guildId, channelId],
  );
  return rows.map(toWireWebhook);
}

export interface UpdateWebhookInput {
  name?: string;
  avatarKey?: string | null;
  disabled?: boolean;
}

export async function updateWebhook(
  guildId: string,
  webhookId: string,
  actorId: string,
  input: UpdateWebhookInput,
): Promise<WireWebhook> {
  await requireManageWebhooks(guildId, actorId);
  const webhook = await queryOne<WebhookRow>(
    `SELECT ${WEBHOOK_COLUMNS} FROM webhooks WHERE id = $1 AND guild_id = $2`,
    [webhookId, guildId],
  );
  if (!webhook) throw Errors.NOT_FOUND(undefined, "Unknown webhook.");

  const changes: Array<{ key: string; oldValue?: unknown; newValue?: unknown }> = [];
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (input.name !== undefined) {
    const name = input.name.trim().slice(0, 80);
    if (!name) throw Errors.VALIDATION_FAILED({ field: "name" }, "Webhook name cannot be empty.");
    sets.push(`name = $${i++}`);
    params.push(name);
    changes.push({ key: "name", oldValue: webhook.name, newValue: name });
  }
  if (input.avatarKey !== undefined) {
    sets.push(`avatar_key = $${i++}`);
    params.push(input.avatarKey);
    changes.push({ key: "avatar", oldValue: webhook.avatar_key, newValue: input.avatarKey });
  }
  if (input.disabled !== undefined) {
    sets.push(`disabled = $${i++}`);
    params.push(input.disabled);
    changes.push({ key: "disabled", oldValue: webhook.disabled, newValue: input.disabled });
  }
  if (sets.length === 0) throw Errors.VALIDATION_FAILED(undefined, "Nothing to update.");

  params.push(webhookId);
  const row = await queryOne<WebhookRow>(
    `UPDATE webhooks SET ${sets.join(", ")} WHERE id = $${i} RETURNING ${WEBHOOK_COLUMNS}`,
    params,
  );
  if (!row) throw Errors.INTERNAL(undefined, "Failed to update webhook");

  // Keep the bot author's display name / avatar in sync for future messages.
  if (webhook.bot_user_id) {
    const patch: { displayName?: string; avatarKey?: string | null } = {};
    if (input.name !== undefined) patch.displayName = input.name.trim().slice(0, 80);
    if (input.avatarKey !== undefined) patch.avatarKey = input.avatarKey;
    if (Object.keys(patch).length > 0) await updateProfile(webhook.bot_user_id, patch);
  }

  await writeAuditLog({
    guildId,
    actionType: AuditLogActionType.WEBHOOK_UPDATE,
    actorId,
    targetId: webhookId,
    changes,
  });
  return toWireWebhook(row);
}

/** Rotate a webhook's secret. The previous token stops working immediately. */
export async function rotateWebhookToken(
  guildId: string,
  webhookId: string,
  actorId: string,
): Promise<{ webhook: WireWebhook; token: string }> {
  await requireManageWebhooks(guildId, actorId);
  const webhook = await queryOne<WebhookRow>(
    `SELECT ${WEBHOOK_COLUMNS} FROM webhooks WHERE id = $1 AND guild_id = $2`,
    [webhookId, guildId],
  );
  if (!webhook) throw Errors.NOT_FOUND(undefined, "Unknown webhook.");

  const token = generateWebhookToken();
  const row = await queryOne<WebhookRow>(
    `UPDATE webhooks SET token_hash = $1, token_prefix = $2, rotated_at = now()
      WHERE id = $3 RETURNING ${WEBHOOK_COLUMNS}`,
    [hashToken(token), token.slice(0, 8), webhookId],
  );
  if (!row) throw Errors.INTERNAL(undefined, "Failed to rotate webhook token");

  await writeAuditLog({
    guildId,
    actionType: AuditLogActionType.WEBHOOK_UPDATE,
    actorId,
    targetId: webhookId,
    changes: [{ key: "token", oldValue: webhook.token_prefix, newValue: row.token_prefix }],
  });

  return { webhook: toWireWebhook(row), token };
}

export async function deleteWebhook(guildId: string, webhookId: string, actorId: string): Promise<void> {
  await requireManageWebhooks(guildId, actorId);
  const webhook = await queryOne<{ bot_user_id: string | null; name: string }>(
    `SELECT bot_user_id, name FROM webhooks WHERE id = $1 AND guild_id = $2`,
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
    changes: [{ key: "name", oldValue: webhook.name }],
  });
}

export async function listWebhookDeliveries(
  guildId: string,
  webhookId: string,
  actorId: string,
  options: { limit: number },
): Promise<WireWebhookDelivery[]> {
  await requireManageWebhooks(guildId, actorId);
  const webhook = await queryOne<{ id: string }>(`SELECT id FROM webhooks WHERE id = $1 AND guild_id = $2`, [
    webhookId,
    guildId,
  ]);
  if (!webhook) throw Errors.NOT_FOUND(undefined, "Unknown webhook.");

  const rows = await query<{
    id: string;
    webhook_id: string;
    message_id: string | null;
    status_code: number;
    success: boolean;
    error: string | null;
    created_at: Date;
  }>(
    `SELECT id, webhook_id, message_id, status_code, success, error, created_at
       FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY id DESC LIMIT $2`,
    [webhookId, options.limit],
  );
  return rows.map((row) => ({
    id: row.id,
    webhookId: row.webhook_id,
    messageId: row.message_id,
    statusCode: row.status_code,
    success: row.success,
    error: row.error,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function resolveWebhook(webhookId: string, token: string): Promise<WebhookRow & { bot_user_id: string }> {
  if (!token || token.length < 20) throw Errors.UNAUTHENTICATED(undefined, "Invalid webhook token.");
  const row = await queryOne<WebhookRow>(
    `SELECT ${WEBHOOK_COLUMNS} FROM webhooks WHERE id = $1`,
    [webhookId],
  );
  if (!row || !row.bot_user_id) throw Errors.NOT_FOUND(undefined, "Unknown webhook.");
  if (row.disabled) throw Errors.FORBIDDEN(undefined, "This webhook is disabled.");

  const provided = Buffer.from(hashToken(token));
  const stored = Buffer.from(row.token_hash);
  if (provided.length !== stored.length) throw Errors.UNAUTHENTICATED(undefined, "Invalid webhook token.");
  if (!timingSafeEqual(provided, stored)) throw Errors.UNAUTHENTICATED(undefined, "Invalid webhook token.");
  return { ...row, bot_user_id: row.bot_user_id };
}

export interface ExecuteWebhookInput {
  content?: string | null;
  username?: string | null;
  tts?: boolean;
  threadId?: string | null;
  embeds?: unknown;
  idempotencyKey?: string | null;
}

export interface ExecuteWebhookResult {
  message: unknown;
  duplicate: boolean;
}

// Per-webhook sliding-window delivery limit (defence in depth; the HTTP layer
// additionally rate-limits by source address).
const WEBHOOK_WINDOW_MS = 10_000;
const WEBHOOK_MAX_PER_WINDOW = 30;
const webhookTimes = new Map<string, number[]>();

function assertWebhookRateLimit(webhookId: string): void {
  const now = Date.now();
  const recent = (webhookTimes.get(webhookId) ?? []).filter((t) => now - t < WEBHOOK_WINDOW_MS);
  if (recent.length >= WEBHOOK_MAX_PER_WINDOW) {
    webhookTimes.set(webhookId, recent);
    throw Errors.RATE_LIMITED({ retryAfterMs: WEBHOOK_WINDOW_MS - (now - (recent[0] ?? now)) });
  }
  recent.push(now);
  webhookTimes.set(webhookId, recent);
}

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : 500;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "Delivery failed";
}

async function recordDelivery(input: {
  webhookId: string;
  messageId?: string | null;
  statusCode: number;
  success: boolean;
  error?: string | null;
}): Promise<void> {
  await execute(
    `INSERT INTO webhook_deliveries (id, webhook_id, message_id, status_code, success, error)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [nextId(), input.webhookId, input.messageId ?? null, input.statusCode, input.success, input.error ?? null],
  );
}

/**
 * Shared delivery core for both token-authenticated execution and the
 * permission-checked management "test delivery" path. The caller must have
 * already resolved and authorized the webhook.
 *
 * `idempotencyKey` makes retries safe: the key is reserved before the message is
 * created, so a repeated delivery returns the original message instead of
 * posting a duplicate.
 */
async function deliverResolvedWebhook(
  webhook: WebhookRow & { bot_user_id: string },
  input: ExecuteWebhookInput,
): Promise<ExecuteWebhookResult> {
  const botUserId = webhook.bot_user_id;
  const webhookId = webhook.id;
  let reservationId: string | null = null;

  try {
    const normalized = normalizeEmbeds(input.embeds);
    if (normalized.error) throw Errors.VALIDATION_FAILED({ field: "embeds" }, normalized.error);
    const embeds: Embed[] = normalized.embeds;

    const content = (input.content ?? "").slice(0, Limits.MESSAGE_CONTENT_MAX);
    if (!content.trim() && embeds.length === 0) throw Errors.MESSAGE_EMPTY();

    const username = input.username ? input.username.trim().slice(0, 80) : null;
    const idempotencyKey = input.idempotencyKey ?? null;

    if (idempotencyKey) {
      reservationId = nextId();
      const inserted = await execute(
        `INSERT INTO webhook_deliveries (id, webhook_id, status_code, success, error, idempotency_key)
         VALUES ($1, $2, 0, FALSE, 'in_progress', $3)
         ON CONFLICT (webhook_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
        [reservationId, webhookId, idempotencyKey],
      );
      if (inserted === 0) {
        reservationId = null;
        const prior = await queryOne<{ message_id: string | null }>(
          `SELECT message_id FROM webhook_deliveries WHERE webhook_id = $1 AND idempotency_key = $2 LIMIT 1`,
          [webhookId, idempotencyKey],
        );
        if (prior?.message_id) {
          const existingRow = await getMessageRow(prior.message_id);
          if (existingRow) {
            const assembled = (await assembleMessages(botUserId, [existingRow]))[0];
            if (assembled) return { message: assembled, duplicate: true };
          }
        }
        throw Errors.VALIDATION_FAILED(
          { field: "idempotencyKey" },
          "A delivery with this idempotency key is already in progress.",
        );
      }
    }

    assertWebhookRateLimit(webhookId);
    await requireChannelRow(webhook.channel_id);

    const messageId = nextId();
    await withTransaction(async (tx) => {
      await txQuery(
        tx,
        `INSERT INTO messages (id, channel_id, guild_id, author_id, content, tts, webhook_id, flags, embeds, webhook_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8::jsonb, $9)`,
        [
          messageId,
          webhook.channel_id,
          webhook.guild_id,
          botUserId,
          content,
          input.tts ?? false,
          webhookId,
          JSON.stringify(embeds),
          username,
        ],
      );
      await setLastMessageId(tx as never, webhook.channel_id, messageId);
    });

    if (reservationId) {
      await execute(
        `UPDATE webhook_deliveries SET status_code = 200, success = TRUE, error = NULL, message_id = $2 WHERE id = $1`,
        [reservationId, messageId],
      );
    } else {
      await recordDelivery({ webhookId, messageId, statusCode: 200, success: true });
    }
    await execute(`UPDATE webhooks SET last_used_at = now() WHERE id = $1`, [webhookId]);

    const row = (await getMessageRow(messageId)) as MessageRow;
    const assembled = (await assembleMessages(botUserId, [row]))[0];
    if (!assembled) throw Errors.INTERNAL(undefined, "Failed to assemble webhook message");

    bus().toChannel(webhook.channel_id, ServerEvents.MESSAGE_CREATE, assembled);
    return { message: assembled, duplicate: false };
  } catch (error) {
    if (reservationId) {
      // Release the reservation so a corrected retry can proceed.
      await execute(`DELETE FROM webhook_deliveries WHERE id = $1`, [reservationId]).catch(() => undefined);
    }
    await recordDelivery({
      webhookId,
      statusCode: statusOf(error),
      success: false,
      error: messageOf(error),
    }).catch(() => undefined);
    throw error;
  }
}

/**
 * Execute a webhook by token. Authorization is the token itself (bearer
 * capability), so no user permission check applies — but the webhook must exist,
 * be enabled, and the token must match.
 */
export async function executeWebhook(
  webhookId: string,
  token: string,
  input: ExecuteWebhookInput,
): Promise<ExecuteWebhookResult> {
  const webhook = await resolveWebhook(webhookId, token);
  return deliverResolvedWebhook(webhook, input);
}

/**
 * Management "test delivery": post a sample message through an existing webhook
 * using its stored secret, so operators can verify a destination without ever
 * seeing the token. Requires MANAGE_WEBHOOKS and works even while the webhook is
 * disabled, so a misconfiguration can be diagnosed before re-enabling.
 */
export async function testWebhook(
  guildId: string,
  webhookId: string,
  actorId: string,
): Promise<ExecuteWebhookResult> {
  await requireManageWebhooks(guildId, actorId);
  const row = await queryOne<WebhookRow>(
    `SELECT ${WEBHOOK_COLUMNS} FROM webhooks WHERE id = $1 AND guild_id = $2`,
    [webhookId, guildId],
  );
  if (!row || !row.bot_user_id) throw Errors.NOT_FOUND(undefined, "Unknown webhook.");
  return deliverResolvedWebhook(
    { ...row, bot_user_id: row.bot_user_id },
    { content: "Test delivery from the Nebula webhook console." },
  );
}

/** Used to verify a viewer may see a webhook's channel before listing. */
export async function assertWebhookChannelVisible(channelId: string, userId: string) {
  const access = await tryChannelAccess(channelId, userId);
  if (!access) throw Errors.CHANNEL_NOT_ACCESSIBLE();
  return access;
}
