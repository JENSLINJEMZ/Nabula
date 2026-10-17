import type {
  Attachment,
  AuditLogEntry,
  Channel,
  ChannelOverwrite,
  Guild,
  GuildMember,
  Invite,
  Notification,
  Presence,
  PublicUser,
  Relationship,
  Role,
  SelfUser,
  VoiceState,
} from "@nebula/shared";
import { deserializePermissions } from "@nebula/shared";

/**
 * Media URLs are always served through an authorization-checked route; storage
 * keys are never exposed directly to clients.
 */
export const media = {
  avatar: (key: string) => `/api/media/avatars/${encodeURIComponent(key)}`,
  banner: (key: string) => `/api/media/banners/${encodeURIComponent(key)}`,
  icon: (key: string) => `/api/media/icons/${encodeURIComponent(key)}`,
  attachment: (attachmentId: string, filename: string) =>
    `/api/media/attachments/${attachmentId}/${encodeURIComponent(filename)}`,
};

export interface UserRow {
  id: string;
  username: string;
  discriminator: string;
  display_name: string | null;
  avatar_key: string | null;
  banner_key: string | null;
  accent_color: number | null;
  bio: string | null;
  bot: boolean;
  premium_type: number;
  email: string | null;
  email_verified: boolean;
  flags: string | number;
  created_at: Date;
  disabled?: boolean;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    discriminator: row.discriminator,
    avatarUrl: row.avatar_key ? media.avatar(row.avatar_key) : null,
    bannerUrl: row.banner_key ? media.banner(row.banner_key) : null,
    accentColor: row.accent_color,
    bio: row.bio,
    bot: row.bot,
    createdAt: row.created_at.toISOString(),
  };
}

export function toSelfUser(row: UserRow & { mfa_enabled?: boolean }): SelfUser {
  return {
    ...toPublicUser(row),
    email: row.email,
    emailVerified: row.email_verified,
    mfaEnabled: row.mfa_enabled ?? false,
    premiumType: row.premium_type,
  };
}

export interface RoleRow {
  id: string;
  guild_id: string;
  name: string;
  color: number;
  hoist: boolean;
  position: number;
  permissions: string;
  managed: boolean;
  mentionable: boolean;
  is_everyone: boolean;
}

export function toRole(row: RoleRow): Role {
  return {
    id: row.id,
    guildId: row.guild_id,
    name: row.name,
    color: row.color,
    hoist: row.hoist,
    position: row.position,
    permissions: row.permissions,
    managed: row.managed,
    mentionable: row.mentionable,
    isEveryone: row.is_everyone,
  };
}

export interface GuildRow {
  id: string;
  name: string;
  icon_key: string | null;
  owner_id: string;
  description: string | null;
  system_channel_id: string | null;
  rules_channel_id: string | null;
  features: string[];
  created_at: Date;
  member_count?: string | number;
  presence_count?: string | number;
}

export function toGuild(row: GuildRow): Guild {
  return {
    id: row.id,
    name: row.name,
    iconUrl: row.icon_key ? media.icon(row.icon_key) : null,
    ownerId: row.owner_id,
    description: row.description,
    systemChannelId: row.system_channel_id,
    rulesChannelId: row.rules_channel_id,
    features: row.features ?? [],
    memberCount: row.member_count !== undefined ? Number(row.member_count) : undefined,
    presenceCount: row.presence_count !== undefined ? Number(row.presence_count) : undefined,
    createdAt: row.created_at.toISOString(),
  };
}

export interface ChannelRowFull {
  id: string;
  guild_id: string | null;
  type: number;
  name: string | null;
  topic: string | null;
  position: number;
  parent_id: string | null;
  nsfw: boolean;
  rate_limit_per_user: number;
  user_limit: number;
  bitrate: number;
  last_message_id: string | null;
  owner_id: string | null;
  default_auto_archive_duration: number;
  thread_message_count: number;
  dm_closed: boolean;
  created_at: Date;
}

export function toChannel(
  row: ChannelRowFull,
  options: {
    overwrites?: ChannelOverwrite[];
    permissions?: bigint;
    recipients?: PublicUser[];
  } = {},
): Channel {
  return {
    id: row.id,
    type: row.type as Channel["type"],
    guildId: row.guild_id,
    name: row.name,
    topic: row.topic,
    position: row.position,
    parentId: row.parent_id,
    nsfw: row.nsfw,
    rateLimitPerUser: row.rate_limit_per_user,
    userLimit: row.user_limit,
    bitrate: row.bitrate,
    lastMessageId: row.last_message_id,
    ownerId: row.owner_id,
    permissionOverwrites: options.overwrites ?? [],
    permissions: options.permissions !== undefined ? options.permissions.toString() : undefined,
    recipients: options.recipients,
    createdAt: row.created_at.toISOString(),
  };
}

