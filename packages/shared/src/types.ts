import type { ChannelType, MessageType, PresenceStatus, RelationshipType } from "./constants.js";

/**
 * Wire/domain types shared between server and web client. All ids are strings
 * (snowflakes). Timestamps are ISO-8601 strings on the wire.
 */

export interface PublicUser {
  id: string;
  username: string;
  displayName: string | null;
  discriminator: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  accentColor: number | null;
  bio: string | null;
  bot: boolean;
  createdAt: string;
}

export interface SelfUser extends PublicUser {
  email: string | null;
  emailVerified: boolean;
  mfaEnabled: boolean;
  premiumType: number;
}

export interface Presence {
  userId: string;
  status: PresenceStatus;
  customStatus: string | null;
  activities: Activity[];
  updatedAt: string;
}

export interface Activity {
  type: number;
  name: string;
  details?: string | null;
  state?: string | null;
  since?: number | null;
}

export interface Relationship {
  userId: string;
  type: RelationshipType;
  since: string;
  user: PublicUser;
}

export interface Role {
  id: string;
  guildId: string;
  name: string;
  color: number;
  hoist: boolean;
  position: number;
  /** Serialized permission bits. */
  permissions: string;
  managed: boolean;
  mentionable: boolean;
  isEveryone: boolean;
}

export interface ChannelOverwrite {
  targetId: string;
  type: 0 | 1;
  allow: string;
  deny: string;
}

export interface Channel {
  id: string;
  type: ChannelType;
  guildId: string | null;
  name: string | null;
  topic: string | null;
  position: number;
  parentId: string | null;
  nsfw: boolean;
  rateLimitPerUser: number;
  userLimit: number;
  bitrate: number;
  lastMessageId: string | null;
  ownerId: string | null;
  permissionOverwrites: ChannelOverwrite[];
  /** Computed permissions for the requesting user (guild channels only). */
  permissions?: string;
  recipients?: PublicUser[];
  createdAt: string;
}

export interface Guild {
  id: string;
  name: string;
  iconUrl: string | null;
  ownerId: string;
  systemChannelId: string | null;
  rulesChannelId: string | null;
  description: string | null;
  memberCount?: number;
  presenceCount?: number;
  roles?: Role[];
  channels?: Channel[];
  features: string[];
  createdAt: string;
}

export interface GuildMember {
  guildId: string;
  userId: string;
  nickname: string | null;
  roles: string[];
  joinedAt: string;
  timeoutUntil: string | null;
  isOwner: boolean;
  user?: PublicUser;
  presence?: Presence;
}

export interface Attachment {
  id: string;
  messageId: string | null;
  filename: string;
  contentType: string | null;
  size: number;
  width: number | null;
  height: number | null;
  url: string;
  proxyUrl: string;
  isSpoiler: boolean;
}

export interface Reaction {
  emoji: string;
  count: number;
  me: boolean;
  users?: string[];
}

export interface Message {
  id: string;
  channelId: string;
  guildId: string | null;
  author: PublicUser;
  content: string;
  timestamp: string;
  editedTimestamp: string | null;
  tts: boolean;
  mentionEveryone: boolean;
  mentions: PublicUser[];
  mentionRoleIds: string[];
  pinned: boolean;
  type: MessageType;
  flags: number;
  attachments: Attachment[];
  reactions: Reaction[];
  embeds: unknown[];
  referencedMessage: Message | null;
  threadId: string | null;
  nonce: string | null;
  webhookId: string | null;
}

export interface ReadState {
  channelId: string;
  lastReadMessageId: string | null;
  mentionCount: number;
  unread: boolean;
}

export interface Invite {
  code: string;
  guildId: string;
  channelId: string;
  inviterId: string | null;
  uses: number;
  maxUses: number;
  maxAge: number;
  temporary: boolean;
  expiresAt: string | null;
  createdAt: string;
  guild?: Guild;
}

export interface VoiceState {
  guildId: string;
  channelId: string;
  userId: string;
  sessionId: string;
  selfMute: boolean;
  selfDeaf: boolean;
  selfStream: boolean;
  selfVideo: boolean;
  mute: boolean;
  deaf: boolean;
  suppress: boolean;
}

export interface AuditLogEntry {
  id: string;
  guildId: string;
  actionType: number;
  actorId: string | null;
  targetId: string | null;
  reason: string | null;
  changes: AuditLogChange[];
  createdAt: string;
  actor?: PublicUser | null;
}

export interface AuditLogChange {
  key: string;
  oldValue?: unknown;
  newValue?: unknown;
}

export interface Notification {
  id: string;
  userId: string;
  type: "mention" | "dm" | "friend_request" | "guild_invite" | "system";
  actorId: string | null;
  guildId: string | null;
  channelId: string | null;
  messageId: string | null;
  title: string;
  body: string | null;
  read: boolean;
  createdAt: string;
}

export interface NotificationSettings {
  desktop: boolean;
  sounds: boolean;
  suppressEveryone: boolean;
  suppressRoles: boolean;
  suppressFromOthers: boolean;
}

export interface UserSettings {
  theme: "dark" | "light";
  messageDisplay: "cozy" | "compact";
  reducedMotion: boolean;
  fontScale: number;
  locale: string;
}

export interface Page<T> {
  items: T[];
  /** Cursor for fetching the next page (opaque). */
  nextCursor: string | null;
}

/** Realtime event envelope: `{t: eventName, d: payload}` mirrors Discord's gateway shape. */
export interface GatewayPayload<T = unknown> {
  t: string;
  d: T;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
