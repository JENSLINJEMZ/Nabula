import { create } from "zustand";
import type {
  AuditLogEntry,
  Channel,
  Guild,
  GuildMember,
  Invite,
  Message,
  Notification,
  NotificationSettings,
  PublicUser,
  ReadState,
  Relationship,
  Role,
  SelfUser,
  UserSettings,
  VoiceState,
} from "@nebula/shared";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, apiUpload } from "./lib/api";
import { connectSocket, disconnectSocket, getSocket, subscribe } from "./lib/socket";

/* --------------------------------------------------------------- exports */

export type User = PublicUser;
export type {
  AuditLogEntry,
  Channel,
  Guild,
  GuildMember,
  Invite,
  Message,
  Notification,
  NotificationSettings,
  PublicUser,
  ReadState,
  Relationship,
  Role,
  SelfUser,
  UserSettings,
  VoiceState,
};

export type Toast = { kind: "error" | "info" | "success"; message: string } | null;

export { applyRealtime } from "./realtime";

/* ----------------------------------------------------------------- state */

/** localStorage keys used to remember the last viewed location (used by the `/` redirect). */
export const LAST_GUILD_KEY = "nebula:lastGuild";
export const LAST_CHANNEL_KEY = "nebula:lastChannel";
export const LAST_DM_KEY = "nebula:lastDm";

/**
 * Router bridge. The Zustand store lives outside React's router, so navigation
 * triggered by store actions (selectGuild/selectChannel/selectDm) is delegated
 * through this hook. `setRouterNavigator` is called by <NavigationBridge/> which
 * renders inside <BrowserRouter> in App.tsx.
 */
let navTo: ((path: string) => void) | null = null;
export function setRouterNavigator(fn: ((path: string) => void) | null): void {
  navTo = fn;
}

/** Imperative navigation through the router bridge (no-op before the router mounts). */
export function navigateTo(path: string): void {
  navTo?.(path);
}

export interface Overwrite {
  targetId: string;
  type: 0 | 1;
  allow: string;
  deny: string;
}

export interface AppState {
  booted: boolean;
  me: SelfUser | null;

  guilds: Guild[];
  channelsByGuild: Record<string, Channel[]>;
  rolesByGuild: Record<string, Role[]>;
  membersByGuild: Record<string, GuildMember[]>;
  permissionsByGuild: Record<string, string>;
  ownerByGuild: Record<string, boolean>;
  activeGuildId: string | null;
  activeChannelId: string | null;

  dms: Channel[];
  activeDmId: string | null;

  activeThreadId: string | null;
  threadsByChannel: Record<string, Channel[]>;
  threadDrafts: Record<string, string>;

  messagesByChannel: Record<string, Message[]>;
  pinnedByChannel: Record<string, Message[]>;
  relationships: Relationship[];
  presence: Record<string, string>;
  readStates: Record<string, ReadState>;
  notifications: Notification[];
  unreadNotifications: number;

  voiceStates: VoiceState[];
  selfVoice: VoiceState | null;

  typing: Record<string, number>;
  ready: boolean;
  toast: Toast;

  // search
  searchOpen: boolean;
  searchQuery: string;
  searchResults: Message[];
  searchBusy: boolean;

  // ui
  memberProfileId: string | null;
  showUserSettings: boolean;
  showServerSettings: boolean;
  serverSettingsTab: string;
  channelSettingsId: string | null;
  pinnedOpen: boolean;
  notificationsOpen: boolean;

  settings: UserSettings | null;
  notificationSettings: NotificationSettings | null;