export function toOverwrite(row: { target_id: string; type: number; allow: string; deny: string }): ChannelOverwrite {
  return {
    targetId: row.target_id,
    type: row.type === 1 ? 1 : 0,
    allow: deserializePermissions(row.allow).toString(),
    deny: deserializePermissions(row.deny).toString(),
  };
}

export interface AttachmentRow {
  id: string;
  message_id: string | null;
  filename: string;
  content_type: string | null;
  size_bytes: string | number;
  width: number | null;
  height: number | null;
  is_spoiler: boolean;
}

export function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    messageId: row.message_id,
    filename: row.filename,
    contentType: row.content_type,
    size: Number(row.size_bytes),
    width: row.width,
    height: row.height,
    url: media.attachment(row.id, row.filename),
    proxyUrl: media.attachment(row.id, row.filename),
    isSpoiler: row.is_spoiler,
  };
}

export interface RelationshipRow {
  user_id: string;
  target_id: string;
  type: number;
  created_at: Date;
}

export function toRelationship(row: RelationshipRow, user: PublicUser): Relationship {
  return {
    userId: row.target_id,
    type: row.type as Relationship["type"],
    since: row.created_at.toISOString(),
    user,
  };
}

export interface PresenceRow {
  user_id: string;
  status: string;
  custom_status: string | null;
  activities: unknown;
  updated_at: Date;
}

export function toPresence(row: PresenceRow): Presence {
  return {
    userId: row.user_id,
    status: row.status as Presence["status"],
    customStatus: row.custom_status,
    activities: Array.isArray(row.activities) ? (row.activities as Presence["activities"]) : [],
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toGuildMember(
  row: {
    guild_id: string;
    user_id: string;
    nickname: string | null;
    joined_at: Date;
    timeout_until: Date | null;
    is_owner: boolean;
  },
  extras: { user?: PublicUser; presence?: Presence; roles?: string[] } = {},
): GuildMember {
  return {
    guildId: row.guild_id,
    userId: row.user_id,
    nickname: row.nickname,
    roles: extras.roles ?? [],
    joinedAt: row.joined_at.toISOString(),
    timeoutUntil: row.timeout_until ? row.timeout_until.toISOString() : null,
    isOwner: row.is_owner,
    user: extras.user,
    presence: extras.presence,
  };
}

export function toInvite(
  row: {
    code: string;
    guild_id: string;
    channel_id: string;
    inviter_id: string | null;
    uses: number;
    max_uses: number;
    max_age: number;
    temporary: boolean;
    expires_at: Date | null;
    created_at: Date;
  },
  guild?: Guild,
): Invite {
  return {
    code: row.code,
    guildId: row.guild_id,
    channelId: row.channel_id,
    inviterId: row.inviter_id,
    uses: row.uses,
    maxUses: row.max_uses,
    maxAge: row.max_age,
    temporary: row.temporary,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    guild,
  };
}

export function toNotification(row: {
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
}): Notification {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type as Notification["type"],
    actorId: row.actor_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    title: row.title,
    body: row.body,
    read: row.read,
    createdAt: row.created_at.toISOString(),
  };
}

export function toAuditLogEntry(
  row: {
    id: string;
    guild_id: string;
    action_type: number;
    actor_id: string | null;
    target_id: string | null;
    reason: string | null;
    changes: unknown;
    created_at: Date;
  },
  actor: PublicUser | null = null,
): AuditLogEntry {
  return {
    id: row.id,
    guildId: row.guild_id,
    actionType: row.action_type,
    actorId: row.actor_id,
    targetId: row.target_id,
    reason: row.reason,
    changes: Array.isArray(row.changes) ? (row.changes as AuditLogEntry["changes"]) : [],
    createdAt: row.created_at.toISOString(),
    actor,
  };
}

export function toVoiceState(row: {
  guild_id: string | null;
  channel_id: string;
  user_id: string;
  session_id: string;
  self_mute: boolean;
  self_deaf: boolean;
  self_stream: boolean;
  self_video: boolean;
  mute: boolean;
  deaf: boolean;
  suppress: boolean;
}): VoiceState {
  return {
    guildId: row.guild_id ?? "",
    channelId: row.channel_id,
    userId: row.user_id,
    sessionId: row.session_id,
    selfMute: row.self_mute,
    selfDeaf: row.self_deaf,
    selfStream: row.self_stream,
    selfVideo: row.self_video,
    mute: row.mute,
    deaf: row.deaf,
    suppress: row.suppress,
  };
}
