/**
 * Permission bitfield — mirrors Discord's documented permission model.
 *
 * Verified against official documentation (docs.discord.com/developers/topics/permissions):
 *  - Permissions are a variable-length integer serialized as a string, combined with `|`
 *    and tested with `&`.
 *  - Computation order is: guild base permissions (@everyone role OR'd with every role the
 *    member has) -> ADMINISTRATOR bypass (grants everything and bypasses overwrites) ->
 *    per-channel overwrites applied in a fixed order.
 *  - Overwrite order: @everyone deny, @everyone allow, (all role denies OR'd together),
 *    (all role allows OR'd together), member deny, member allow.
 *  - Role hierarchy does NOT affect permission resolution (only hierarchy-gated actions
 *    such as kick/ban/edit-roles use position).
 *
 * Bits are kept as `bigint` because the flag set exceeds 32 bits (up to bit 52).
 */

export const Permissions = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_AUDIT_LOG: 1n << 7n,
  PRIORITY_SPEAKER: 1n << 8n,
  STREAM: 1n << 9n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  SEND_TTS_MESSAGES: 1n << 12n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  USE_EXTERNAL_EMOJIS: 1n << 18n,
  VIEW_GUILD_INSIGHTS: 1n << 19n,
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  MUTE_MEMBERS: 1n << 22n,
  DEAFEN_MEMBERS: 1n << 23n,
  MOVE_MEMBERS: 1n << 24n,
  USE_VAD: 1n << 25n,
  CHANGE_NICKNAME: 1n << 26n,
  MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_WEBHOOKS: 1n << 29n,
  MANAGE_GUILD_EXPRESSIONS: 1n << 30n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
  REQUEST_TO_SPEAK: 1n << 32n,
  MANAGE_EVENTS: 1n << 33n,
  MANAGE_THREADS: 1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  CREATE_PRIVATE_THREADS: 1n << 36n,
  USE_EXTERNAL_STICKERS: 1n << 37n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  USE_EMBEDDED_ACTIVITIES: 1n << 39n,
  MODERATE_MEMBERS: 1n << 40n,
  VIEW_CREATOR_MONETIZATION_ANALYTICS: 1n << 41n,
  USE_SOUNDBOARD: 1n << 42n,
  CREATE_GUILD_EXPRESSIONS: 1n << 43n,
  CREATE_EVENTS: 1n << 44n,
  USE_EXTERNAL_SOUNDS: 1n << 45n,
  SEND_VOICE_MESSAGES: 1n << 46n,
  SET_VOICE_CHANNEL_STATUS: 1n << 48n,
  SEND_POLLS: 1n << 49n,
  USE_EXTERNAL_APPS: 1n << 50n,
  PIN_MESSAGES: 1n << 51n,
  BYPASS_SLOWMODE: 1n << 52n,
} as const;

export type PermissionName = keyof typeof Permissions;

/** Every known permission bit OR'd together. */
export const ALL_PERMISSIONS: bigint = Object.values(Permissions).reduce((a, b) => a | b, 0n);

export const NO_PERMISSIONS = 0n;

/** Permission bits relevant when the guild-wide 2FA requirement is enabled. */
export const TWO_FACTOR_REQUIRED_PERMISSIONS: bigint =
  Permissions.KICK_MEMBERS |
  Permissions.BAN_MEMBERS |
  Permissions.ADMINISTRATOR |
  Permissions.MANAGE_CHANNELS |
  Permissions.MANAGE_GUILD |
  Permissions.MANAGE_MESSAGES |
  Permissions.MANAGE_ROLES |
  Permissions.MANAGE_WEBHOOKS |
  Permissions.MANAGE_GUILD_EXPRESSIONS |
  Permissions.MANAGE_THREADS |
  Permissions.VIEW_CREATOR_MONETIZATION_ANALYTICS;

/**
 * Default permissions granted to the @everyone role of a new guild.
 * Mirrors a reasonable Discord-like default: view channels, send/react, read history,
 * connect to voice, speak, and create instant invites.
 */
export const DEFAULT_EVERYONE_PERMISSIONS: bigint =
  Permissions.VIEW_CHANNEL |
  Permissions.SEND_MESSAGES |
  Permissions.SEND_MESSAGES_IN_THREADS |
  Permissions.ADD_REACTIONS |
  Permissions.READ_MESSAGE_HISTORY |
  Permissions.EMBED_LINKS |
  Permissions.ATTACH_FILES |
  Permissions.CONNECT |
  Permissions.SPEAK |
  Permissions.STREAM |
  Permissions.USE_VAD |
  Permissions.CHANGE_NICKNAME |
  Permissions.CREATE_INSTANT_INVITE |
  Permissions.USE_APPLICATION_COMMANDS |
  Permissions.CREATE_PUBLIC_THREADS;

export function hasPermission(bits: bigint, permission: bigint): boolean {
  if (permission === 0n) return true;
  // ADMINISTRATOR implies every permission.
  if ((bits & Permissions.ADMINISTRATOR) !== 0n) return true;
  return (bits & permission) === permission;
}