  // ---- actions ----
  bootstrap: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, inviteCode?: string) => Promise<void>;
  logout: () => Promise<void>;
  connectRealtime: () => Promise<void>;
  pushToast: (toast: Toast) => void;
  dismissToast: () => void;

  loadGuilds: () => Promise<void>;
  selectGuild: (guildId: string | null, opts?: { channelId?: string; silent?: boolean }) => Promise<void>;
  loadChannels: (guildId: string) => Promise<void>;
  selectChannel: (channelId: string | null, opts?: { silent?: boolean }) => Promise<void>;
  loadThreads: (channelId: string) => Promise<void>;
  openThread: (threadId: string, opts?: { silent?: boolean }) => Promise<void>;
  closeThread: () => void;
  setThreadDraft: (threadId: string, draft: string) => void;
  createThread: (channelId: string, name: string, messageId?: string) => Promise<void>;
  createGuild: (name: string) => Promise<void>;
  updateGuild: (guildId: string, patch: { name?: string; description?: string | null }) => Promise<void>;
  deleteGuild: (guildId: string) => Promise<void>;
  leaveGuild: (guildId: string) => Promise<void>;
  createChannel: (
    guildId: string,
    input: { name: string; type: number; parentId?: string | null; topic?: string | null },
  ) => Promise<void>;
  updateChannel: (channelId: string, patch: Record<string, unknown>) => Promise<void>;
  deleteChannel: (channelId: string) => Promise<void>;
  createInvite: (channelId: string) => Promise<string | null>;
  joinInvite: (code: string) => Promise<void>;
  loadInvites: (guildId: string) => Promise<Invite[]>;
  deleteInvite: (code: string) => Promise<void>;
  transferOwnership: (guildId: string, userId: string) => Promise<void>;
  loadOverwrites: (channelId: string) => Promise<Overwrite[]>;
  upsertOverwrite: (channelId: string, targetId: string, body: { type: 0 | 1; allow: string; deny: string }) => Promise<void>;
  deleteOverwrite: (channelId: string, targetId: string) => Promise<void>;

  loadRoles: (guildId: string) => Promise<void>;
  createRole: (guildId: string, input: Record<string, unknown>) => Promise<void>;
  updateRole: (guildId: string, roleId: string, patch: Record<string, unknown>) => Promise<void>;
  deleteRole: (guildId: string, roleId: string) => Promise<void>;
  setMemberRoles: (guildId: string, userId: string, roles: string[]) => Promise<void>;

  loadMembers: (guildId: string) => Promise<void>;
  setNickname: (guildId: string, userId: string, nickname: string | null) => Promise<void>;
  timeoutMember: (guildId: string, userId: string, seconds: number) => Promise<void>;
  kickMember: (guildId: string, userId: string) => Promise<void>;
  banMember: (guildId: string, userId: string) => Promise<void>;
  unbanMember: (guildId: string, userId: string) => Promise<void>;
  loadBans: (guildId: string) => Promise<{ userId: string; reason: string | null; user?: PublicUser }[]>;
  loadAuditLog: (guildId: string) => Promise<AuditLogEntry[]>;

  loadDms: () => Promise<void>;
  selectDm: (channelId: string | null, opts?: { silent?: boolean }) => Promise<void>;
  openDm: (userId: string) => Promise<void>;
  createGroupDm: (userIds: string[]) => Promise<void>;
  addDmRecipient: (channelId: string, userId: string) => Promise<void>;
  removeDmRecipient: (channelId: string, userId: string) => Promise<void>;
  loadRelationships: () => Promise<void>;
  searchUsers: (q: string) => Promise<PublicUser[]>;
  sendFriendRequest: (userId: string) => Promise<void>;
  acceptFriend: (userId: string) => Promise<void>;
  removeFriend: (userId: string) => Promise<void>;
  blockUser: (userId: string) => Promise<void>;
  unblockUser: (userId: string) => Promise<void>;

  loadMessages: (channelId: string) => Promise<void>;
  loadOlder: (channelId: string) => Promise<void>;
  sendMessage: (channelId: string, content: string) => Promise<void>;
  sendReply: (channelId: string, content: string, referenceMessageId: string) => Promise<void>;
  editMessage: (messageId: string, content: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  forwardMessage: (messageId: string, channelIds: string[]) => Promise<number>;
  toggleReaction: (channelId: string, messageId: string, emoji: string, me: boolean) => Promise<void>;
  loadPins: (channelId: string) => Promise<void>;
  pinMessage: (messageId: string) => Promise<void>;
  unpinMessage: (messageId: string) => Promise<void>;
  uploadAttachment: (channelId: string, file: File) => Promise<{ id: string; filename: string } | null>;
  sendWithAttachments: (channelId: string, content: string, attachmentIds: string[]) => Promise<void>;
  search: (q: string) => Promise<void>;
  setSearchOpen: (open: boolean) => void;

  joinVoice: (channelId: string) => Promise<void>;
  leaveVoice: () => Promise<void>;
  toggleMute: () => Promise<void>;
  toggleDeaf: () => Promise<void>;

  setTyping: (channelId: string) => void;
  setPresence: (status: string) => Promise<void>;
  updateProfile: (patch: { displayName?: string | null; bio?: string | null }) => Promise<void>;
  loadSettings: () => Promise<void>;
  updateSettings: (patch: Partial<UserSettings>) => Promise<void>;
  loadNotificationSettings: () => Promise<void>;
  updateNotificationSettings: (patch: Partial<NotificationSettings>) => Promise<void>;

  loadReadStates: () => Promise<void>;
  ackChannel: (channelId: string, messageId?: string | null) => Promise<void>;
  loadNotifications: () => Promise<void>;
  ackNotifications: (ids?: string[]) => Promise<void>;

  openMemberProfile: (userId: string | null) => void;
  setUserSettingsOpen: (open: boolean) => void;
  setServerSettingsOpen: (open: boolean) => void;
  setServerSettingsTab: (tab: string) => void;
  setChannelSettings: (channelId: string | null) => void;
  setPinnedOpen: (open: boolean) => void;
  setNotificationsOpen: (open: boolean) => void;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}

