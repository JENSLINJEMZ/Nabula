import { useEffect, useState } from "react";
import { Ban, Hash, Plus, Trash2, UserCog } from "lucide-react";
import { AuditLogActionType, Permissions, type AuditLogEntry, type Invite, type Role } from "@nebula/shared";
import { useApp } from "../store";
import { hasBits } from "../lib/perms";
import { cx, displayName, memberName, roleColor } from "../lib/ui";
import { Avatar, IconButton, Modal, Switch } from "./primitives";

const ACTION_LABELS: Record<number, string> = Object.fromEntries(
  Object.entries(AuditLogActionType).map(([name, value]) => [value, name.replace(/_/g, " ").toLowerCase()]),
);

const PERMISSION_GROUPS: { label: string; perms: { key: keyof typeof Permissions; label: string }[] }[] = [
  {
    label: "General server",
    perms: [
      { key: "VIEW_CHANNEL", label: "View channels" },
      { key: "MANAGE_CHANNELS", label: "Manage channels" },
      { key: "MANAGE_GUILD", label: "Manage server" },
      { key: "VIEW_AUDIT_LOG", label: "View audit log" },
      { key: "MANAGE_ROLES", label: "Manage roles" },
      { key: "CREATE_INSTANT_INVITE", label: "Create invites" },
      { key: "CHANGE_NICKNAME", label: "Change nickname" },
      { key: "MANAGE_NICKNAMES", label: "Manage nicknames" },
      { key: "ADMINISTRATOR", label: "Administrator" },
    ],
  },
  {
    label: "Membership",
    perms: [
      { key: "KICK_MEMBERS", label: "Kick members" },
      { key: "BAN_MEMBERS", label: "Ban members" },
      { key: "MODERATE_MEMBERS", label: "Timeout members" },
    ],
  },
  {
    label: "Text channels",
    perms: [
      { key: "SEND_MESSAGES", label: "Send messages" },
      { key: "MANAGE_MESSAGES", label: "Manage messages" },
      { key: "EMBED_LINKS", label: "Embed links" },
      { key: "ATTACH_FILES", label: "Attach files" },
      { key: "READ_MESSAGE_HISTORY", label: "Read history" },
      { key: "MENTION_EVERYONE", label: "Mention everyone" },
      { key: "ADD_REACTIONS", label: "Add reactions" },
    ],
  },
  {
    label: "Voice channels",
    perms: [
      { key: "CONNECT", label: "Connect" },
      { key: "SPEAK", label: "Speak" },
      { key: "STREAM", label: "Video" },
      { key: "MUTE_MEMBERS", label: "Mute members" },
      { key: "DEAFEN_MEMBERS", label: "Deafen members" },
      { key: "MOVE_MEMBERS", label: "Move members" },
      { key: "PRIORITY_SPEAKER", label: "Priority speaker" },
    ],
  },
];

const TABS = ["overview", "roles", "members", "invites", "bans", "audit"] as const;
type TabId = (typeof TABS)[number];

