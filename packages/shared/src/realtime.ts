/**
 * Realtime protocol contract (Socket.IO). Event names mirror Discord gateway
 * event naming so the semantics are familiar and the domain vocabulary is stable.
 *
 * Client -> Server: `C2S_*`
 * Server -> Client: `S2C_*`
 */

export const ClientEvents = {
  /** Identify with a session; server replies S2C_READY. */
  IDENTIFY: "IDENTIFY",
  HEARTBEAT: "HEARTBEAT",
  SUBSCRIBE_GUILD: "SUBSCRIBE_GUILD",
  UNSUBSCRIBE_GUILD: "UNSUBSCRIBE_GUILD",
  TYPING_START: "TYPING_START",
  PRESENCE_UPDATE: "PRESENCE_UPDATE",
  /** Bulk read-state advance for a channel. */
  READ_STATE_ACK: "READ_STATE_ACK",
  VOICE_STATE_UPDATE: "VOICE_STATE_UPDATE",
  /** WebRTC signaling payloads (offer/answer/ice) relayed to a peer. */
  VOICE_SIGNAL: "VOICE_SIGNAL",
} as const;

export const ServerEvents = {
  READY: "READY",
  RESUMED: "RESUMED",
  ERROR: "ERROR",
  HELLO: "HELLO",
  HEARTBEAT_ACK: "HEARTBEAT_ACK",
  MESSAGE_CREATE: "MESSAGE_CREATE",
  MESSAGE_UPDATE: "MESSAGE_UPDATE",
  MESSAGE_DELETE: "MESSAGE_DELETE",
  MESSAGE_REACTION_ADD: "MESSAGE_REACTION_ADD",
  MESSAGE_REACTION_REMOVE: "MESSAGE_REACTION_REMOVE",
  TYPING_START: "TYPING_START",
  PRESENCE_UPDATE: "PRESENCE_UPDATE",
  GUILD_CREATE: "GUILD_CREATE",
  GUILD_UPDATE: "GUILD_UPDATE",
  GUILD_DELETE: "GUILD_DELETE",
  GUILD_MEMBER_ADD: "GUILD_MEMBER_ADD",
  GUILD_MEMBER_UPDATE: "GUILD_MEMBER_UPDATE",
  GUILD_MEMBER_REMOVE: "GUILD_MEMBER_REMOVE",
  GUILD_ROLE_CREATE: "GUILD_ROLE_CREATE",
  GUILD_ROLE_UPDATE: "GUILD_ROLE_UPDATE",
  GUILD_ROLE_DELETE: "GUILD_ROLE_DELETE",
  CHANNEL_CREATE: "CHANNEL_CREATE",
  CHANNEL_UPDATE: "CHANNEL_UPDATE",
  CHANNEL_DELETE: "CHANNEL_DELETE",
  CHANNEL_PINS_UPDATE: "CHANNEL_PINS_UPDATE",
  READ_STATE_UPDATE: "READ_STATE_UPDATE",
  NOTIFICATION_CREATE: "NOTIFICATION_CREATE",
  RELATIONSHIP_UPDATE: "RELATIONSHIP_UPDATE",
  VOICE_STATE_UPDATE: "VOICE_STATE_UPDATE",
  VOICE_SIGNAL: "VOICE_SIGNAL",
  /** A slash-command invocation result surfaced back to the invoking client. */
  INTERACTION_RESULT: "INTERACTION_RESULT",
} as const;

export type ClientEventName = (typeof ClientEvents)[keyof typeof ClientEvents];
export type ServerEventName = (typeof ServerEvents)[keyof typeof ServerEvents];

export interface SocketErrorPayload {
  code: string;
  message: string;
  /** Original client event name, when the error relates to a specific request. */
  op?: string;
}

export interface ReadyPayload {
  sessionId: string;
  user: unknown;
  guildIds: string[];
  /** Per-user notification settings, echoed so clients can gate toasts. */
  notificationSettings: unknown;
}

export interface TypingStartPayload {
  channelId: string;
  guildId: string | null;
  userId: string;
  timestamp: number;
}

export interface ReadStateUpdatePayload {
  channelId: string;
  lastReadMessageId: string | null;
  mentionCount: number;
  unread: boolean;
}

export interface VoiceSignalPayload {
  channelId: string;
  toUserId: string;
  fromUserId: string;
  /** "offer" | "answer" | "candidate" */
  kind: "offer" | "answer" | "candidate";
  payload: unknown;
}

/** Room naming helpers — one code path for subscribe/permission checks. */
export const rooms = {
  user: (userId: string) => `user:${userId}`,
  guild: (guildId: string) => `guild:${guildId}`,
  channel: (channelId: string) => `channel:${channelId}`,
  voice: (channelId: string) => `voice:${channelId}`,
} as const;
