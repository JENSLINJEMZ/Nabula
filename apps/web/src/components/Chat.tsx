import { useMemo, useState, type ReactNode } from "react";
import {
  Bell,
  ChevronDown,
  Compass,
  Crown,
  Hash,
  Headphones,
  LogOut,
  Mic,
  MicOff,
  Menu,
  Pencil,
  PhoneOff,
  Plus,
  Search,
  Settings as SettingsIcon,
  Trash2,
  UserPlus,
  Volume2,
  X,
} from "lucide-react";
import { Permissions, type Channel, type GuildMember, type Role } from "@nebula/shared";
import { useApp } from "../store";
import { hasBits } from "../lib/perms";
import {
  avatarColor,
  cx,
  displayName,
  memberColor,
  memberName,
  partitionChannels,
  presenceColor,
  roleColor,
  topRole,
} from "../lib/ui";
import { Avatar, Dropdown, IconButton, MenuItem } from "./primitives";
import { ChatView } from "./ChatView";
import { Friends } from "./Friends";
import { GroupDmModal } from "./GroupDmModal";
import { VoicePanel } from "./VoicePanel";
import { Settings } from "./Settings";
import { ServerSettings } from "./ServerSettings";
import { ChannelSettings } from "./ChannelSettings";
import { MemberProfile } from "./MemberProfile";
import { SearchPanel } from "./SearchPanel";
import { PinsPanel } from "./PinsPanel";
import { NotificationsPanel } from "./NotificationsPanel";

/* ------------------------------------------------------------ server rail */

function GuildRail({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const guilds = useApp((s) => s.guilds);
  const activeGuildId = useApp((s) => s.activeGuildId);
  const selectGuild = useApp((s) => s.selectGuild);
  const notificationsOpen = useApp((s) => s.notificationsOpen);
  const setNotificationsOpen = useApp((s) => s.setNotificationsOpen);
  const unread = useApp((s) => s.unreadNotifications);

  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const createGuild = useApp((s) => s.createGuild);
  const joinInvite = useApp((s) => s.joinInvite);

  return (
    <nav className="flex w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto bg-nebula-950 py-3" aria-label="Servers">
      <button
        type="button"
        title="Direct messages"
        onClick={() => {
          void selectGuild(null);
          onToggleSidebar();
        }}
        className={cx(
          "flex h-12 w-12 items-center justify-center rounded-2xl transition-all",
          activeGuildId === null ? "bg-nebula-accent text-white" : "bg-nebula-800 text-slate-300 hover:bg-nebula-accent hover:text-white",
        )}
      >
        <Compass size={22} aria-hidden />
      </button>
      <div className="h-px w-8 bg-nebula-700" aria-hidden />
      {guilds.map((g) => (
        <button
          key={g.id}
          type="button"
          title={g.name}
          onClick={() => {
            void selectGuild(g.id);
            onToggleSidebar();
          }}
          className={cx(
            "flex h-12 w-12 items-center justify-center overflow-hidden rounded-2xl text-sm font-semibold transition-all",
            activeGuildId === g.id
              ? "bg-nebula-accent text-white"
              : "bg-nebula-800 text-slate-200 hover:rounded-xl hover:bg-nebula-accent hover:text-white",
          )}
        >
          {g.iconUrl ? <img src={g.iconUrl} alt="" className="h-full w-full object-cover" /> : g.name.slice(0, 2).toUpperCase()}
        </button>
      ))}

      <button
        type="button"
        title="Add a server"
        onClick={() => setOpen((v) => !v)}
        className="flex h-12 w-12 items-center justify-center rounded-2xl bg-nebula-800 text-nebula-accent2 transition-all hover:rounded-xl hover:bg-nebula-accent2 hover:text-nebula-950"
      >
        <Plus size={22} aria-hidden />
      </button>

      <div className="mt-auto flex flex-col items-center gap-2">
        <button
          type="button"
          title="Notifications"
          onClick={() => setNotificationsOpen(!notificationsOpen)}
          className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-nebula-800 text-slate-300 hover:bg-nebula-700 hover:text-white"
        >
          <Bell size={18} aria-hidden />
          {unread > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-nebula-danger px-1 text-[10px] font-bold text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      </div>

      {open && (
        <div className="absolute left-20 top-3 z-30 w-72 rounded-lg border border-nebula-700 bg-nebula-900 p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-100">Add a server</span>
            <button type="button" className="text-xs text-slate-500 hover:text-slate-300" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          <form
            className="space-y-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const value = code.trim();
              if (!value) return;
              setError(null);
              try {
                await joinInvite(value);
                setCode("");
                setOpen(false);
                onToggleSidebar();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Could not join.");
              }
            }}
          >
            <input className="input" placeholder="Invite code" value={code} onChange={(e) => setCode(e.target.value)} />
            <button type="submit" className="btn-primary w-full text-xs" disabled={!code.trim()}>
              Join server
            </button>
          </form>
          <div className="my-3 h-px bg-nebula-800" aria-hidden />
          <form
            className="space-y-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!name.trim()) return;
              await createGuild(name.trim());
              setName("");
              setOpen(false);
              onToggleSidebar();
            }}
          >
            <input className="input" placeholder="New server name" value={name} onChange={(e) => setName(e.target.value)} />
            <button type="submit" className="btn-ghost w-full text-xs" disabled={!name.trim()}>
              Create server
            </button>
          </form>
          {error && <p className="mt-2 text-xs text-nebula-danger">{error}</p>}
        </div>
      )}
    </nav>
  );
}

