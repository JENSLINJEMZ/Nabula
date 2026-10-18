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

/**
 * A structured, self-contained embed. Nebula never fetches remote URLs to build
 * embeds: every field here is supplied verbatim by an authenticated caller and
 * rendered client-side from the stored values only.
 */
export interface Embed {
  title: string | null;
  description: string | null;
  url: string | null;
  color: number | null;
  fields: EmbedField[];
}

export interface EmbedField {
  name: string;
  value: string;
  inline: boolean;
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
  embeds: Embed[];
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

/**
 * Slash-command metadata. Mirrors the server registry so the composer can render
 * autocomplete, argument hints and validation errors without hard-coding command
 * knowledge in the client.
 */
export interface CommandOption {
  name: string;
  description: string;
  /** Argument type: 3 = string, 4 = integer, 5 = boolean, 6 = user, 8 = choice. */
  type: number;
  required: boolean;
  /** Allowed values for choice arguments (type 8). */
  choices?: string[];
  /** Example value shown as a hint. */
  example?: string;
}

export interface Command {
  id: string;
  name: string;
  description: string;
  /** Usage string, e.g. `/me <text>`. */
  usage: string;
  options: CommandOption[];
  dmCapable: boolean;
  /** True when the command always answers only the invoker (never posts). */
  ephemeral: boolean;
}

/** Ephemeral response to an invocation, delivered to the invoker over the gateway. */
export interface CommandResult {
  command: string;
  invocationId: string | null;
  content: string;
  ephemeral: boolean;
}

export interface Webhook {
  id: string;
  guildId: string | null;
  channelId: string;
  name: string;
  /** First bytes of the token, safe to display. Never the full token. */
  tokenPrefix: string;
  avatarUrl: string | null;
  creatorId: string | null;
  disabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  rotatedAt: string | null;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  messageId: string | null;
  statusCode: number;
  success: boolean;
  error: string | null;
  createdAt: string;
}
