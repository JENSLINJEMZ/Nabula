import type { Server, Socket } from "socket.io";
import { ServerEvents } from "@nebula/shared";
import { logger } from "../logger.js";

/**
 * Registry of live sockets keyed by session id.
 *
 * Session revocation (logout, "log out other sessions", password change/reset,
 * 2FA disable) must also terminate realtime connections — the Socket.IO
 * handshake only checks the session once, at connect time. Revocation paths
 * call `disconnectSession` / `disconnectUserSessions` so a revoked session can
 * never keep receiving gateway events.
 *
 * Single-process in-memory registry; with the Socket.IO Redis adapter the same
 * call sites can be extended cluster-wide (documented as a known gap).
 */
let io: Server | null = null;
const socketsBySession = new Map<string, Set<string>>();

export function attachSessionRegistry(server: Server): void {
  io = server;
}

export function registerSessionSocket(sessionId: string, socketId: string): void {
  let set = socketsBySession.get(sessionId);
  if (!set) {
    set = new Set();
    socketsBySession.set(sessionId, set);
  }
  set.add(socketId);
}

export function unregisterSessionSocket(sessionId: string, socketId: string): void {
  const set = socketsBySession.get(sessionId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) socketsBySession.delete(sessionId);
}

/** Terminate every live socket bound to one session. */
export async function disconnectSession(sessionId: string): Promise<void> {
  const socketIds = socketsBySession.get(sessionId);
  if (!socketIds || !io) return;
  for (const socketId of [...socketIds]) {
    try {
      const socket = (await io.in(socketId).fetchSockets())[0];
      if (!socket) {
        unregisterSessionSocket(sessionId, socketId);
        continue;
      }
      socket.emit(ServerEvents.SESSION_REVOKED, { sessionId });
      socket.disconnect(true);
    } catch (error) {
      logger.warn("failed to disconnect revoked session socket", {
        sessionId,
        socketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  socketsBySession.delete(sessionId);
}

/** Terminate every live socket for a user, optionally sparing one session. */
export async function disconnectUserSessions(userId: string, exceptSessionId?: string): Promise<void> {
  if (!io) return;
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const socket of sockets) {
    const data = socket.data as { sessionId?: string };
    if (!data.sessionId || data.sessionId === exceptSessionId) continue;
    socket.emit(ServerEvents.SESSION_REVOKED, { sessionId: data.sessionId });
    socket.disconnect(true);
  }
}

/** Test helper: drop the registry between integration-test servers. */
export function resetSessionRegistry(): void {
  io = null;
  socketsBySession.clear();
}

export function sessionSocketCount(sessionId: string): number {
  return socketsBySession.get(sessionId)?.size ?? 0;
}

/** Used by the gateway connection handler for type-safe socket references. */
export type RegisteredSocket = Socket;