export function hasAnyPermission(bits: bigint, permissions: bigint): boolean {
  if (permissions === 0n) return false;
  if ((bits & Permissions.ADMINISTRATOR) !== 0n) return true;
  return (bits & permissions) !== 0n;
}

export function serializePermissions(bits: bigint): string {
  return bits.toString();
}

export function deserializePermissions(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === "bigint") return value;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

export interface PermissionOverwrite {
  /** Role id or user id this overwrite applies to. */
  targetId: string;
  /** 0 = role overwrite, 1 = member overwrite. */
  type: 0 | 1;
  allow: bigint;
  deny: bigint;
}

export interface ComputeBasePermissionsInput {
  isOwner: boolean;
  /** The @everyone role's permission bits. */
  everyoneRolePermissions: bigint;
  /** Permission bits of every extra role the member holds. */
  rolePermissions: bigint[];
}

/**
 * Discord's documented `compute_base_permissions`.
 */
export function computeBasePermissions(input: ComputeBasePermissionsInput): bigint {
  if (input.isOwner) return ALL_PERMISSIONS;

  let permissions = input.everyoneRolePermissions;
  for (const role of input.rolePermissions) permissions |= role;

  if ((permissions & Permissions.ADMINISTRATOR) !== 0n) return ALL_PERMISSIONS;
  return permissions;
}

export interface ComputeChannelPermissionsInput {
  basePermissions: bigint;
  /** The @everyone role id for the guild (equal to the guild id). */
  everyoneRoleId: string;
  /** All role ids the member holds (including @everyone's role id). */
  memberRoleIds: string[];
  memberId: string;
  overwrites: PermissionOverwrite[];
}

/**
 * Discord's documented `compute_overwrites`. Assumes base permissions already
 * collapsed ADMINISTRATOR into ALL_PERMISSIONS.
 */
export function computeChannelPermissions(input: ComputeChannelPermissionsInput): bigint {
  const { basePermissions, memberRoleIds, memberId, overwrites, everyoneRoleId } = input;

  if ((basePermissions & Permissions.ADMINISTRATOR) !== 0n) return ALL_PERMISSIONS;

  let permissions = basePermissions;
  const roleIdSet = new Set(memberRoleIds);

  // 3. Overwrites that deny permissions for @everyone.
  // 4. Overwrites that allow permissions for @everyone.
  const everyoneOverwrite = overwrites.find((o) => o.type === 0 && o.targetId === everyoneRoleId);
  if (everyoneOverwrite) {
    permissions &= ~everyoneOverwrite.deny;
    permissions |= everyoneOverwrite.allow;
  }

  // 5. Role-specific denies (OR'd across roles) then 6. role-specific allows.
  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type !== 0) continue;
    if (overwrite.targetId === everyoneRoleId) continue;
    if (roleIdSet.has(overwrite.targetId)) {
      roleAllow |= overwrite.allow;
      roleDeny |= overwrite.deny;
    }
  }
  permissions &= ~roleDeny;
  permissions |= roleAllow;

  // 7. Member-specific deny, 8. member-specific allow.
  const memberOverwrite = overwrites.find((o) => o.type === 1 && o.targetId === memberId);
  if (memberOverwrite) {
    permissions &= ~memberOverwrite.deny;
    permissions |= memberOverwrite.allow;
  }

  return permissions;
}

/**
 * Apply implicit-permission rules after the explicit bitfield is computed.
 * Verified rules: VIEW_CHANNEL denial implicitly denies all other channel perms;
 * SEND_MESSAGES denial implicitly denies MENTION_EVERYONE, SEND_TTS_MESSAGES,
 * ATTACH_FILES and EMBED_LINKS.
 *
 * `CONNECT` denial also implicitly denies voice management actions.
 */
export function applyImplicitPermissions(permissions: bigint, isVoiceChannel = false): bigint {
  let result = permissions;

  if ((result & Permissions.VIEW_CHANNEL) === 0n) {
    // Cannot see the channel => nothing else in it applies.
    return result & Permissions.VIEW_CHANNEL;
  }

  if ((result & Permissions.SEND_MESSAGES) === 0n) {
    result &= ~(
      Permissions.MENTION_EVERYONE |
      Permissions.SEND_TTS_MESSAGES |
      Permissions.ATTACH_FILES |
      Permissions.EMBED_LINKS
    );
  }

  if (isVoiceChannel && (result & Permissions.CONNECT) === 0n) {
    result &= ~(Permissions.SPEAK | Permissions.STREAM | Permissions.USE_VAD | Permissions.PRIORITY_SPEAKER);
  }

  return result;
}

/**
 * Timed-out members temporarily lose every permission except VIEW_CHANNEL and
 * READ_MESSAGE_HISTORY. Owners and ADMINISTRATOR holders are exempt.
 */
export function applyTimeout(permissions: bigint, isTimedOut: boolean): bigint {
  if (!isTimedOut) return permissions;
  if ((permissions & Permissions.ADMINISTRATOR) !== 0n) return permissions;
  return permissions & (Permissions.VIEW_CHANNEL | Permissions.READ_MESSAGE_HISTORY);
}
