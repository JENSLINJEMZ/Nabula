import type { Message, ReadState, VoiceState } from "@nebula/shared";
import type { AppState } from "./store";
import { getSocket } from "./lib/socket";

type Setter = (
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState>),
  replace?: boolean,
) => void;

/** Wire all server -> client gateway events into the store. Idempotent per socket. */
export function applyRealtime(set: Setter, get: () => AppState): void {
  const socket = getSocket();
  if (!socket) return;

  socket.on("READY", (payload: { user?: unknown }) => {
    set({ ready: true });
    if (payload && typeof payload === "object" && "user" in payload) {
      // The gateway echoes the self user; keep it fresh after reconnects.
      void get().loadRelationships();
    }
  });

  socket.on("MESSAGE_CREATE", (message: Message) => {
    set((s) => {
      const list = s.messagesByChannel[message.channelId] ?? [];
      if (list.some((m) => m.id === message.id)) return {};
      const isActive =
        message.channelId === (s.activeChannelId ?? s.activeDmId);
      return {
        messagesByChannel: { ...s.messagesByChannel, [message.channelId]: [...list, message] },
        // Incoming messages in the channel I'm looking at are auto-read.
        readStates: isActive
          ? {
              ...s.readStates,
              [message.channelId]: {
                channelId: message.channelId,
                lastReadMessageId: message.id,
                mentionCount: 0,
                unread: false,
              },
            }
          : s.readStates,
      };
    });
  });

  socket.on("MESSAGE_UPDATE", (message: Message) => {
    set((s) => {
      const list = s.messagesByChannel[message.channelId] ?? [];
      return {
        messagesByChannel: {
          ...s.messagesByChannel,
          [message.channelId]: list.map((m) => (m.id === message.id ? { ...m, ...message } : m)),
        },
      };
    });
  });

  socket.on("MESSAGE_DELETE", (payload: { id?: string; ids?: string[]; channelId: string }) => {
    set((s) => {
      const list = s.messagesByChannel[payload.channelId] ?? [];
      const removed = new Set(payload.ids ?? (payload.id ? [payload.id] : []));
      return {
        messagesByChannel: {
          ...s.messagesByChannel,
          [payload.channelId]: list.filter((m) => !removed.has(m.id)),
        },
        pinnedByChannel: {
          ...s.pinnedByChannel,
          [payload.channelId]: (s.pinnedByChannel[payload.channelId] ?? []).filter((m) => !removed.has(m.id)),
        },
      };
    });
  });

  socket.on(
    "MESSAGE_REACTION_ADD",
    (payload: { channelId: string; messageId: string; emoji: string; userId: string; count?: number }) => {
      set((s) => applyReactionDelta(s, payload, 1));
    },
  );

  socket.on(
    "MESSAGE_REACTION_REMOVE",
    (payload: { channelId: string; messageId: string; emoji: string; userId: string; count?: number }) => {
      set((s) => applyReactionDelta(s, payload, -1));
    },
  );

  socket.on("TYPING_START", (payload: { channelId: string; userId: string }) => {
    const key = `${payload.channelId}:${payload.userId}`;
    set((s) => ({ typing: { ...s.typing, [key]: Date.now() + 6000 } }));
  });

  socket.on("PRESENCE_UPDATE", (payload: { userId: string; status: string }) => {
    set((s) => ({ presence: { ...s.presence, [payload.userId]: payload.status } }));
  });

  socket.on("READ_STATE_UPDATE", (state: ReadState) => {
    set((s) => ({ readStates: { ...s.readStates, [state.channelId]: state } }));
  });

  socket.on("NOTIFICATION_CREATE", () => {
    void get().loadNotifications();
  });

  socket.on("RELATIONSHIP_UPDATE", () => {
    void get().loadRelationships();
  });

  socket.on("VOICE_STATE_UPDATE", (state: VoiceState) => {
    set((s) => {
      const others = s.voiceStates.filter((v) => v.userId !== state.userId);
      const next = state.channelId ? [...others, state] : others;
      return { voiceStates: next };
    });
  });

  socket.on("GUILD_CREATE", () => void get().loadGuilds());
  socket.on("GUILD_UPDATE", () => void get().loadGuilds());
  socket.on("GUILD_DELETE", () => {
    void get().loadGuilds();
    const active = get().activeGuildId;
    if (active && !get().guilds.some((g) => g.id === active)) set({ activeGuildId: null, activeChannelId: null });
  });
  socket.on("GUILD_MEMBER_ADD", () => {
    const gid = get().activeGuildId;
    if (gid) void get().loadMembers(gid);
  });
  socket.on("GUILD_MEMBER_REMOVE", () => {
    const gid = get().activeGuildId;
    if (gid) void get().loadMembers(gid);
  });
  socket.on("GUILD_ROLE_CREATE", () => {
    const gid = get().activeGuildId;
    if (gid) void get().loadRoles(gid);
  });
  socket.on("GUILD_ROLE_UPDATE", () => {
    const gid = get().activeGuildId;
    if (gid) void get().loadRoles(gid);
  });
  socket.on("GUILD_ROLE_DELETE", () => {
    const gid = get().activeGuildId;
    if (gid) void get().loadRoles(gid);
  });
  socket.on("CHANNEL_CREATE", () => {
    const gid = get().activeGuildId;
    if (!gid) return;
    // Refresh the sidebar; do NOT re-select the first channel (that would yank
    // the user out of the channel they are viewing when a thread is created).
    void get().loadChannels(gid);
    const active = get().activeChannelId;
    if (active) void get().loadThreads(active);
  });
  socket.on("CHANNEL_UPDATE", () => {
    const gid = get().activeGuildId;
    if (gid) void get().loadChannels(gid);
  });
  socket.on("CHANNEL_DELETE", () => {
    const gid = get().activeGuildId;
    if (gid) void get().loadChannels(gid);
    if (!get().activeChannelId) return;
  });
  socket.on("ERROR", (payload: { code?: string; message?: string }) => {
    set({ toast: { kind: "error", message: payload.message ?? "Realtime error" } });
  });
}

function applyReactionDelta(
  s: AppState,
  payload: { channelId: string; messageId: string; emoji: string; userId: string; count?: number },
  delta: number,
): Partial<AppState> {
  const list = s.messagesByChannel[payload.channelId];
  if (!list) return {};
  const me = s.me?.id;
  const isMe = payload.userId === me;
  return {
    messagesByChannel: {
      ...s.messagesByChannel,
      [payload.channelId]: list.map((m) => {
        if (m.id !== payload.messageId) return m;
        const reactions = [...(m.reactions ?? [])];
        const idx = reactions.findIndex((r) => r.emoji === payload.emoji);
        if (idx === -1) {
          if (delta < 0) return m;
          reactions.push({ emoji: payload.emoji, count: payload.count ?? 1, me: isMe });
        } else {
          const current = reactions[idx]!;
          const count = Math.max(0, current.count + delta);
          if (count === 0) reactions.splice(idx, 1);
          else reactions[idx] = { ...current, count, me: isMe ? delta > 0 : current.me };
        }
        return { ...m, reactions };
      }),
    },
  };
}
