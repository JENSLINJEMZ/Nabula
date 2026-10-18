import type { Server as HttpServer } from "node:http";
import { ClientEvents, Errors, ServerEvents, isNebulaError, rooms } from "@nebula/shared";
import { Server, type Socket } from "socket.io";
import { env } from "../config.js";
import { logger } from "../logger.js";
import { SESSION_COOKIE, resolveSession } from "../auth/sessions.js";
import { pool, query } from "../db/pool.js";
import { filterAccessibleThreads, listDmChannels, listGuildChannelsForUser } from "../domain/channels.js";
import { getNotificationSettings } from "../domain/notifications.js";
import { getSelfUser, getUserPresence, setPresence } from "../domain/users.js";
import { listGuildsForUser } from "../domain/guilds.js";
import { markChannelRead } from "../domain/messages.js";
import { assertChannelAccess } from "../domain/permissions.js";
import { clearVoiceOnDisconnect, updateVoiceState } from "../domain/voice.js";
import { setRealtimeBus, type RealtimeBus } from "./bus.js";

interface SocketData {
  userId: string;
  sessionId: string;
  guildIds: Set<string>;
  channelIds: Set<string>;
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

/** Which channel rooms should this user be subscribed to right now? */
async function computeAccessibleChannels(userId: string): Promise<{ channelIds: string[]; guildIds: string[] }> {
  const guilds = await listGuildsForUser(userId);
  const guildIds = guilds.map((g) => g.id);
  const channelIds: string[] = [];

  for (const guild of guilds) {
    try {
      const channels = await filterAccessibleThreads(userId, await listGuildChannelsForUser(guild.id, userId));
      for (const channel of channels) channelIds.push(channel.id);
    } catch (error) {
      logger.warn("failed to compute guild channels for subscription", {
        guildId: guild.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const dms = await listDmChannels(userId);
  for (const dm of dms) channelIds.push(dm.id);

  return { channelIds, guildIds };
}

async function applySubscriptions(socket: Socket, userId: string, data: SocketData): Promise<void> {
  const { channelIds, guildIds } = await computeAccessibleChannels(userId);

  const nextGuilds = new Set(guildIds);
  for (const id of nextGuilds) {
    if (!data.guildIds.has(id)) await socket.join(rooms.guild(id));
  }
  for (const id of data.guildIds) {
    if (!nextGuilds.has(id)) await socket.leave(rooms.guild(id));
  }
  data.guildIds = nextGuilds;

  const nextChannels = new Set(channelIds);
  for (const id of nextChannels) {
    if (!data.channelIds.has(id)) await socket.join(rooms.channel(id));
  }
  for (const id of data.channelIds) {
    if (!nextChannels.has(id)) await socket.leave(rooms.channel(id));
  }
  data.channelIds = nextChannels;
}

export function attachGateway(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    path: "/socket.io",
    cors: { origin: [env.PUBLIC_WEB_ORIGIN], credentials: true },
    maxHttpBufferSize: 1_000_000,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    transports: ["websocket", "polling"],
  });

  // ---- Realtime bus implementation ----
  const busImpl: RealtimeBus = {
    toChannel(channelId, event, payload) {
      io.to(rooms.channel(channelId)).emit(event, payload);
    },
    toGuild(guildId, event, payload) {
      io.to(rooms.guild(guildId)).emit(event, payload);
    },
    toUser(userId, event, payload) {
      io.to(rooms.user(userId)).emit(event, payload);
    },
    toSocket(socketId, event, payload) {
      io.to(socketId).emit(event, payload);
    },
    toVoicePeers(channelId, exceptUserId, event, payload) {
      io.to(rooms.voice(channelId)).except(rooms.user(exceptUserId)).emit(event, payload);
    },
    refreshGuild(guildId) {
      void refreshGuildSubscriptions(guildId);
    },
  };
  setRealtimeBus(busImpl);

  /**
   * Recompute channel subscriptions for every connected member of a guild. Called
   * after permission-affecting changes (role edits, overwrite edits, membership
   * changes) so that clients never keep receiving events for a channel they can no
   * longer view, nor miss events for one they now can.
   */
  async function refreshGuildSubscriptions(guildId: string): Promise<void> {
    const sockets = await io.in(rooms.guild(guildId)).fetchSockets();
    for (const socket of sockets) {
      const data = socket.data as SocketData;
      if (!data.userId) continue;
      try {
        await applySubscriptions(socket as unknown as Socket, data.userId, data);
      } catch (error) {
        logger.warn("subscription refresh failed", {
          guildId,
          userId: data.userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  io.use(async (socket, next) => {
    try {
      const cookies = parseCookies(socket.handshake.headers.cookie);
      const token = cookies[SESSION_COOKIE];
      const resolved = await resolveSession(token);
      if (!resolved) {
        next(new Error("UNAUTHENTICATED"));
        return;
      }
      const data = socket.data as SocketData;
      data.userId = resolved.userId;
      data.sessionId = resolved.session.id;
      data.guildIds = new Set();
      data.channelIds = new Set();
      next();
    } catch (error) {
      logger.warn("socket handshake failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      next(new Error("UNAUTHENTICATED"));
    }
  });

  io.on("connection", (socket) => {
    const data = socket.data as SocketData;
    const { userId } = data;

    /** Send the current gateway state snapshot. Also re-issued on IDENTIFY. */
    const sendReady = async () => {
      const [user, notificationSettings] = await Promise.all([
        getSelfUser(userId),
        getNotificationSettings(userId),
      ]);
      socket.emit(ServerEvents.READY, {
        sessionId: data.sessionId,
        user,
        guildIds: [...data.guildIds],
        notificationSettings,
      });
    };

    void (async () => {
      try {
        await socket.join(rooms.user(userId));
        await applySubscriptions(socket, userId, data);
        await setPresence(userId, "online", null);

        await sendReady();

        // Notify guild peers that this user came online.
        for (const guildId of data.guildIds) {
          io.to(rooms.guild(guildId)).emit(ServerEvents.PRESENCE_UPDATE, {
            userId,
            status: "online",
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (error) {
        logger.error("gateway connection setup failed", {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        socket.emit(ServerEvents.ERROR, { code: "INTERNAL", message: "Failed to initialise connection." });
      }
    })();

    const safeHandler = <T>(op: string, handler: (payload: T) => Promise<void>) => {
      return (payload: T) => {
        void handler(payload).catch((error) => {
          const code = isNebulaError(error) ? error.code : "INTERNAL";
          const message = isNebulaError(error)
            ? error.message
            : "An internal error occurred while handling the event.";
          if (!isNebulaError(error)) {
            logger.error("gateway handler error", {
              op,
              userId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          socket.emit(ServerEvents.ERROR, { code, message, op });
        });
      };
    };

    socket.on(
      ClientEvents.HEARTBEAT,
      safeHandler(ClientEvents.HEARTBEAT, async () => {
        socket.emit(ServerEvents.HEARTBEAT_ACK, { at: Date.now() });
      }),
    );

    socket.on(
      ClientEvents.IDENTIFY,
      safeHandler(ClientEvents.IDENTIFY, async () => {
        // Re-send the state snapshot. Idempotent: safe to call on reconnect.
        await sendReady();
      }),
    );

    socket.on(
      ClientEvents.SUBSCRIBE_GUILD,
      safeHandler<{ guildId: string }>(ClientEvents.SUBSCRIBE_GUILD, async (payload) => {
        const guildId = String(payload?.guildId ?? "");
        if (!guildId) throw Errors.VALIDATION_FAILED({ field: "guildId" });
        const member = await query(`SELECT 1 FROM guild_members WHERE guild_id = $1 AND user_id = $2`, [
          guildId,
          userId,
        ]);
        if (member.length === 0) throw Errors.NOT_GUILD_MEMBER();
        const channels = await filterAccessibleThreads(userId, await listGuildChannelsForUser(guildId, userId));
        await socket.join(rooms.guild(guildId));
        data.guildIds.add(guildId);
        for (const channel of channels) {
          await socket.join(rooms.channel(channel.id));
          data.channelIds.add(channel.id);
        }
      }),
    );

    socket.on(
      ClientEvents.UNSUBSCRIBE_GUILD,
      safeHandler<{ guildId: string }>(ClientEvents.UNSUBSCRIBE_GUILD, async (payload) => {
        const guildId = String(payload?.guildId ?? "");
        await socket.leave(rooms.guild(guildId));
        data.guildIds.delete(guildId);
      }),
    );

    socket.on(
      ClientEvents.TYPING_START,
      safeHandler<{ channelId: string }>(ClientEvents.TYPING_START, async (payload) => {
        const channelId = String(payload?.channelId ?? "");
        const access = await assertChannelAccess(channelId, userId, undefined as never);
        io.to(rooms.channel(channelId)).emit(ServerEvents.TYPING_START, {
          channelId,
          guildId: access.channel.guild_id,
          userId,
          timestamp: Date.now(),
        });
      }),
    );

    socket.on(
      ClientEvents.PRESENCE_UPDATE,
      safeHandler<{ status: string; customStatus?: string | null; activities?: unknown[] }>(
        ClientEvents.PRESENCE_UPDATE,
        async (payload) => {
          const status = ["online", "idle", "dnd", "invisible", "offline"].includes(payload?.status)
            ? payload.status
            : "online";
          const presenceStatus = status === "invisible" ? "offline" : status;
          await setPresence(userId, presenceStatus, payload?.customStatus ?? null, payload?.activities ?? []);
          const presence = await getUserPresence(userId);
          for (const guildId of data.guildIds) {
            io.to(rooms.guild(guildId)).emit(ServerEvents.PRESENCE_UPDATE, presence);
          }
          io.to(rooms.user(userId)).emit(ServerEvents.PRESENCE_UPDATE, presence);
        },
      ),
    );

    socket.on(
      ClientEvents.READ_STATE_ACK,
      safeHandler<{ channelId: string; messageId?: string | null }>(ClientEvents.READ_STATE_ACK, async (payload) => {
        const channelId = String(payload?.channelId ?? "");
        await markChannelRead(channelId, userId, payload?.messageId ?? null);
      }),
    );

    socket.on(
      ClientEvents.VOICE_STATE_UPDATE,
      safeHandler<{
        selfMute?: boolean;
        selfDeaf?: boolean;
        selfStream?: boolean;
        selfVideo?: boolean;
      }>(ClientEvents.VOICE_STATE_UPDATE, async (payload) => {
        await updateVoiceState(userId, {
          selfMute: payload?.selfMute,
          selfDeaf: payload?.selfDeaf,
          selfStream: payload?.selfStream,
          selfVideo: payload?.selfVideo,
        });
      }),
    );

    socket.on(
      ClientEvents.VOICE_SIGNAL,
      safeHandler<{
        channelId: string;
        toUserId: string;
        kind: "offer" | "answer" | "candidate";
        payload: unknown;
      }>(ClientEvents.VOICE_SIGNAL, async (payload) => {
        const channelId = String(payload?.channelId ?? "");
        const toUserId = String(payload?.toUserId ?? "");
        const kind = payload?.kind;
        if (!channelId || !toUserId || !["offer", "answer", "candidate"].includes(String(kind))) {
          throw Errors.VALIDATION_FAILED(undefined, "Malformed voice signal.");
        }
        // Both parties must currently be connected to the same voice channel.
        const rows = await query<{ user_id: string; channel_id: string }>(
          `SELECT user_id, channel_id FROM voice_states WHERE user_id = ANY($1::bigint[])`,
          [[userId, toUserId]],
        );
        const mine = rows.find((r) => r.user_id === userId);
        const theirs = rows.find((r) => r.user_id === toUserId);
        if (!mine || !theirs || mine.channel_id !== theirs.channel_id || mine.channel_id !== channelId) {
          throw Errors.FORBIDDEN(undefined, "Voice signalling requires both peers in the same voice channel.");
        }

        // Relay to all of the target's devices; the client correlates by `fromUserId`.
        io.to(rooms.user(toUserId)).emit(ServerEvents.VOICE_SIGNAL, {
          channelId,
          fromUserId: userId,
          toUserId,
          kind,
          payload: payload.payload,
        });
      }),
    );

    socket.on("disconnect", (reason) => {
      void (async () => {
        try {
          await clearVoiceOnDisconnect(userId);
          // Only mark offline when no other connection for this user remains.
          const remaining = await io.in(rooms.user(userId)).fetchSockets();
          if (remaining.length === 0) {
            await setPresence(userId, "offline", null);
            for (const guildId of data.guildIds) {
              io.to(rooms.guild(guildId)).emit(ServerEvents.PRESENCE_UPDATE, {
                userId,
                status: "offline",
                updatedAt: new Date().toISOString(),
              });
            }
          }
        } catch (error) {
          logger.warn("disconnect cleanup failed", {
            userId,
            reason,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    });
  });

  logger.info("realtime gateway attached");
  return io;
}

export async function shutdownGateway(io: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    io.close(() => resolve());
  });
  await pool.end().catch(() => undefined);
}
