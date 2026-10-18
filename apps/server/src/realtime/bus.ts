import type { ServerEventName } from "@nebula/shared";

/**
 * Decouples domain services from Socket.IO. Services publish events through this
 * bus; the realtime gateway installs the concrete implementation at startup.
 * When no gateway is attached (e.g. in unit tests) publishes are no-ops.
 */
export interface RealtimeBus {
  /** Broadcast to everyone currently subscribed to a channel. */
  toChannel(channelId: string, event: ServerEventName, payload: unknown): void;
  /** Broadcast to every connection of a guild. */
  toGuild(guildId: string, event: ServerEventName, payload: unknown): void;
  /** Send to all of a user's active connections (all devices). */
  toUser(userId: string, event: ServerEventName, payload: unknown): void;
  /** Send to a specific socket id. */
  toSocket(socketId: string, event: ServerEventName, payload: unknown): void;
  /** Send to every socket currently in a voice room except one user. */
  toVoicePeers(channelId: string, exceptUserId: string, event: ServerEventName, payload: unknown): void;
  /**
   * Subscribe every one of a user's active connections to a channel room.
   * Needed for channels created *after* connect (e.g. new DMs and group DMs):
   * without it, recipients only receive realtime messages after a reconnect.
   */
  joinUserToChannel(userId: string, channelId: string): Promise<void>;
  /** Unsubscribe every one of a user's active connections from a channel room. */
  leaveUserFromChannel(userId: string, channelId: string): Promise<void>;
  /**
   * Ask the gateway to recompute per-connection channel subscriptions for a
   * guild. Must be called whenever a change could alter who can see which
   * channel (role edits, overwrite edits, membership changes) so that clients
   * never keep receiving events for channels they can no longer view.
   */
  refreshGuild?(guildId: string): void;
}

const noop: RealtimeBus = {
  toChannel: () => undefined,
  toGuild: () => undefined,
  toUser: () => undefined,
  toSocket: () => undefined,
  toVoicePeers: () => undefined,
  joinUserToChannel: async () => undefined,
  leaveUserFromChannel: async () => undefined,
};

let current: RealtimeBus = noop;

export function setRealtimeBus(impl: RealtimeBus): void {
  current = impl;
}

export function bus(): RealtimeBus {
  return current;
}
