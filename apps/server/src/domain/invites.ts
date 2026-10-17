import { randomBytes } from "node:crypto";
import { AuditLogActionType, Errors, Limits, Permissions } from "@nebula/shared";
import { execute, query, queryOne } from "../db/pool.js";
import { bus } from "../realtime/bus.js";
import { ServerEvents } from "@nebula/shared";
import { writeAuditLog } from "./audit.js";
import { addGuildMember } from "./guilds.js";
import { toGuild, toInvite, type GuildRow } from "./mappers.js";
import { assertChannelAccess, loadMemberContext } from "./permissions.js";
import { getBlockedIds } from "./relationships.js";

const CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function generateInviteCode(length = 8): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[(bytes[i] ?? 0) % CODE_ALPHABET.length];
  }
  return out;
}

export interface InviteRow {
  code: string;
  guild_id: string;
  channel_id: string;
  inviter_id: string | null;
  uses: number;
  max_uses: number;
  max_age: number;
  temporary: boolean;
  created_at: Date;
  expires_at: Date | null;
  revoked: boolean;
}

export interface CreateInviteInput {
  maxAge?: number;
  maxUses?: number;
  temporary?: boolean;
}

export async function createInvite(
  guildId: string,
  channelId: string,
  actorId: string,
  input: CreateInviteInput = {},
) {
  const access = await assertChannelAccess(channelId, actorId, Permissions.CREATE_INSTANT_INVITE);
  if (access.channel.guild_id !== guildId) throw Errors.UNKNOWN_CHANNEL();

  const maxAge = Math.min(Math.max(input.maxAge ?? 86400, 0), Limits.INVITE_MAX_AGE_MAX);
  const maxUses = Math.min(Math.max(input.maxUses ?? 0, 0), Limits.INVITE_MAX_USES_MAX);
  const expiresAt = maxAge === 0 ? null : new Date(Date.now() + maxAge * 1000);

  let code = generateInviteCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = await queryOne(`SELECT 1 FROM invites WHERE code = $1`, [code]);
    if (!clash) break;
    code = generateInviteCode(10);
  }

  const row = await queryOne<InviteRow>(
    `INSERT INTO invites (code, guild_id, channel_id, inviter_id, max_uses, max_age, temporary, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING code, guild_id, channel_id, inviter_id, uses, max_uses, max_age, temporary, created_at, expires_at, revoked`,
    [code, guildId, channelId, actorId, maxUses, maxAge, input.temporary ?? false, expiresAt],
  );
  if (!row) throw Errors.INTERNAL(undefined, "Failed to create invite");

  await writeAuditLog({
    guildId,
    actionType: AuditLogActionType.INVITE_CREATE,
    actorId,
    targetId: channelId,
    changes: [{ key: "code", newValue: code }],
  });

  return toInvite(row);
}

export async function getInvite(code: string) {
  const row = await queryOne<InviteRow & { guild_name: string }>(
    `SELECT i.*, g.name AS guild_name FROM invites i JOIN guilds g ON g.id = i.guild_id WHERE i.code = $1`,
    [code],
  );
  if (!row) throw Errors.UNKNOWN_INVITE();
  return row;
}

/** Public invite preview (no auth required beyond a validated session optional). */
export async function previewInvite(code: string) {
  const row = await getInvite(code);
  if (!isInviteUsable(row)) throw Errors.UNKNOWN_INVITE(undefined, "This invite is no longer valid.");

  const guild = await queryOne<GuildRow>(
    `SELECT g.id, g.name, g.icon_key, g.owner_id, g.description, g.system_channel_id, g.rules_channel_id,
            g.features, g.created_at,
            (SELECT COUNT(*)::text FROM guild_members m WHERE m.guild_id = g.id) AS member_count,
            (SELECT COUNT(*)::text FROM guild_members m JOIN presence p ON p.user_id = m.user_id
              WHERE m.guild_id = g.id AND p.status <> 'offline') AS presence_count
       FROM guilds g WHERE g.id = $1`,
    [row.guild_id],
  );
  if (!guild) throw Errors.UNKNOWN_GUILD();
  return { invite: toInvite(row), guild: toGuild(guild) };
}