/* --------------------------------------------------------- guild sidebar */

interface CategoryGroup {
  category: Channel;
  channels: Channel[];
}

function groupChannels(channels: Channel[]): { orphans: Channel[]; categories: CategoryGroup[] } {
  const byPos = (a: Channel, b: Channel) => a.position - b.position;
  const categories = channels.filter((c) => c.type === 4).sort(byPos);
  const orphans = channels.filter((c) => c.type !== 4 && !c.parentId).sort(byPos);
  return {
    orphans,
    categories: categories.map((category) => ({
      category,
      channels: channels.filter((c) => c.parentId === category.id).sort(byPos),
    })),
  };
}

function GuildSidebar() {
  const activeGuildId = useApp((s) => s.activeGuildId);
  const guilds = useApp((s) => s.guilds);
  const channelsByGuild = useApp((s) => s.channelsByGuild);
  const activeChannelId = useApp((s) => s.activeChannelId);
  const selectChannel = useApp((s) => s.selectChannel);
  const createChannel = useApp((s) => s.createChannel);
  const deleteChannel = useApp((s) => s.deleteChannel);
  const voiceStates = useApp((s) => s.voiceStates);
  const selfVoice = useApp((s) => s.selfVoice);
  const membersByGuild = useApp((s) => s.membersByGuild);
  const permissionsByGuild = useApp((s) => s.permissionsByGuild);
  const ownerByGuild = useApp((s) => s.ownerByGuild);
  const joinVoice = useApp((s) => s.joinVoice);
  const leaveVoice = useApp((s) => s.leaveVoice);
  const setServerSettingsOpen = useApp((s) => s.setServerSettingsOpen);
  const setChannelSettings = useApp((s) => s.setChannelSettings);
  const setSearchOpen = useApp((s) => s.setSearchOpen);
  const readStates = useApp((s) => s.readStates);

  const [creating, setCreating] = useState<null | 0 | 2>(null);
  const [name, setName] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const guild = guilds.find((g) => g.id === activeGuildId) ?? null;
  const channels = activeGuildId ? channelsByGuild[activeGuildId] ?? [] : [];
  const perms = activeGuildId ? permissionsByGuild[activeGuildId] : undefined;
  const isOwner = activeGuildId ? ownerByGuild[activeGuildId] ?? false : false;
  const canManageChannels = isOwner || hasBits(perms, Permissions.MANAGE_CHANNELS);
  const canManageGuild = isOwner || hasBits(perms, Permissions.MANAGE_GUILD);

  const members = activeGuildId ? membersByGuild[activeGuildId] ?? [] : [];
  const { orphans, categories } = useMemo(() => groupChannels(channels), [channels]);
  const text = orphans.filter((c) => c.type !== 2 && c.type !== 13);
  const voice = orphans.filter((c) => c.type === 2 || c.type === 13);

  const nameFor = (userId: string) => {
    if (userId === useApp.getState().me?.id) return "You";
    const member = members.find((m) => m.userId === userId);
    return member ? memberName(member) : userId.slice(-4);
  };

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!activeGuildId || !name.trim() || creating === null) return;
    await createChannel(activeGuildId, { name: name.trim(), type: creating });
    setName("");
    setCreating(null);
  }

  const TextChannel = ({ channel }: { channel: Channel }) => (
    <ChannelRow
      channel={channel}
      active={channel.id === activeChannelId}
      icon={<Hash size={16} aria-hidden />}
      onClick={() => void selectChannel(channel.id)}
      canManage={canManageChannels}
      onEdit={() => setChannelSettings(channel.id)}
      onDelete={() => void deleteChannel(channel.id)}
      unread={Boolean(readStates[channel.id]?.unread)}
      mentions={readStates[channel.id]?.mentionCount ?? 0}
    />
  );

  const VoiceChannel = ({ channel }: { channel: Channel }) => {
    const occupants = voiceStates.filter((v) => v.channelId === channel.id);
    const inChannel = selfVoice?.channelId === channel.id;
    return (
      <div>
        <button
          type="button"
          onClick={() => (inChannel ? void leaveVoice() : void joinVoice(channel.id))}
          className={cx(
            "flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left transition-colors",
            inChannel ? "bg-nebula-800 text-slate-100" : "text-slate-400 hover:bg-white/5 hover:text-slate-200",
          )}
        >
          <Volume2 size={16} className="shrink-0 text-slate-500" aria-hidden />
          <span className="truncate text-sm">{channel.name}</span>
          {channel.userLimit > 0 && (
            <span className="ml-auto text-[10px] text-slate-500">
              {occupants.length}/{channel.userLimit}
            </span>
          )}
        </button>
        {occupants.length > 0 && (
          <ul className="ml-5 space-y-0.5 pb-1">
            {occupants.map((v) => (
              <li key={v.userId} className="flex items-center gap-1.5 truncate text-xs text-slate-400">
                <span
                  className="h-4 w-4 shrink-0 rounded-full"
                  style={{ backgroundColor: avatarColor(v.userId) }}
                  aria-hidden
                />
                <span className="truncate">{nameFor(v.userId)}</span>
                {v.selfMute && <MicOff size={11} className="shrink-0 text-slate-500" aria-hidden />}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 w-60 shrink-0 flex-col bg-nebula-900">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-nebula-800 px-3 shadow-sm">
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left font-semibold text-slate-100 hover:text-white"
          onClick={() => canManageGuild && setServerSettingsOpen(true)}
          title={canManageGuild ? "Server settings" : guild?.name}
        >
          {guild?.name ?? "Server"}
        </button>
        {canManageGuild && (
          <IconButton title="Server settings" onClick={() => setServerSettingsOpen(true)}>
            <ChevronDown size={16} aria-hidden />
          </IconButton>
        )}
      </header>

      <div className="flex items-center gap-1 px-2 pt-2">
        <button
          type="button"
          className="flex flex-1 items-center gap-1.5 rounded bg-nebula-950/60 px-2 py-1.5 text-xs text-slate-400 hover:text-slate-200"
          onClick={() => setSearchOpen(true)}
        >
          <Search size={13} aria-hidden />
          Search
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {text.length > 0 && (
          <section aria-label="Text channels">
            <SectionHeader
              label="Text channels"
              onAdd={canManageChannels ? () => setCreating(0) : undefined}
              addTitle="Create text channel"
            />
            {text.map((c) => (
              <TextChannel key={c.id} channel={c} />
            ))}
          </section>
        )}

        {categories.map(({ category, channels: children }) => {
          const isCollapsed = collapsed[category.id];
          const childText = children.filter((c) => c.type !== 2 && c.type !== 13);
          const childVoice = children.filter((c) => c.type === 2 || c.type === 13);
          return (
            <section key={category.id} className="mt-4" aria-label={category.name ?? "Category"}>
              <div className="flex items-center justify-between px-1 pb-1">
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-300"
                  onClick={() => setCollapsed((prev) => ({ ...prev, [category.id]: !isCollapsed }))}
                  aria-expanded={!isCollapsed}
                >
                  <ChevronDown size={12} className={cx("transition-transform", isCollapsed && "-rotate-90")} aria-hidden />
                  {category.name}
                </button>
                {canManageChannels && (
                  <IconButton title="Channel options" onClick={() => setChannelSettings(category.id)} className="p-0.5">
                    <Pencil size={12} aria-hidden />
                  </IconButton>
                )}
              </div>
              {!isCollapsed && (
                <>
                  {childText.map((c) => (
                    <TextChannel key={c.id} channel={c} />
                  ))}
                  {childVoice.map((c) => (
                    <VoiceChannel key={c.id} channel={c} />
                  ))}
                </>
              )}
            </section>
          );
        })}

        {voice.length > 0 && (
          <section className="mt-4" aria-label="Voice channels">
            <SectionHeader
              label="Voice channels"
              onAdd={canManageChannels ? () => setCreating(2) : undefined}
              addTitle="Create voice channel"
            />
            {voice.map((c) => (
              <VoiceChannel key={c.id} channel={c} />
            ))}
          </section>
        )}

        {channels.length === 0 && <p className="px-2 py-4 text-xs text-slate-500">No channels yet.</p>}

        {creating !== null && (
          <form className="mt-2 space-y-2 px-1" onSubmit={submitCreate}>
            <input
              className="input"
              autoFocus
              placeholder={creating === 2 ? "New voice channel" : "new-channel"}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="flex gap-2">
              <button type="submit" className="btn-primary flex-1 text-xs" disabled={!name.trim()}>
                Create
              </button>
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() => {
                  setCreating(null);
                  setName("");
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>

      <VoicePanel />
      <UserPanel />
    </div>
  );
}

function SectionHeader({ label, onAdd, addTitle }: { label: string; onAdd?: () => void; addTitle?: string }) {
  return (
    <div className="flex items-center justify-between px-1 pb-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      {onAdd && (
        <IconButton title={addTitle ?? "Add"} onClick={onAdd} className="p-0.5">
          <Plus size={14} aria-hidden />
        </IconButton>
      )}
    </div>
  );
}

function ChannelRow({
  channel,
  active,
  icon,
  onClick,
  canManage,
  onEdit,
  onDelete,
  unread,
  mentions,
}: {
  channel: Channel;
  active: boolean;
  icon: ReactNode;
  onClick: () => void;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
  unread?: boolean;
  mentions?: number;
}) {
  const highlight = !active && (unread || (mentions ?? 0) > 0);
  return (
    <div className="group/row relative">
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? "page" : undefined}
        className={cx(
          "flex w-full items-center gap-1.5 rounded px-2 py-1.5 pr-7 text-left transition-colors",
          active ? "bg-nebula-800 text-slate-100" : "text-slate-400 hover:bg-white/5 hover:text-slate-200",
        )}
      >
        <span className="shrink-0 text-slate-500">{icon}</span>
        <span className={cx("truncate text-sm", highlight && "font-medium text-slate-100")}>{channel.name}</span>
        {!active && (mentions ?? 0) > 0 ? (
          <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-nebula-danger px-1 text-[10px] font-bold text-white">
            {mentions! > 99 ? "99+" : mentions}
          </span>
        ) : !active && unread ? (
          <span className="ml-auto mr-1 h-2 w-2 shrink-0 rounded-full bg-slate-200" aria-label="Unread" />
        ) : null}
      </button>
      {canManage && (
        <div className="absolute right-1 top-1/2 hidden -translate-y-1/2 group-hover/row:block">
          <Dropdown
            trigger={({ toggle }) => (
              <IconButton title="Channel options" onClick={toggle} className="bg-nebula-900 p-0.5">
                <Pencil size={12} aria-hidden />
              </IconButton>
            )}
          >
            {(close) => (
              <>
                <MenuItem
                  icon={<Pencil size={14} aria-hidden />}
                  onClick={() => {
                    close();
                    onEdit();
                  }}
                >
                  Edit channel
                </MenuItem>
                <MenuItem
                  icon={<Trash2 size={14} aria-hidden />}
                  danger
                  onClick={() => {
                    close();
                    onDelete();
                  }}
                >
                  Delete channel
                </MenuItem>
              </>
            )}
          </Dropdown>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- home sidebar */

function HomeSidebar() {
  const dms = useApp((s) => s.dms);
  const activeDmId = useApp((s) => s.activeDmId);
  const selectDm = useApp((s) => s.selectDm);
  const relationships = useApp((s) => s.relationships);
  const presence = useApp((s) => s.presence);
  const me = useApp((s) => s.me);
  const openDm = useApp((s) => s.openDm);
  const readStates = useApp((s) => s.readStates);
  const [tab, setTab] = useState<"friends" | "dms">("friends");
  const [groupDmOpen, setGroupDmOpen] = useState(false);

  const friends = relationships.filter((r) => r.type === 1);

  return (
    <div className="flex min-h-0 w-60 shrink-0 flex-col bg-nebula-900">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-nebula-800 px-4 font-semibold text-slate-100 shadow-sm">
        <span>Direct Messages</span>
        <IconButton title="Create group DM" onClick={() => setGroupDmOpen(true)}>
          <UserPlus size={16} aria-hidden />
        </IconButton>
      </header>

      <div className="flex gap-1 p-2">
        {(["friends", "dms"] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={cx(
              "flex-1 rounded px-2 py-1.5 text-sm capitalize",
              tab === t ? "bg-nebula-800 text-slate-100" : "text-slate-400 hover:bg-white/5",
            )}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {tab === "friends" ? (
          <ul className="space-y-0.5">
            {friends.map((r) => (
              <li key={r.userId}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-white/5"
                  onClick={() => void openDm(r.userId)}
                >
                  <Avatar user={r.user} size={28} presence={presence[r.user.id] ?? "offline"} />
                  <span className="truncate text-sm text-slate-300">{displayName(r.user)}</span>
                </button>
              </li>
            ))}
            {friends.length === 0 && <p className="px-2 py-3 text-xs text-slate-500">No friends yet.</p>}
          </ul>
        ) : (
          <ul className="space-y-0.5">
            {dms.map((dm) => {
              const others = (dm.recipients ?? []).filter((u) => u.id !== me?.id);
              const label =
                dm.type === 3
                  ? others.map((u) => displayName(u)).join(", ") || "Group"
                  : others[0]
                    ? displayName(others[0])
                    : dm.name || "Direct message";
              return (
                <li key={dm.id}>
                  <button
                    type="button"
                    onClick={() => void selectDm(dm.id)}
                    data-channel-id={dm.id}
                    aria-label={dm.type === 3 ? `${label} (group DM)` : undefined}
                    className={cx(
                      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left",
                      dm.id === activeDmId ? "bg-nebula-800 text-slate-100" : "text-slate-400 hover:bg-white/5 hover:text-slate-200",
                    )}
                  >
                    <Avatar id={others[0]?.id ?? dm.id} name={label} size={28} />
                    <span className="truncate text-sm">{label}</span>
                    {dm.id !== activeDmId && (readStates[dm.id]?.mentionCount ?? 0) > 0 ? (
                      <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-nebula-danger px-1 text-[10px] font-bold text-white">
                        {readStates[dm.id]!.mentionCount > 99 ? "99+" : readStates[dm.id]!.mentionCount}
                      </span>
                    ) : dm.id !== activeDmId && readStates[dm.id]?.unread ? (
                      <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-slate-200" aria-label="Unread" />
                    ) : null}
                  </button>
                </li>
              );
            })}
            {dms.length === 0 && <p className="px-2 py-3 text-xs text-slate-500">No conversations yet.</p>}
          </ul>
        )}
      </div>

      {groupDmOpen && <GroupDmModal mode="create" onClose={() => setGroupDmOpen(false)} />}

      <UserPanel />
    </div>
  );
}

/* -------------------------------------------------------------- user panel */

function UserPanel() {
  const me = useApp((s) => s.me);
  const selfVoice = useApp((s) => s.selfVoice);
  const logout = useApp((s) => s.logout);
  const leaveVoice = useApp((s) => s.leaveVoice);
  const toggleMute = useApp((s) => s.toggleMute);
  const toggleDeaf = useApp((s) => s.toggleDeaf);
  const setUserSettingsOpen = useApp((s) => s.setUserSettingsOpen);
  const setPresence = useApp((s) => s.setPresence);
  const presence = useApp((s) => s.presence);

  if (!me) return null;
  const myStatus = presence[me.id] ?? "online";

  return (
    <div className="flex items-center gap-2 border-t border-nebula-800 bg-nebula-950/60 px-2 py-2">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={() => setUserSettingsOpen(true)}
      >
        <Avatar user={me} size={32} presence={myStatus} />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-slate-100">{displayName(me)}</span>
          <span className="block truncate text-[11px] text-slate-500">@{me.username}</span>
        </span>
      </button>
      <div className="flex items-center">
        {selfVoice && (
          <IconButton title="Disconnect voice" tone="danger" onClick={() => void leaveVoice()}>
            <PhoneOff size={15} aria-hidden />
          </IconButton>
        )}
        <Dropdown
          align="right"
          trigger={({ toggle }) => (
            <IconButton title="Set status" onClick={toggle} pressed={myStatus !== "online"}>
              <span className="block h-3.5 w-3.5 rounded-full" style={{ backgroundColor: presenceColor(myStatus) }} />
            </IconButton>
          )}
        >
          {(close) => (
            <>
              {[
                { value: "online", label: "Online" },
                { value: "idle", label: "Idle" },
                { value: "dnd", label: "Do Not Disturb" },
                { value: "invisible", label: "Invisible" },
              ].map((o) => (
                <MenuItem
                  key={o.value}
                  icon={<span className="h-3 w-3 rounded-full" style={{ backgroundColor: presenceColor(o.value) }} />}
                  onClick={() => {
                    close();
                    void setPresence(o.value);
                  }}
                >
                  {o.label}
                </MenuItem>
              ))}
            </>
          )}
        </Dropdown>
        <IconButton
          title={selfVoice?.selfMute ? "Unmute" : "Mute"}
          pressed={selfVoice?.selfMute}
          onClick={() => (selfVoice ? void toggleMute() : undefined)}
          tone={selfVoice?.selfMute ? "danger" : "default"}
        >
          {selfVoice?.selfMute ? <MicOff size={15} aria-hidden /> : <Mic size={15} aria-hidden />}
        </IconButton>
        <IconButton
          title={selfVoice?.selfDeaf ? "Undeafen" : "Deafen"}
          pressed={selfVoice?.selfDeaf}
          onClick={() => (selfVoice ? void toggleDeaf() : undefined)}
          tone={selfVoice?.selfDeaf ? "danger" : "default"}
        >
          <Headphones size={15} aria-hidden />
        </IconButton>
        <IconButton title="User settings" onClick={() => setUserSettingsOpen(true)}>
          <SettingsIcon size={15} aria-hidden />
        </IconButton>
        <IconButton title="Log out" tone="danger" onClick={() => void logout()}>
          <LogOut size={15} aria-hidden />
        </IconButton>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ member list */

function MemberList() {
  const activeGuildId = useApp((s) => s.activeGuildId);
  const membersByGuild = useApp((s) => s.membersByGuild);
  const rolesByGuild = useApp((s) => s.rolesByGuild);
  const presence = useApp((s) => s.presence);
  const openMemberProfile = useApp((s) => s.openMemberProfile);

  const members = activeGuildId ? membersByGuild[activeGuildId] ?? [] : [];
  const roles = activeGuildId ? rolesByGuild[activeGuildId] ?? [] : [];

  const groups = useMemo(() => {
    const hoisted = roles.filter((r) => r.hoist && !r.isEveryone).sort((a, b) => b.position - a.position);
    const assigned = new Set<string>();
    const sections: { key: string; label: string; color: string | null; members: GuildMember[] }[] = [];

    for (const role of hoisted) {
      const inRole = members.filter((m) => m.roles.includes(role.id));
      if (inRole.length === 0) continue;
      inRole.forEach((m) => assigned.add(m.userId));
      sections.push({ key: role.id, label: role.name, color: roleColor(role.color), members: inRole });
    }

    const rest = members.filter((m) => !assigned.has(m.userId));
    const online = rest.filter((m) => (presence[m.userId] ?? "offline") !== "offline");
    const offline = rest.filter((m) => (presence[m.userId] ?? "offline") === "offline");
    if (online.length) sections.push({ key: "online", label: "Online", color: null, members: online });
    if (offline.length) sections.push({ key: "offline", label: "Offline", color: null, members: offline });
    return sections;
  }, [members, roles, presence]);

  if (!activeGuildId || members.length === 0) return null;

  return (
    <aside className="hidden w-60 shrink-0 overflow-y-auto bg-nebula-900 px-2 py-3 lg:block" aria-label="Members">
      {groups.map((group) => (
        <section key={group.key} className="mb-3">
          <h3 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-500" style={group.color ? { color: group.color } : undefined}>
            {group.label} — {group.members.length}
          </h3>
          <ul className="space-y-0.5">
            {group.members.map((m) => {
              const color = memberColor(m, roles);
              const offline = (presence[m.userId] ?? "offline") === "offline";
              return (
                <li key={m.userId}>
                  <button
                    type="button"
                    onClick={() => openMemberProfile(m.userId)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-white/5"
                  >
                    <Avatar user={m.user} id={m.userId} name={memberName(m)} size={28} presence={presence[m.userId] ?? "offline"} />
                    <span className={cx("flex items-center gap-1 truncate text-sm", offline ? "text-slate-500" : "text-slate-300")}>
                      <span className="truncate" style={color ? { color } : undefined}>
                        {memberName(m)}
                      </span>
                      {m.isOwner && <Crown size={12} className="shrink-0 text-nebula-warn" aria-label="Owner" />}
                      {m.timeoutUntil && new Date(m.timeoutUntil) > new Date() && (
                        <span className="shrink-0 rounded bg-nebula-warn/20 px-1 text-[9px] uppercase text-nebula-warn">timed out</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </aside>
  );
}

/* ------------------------------------------------------------------ shell */

export function ChatShell() {
  const activeGuildId = useApp((s) => s.activeGuildId);
  const activeDmId = useApp((s) => s.activeDmId);
  const activeChannelId = useApp((s) => s.activeChannelId);
  const showUserSettings = useApp((s) => s.showUserSettings);
  const showServerSettings = useApp((s) => s.showServerSettings);
  const channelSettingsId = useApp((s) => s.channelSettingsId);
  const memberProfileId = useApp((s) => s.memberProfileId);
  const searchOpen = useApp((s) => s.searchOpen);
  const pinnedOpen = useApp((s) => s.pinnedOpen);
  const notificationsOpen = useApp((s) => s.notificationsOpen);
  const setUserSettingsOpen = useApp((s) => s.setUserSettingsOpen);
  const setServerSettingsOpen = useApp((s) => s.setServerSettingsOpen);
  const setChannelSettings = useApp((s) => s.setChannelSettings);
  const openMemberProfile = useApp((s) => s.openMemberProfile);
  const setSearchOpen = useApp((s) => s.setSearchOpen);
  const setPinnedOpen = useApp((s) => s.setPinnedOpen);
  const setNotificationsOpen = useApp((s) => s.setNotificationsOpen);

  const [mobileNav, setMobileNav] = useState(false);

  const showDm = activeDmId !== null && !activeChannelId;
  const mainView = activeGuildId || showDm || activeChannelId ? <ChatView /> : <Friends />;

  return (
    <div className="flex h-full bg-nebula-900">
      <GuildRail onToggleSidebar={() => setMobileNav((v) => !v)} />

      {/* Sidebar: fixed drawer on small screens, static on md+. */}
      <div className={cx(mobileNav ? "fixed inset-y-0 left-[72px] z-30 flex md:static" : "hidden md:flex")}>
        {activeGuildId ? <GuildSidebar /> : <HomeSidebar />}
      </div>
      {mobileNav && <div className="fixed inset-0 z-20 bg-black/50 md:hidden" onClick={() => setMobileNav(false)} aria-hidden />}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-nebula-800 px-2 md:hidden">
          <button
            type="button"
            aria-label="Toggle channel list"
            className="rounded p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-100"
            onClick={() => setMobileNav((v) => !v)}
          >
            <Menu size={18} aria-hidden />
          </button>
          <span className="truncate text-sm font-semibold text-slate-200">
            {activeGuildId ? "Channels" : showDm ? "Direct message" : "Friends"}
          </span>
        </div>
        <div className="flex min-h-0 flex-1">{mainView}</div>
      </div>

      <MemberList />

      {showUserSettings && <Settings onClose={() => setUserSettingsOpen(false)} />}
      {showServerSettings && <ServerSettings onClose={() => setServerSettingsOpen(false)} />}
      {channelSettingsId && <ChannelSettings channelId={channelSettingsId} onClose={() => setChannelSettings(null)} />}
      {memberProfileId && <MemberProfile userId={memberProfileId} onClose={() => openMemberProfile(null)} />}
      {searchOpen && <SearchPanel onClose={() => setSearchOpen(false)} />}
      {pinnedOpen && <PinsPanel onClose={() => setPinnedOpen(false)} />}
      {notificationsOpen && <NotificationsPanel onClose={() => setNotificationsOpen(false)} />}
    </div>
  );
}
