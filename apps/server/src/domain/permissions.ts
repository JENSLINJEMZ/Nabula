import {
  ALL_PERMISSIONS,
  ChannelType,
  Errors,
  Permissions,
  applyImplicitPermissions,
  applyTimeout,
  computeBasePermissions,
  computeChannelPermissions,
  deserializePermissions,
  type PermissionOverwrite,
} from "@nebula/shared";
import { queryOne, query } from "../db/pool.js";

/**
 * Authoritative permission resolution. Every authorization decision in the
 * server goes through this module — route handlers never trust a client-provided
 * role, membership or permission claim.
 */

export interface MemberContext {
  guildId: string;
  userId: string;
  isMember: boolean;
  isOwner: boolean;
  isTimedOut: boolean;
  everyoneRoleId: string;
  memberRoleIds: string[];
  /** Base guild permissions with ADMINISTRATOR collapsed and timeout applied. */
  basePermissions: bigint;
  /** Highest role position the member holds (owner == Infinity). */
  highestRolePosition: number;
}

interface RoleRow {
  id: string;
  permissions: string;
  position: number;
  is_everyone: boolean;
}

/**
 * Load everything needed to compute this member's permissions in a guild.
 * Throws NOT_GUILD_MEMBER when the user is not a member.
 */
export async function loadMemberContext(guildId: string, userId: string): Promise<MemberContext> {
  const member = await queryOne<{ is_owner: boolean; timeout_until: Date | null }>(
    `SELECT is_owner, timeout_until FROM guild_members WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId],
  );
  if (!member) throw Errors.NOT_GUILD_MEMBER();

  const roles = await query<RoleRow>(
    `SELECT id, permissions, position, is_everyone FROM roles WHERE guild_id = $1`,
    [guildId],
  );
  const everyone = roles.find((r) => r.is_everyone);
  if (!everyone) throw Errors.INTERNAL({ guildId }, "Guild is missing its @everyone role");

  const memberRoleRows = await query<{ role_id: string }>(
    `SELECT role_id FROM member_roles WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId],
  );
  const memberRoleIds = memberRoleRows.map((r) => r.role_id);

  const roleById = new Map(roles.map((r) => [r.id, r]));
  const rolePermissions = memberRoleIds
    .map((id) => roleById.get(id))
    .filter((r): r is RoleRow => Boolean(r))
    .map((r) => deserializePermissions(r.permissions));

  const rawBase = computeBasePermissions({
    isOwner: member.is_owner,
    everyoneRolePermissions: deserializePermissions(everyone.permissions),
    rolePermissions,
  });

  const isTimedOut = member.timeout_until !== null && member.timeout_until.getTime() > Date.now();
  const basePermissions = applyTimeout(rawBase, isTimedOut && !member.is_owner);

  let highestRolePosition = member.is_owner ? Number.MAX_SAFE_INTEGER : 0;
  for (const id of memberRoleIds) {
    const role = roleById.get(id);
    if (role && role.position > highestRolePosition) highestRolePosition = role.position;
  }

  return {
    guildId,
    userId,
    isMember: true,
    isOwner: member.is_owner,
    isTimedOut,
    everyoneRoleId: guildId, // @everyone role id equals the guild id (Discord convention)
    memberRoleIds,
    basePermissions,
    highestRolePosition,
  };
}

export function memberHasPermission(ctx: MemberContext, permission: bigint): boolean {
  if (permission === 0n) return true;
  if ((ctx.basePermissions & Permissions.ADMINISTRATOR) !== 0n) return true;
  return (ctx.basePermissions & permission) === permission;
}

export function assertMemberPermission(ctx: MemberContext, permission: bigint): void {
  if (!memberHasPermission(ctx, permission)) {
    throw Errors.MISSING_PERMISSIONS({ guildId: ctx.guildId, permission: permission.toString() });
  }
}

interface ChannelRow {
  id: string;
  guild_id: string | null;
  type: number;
  parent_id: string | null;
}

async function getChannelRow(channelId: string): Promise<ChannelRow> {
  const row = await queryOne<ChannelRow>(
    `SELECT id, guild_id, type, parent_id FROM channels WHERE id = $1`,
    [channelId],
  );
  if (!row) throw Errors.UNKNOWN_CHANNEL();
  return row;
}

async function loadOverwrites(channelId: string): Promise<PermissionOverwrite[]> {
  const rows = await query<{ target_id: string; type: number; allow: string; deny: string }>(
    `SELECT target_id, type, allow, deny FROM channel_overwrites WHERE channel_id = $1`,
    [channelId],
  );
  return rows.map((r) => ({
    targetId: r.target_id,
    type: r.type === 1 ? 1 : 0,
    allow: deserializePermissions(r.allow),
    deny: deserializePermissions(r.deny),
  }));
}

/**
 * Compute effective permissions for a member in a guild channel, including
 * category syncing (a text/voice channel inherits its parent category's
 * overwrites when the channel has none of its own for that target — modelled by
 * simply concatenating parent overwrites that the child does not override).
 *
 * Threads inherit their parent channel's permissions.
 */