/* ----------------------------------------------------------------- store */

export const useApp = create<AppState>()((set, get) => {
  /** Run a mutation, surfacing failures as a toast. */
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      set({ toast: { kind: "error", message: errText(error) } });
      return undefined;
    }
  }

  return {
    booted: false,
    me: null,
    guilds: [],
    channelsByGuild: {},
    rolesByGuild: {},
    membersByGuild: {},
    permissionsByGuild: {},
    ownerByGuild: {},
    activeGuildId: null,
    activeChannelId: null,
    dms: [],
    activeDmId: null,
    activeThreadId: null,
    threadsByChannel: {},
    threadDrafts: {},
    messagesByChannel: {},
    pinnedByChannel: {},
    relationships: [],
    presence: {},
    readStates: {},
    notifications: [],
    unreadNotifications: 0,
    voiceStates: [],
    selfVoice: null,
    typing: {},
    ready: false,
    toast: null,
    searchOpen: false,
    searchQuery: "",
    searchResults: [],
    searchBusy: false,
    memberProfileId: null,
    showUserSettings: false,
    showServerSettings: false,
    serverSettingsTab: "overview",
    channelSettingsId: null,
    pinnedOpen: false,
    notificationsOpen: false,
    settings: null,
    notificationSettings: null,

    pushToast: (toast) => set({ toast }),
    dismissToast: () => set({ toast: null }),

    async bootstrap() {
      try {
        const res = await apiGet<{ user: SelfUser | null }>("/api/auth/me");
        if (res.user) {
          set({ me: res.user });
          await Promise.all([get().loadGuilds(), get().loadDms(), get().loadRelationships(), get().loadReadStates()]);
          void get().loadNotifications();
          await get().connectRealtime();
        }
      } catch {
        // Not signed in.
      } finally {
        set({ booted: true });
      }
    },

    async login(username, password) {
      const res = await apiPost<{ user: SelfUser }>("/api/auth/login", { username, password });
      set({ me: res.user });
      await Promise.all([get().loadGuilds(), get().loadDms(), get().loadRelationships(), get().loadReadStates()]);
      void get().loadNotifications();
      await get().connectRealtime();
    },

    async register(username, password, inviteCode) {
      const res = await apiPost<{ user: SelfUser }>("/api/auth/register", { username, password, inviteCode: inviteCode || null });
      set({ me: res.user });
      await Promise.all([get().loadGuilds(), get().loadDms()]);
      await get().connectRealtime();
    },

    async logout() {
      try {
        await apiPost("/api/auth/logout");
      } finally {
        disconnectSocket();
        set({
          me: null,
          guilds: [],
          channelsByGuild: {},
          rolesByGuild: {},
          membersByGuild: {},
          dms: [],
          messagesByChannel: {},
          pinnedByChannel: {},
          relationships: [],
          notifications: [],
          readStates: {},
          activeGuildId: null,
          activeChannelId: null,
          activeDmId: null,
          activeThreadId: null,
          threadsByChannel: {},
          threadDrafts: {},
          ready: false,
        });
        navTo?.("/");
      }
    },

    async connectRealtime() {
      connectSocket();
      subscribe(
        (partial) => set(partial as never),
        get,
      );
    },

    /* ---------------------------------------------------------- guilds */

    async loadGuilds() {
      const res = await apiGet<{ guilds: Guild[] }>("/api/guilds");
      set({ guilds: res.guilds });
    },

    async selectGuild(guildId, opts) {
      set({ activeGuildId: guildId, activeChannelId: null, activeDmId: null, activeThreadId: null });
      try {
        if (guildId) localStorage.setItem(LAST_GUILD_KEY, guildId);
        else localStorage.removeItem(LAST_GUILD_KEY);
      } catch {
        /* storage unavailable */
      }
      if (!guildId) {
        if (!opts?.silent) navTo?.("/channels/@me");
        return;
      }
      await Promise.all([get().loadChannels(guildId), get().loadRoles(guildId), get().loadMembers(guildId)]);
      const perms = await run(async () =>
        apiGet<{ permissions: string; isOwner: boolean }>(`/api/guilds/${guildId}/permissions`),
      );
      if (perms) {
        set((s) => ({
          permissionsByGuild: { ...s.permissionsByGuild, [guildId]: perms.permissions },
          ownerByGuild: { ...s.ownerByGuild, [guildId]: perms.isOwner },
        }));
      }
      const channels = get().channelsByGuild[guildId] ?? [];
      const target =
        (opts?.channelId ? channels.find((c) => c.id === opts.channelId) : undefined) ??
        channels.find((c) => c.type === 0);
      if (target) await get().selectChannel(target.id, { silent: opts?.silent });
    },

    async loadChannels(guildId) {
      const res = await apiGet<{ channels: Channel[] }>(`/api/guilds/${guildId}/channels`);
      set((s) => ({ channelsByGuild: { ...s.channelsByGuild, [guildId]: res.channels } }));
    },

    async selectChannel(channelId, opts) {
      set({ activeChannelId: channelId, activeDmId: null, activeThreadId: null, pinnedOpen: false });
      if (channelId) {
        try {
          localStorage.setItem(LAST_CHANNEL_KEY, channelId);
        } catch {
          /* storage unavailable */
        }
        const guildId = get().activeGuildId;
        if (!opts?.silent && guildId) navTo?.(`/channels/${guildId}/${channelId}`);
        await get().loadMessages(channelId);
        void get().loadThreads(channelId);
        void get().ackChannel(channelId);
      }
    },

    async createGuild(name) {
      const res = await run(async () => apiPost<{ guild: Guild }>("/api/guilds", { name }));
      if (!res) return;
      await get().loadGuilds();
      await get().selectGuild(res.guild.id);
    },

    async updateGuild(guildId, patch) {
      await run(async () => apiPatch(`/api/guilds/${guildId}`, patch));
      await get().loadGuilds();
    },

    async deleteGuild(guildId) {
      await run(async () => apiDelete(`/api/guilds/${guildId}`));
      set({ activeGuildId: null, activeChannelId: null, showServerSettings: false });
      await get().loadGuilds();
    },

    async leaveGuild(guildId) {
      await run(async () => apiPost(`/api/guilds/${guildId}/leave`));
      set({ activeGuildId: null, activeChannelId: null, showServerSettings: false });
      await get().loadGuilds();
    },

    async createChannel(guildId, input) {
      const res = await run(async () =>
        apiPost<{ channel: Channel }>(`/api/guilds/${guildId}/channels`, {
          name: input.name,
          type: input.type,
          parentId: input.parentId ?? null,
          topic: input.topic ?? null,
        }),
      );
      if (!res) return;
      await get().loadChannels(guildId);
      if (input.type === 0) await get().selectChannel(res.channel.id);
    },

    async updateChannel(channelId, patch) {
      await run(async () => apiPatch(`/api/channels/${channelId}`, patch));
      const gid = get().activeGuildId;
      if (gid) await get().loadChannels(gid);
    },

    async deleteChannel(channelId) {
      await run(async () => apiDelete(`/api/channels/${channelId}`));
      if (get().activeChannelId === channelId) set({ activeChannelId: null });
      const gid = get().activeGuildId;
      if (gid) await get().loadChannels(gid);
    },

    async createInvite(channelId) {
      const res = await run(async () => apiPost<{ invite: Invite }>(`/api/channels/${channelId}/invites`, {}));
      return res?.invite.code ?? null;
    },

    async joinInvite(code) {
      const res = await run(async () => apiPost<{ guildId: string }>(`/api/invites/${encodeURIComponent(code)}`));
      if (!res) return;
      await get().loadGuilds();
      await get().selectGuild(res.guildId);
    },

    async loadInvites(guildId) {
      const res = await apiGet<{ invites: Invite[] }>(`/api/guilds/${guildId}/invites`);
      return res.invites;
    },

    async deleteInvite(code) {
      await run(async () => apiDelete(`/api/invites/${encodeURIComponent(code)}`));
    },

    async transferOwnership(guildId, userId) {
      await run(async () => apiPost(`/api/guilds/${guildId}/transfer-ownership`, { userId }));
      await get().loadGuilds();
    },

    async loadOverwrites(channelId) {
      const res = await apiGet<{ overwrites: Overwrite[] }>(`/api/channels/${channelId}/overwrites`);
      return res.overwrites;
    },

    async upsertOverwrite(channelId, targetId, body) {
      await run(async () => apiPut(`/api/channels/${channelId}/permissions/${targetId}`, body));
      const gid = get().activeGuildId;
      if (gid) await get().loadChannels(gid);
    },

    async deleteOverwrite(channelId, targetId) {
      await run(async () => apiDelete(`/api/channels/${channelId}/permissions/${targetId}`));
      const gid = get().activeGuildId;
      if (gid) await get().loadChannels(gid);
    },

    /* ----------------------------------------------------------- roles */

    async loadRoles(guildId) {
      const res = await apiGet<{ roles: Role[] }>(`/api/guilds/${guildId}/roles`);
      set((s) => ({ rolesByGuild: { ...s.rolesByGuild, [guildId]: res.roles } }));
    },

    async createRole(guildId, input) {
      await run(async () => apiPost(`/api/guilds/${guildId}/roles`, input));
      await get().loadRoles(guildId);
    },

    async updateRole(guildId, roleId, patch) {
      await run(async () => apiPatch(`/api/guilds/${guildId}/roles/${roleId}`, patch));
      await get().loadRoles(guildId);
    },

    async deleteRole(guildId, roleId) {
      await run(async () => apiDelete(`/api/guilds/${guildId}/roles/${roleId}`));
      await get().loadRoles(guildId);
    },

    async setMemberRoles(guildId, userId, roles) {
      await run(async () => apiPut(`/api/guilds/${guildId}/members/${userId}/roles`, { roles }));
      await get().loadMembers(guildId);
    },

    /* -------------------------------------------------- members / mod */

    async loadMembers(guildId) {
      const res = await apiGet<{ members: GuildMember[] }>(`/api/guilds/${guildId}/members?limit=200`);
      set((s) => ({ membersByGuild: { ...s.membersByGuild, [guildId]: res.members } }));
      const presence: Record<string, string> = {};
      for (const m of res.members) if (m.presence) presence[m.userId] = m.presence.status;
      if (Object.keys(presence).length) {
        set((s) => ({ presence: { ...s.presence, ...presence } }));
      }
    },

    async setNickname(guildId, userId, nickname) {
      await run(async () => apiPatch(`/api/guilds/${guildId}/members/${userId}`, { nickname }));
      await get().loadMembers(guildId);
    },

    async timeoutMember(guildId, userId, seconds) {
      await run(async () => apiPatch(`/api/guilds/${guildId}/members/${userId}`, { timeoutSeconds: seconds }));
      await get().loadMembers(guildId);
    },

    async kickMember(guildId, userId) {
      await run(async () => apiPost(`/api/guilds/${guildId}/members/${userId}/kick`, {}));
      await get().loadMembers(guildId);
      set({ memberProfileId: null });
    },

    async banMember(guildId, userId) {
      await run(async () => apiPut(`/api/guilds/${guildId}/bans/${userId}`, {}));
      await get().loadMembers(guildId);
      set({ memberProfileId: null });
    },

    async unbanMember(guildId, userId) {
      await run(async () => apiDelete(`/api/guilds/${guildId}/bans/${userId}`));
    },

    async loadBans(guildId) {
      const res = await apiGet<{ bans: { userId: string; reason: string | null; user?: PublicUser }[] }>(
        `/api/guilds/${guildId}/bans`,
      );
      return res.bans;
    },

    async loadAuditLog(guildId) {
      const res = await apiGet<{ entries: AuditLogEntry[] }>(`/api/guilds/${guildId}/audit-logs?limit=50`);
      return res.entries;
    },

    /* ------------------------------------------------------------- DMs */

    async loadDms() {
      const res = await apiGet<{ channels: Channel[] }>("/api/users/@me/channels");
      set({ dms: res.channels });
    },

    async selectDm(channelId, opts) {
      set({ activeGuildId: null, activeChannelId: null, activeDmId: channelId, activeThreadId: null, pinnedOpen: false });
      if (channelId) {
        try {
          localStorage.setItem(LAST_DM_KEY, channelId);
        } catch {
          /* storage unavailable */
        }
        if (!opts?.silent) navTo?.(`/channels/@me/${channelId}`);
        await get().loadMessages(channelId);
        void get().ackChannel(channelId);
      } else {
        // Leaving the DM view: forget the deep-link target so `/` and refreshes
        // don't bounce back to a DM that may have been left or closed.
        try {
          localStorage.removeItem(LAST_DM_KEY);
        } catch {
          /* storage unavailable */
        }
      }
    },

    async loadThreads(channelId) {
      const res = await run(async () => apiGet<{ threads: Channel[] }>(`/api/channels/${channelId}/threads`));
      if (!res) return;
      set((s) => ({ threadsByChannel: { ...s.threadsByChannel, [channelId]: res.threads } }));
    },

    async openThread(threadId, opts) {
      const parent = get().activeChannelId;
      const guildId = get().activeGuildId;
      set({ activeThreadId: threadId, pinnedOpen: false });
      await get().loadMessages(threadId);
      void get().ackChannel(threadId);
      if (!opts?.silent && guildId && parent) navTo?.(`/channels/${guildId}/${parent}/threads/${threadId}`);
    },

    closeThread() {
      const parent = get().activeChannelId;
      const guildId = get().activeGuildId;
      set({ activeThreadId: null });
      if (guildId && parent) navTo?.(`/channels/${guildId}/${parent}`);
    },

    setThreadDraft(threadId, draft) {
      set((s) => ({ threadDrafts: { ...s.threadDrafts, [threadId]: draft } }));
    },

    async createThread(channelId, name, messageId) {
      const res = await run(async () =>
        apiPost<{ thread: Channel }>(`/api/channels/${channelId}/threads`, { name, messageId: messageId ?? null }),
      );
      if (!res) return;
      await get().loadThreads(channelId);
      await get().openThread(res.thread.id);
    },

    async openDm(userId) {
      const res = await run(async () =>
        apiPost<{ channel: Channel }>("/api/users/@me/channels", { recipientId: userId }),
      );
      if (!res) return;
      await get().loadDms();
      await get().selectDm(res.channel.id);
    },

    async createGroupDm(userIds) {
      const res = await run(async () =>
        apiPost<{ channel: Channel }>("/api/users/@me/channels", { recipients: userIds }),
      );
      if (!res) return;
      await get().loadDms();
      await get().selectDm(res.channel.id);
    },

    async addDmRecipient(channelId, userId) {
      const res = await run(async () =>
        apiPost<{ channel: Channel }>(`/api/channels/${channelId}/recipients`, { userId }),
      );
      if (!res) return;
      await get().loadDms();
    },

    async removeDmRecipient(channelId, userId) {
      const me = get().me;
      const res = await run(async () =>
        apiDelete<{ channel?: Channel | null; deleted?: boolean }>(
          `/api/channels/${channelId}/recipients/${userId}`,
        ),
      );
      if (!res) return;
      await get().loadDms();
      // Leaving (or being removed) while viewing this DM — or the group closing
      // because too few participants remain — sends the user back home.
      if (get().activeDmId === channelId && (userId === me?.id || res.deleted)) {
        await get().selectDm(null);
        navTo?.("/channels/@me");
      }
    },

    async loadRelationships() {
      const res = await apiGet<{ relationships: Relationship[] }>("/api/users/@me/relationships");
      set({ relationships: res.relationships });
    },

    async searchUsers(q) {
      try {
        const res = await apiGet<{ users: PublicUser[] }>(`/api/users/search?q=${encodeURIComponent(q)}`);
        return res.users;
      } catch {
        return [];
      }
    },

    async sendFriendRequest(userId) {
      const res = await run(async () => apiPost<{ result: string }>("/api/users/@me/relationships", { userId }));
      if (res) await get().loadRelationships();
    },

    async acceptFriend(userId) {
      await run(async () => apiPut(`/api/users/@me/relationships/${userId}`));
      await get().loadRelationships();
    },

    async removeFriend(userId) {
      await run(async () => apiDelete(`/api/users/@me/relationships/${userId}`));
      await get().loadRelationships();
    },

    async blockUser(userId) {
      await run(async () => apiPut(`/api/users/@me/relationships/${userId}/block`));
      await get().loadRelationships();
    },

    async unblockUser(userId) {
      await run(async () => apiDelete(`/api/users/@me/relationships/${userId}/block`));
      await get().loadRelationships();
    },

    /* -------------------------------------------------------- messages */

    async loadMessages(channelId) {
      const res = await apiGet<{ messages: Message[] }>(`/api/channels/${channelId}/messages?limit=50`);
      set((s) => ({ messagesByChannel: { ...s.messagesByChannel, [channelId]: res.messages } }));
    },

    async loadOlder(channelId) {
      const existing = get().messagesByChannel[channelId] ?? [];
      const oldest = existing[0];
      if (!oldest) return;
      const res = await apiGet<{ messages: Message[] }>(`/api/channels/${channelId}/messages?limit=50&before=${oldest.id}`);
      if (res.messages.length === 0) return;
      set((s) => {
        const list = s.messagesByChannel[channelId] ?? [];
        const seen = new Set(list.map((m) => m.id));
        const merged = [...res.messages.filter((m) => !seen.has(m.id)), ...list];
        return { messagesByChannel: { ...s.messagesByChannel, [channelId]: merged } };
      });
    },

    async sendMessage(channelId, content) {
      if (!(await run(async () => apiPost(`/api/channels/${channelId}/messages`, { content })))) return;
      await get().loadMessages(channelId);
    },

    async sendReply(channelId, content, referenceMessageId) {
      await run(async () => apiPost(`/api/channels/${channelId}/messages`, { content, referenceMessageId }));
      await get().loadMessages(channelId);
    },

    async editMessage(messageId, content) {
      const res = await run(async () => apiPatch<{ message: Message }>(`/api/messages/${messageId}`, { content }));
      if (!res) return;
      set((s) => {
        const list = s.messagesByChannel[res.message.channelId] ?? [];
        return {
          messagesByChannel: {
            ...s.messagesByChannel,
            [res.message.channelId]: list.map((m) => (m.id === messageId ? res.message : m)),
          },
        };
      });
    },

    async deleteMessage(messageId) {
      const channelId = findChannelOfMessage(get(), messageId);
      await run(async () => apiDelete(`/api/messages/${messageId}`));
      if (channelId) {
        set((s) => ({
          messagesByChannel: {
            ...s.messagesByChannel,
            [channelId]: (s.messagesByChannel[channelId] ?? []).filter((m) => m.id !== messageId),
          },
        }));
      }
    },

    async forwardMessage(messageId, channelIds) {
      const res = await run(async () =>
        apiPost<{ messages: Message[] }>(`/api/messages/${messageId}/forward`, { channelIds }),
      );
      if (!res) return 0;
      // Refresh each destination so the copy is visible immediately even if a
      // realtime push has not landed yet.
      for (const id of new Set(res.messages.map((m) => m.channelId))) {
        if (get().messagesByChannel[id]) await get().loadMessages(id);
      }
      const n = res.messages.length;
      get().pushToast({
        kind: "success",
        message: `Forwarded to ${n} ${n === 1 ? "conversation" : "conversations"}.`,
      });
      return n;
    },

    async toggleReaction(channelId, messageId, emoji, me) {
      const enc = encodeURIComponent(emoji);
      if (me) {
        await run(async () => apiDelete(`/api/channels/${channelId}/messages/${messageId}/reactions/${enc}/@me`));
      } else {
        await run(async () => apiPut(`/api/channels/${channelId}/messages/${messageId}/reactions/${enc}/@me`));
      }
    },

    async loadPins(channelId) {
      const res = await apiGet<{ messages: Message[] }>(`/api/channels/${channelId}/pins`);
      set((s) => ({ pinnedByChannel: { ...s.pinnedByChannel, [channelId]: res.messages } }));
    },

    async pinMessage(messageId) {
      const channelId = findChannelOfMessage(get(), messageId);
      await run(async () => apiPut(`/api/messages/${messageId}/pin`));
      if (channelId) await get().loadPins(channelId);
    },

    async unpinMessage(messageId) {
      const channelId = findChannelOfMessage(get(), messageId);
      await run(async () => apiDelete(`/api/messages/${messageId}/pin`));
      if (channelId) await get().loadPins(channelId);
    },

    async uploadAttachment(channelId, file) {
      try {
        const res = await apiUpload<{ attachment: { id: string; filename: string } }>(
          `/api/channels/${channelId}/attachments`,
          file,
        );
        return res.attachment;
      } catch (error) {
        set({ toast: { kind: "error", message: errText(error) } });
        return null;
      }
    },

    async sendWithAttachments(channelId, content, attachmentIds) {
      await run(async () => apiPost(`/api/channels/${channelId}/messages`, { content, attachmentIds }));
      await get().loadMessages(channelId);
    },

    async search(q) {
      if (!q.trim()) {
        set({ searchResults: [], searchQuery: q });
        return;
      }
      set({ searchBusy: true, searchQuery: q });
      try {
        const res = await apiGet<{ messages: Message[] }>(`/api/search?q=${encodeURIComponent(q)}&limit=25`);
        set({ searchResults: res.messages });
      } catch (error) {
        set({ toast: { kind: "error", message: errText(error) } });
      } finally {
        set({ searchBusy: false });
      }
    },

    setSearchOpen: (open) => set({ searchOpen: open, ...(open ? {} : { searchResults: [], searchQuery: "" }) }),

    /* ----------------------------------------------------------- voice */

    async joinVoice(channelId) {
      const res = await run(async () =>
        apiPost<{ state: VoiceState }>(`/api/channels/${channelId}/voice/join`, { selfMute: false, selfDeaf: false }),
      );
      if (res?.state) set({ selfVoice: res.state });
    },

    async leaveVoice() {
      await run(async () => apiDelete("/api/users/@me/voice-state"));
      set({ selfVoice: null });
    },

    async toggleMute() {
      const current = get().selfVoice;
      if (!current) return;
      const selfMute = !current.selfMute;
      await run(async () => apiPatch("/api/users/@me/voice-state", { selfMute }));
      set({ selfVoice: { ...current, selfMute } });
    },

    async toggleDeaf() {
      const current = get().selfVoice;
      if (!current) return;
      const selfDeaf = !current.selfDeaf;
      await run(async () => apiPatch("/api/users/@me/voice-state", { selfDeaf }));
      set({ selfVoice: { ...current, selfDeaf } });
    },

    /* ------------------------------------------------------------ user */

    setTyping(channelId) {
      getSocket()?.emit("TYPING_START", { channelId });
    },

    async setPresence(status) {
      await run(async () => apiPut("/api/users/@me/presence", { status }));
      const me = get().me;
      if (me) set((s) => ({ presence: { ...s.presence, [me.id]: status } }));
    },

    async updateProfile(patch) {
      const res = await run(async () => apiPatch<{ user: SelfUser }>("/api/users/@me", patch));
      if (res) set({ me: res.user, toast: { kind: "success", message: "Profile saved." } });
    },

    async loadSettings() {
      const res = await apiGet<{ settings: UserSettings }>("/api/users/@me/settings");
      set({ settings: res.settings });
    },

    async updateSettings(patch) {
      const res = await run(async () => apiPatch<{ settings: UserSettings }>("/api/users/@me/settings", patch));
      if (res) set({ settings: res.settings });
    },

    async loadNotificationSettings() {
      const res = await apiGet<{ settings: NotificationSettings }>("/api/users/@me/notification-settings");
      set({ notificationSettings: res.settings });
    },

    async updateNotificationSettings(patch) {
      const res = await run(async () =>
        apiPatch<{ settings: NotificationSettings }>("/api/users/@me/notification-settings", patch),
      );
      if (res) set({ notificationSettings: res.settings });
    },

    /* ------------------------------------------- read state / notifs */

    async loadReadStates() {
      try {
        const res = await apiGet<{ readStates: ReadState[] }>("/api/users/@me/read-states");
        const map: Record<string, ReadState> = {};
        for (const rs of res.readStates) map[rs.channelId] = rs;
        set({ readStates: map });
      } catch {
        // Non-fatal.
      }
    },

    async ackChannel(channelId, messageId) {
      try {
        const state = await apiPost<ReadState>(`/api/channels/${channelId}/ack`, {
          messageId: messageId ?? null,
        });
        set((s) => ({ readStates: { ...s.readStates, [channelId]: state } }));
      } catch {
        // Non-fatal.
      }
    },

    async loadNotifications() {
      try {
        const res = await apiGet<{ notifications: Notification[]; unread: number }>("/api/users/@me/notifications");
        set({ notifications: res.notifications, unreadNotifications: res.unread });
      } catch {
        // Non-fatal.
      }
    },

    async ackNotifications(ids) {
      await run(async () => apiPost("/api/users/@me/notifications/ack", ids ? { ids } : {}));
      await get().loadNotifications();
    },

    /* -------------------------------------------------------------- ui */

    openMemberProfile: (userId) => set({ memberProfileId: userId }),
    setUserSettingsOpen: (open) => set({ showUserSettings: open }),
    setServerSettingsOpen: (open) => set({ showServerSettings: open }),
    setServerSettingsTab: (tab) => set({ serverSettingsTab: tab }),
    setChannelSettings: (channelId) => set({ channelSettingsId: channelId }),
    setPinnedOpen: (open) => set({ pinnedOpen: open }),
    setNotificationsOpen: (open) => set({ notificationsOpen: open }),
  };
});

function findChannelOfMessage(state: AppState, messageId: string): string | null {
  for (const [channelId, list] of Object.entries(state.messagesByChannel)) {
    if (list.some((m) => m.id === messageId)) return channelId;
  }
  return null;
}