export function isInviteUsable(row: InviteRow): boolean {
  if (row.revoked) return false;
  if (row.expires_at && row.expires_at.getTime() < Date.now()) return false;
  if (row.max_uses > 0 && row.uses >= row.max_uses) return false;
  return true;
}

/**
 * Accept an invite. Idempotent for existing members. Rejects invitations from a
 * guild whose owner has blocked the user, and self-bans.
 */
export async function acceptInvite(code: string, userId: string): Promise<{ guildId: string; alreadyMember: boolean }> {
  const row = await getInvite(code);
  if (!isInviteUsable(row)) throw Errors.UNKNOWN_INVITE(undefined, "This invite is no longer valid.");

  const banned = await queryOne(`SELECT 1 FROM guild_bans WHERE guild_id = $1 AND user_id = $2`, [
    row.guild_id,
    userId,
  ]);
  if (banned) throw Errors.FORBIDDEN(undefined, "You are banned from this guild.");

  const existing = await queryOne(`SELECT 1 FROM guild_members WHERE guild_id = $1 AND user_id = $2`, [
    row.guild_id,
    userId,
  ]);
  if (existing) return { guildId: row.guild_id, alreadyMember: true };

  const countRow = await queryOne<{ count: string }>(`SELECT COUNT(*)::text AS count FROM guild_members WHERE user_id = $1`, [userId]);
  if (Number(countRow?.count ?? 0) >= Limits.GUILDS_MAX_PER_USER) {
    throw Errors.VALIDATION_FAILED(undefined, "You have joined the maximum number of guilds.");
  }

  const blocked = await getBlockedIds(userId);
  if (row.inviter_id && blocked.has(row.inviter_id)) {
    throw Errors.BLOCKED(undefined, "You cannot join via an invite from a blocked user.");
  }

  await addGuildMember(row.guild_id, userId);
  await execute(`UPDATE invites SET uses = uses + 1 WHERE code = $1`, [code]);

  bus().toGuild(row.guild_id, ServerEvents.GUILD_MEMBER_ADD, { guildId: row.guild_id, userId });
  return { guildId: row.guild_id, alreadyMember: false };
}

export async function deleteInvite(code: string, actorId: string): Promise<void> {
  const row = await getInvite(code);
  const ctx = await loadMemberContext(row.guild_id, actorId);
  if ((ctx.basePermissions & Permissions.MANAGE_GUILD) !== Permissions.MANAGE_GUILD) {
    throw Errors.MISSING_PERMISSIONS({ permission: "MANAGE_GUILD" });
  }
  await execute(`DELETE FROM invites WHERE code = $1`, [code]);
  await writeAuditLog({
    guildId: row.guild_id,
    actionType: AuditLogActionType.INVITE_DELETE,
    actorId,
    targetId: row.channel_id,
    changes: [{ key: "code", oldValue: code }],
  });
}

export async function listGuildInvites(guildId: string, actorId: string) {
  const ctx = await loadMemberContext(guildId, actorId);
  if ((ctx.basePermissions & Permissions.MANAGE_GUILD) !== Permissions.MANAGE_GUILD) {
    throw Errors.MISSING_PERMISSIONS({ permission: "MANAGE_GUILD" });
  }
  const rows = await query<InviteRow>(
    `SELECT code, guild_id, channel_id, inviter_id, uses, max_uses, max_age, temporary, created_at, expires_at, revoked
       FROM invites WHERE guild_id = $1 AND revoked = FALSE
        AND (expires_at IS NULL OR expires_at > now())
        AND (max_uses = 0 OR uses < max_uses)
      ORDER BY created_at DESC LIMIT 100`,
    [guildId],
  );
  return rows.map((r) => toInvite(r));
}
