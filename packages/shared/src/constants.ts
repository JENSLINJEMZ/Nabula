/**
 * Shared constants for Nebula. Channel types, message types and flags mirror
 * Discord's documented enumerations so the domain model is interoperable.
 */

export const ChannelType = {
  GUILD_TEXT: 0,
  DM: 1,
  GUILD_VOICE: 2,
  GROUP_DM: 3,
  GUILD_CATEGORY: 4,
  GUILD_ANNOUNCEMENT: 5,
  PUBLIC_THREAD: 11,
  PRIVATE_THREAD: 12,
  GUILD_STAGE_VOICE: 13,
  GUILD_FORUM: 15,
} as const;
export type ChannelType = (typeof ChannelType)[keyof typeof ChannelType];

export const TEXT_CHANNEL_TYPES: ChannelType[] = [
  ChannelType.GUILD_TEXT,
  ChannelType.GUILD_ANNOUNCEMENT,
  ChannelType.GUILD_FORUM,
];
export const VOICE_CHANNEL_TYPES: ChannelType[] = [ChannelType.GUILD_VOICE, ChannelType.GUILD_STAGE_VOICE];

export const MessageType = {
  DEFAULT: 0,
  RECIPIENT_ADD: 1,
  RECIPIENT_REMOVE: 2,
  CALL: 3,
  CHANNEL_NAME_CHANGE: 4,
  CHANNEL_ICON_CHANGE: 5,
  CHANNEL_PINNED_MESSAGE: 6,
  USER_JOIN: 7,
  REPLY: 19,
  THREAD_STARTER_MESSAGE: 21,
  AUTO_MODERATION_ACTION: 24,
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const MessageFlags = {
  CROSSPOSTED: 1 << 0,
  IS_CROSSPOST: 1 << 1,
  SUPPRESS_EMBEDS: 1 << 2,
  SOURCE_MESSAGE_DELETED: 1 << 3,
  URGENT: 1 << 4,
  HAS_THREAD: 1 << 5,
  EPHEMERAL: 1 << 6,
  LOADING: 1 << 7,
  SUPPRESS_NOTIFICATIONS: 1 << 12,
  IS_VOICE_MESSAGE: 1 << 13,
  HAS_SNAPSHOT: 1 << 14,
} as const;

export const OverwriteType = { ROLE: 0, MEMBER: 1 } as const;

export const PresenceStatus = {
  ONLINE: "online",
  IDLE: "idle",
  DND: "dnd",
  OFFLINE: "offline",
} as const;
export type PresenceStatus = (typeof PresenceStatus)[keyof typeof PresenceStatus];

export const RelationshipType = {
  FRIEND: 1,
  BLOCKED: 2,
  INCOMING_REQUEST: 3,
  OUTGOING_REQUEST: 4,
} as const;
export type RelationshipType = (typeof RelationshipType)[keyof typeof RelationshipType];

export const AuditLogActionType = {
  GUILD_UPDATE: 1,
  CHANNEL_CREATE: 10,
  CHANNEL_UPDATE: 11,
  CHANNEL_DELETE: 12,
  CHANNEL_OVERWRITE_CREATE: 13,
  CHANNEL_OVERWRITE_UPDATE: 14,
  CHANNEL_OVERWRITE_DELETE: 15,
  MEMBER_KICK: 20,
  MEMBER_PRUNE: 21,
  MEMBER_BAN_ADD: 22,
  MEMBER_BAN_REMOVE: 23,
  MEMBER_UPDATE: 24,
  MEMBER_ROLE_UPDATE: 25,
  MEMBER_MOVE: 26,
  MEMBER_TIMEOUT: 27,
  MEMBER_DISCONNECT: 28,
  BOT_ADD: 29,
  ROLE_CREATE: 30,
  ROLE_UPDATE: 31,
  ROLE_DELETE: 32,
  INVITE_CREATE: 40,
  INVITE_UPDATE: 41,
  INVITE_DELETE: 42,
  WEBHOOK_CREATE: 50,
  WEBHOOK_UPDATE: 51,
  WEBHOOK_DELETE: 52,
  MESSAGE_DELETE: 72,
  MESSAGE_BULK_DELETE: 73,
  MESSAGE_PIN: 74,
  MESSAGE_UNPIN: 75,
  MESSAGE_UPDATE: 79,
} as const;

export const Limits = {
  USERNAME_MIN: 2,
  USERNAME_MAX: 32,
  DISPLAY_NAME_MAX: 32,
  PASSWORD_MIN: 8,
  PASSWORD_MAX: 200,
  CHANNEL_NAME_MAX: 100,
  CHANNEL_TOPIC_MAX: 1024,
  GUILD_NAME_MIN: 2,
  GUILD_NAME_MAX: 100,
  MESSAGE_CONTENT_MAX: 2000,
  MESSAGE_PAGE_DEFAULT: 50,
  MESSAGE_PAGE_MAX: 100,
  DS_MESSAGE_CONTENT_MAX: 2000,
  EMBEDS_MAX_PER_MESSAGE: 10,
  EMBED_TITLE_MAX: 256,
  EMBED_DESCRIPTION_MAX: 4096,
  EMBED_TOTAL_MAX: 6000,
  ATTACHMENTS_MAX_PER_MESSAGE: 10,
  REACTIONS_MAX_DISTINCT: 20,
  ROLES_MAX_PER_GUILD: 250,
  CHANNELS_MAX_PER_CATEGORY: 50,
  INVITE_MAX_AGE_MAX: 604800,
  INVITE_MAX_USES_MAX: 100,
  FRIENDS_MAX: 1000,
  GUILDS_MAX_PER_USER: 200,
  AUTO_ARCHIVE_DURATIONS: [60, 1440, 4320, 10080] as const,
  TIMEOUT_MAX_MINUTES: 40320, // 28 days
  SLOWMODE_MAX_SECONDS: 21600,
  VOICE_USER_LIMIT_MAX: 99,
  RATE_LIMIT_WINDOW_MS: 60_000,
  MAX_UPLOAD_BYTES: 26_214_400, // 25 MiB, matches Discord's per-request limit
} as const;

/** MIME allowlist for uploads (validated by magic bytes, not just extension). */
export const ALLOWED_UPLOAD_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/zip",
  "application/json",
];

export const ALLOWED_IMAGE_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
];