export function ServerSettings({ onClose }: { onClose: () => void }) {
  const activeGuildId = useApp((s) => s.activeGuildId);
  const guilds = useApp((s) => s.guilds);
  const membersByGuild = useApp((s) => s.membersByGuild);
  const rolesByGuild = useApp((s) => s.rolesByGuild);
  const permissionsByGuild = useApp((s) => s.permissionsByGuild);
  const ownerByGuild = useApp((s) => s.ownerByGuild);
  const channelsByGuild = useApp((s) => s.channelsByGuild);
  const me = useApp((s) => s.me);

  const updateGuild = useApp((s) => s.updateGuild);
  const deleteGuild = useApp((s) => s.deleteGuild);
  const leaveGuild = useApp((s) => s.leaveGuild);
  const transferOwnership = useApp((s) => s.transferOwnership);
  const createRole = useApp((s) => s.createRole);
  const updateRole = useApp((s) => s.updateRole);
  const deleteRole = useApp((s) => s.deleteRole);
  const openMemberProfile = useApp((s) => s.openMemberProfile);
  const loadInvites = useApp((s) => s.loadInvites);
  const deleteInvite = useApp((s) => s.deleteInvite);
  const createInvite = useApp((s) => s.createInvite);
  const loadBans = useApp((s) => s.loadBans);
  const unbanMember = useApp((s) => s.unbanMember);
  const loadAuditLog = useApp((s) => s.loadAuditLog);

  const [tab, setTab] = useState<TabId>("overview");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [invites, setInvites] = useState<Invite[]>([]);
  const [bans, setBans] = useState<{ userId: string; reason: string | null; user?: { username: string; displayName: string | null } | null }[]>([]);
  const [audit, setAudit] = useState<AuditLogEntry[]>([]);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);

  const guild = guilds.find((g) => g.id === activeGuildId) ?? null;
  const members = activeGuildId ? membersByGuild[activeGuildId] ?? [] : [];
  const roles = activeGuildId ? rolesByGuild[activeGuildId] ?? [] : [];
  const perms = activeGuildId ? permissionsByGuild[activeGuildId] : undefined;
  const isOwner = activeGuildId ? ownerByGuild[activeGuildId] ?? false : false;

  const canManageGuild = isOwner || hasBits(perms, Permissions.MANAGE_GUILD);
  const canManageRoles = isOwner || hasBits(perms, Permissions.MANAGE_ROLES);
  const canBan = isOwner || hasBits(perms, Permissions.BAN_MEMBERS);
  const canViewAudit = isOwner || hasBits(perms, Permissions.VIEW_AUDIT_LOG);

  useEffect(() => {
    if (guild) {
      setName(guild.name);
      setDescription(guild.description ?? "");
    }
  }, [guild]);

  useEffect(() => {
    if (!activeGuildId) return;
    if (tab === "invites" && canManageGuild) void loadInvites(activeGuildId).then(setInvites).catch(() => undefined);
    if (tab === "bans" && canBan) void loadBans(activeGuildId).then((b) => setBans(b as typeof bans)).catch(() => undefined);
    if (tab === "audit" && canViewAudit) void loadAuditLog(activeGuildId).then(setAudit).catch(() => undefined);
  }, [tab, activeGuildId, canManageGuild, canBan, canViewAudit, loadInvites, loadBans, loadAuditLog]);

  if (!activeGuildId || !guild) return null;

  const visibleTabs = TABS.filter((t) => {
    if (t === "invites") return canManageGuild;
    if (t === "bans") return canBan;
    if (t === "audit") return canViewAudit;
    if (t === "roles") return canManageRoles;
    return true;
  });

  const editingRole = roles.find((r) => r.id === editingRoleId) ?? null;

  return (
    <Modal title="Server settings" subtitle={guild.name} onClose={onClose} size="xl">
      <div className="flex gap-5">
        <nav className="w-40 shrink-0 space-y-0.5" aria-label="Settings sections">
          {visibleTabs.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setTab(t);
                setEditingRoleId(null);
              }}
              className={cx(
                "w-full rounded px-3 py-1.5 text-left text-sm capitalize",
                tab === t ? "bg-nebula-800 text-slate-100" : "text-slate-400 hover:bg-white/5 hover:text-slate-200",
              )}
            >
              {t}
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1">
          {tab === "overview" && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">Server name</label>
                <input className="input" value={name} disabled={!canManageGuild} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">Description</label>
                <textarea
                  className="input min-h-20"
                  value={description}
                  disabled={!canManageGuild}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              {canManageGuild && (
                <button type="button" className="btn-primary" onClick={() => void updateGuild(activeGuildId, { name, description: description || null })}>
                  Save changes
                </button>
              )}

              <div className="rounded-md border border-nebula-danger/40 p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-nebula-danger">Danger zone</p>
                <div className="flex flex-wrap gap-2">
                  {isOwner ? (
                    <>
                      <button
                        type="button"
                        className="btn-ghost text-sm text-nebula-danger"
                        onClick={() => {
                          if (confirm("Delete this server permanently?")) void deleteGuild(activeGuildId);
                        }}
                      >
                        <Trash2 size={15} className="mr-1 inline" aria-hidden /> Delete server
                      </button>
                      <select
                        className="input w-56"
                        defaultValue=""
                        onChange={(e) => {
                          if (e.target.value && confirm("Transfer ownership to this member?")) {
                            void transferOwnership(activeGuildId, e.target.value);
                          }
                        }}
                      >
                        <option value="">Transfer ownership…</option>
                        {members
                          .filter((m) => m.userId !== me?.id)
                          .map((m) => (
                            <option key={m.userId} value={m.userId}>
                              {memberName(m)}
                            </option>
                          ))}
                      </select>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn-ghost text-sm text-nebula-danger"
                      onClick={() => {
                        if (confirm("Leave this server?")) void leaveGuild(activeGuildId);
                      }}
                    >
                      Leave server
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {tab === "roles" && canManageRoles && (
            <div className="flex gap-4">
              <div className="w-48 shrink-0">
                <button
                  type="button"
                  className="btn-primary mb-2 w-full text-xs"
                  onClick={async () => {
                    await createRole(activeGuildId, { name: "new role", color: 0x99aab5 });
                  }}
                >
                  <Plus size={14} className="mr-1 inline" aria-hidden /> Create role
                </button>
                <ul className="space-y-0.5">
                  {[...roles].sort((a, b) => b.position - a.position).map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => setEditingRoleId(r.id)}
                        className={cx(
                          "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
                          editingRoleId === r.id ? "bg-nebula-800 text-slate-100" : "text-slate-400 hover:bg-white/5",
                        )}
                      >
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: roleColor(r.color) ?? "#6b7280" }} aria-hidden />
                        <span className="truncate">{r.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="min-w-0 flex-1">
                {editingRole ? (
                  <RoleEditor
                    key={editingRole.id}
                    role={editingRole}
                    onSave={(patch) => void updateRole(activeGuildId, editingRole.id, patch)}
                    onDelete={() => {
                      if (confirm(`Delete role "${editingRole.name}"?`)) void deleteRole(activeGuildId, editingRole.id);
                      setEditingRoleId(null);
                    }}
                  />
                ) : (
                  <p className="text-sm text-slate-500">Select a role to edit it, or create a new one.</p>
                )}
              </div>
            </div>
          )}

          {tab === "members" && (
            <ul className="space-y-1">
              {members.map((m) => (
                <li key={m.userId} className="flex items-center gap-3 rounded px-2 py-1.5 hover:bg-white/5">
                  <Avatar user={m.user} id={m.userId} name={memberName(m)} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-slate-200">{memberName(m)}</span>
                    <span className="block truncate text-xs text-slate-500">
                      {m.user ? `@${m.user.username}` : m.userId}
                    </span>
                  </span>
                  <div className="hidden flex-wrap gap-1 sm:flex">
                    {m.roles
                      .map((id) => roles.find((r) => r.id === id))
                      .filter((r): r is Role => Boolean(r) && !r!.isEveryone)
                      .slice(0, 3)
                      .map((r) => (
                        <span key={r.id} className="rounded bg-nebula-800 px-1.5 py-0.5 text-[10px] text-slate-300">
                          {r.name}
                        </span>
                      ))}
                  </div>
                  <IconButton title="Manage member" onClick={() => openMemberProfile(m.userId)}>
                    <UserCog size={16} aria-hidden />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}

          {tab === "invites" && canManageGuild && (
            <div className="space-y-3">
              <button
                type="button"
                className="btn-primary text-xs"
                onClick={async () => {
                  const textChannel = (channelsByGuild[activeGuildId] ?? []).find((c) => c.type === 0);
                  if (!textChannel) return;
                  await createInvite(textChannel.id);
                  setInvites(await loadInvites(activeGuildId));
                }}
              >
                <Plus size={14} className="mr-1 inline" aria-hidden /> Create invite
              </button>
              <ul className="space-y-1">
                {invites.map((inv) => (
                  <li key={inv.code} className="flex items-center gap-3 rounded border border-nebula-800 px-3 py-2 text-sm">
                    <Hash size={14} className="text-slate-500" aria-hidden />
                    <code className="font-mono text-nebula-accent2">{inv.code}</code>
                    <span className="text-xs text-slate-500">
                      {inv.uses}
                      {inv.maxUses > 0 ? `/${inv.maxUses}` : ""} uses
                      {inv.expiresAt ? ` · expires ${new Date(inv.expiresAt).toLocaleDateString()}` : " · never expires"}
                    </span>
                    <button
                      type="button"
                      className="ml-auto text-slate-500 hover:text-nebula-danger"
                      aria-label="Revoke invite"
                      onClick={async () => {
                        await deleteInvite(inv.code);
                        setInvites(await loadInvites(activeGuildId));
                      }}
                    >
                      <Trash2 size={14} aria-hidden />
                    </button>
                  </li>
                ))}
                {invites.length === 0 && <p className="text-sm text-slate-500">No active invites.</p>}
              </ul>
            </div>
          )}

          {tab === "bans" && canBan && (
            <ul className="space-y-1">
              {bans.map((b) => (
                <li key={b.userId} className="flex items-center gap-3 rounded border border-nebula-800 px-3 py-2 text-sm">
                  <Ban size={14} className="text-nebula-danger" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-slate-200">
                    {b.user ? b.user.displayName || b.user.username : b.userId}
                  </span>
                  <span className="truncate text-xs text-slate-500">{b.reason ?? "No reason"}</span>
                  <button
                    type="button"
                    className="text-xs text-nebula-accent hover:underline"
                    onClick={async () => {
                      await unbanMember(activeGuildId, b.userId);
                      setBans(await loadBans(activeGuildId));
                    }}
                  >
                    Revoke
                  </button>
                </li>
              ))}
              {bans.length === 0 && <p className="text-sm text-slate-500">No bans.</p>}
            </ul>
          )}

          {tab === "audit" && canViewAudit && (
            <ul className="space-y-1">
              {audit.map((entry) => (
                <li key={entry.id} className="rounded border border-nebula-800 px-3 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-200">{ACTION_LABELS[entry.actionType] ?? `action ${entry.actionType}`}</span>
                    <span className="text-xs text-slate-500">{new Date(entry.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="text-xs text-slate-500">
                    by {entry.actor ? displayName(entry.actor) : entry.actorId ?? "unknown"}
                    {entry.targetId ? ` · target ${entry.targetId}` : ""}
                    {entry.reason ? ` · ${entry.reason}` : ""}
                  </p>
                </li>
              ))}
              {audit.length === 0 && <p className="text-sm text-slate-500">No audit log entries.</p>}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

function RoleEditor({
  role,
  onSave,
  onDelete,
}: {
  role: Role;
  onSave: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState(role.color || 0x99aab5);
  const [hoist, setHoist] = useState(role.hoist);
  const [mentionable, setMentionable] = useState(role.mentionable);
  const [bits, setBits] = useState<bigint>(() => {
    try {
      return BigInt(role.permissions);
    } catch {
      return 0n;
    }
  });

  function toggle(key: keyof typeof Permissions) {
    setBits((prev) => prev ^ Permissions[key]);
  }

  const hex = `#${color.toString(16).padStart(6, "0")}`;
  const isEveryone = role.isEveryone;

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">Role name</label>
        <input className="input" value={name} disabled={isEveryone} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="flex items-center gap-4">
        <div className="space-y-1.5">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">Colour</label>
          <input type="color" value={hex} onChange={(e) => setColor(parseInt(e.target.value.slice(1), 16))} className="h-9 w-16 rounded border border-nebula-700 bg-nebula-900" />
        </div>
        <label className="mt-5 flex items-center gap-2 text-sm text-slate-300">
          <Switch label="Hoist members" checked={hoist} onChange={setHoist} /> Display separately
        </label>
        <label className="mt-5 flex items-center gap-2 text-sm text-slate-300">
          <Switch label="Mentionable" checked={mentionable} onChange={setMentionable} /> Allow @mention
        </label>
      </div>

      <div className="space-y-3">
        {PERMISSION_GROUPS.map((group) => (
          <div key={group.label}>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{group.label}</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {group.perms.map((perm) => {
                const checked = (bits & Permissions[perm.key]) === Permissions[perm.key];
                return (
                  <label key={perm.key} className="flex items-center justify-between gap-2 text-sm text-slate-300">
                    {perm.label}
                    <Switch label={perm.label} checked={checked} onChange={() => toggle(perm.key)} />
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn-primary"
          onClick={() =>
            onSave({
              name: name.trim() || role.name,
              color,
              hoist,
              mentionable,
              permissions: bits.toString(),
            })
          }
        >
          Save role
        </button>
        {!isEveryone && !role.managed && (
          <button type="button" className="btn-ghost text-sm text-nebula-danger" onClick={onDelete}>
            <Trash2 size={14} className="mr-1 inline" aria-hidden /> Delete
          </button>
        )}
      </div>
    </div>
  );
}