export async function computeChannelPermissionsForMember(
  channel: ChannelRow,
  ctx: MemberContext,
): Promise<bigint> {
  let effectiveChannel = channel;

  // Threads resolve against their parent.
  if (
    (channel.type === ChannelType.PUBLIC_THREAD || channel.type === ChannelType.PRIVATE_THREAD) &&
    channel.parent_id
  ) {
    effectiveChannel = await getChannelRow(channel.parent_id);
  }

  const overwrites = await loadOverwrites(effectiveChannel.id);

  // Category inheritance: if the channel is a guild channel inside a category,
  // merge parent overwrites for targets the channel does not itself define.
  let merged = overwrites;
  if (effectiveChannel.parent_id && effectiveChannel.type !== ChannelType.GUILD_CATEGORY) {
    const parentOverwrites = await loadOverwrites(effectiveChannel.parent_id);
    const defined = new Set(overwrites.map((o) => o.targetId));
    const inherited = parentOverwrites.filter((o) => !defined.has(o.targetId));
    merged = [...overwrites, ...inherited];
  }

  let permissions = computeChannelPermissions({
    basePermissions: ctx.basePermissions,
    everyoneRoleId: ctx.everyoneRoleId,
    memberRoleIds: ctx.memberRoleIds,
    memberId: ctx.userId,
    overwrites: merged,
  });

  const isVoice =
    channel.type === ChannelType.GUILD_VOICE || channel.type === ChannelType.GUILD_STAGE_VOICE;
  permissions = applyImplicitPermissions(permissions, isVoice);

  return permissions;
}

export interface ChannelAccess {
  channel: ChannelRow;
  permissions: bigint;
  isDm: boolean;
}

/**
 * Assert the user can access a channel. For guild channels this loads the member
 * context and computes channel permissions; for DM/group-DM channels it checks
 * recipient membership.
 */
export async function assertChannelAccess(
  channelId: string,
  userId: string,
  permission: bigint = Permissions.VIEW_CHANNEL,
): Promise<ChannelAccess> {
  const channel = await getChannelRow(channelId);

  if (channel.guild_id === null) {
    // DM / group DM: access is defined by recipient rows.
    const recipient = await queryOne(
      `SELECT 1 AS ok FROM dm_recipients WHERE channel_id = $1 AND user_id = $2`,
      [channelId, userId],
    );
    if (!recipient) throw Errors.CHANNEL_NOT_ACCESSIBLE();
    return { channel, permissions: ALL_PERMISSIONS, isDm: true };
  }

  const ctx = await loadMemberContext(channel.guild_id, userId);
  const permissions = await computeChannelPermissionsForMember(channel, ctx);

  if (permission !== 0n && (permissions & permission) !== permission) {
    throw Errors.CHANNEL_NOT_ACCESSIBLE({ channelId, permission: permission.toString() });
  }

  return { channel, permissions, isDm: false };
}

/** Convenience: resolve access, returning null instead of throwing. */
export async function tryChannelAccess(
  channelId: string,
  userId: string,
): Promise<ChannelAccess | null> {
  try {
    return await assertChannelAccess(channelId, userId, Permissions.VIEW_CHANNEL);
  } catch {
    return null;
  }
}

/**
 * Role/member hierarchy check. An actor may only act on a target whose highest
 * role position is strictly below the actor's. Owners bypass this. Also used to
 * gate role edits (a role at or above your highest cannot be modified).
 */
export function assertHierarchy(actorCtx: MemberContext, targetHighestPosition: number): void {
  if (actorCtx.isOwner) return;
  if (targetHighestPosition >= actorCtx.highestRolePosition) {
    throw Errors.HIERARCHY_VIOLATION({
      actorHighest: actorCtx.highestRolePosition,
      targetHighest: targetHighestPosition,
    });
  }
}

export async function highestRolePositionOfMember(guildId: string, userId: string): Promise<number> {
  const row = await queryOne<{ is_owner: boolean; highest: number | null }>(
    `SELECT gm.is_owner,
            MAX(r.position) AS highest
       FROM guild_members gm
       LEFT JOIN member_roles mr ON mr.guild_id = gm.guild_id AND mr.user_id = gm.user_id
       LEFT JOIN roles r ON r.id = mr.role_id
      WHERE gm.guild_id = $1 AND gm.user_id = $2
      GROUP BY gm.is_owner`,
    [guildId, userId],
  );
  if (!row) throw Errors.NOT_GUILD_MEMBER();
  if (row.is_owner) return Number.MAX_SAFE_INTEGER;
  return row.highest ?? 0;
}

/**
 * Guard for granting permissions: you cannot grant a permission you do not hold
 * yourself (except the owner, who holds everything).
 */
export function assertCanGrantPermissions(actorCtx: MemberContext, granted: bigint): void {
  if (actorCtx.isOwner) return;
  if ((actorCtx.basePermissions & Permissions.ADMINISTRATOR) !== 0n) return;
  const missing = granted & ~actorCtx.basePermissions;
  if (missing !== 0n) {
    throw Errors.MISSING_PERMISSIONS({ missing: missing.toString() });
  }
}
