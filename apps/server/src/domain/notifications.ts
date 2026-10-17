import { Errors } from "@nebula/shared";
import { nextId } from "../ids.js";
import { execute, query, queryOne, pool, type Queryable } from "../db/pool.js";
import { toNotification } from "./mappers.js";

export type NotificationType = "mention" | "dm" | "friend_request" | "guild_invite" | "system";

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  actorId?: string | null;
  guildId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  title: string;
  body?: string | null;
}

export async function createNotification(
  input: CreateNotificationInput,
  client: Queryable = pool,
): Promise<void> {
  await client.query(
    `INSERT INTO notifications (id, user_id, type, actor_id, guild_id, channel_id, message_id, title, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      nextId(),
      input.userId,
      input.type,
      input.actorId ?? null,
      input.guildId ?? null,
      input.channelId ?? null,
      input.messageId ?? null,
      input.title.slice(0, 200),
      input.body ? input.body.slice(0, 500) : null,
    ],
  );
}

export async function listNotifications(userId: string, options: { limit: number; before?: string | null }) {
  const params: unknown[] = [userId];
  let where = "user_id = $1";
  if (options.before) {
    where += " AND id < $2";
    params.push(options.before);
  }
  params.push(options.limit);
  const rows = await query<{
    id: string;
    user_id: string;
    type: string;
    actor_id: string | null;
    guild_id: string | null;
    channel_id: string | null;
    message_id: string | null;
    title: string;
    body: string | null;
    read: boolean;
    created_at: Date;
  }>(
    `SELECT id, user_id, type, actor_id, guild_id, channel_id, message_id, title, body, read, created_at
       FROM notifications WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(toNotification);
}

export async function unreadNotificationCount(userId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM notifications WHERE user_id = $1 AND read = FALSE`,
    [userId],
  );
  return Number(row?.count ?? 0);
}

export async function markNotificationsRead(userId: string, ids?: string[]): Promise<number> {
  if (ids && ids.length > 0) {
    return execute(`UPDATE notifications SET read = TRUE WHERE user_id = $1 AND id = ANY($2::bigint[])`, [
      userId,
      ids,
    ]);
  }
  return execute(`UPDATE notifications SET read = TRUE WHERE user_id = $1 AND read = FALSE`, [userId]);
}

export interface NotificationSettings {
  desktop: boolean;
  sounds: boolean;
  suppressEveryone: boolean;
  suppressRoles: boolean;
  suppressFromOthers: boolean;
}

export async function getNotificationSettings(userId: string): Promise<NotificationSettings> {
  const row = await queryOne<{
    notification_desktop: boolean;
    notification_sounds: boolean;
    suppress_everyone: boolean;
    suppress_roles: boolean;
    suppress_from_others: boolean;
  }>(
    `SELECT notification_desktop, notification_sounds, suppress_everyone, suppress_roles, suppress_from_others
       FROM user_settings WHERE user_id = $1`,
    [userId],
  );
  if (!row) throw Errors.UNKNOWN_USER();
  return {
    desktop: row.notification_desktop,
    sounds: row.notification_sounds,
    suppressEveryone: row.suppress_everyone,
    suppressRoles: row.suppress_roles,
    suppressFromOthers: row.suppress_from_others,
  };
}

export async function updateNotificationSettings(
  userId: string,
  patch: Partial<NotificationSettings>,
): Promise<NotificationSettings> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  const map: Record<keyof NotificationSettings, string> = {
    desktop: "notification_desktop",
    sounds: "notification_sounds",
    suppressEveryone: "suppress_everyone",
    suppressRoles: "suppress_roles",
    suppressFromOthers: "suppress_from_others",
  };
  for (const key of Object.keys(map) as (keyof NotificationSettings)[]) {
    if (patch[key] !== undefined) {
      sets.push(`${map[key]} = $${i++}`);
      params.push(patch[key]);
    }
  }
  if (sets.length === 0) return getNotificationSettings(userId);
  sets.push("updated_at = now()");
  params.push(userId);
  await execute(`UPDATE user_settings SET ${sets.join(", ")} WHERE user_id = $${i}`, params);
  return getNotificationSettings(userId);
}

export interface UserSettingsView {
  theme: "dark" | "light";
  messageDisplay: "cozy" | "compact";
  reducedMotion: boolean;
  fontScale: number;
  locale: string;
}

export async function getUserSettings(userId: string): Promise<UserSettingsView> {
  const row = await queryOne<{
    theme: string;
    message_display: string;
    reduced_motion: boolean;
    font_scale: number;
    locale: string;
  }>(
    `SELECT theme, message_display, reduced_motion, font_scale, locale FROM user_settings WHERE user_id = $1`,
    [userId],
  );
  if (!row) throw Errors.UNKNOWN_USER();
  return {
    theme: row.theme === "light" ? "light" : "dark",
    messageDisplay: row.message_display === "compact" ? "compact" : "cozy",
    reducedMotion: row.reduced_motion,
    fontScale: row.font_scale,
    locale: row.locale,
  };
}

export async function updateUserSettings(userId: string, patch: Partial<UserSettingsView>): Promise<UserSettingsView> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (patch.theme !== undefined) {
    sets.push(`theme = $${i++}`);
    params.push(patch.theme);
  }
  if (patch.messageDisplay !== undefined) {
    sets.push(`message_display = $${i++}`);
    params.push(patch.messageDisplay);
  }
  if (patch.reducedMotion !== undefined) {
    sets.push(`reduced_motion = $${i++}`);
    params.push(patch.reducedMotion);
  }
  if (patch.fontScale !== undefined) {
    const scale = Math.min(Math.max(patch.fontScale, 0.8), 1.5);
    sets.push(`font_scale = $${i++}`);
    params.push(scale);
  }
  if (patch.locale !== undefined) {
    sets.push(`locale = $${i++}`);
    params.push(patch.locale);
  }
  if (sets.length === 0) return getUserSettings(userId);
  sets.push("updated_at = now()");
  params.push(userId);
  await execute(`UPDATE user_settings SET ${sets.join(", ")} WHERE user_id = $${i}`, params);
  return getUserSettings(userId);
}
