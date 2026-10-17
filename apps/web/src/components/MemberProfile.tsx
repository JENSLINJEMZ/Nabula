import { useMemo, useState } from "react";
import { Ban, Check, Clock, MessageSquare, ShieldOff, UserMinus, UserPlus, X } from "lucide-react";
import { Permissions, type PublicUser } from "@nebula/shared";
import { useApp } from "../store";
import { hasBits } from "../lib/perms";
import { cx, displayName, memberName, presenceColor, presenceLabel, roleColor } from "../lib/ui";
import { Avatar, Dropdown, MenuItem, Modal } from "./primitives";

const TIMEOUTS = [
  { label: "60 seconds", seconds: 60 },
  { label: "5 minutes", seconds: 300 },
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86400 },
  { label: "1 week", seconds: 604800 },
];

export function MemberProfile({ userId, onClose }: { userId: string; onClose: () => void }) {
  const me = useApp((s) => s.me);
  const activeGuildId = useApp((s) => s.activeGuildId);
  const membersByGuild = useApp((s) => s.membersByGuild);
  const rolesByGuild = useApp((s) => s.rolesByGuild);
  const permissionsByGuild = useApp((s) => s.permissionsByGuild);
  const ownerByGuild = useApp((s) => s.ownerByGuild);
  const relationships = useApp((s) => s.relationships);
  const dms = useApp((s) => s.dms);
  const presence = useApp((s) => s.presence);

  const openDm = useApp((s) => s.openDm);
  const sendFriendRequest = useApp((s) => s.sendFriendRequest);
  const acceptFriend = useApp((s) => s.acceptFriend);
  const removeFriend = useApp((s) => s.removeFriend);
  const blockUser = useApp((s) => s.blockUser);
  const unblockUser = useApp((s) => s.unblockUser);
  const kickMember = useApp((s) => s.kickMember);
  const banMember = useApp((s) => s.banMember);
  const timeoutMember = useApp((s) => s.timeoutMember);
  const setNickname = useApp((s) => s.setNickname);
  const setMemberRoles = useApp((s) => s.setMemberRoles);

  const [nickname, setNickDraft] = useState("");
  const [nicknameEditing, setNicknameEditing] = useState(false);

  const members = activeGuildId ? membersByGuild[activeGuildId] ?? [] : [];
  const member = members.find((m) => m.userId === userId);
  const roles = activeGuildId ? rolesByGuild[activeGuildId] ?? [] : [];
  const perms = activeGuildId ? permissionsByGuild[activeGuildId] : undefined;
  const isOwner = activeGuildId ? ownerByGuild[activeGuildId] ?? false : false;

  const user: PublicUser | null = useMemo(() => {
    if (userId === me?.id) return me;
    if (member?.user) return member.user;
    const rel = relationships.find((r) => r.userId === userId);
    if (rel?.user) return rel.user;
    for (const dm of dms) {
      const found = (dm.recipients ?? []).find((u) => u.id === userId);
      if (found) return found;
    }
    return null;
  }, [userId, me, member, relationships, dms]);

  const relationship = relationships.find((r) => r.userId === userId);
  const status = presence[userId] ?? "offline";

  const canKick = isOwner || hasBits(perms, Permissions.KICK_MEMBERS);
  const canBan = isOwner || hasBits(perms, Permissions.BAN_MEMBERS);
  const canTimeout = isOwner || hasBits(perms, Permissions.MODERATE_MEMBERS);
  const canManageNick = isOwner || hasBits(perms, Permissions.MANAGE_NICKNAMES);
  const canManageRoles = isOwner || hasBits(perms, Permissions.MANAGE_ROLES);
  const isSelf = userId === me?.id;
  const isTargetOwner = member?.isOwner ?? false;
  const memberRoles = member?.roles ?? [];
  const assignableRoles = roles.filter((r) => !r.isEveryone && !r.managed);

  async function toggleRole(roleId: string) {
    if (!activeGuildId) return;
    const next = memberRoles.includes(roleId) ? memberRoles.filter((r) => r !== roleId) : [...memberRoles, roleId];
    await setMemberRoles(activeGuildId, userId, next);
  }

  return (
    <Modal title="Member" onClose={onClose} size="sm">
      {!user ? (
        <p className="text-sm text-slate-400">This user is unavailable.</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Avatar user={user} size={56} presence={status} />
            <div className="min-w-0">
              <p className="truncate font-semibold text-slate-100">{member ? memberName(member) : displayName(user)}</p>
              <p className="truncate text-sm text-slate-500">@{user.username}</p>
              <p className="flex items-center gap-1.5 text-xs text-slate-500">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: presenceColor(status) }} aria-hidden />
                {presenceLabel(status)}
              </p>
            </div>
          </div>

          {user.bio && <p className="whitespace-pre-wrap rounded-md bg-nebula-950/60 p-3 text-sm text-slate-300">{user.bio}</p>}

          {member && memberRoles.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Roles</p>
              <div className="flex flex-wrap gap-1.5">
                {memberRoles.map((roleId) => {
                  const role = roles.find((r) => r.id === roleId);
                  if (!role) return null;
                  const color = roleColor(role.color);
                  return (
                    <span
                      key={roleId}
                      className="flex items-center gap-1 rounded bg-nebula-800 px-2 py-0.5 text-xs text-slate-200"
                    >
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color ?? "#6b7280" }} aria-hidden />
                      {role.name}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {member?.timeoutUntil && new Date(member.timeoutUntil) > new Date() && (
            <p className="rounded-md border border-nebula-warn/40 bg-nebula-warn/10 px-3 py-2 text-xs text-nebula-warn">
              Timed out until {new Date(member.timeoutUntil).toLocaleString()}
            </p>
          )}

          {!isSelf && user && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary flex items-center gap-1.5 text-sm" onClick={() => void openDm(userId)}>
                <MessageSquare size={15} aria-hidden /> Message
              </button>
              {!relationship && (
                <button type="button" className="btn-ghost flex items-center gap-1.5 text-sm" onClick={() => void sendFriendRequest(userId)}>
                  <UserPlus size={15} aria-hidden /> Add friend
                </button>
              )}
              {relationship?.type === 3 && (
                <button type="button" className="btn-ghost flex items-center gap-1.5 text-sm" onClick={() => void acceptFriend(userId)}>
                  <Check size={15} aria-hidden /> Accept request
                </button>
              )}
              {relationship?.type === 4 && (
                <button type="button" className="btn-ghost flex items-center gap-1.5 text-sm" onClick={() => void removeFriend(userId)}>
                  <X size={15} aria-hidden /> Cancel request
                </button>
              )}
              {relationship?.type === 1 && (
                <button type="button" className="btn-ghost flex items-center gap-1.5 text-sm" onClick={() => void removeFriend(userId)}>
                  <UserMinus size={15} aria-hidden /> Remove friend
                </button>
              )}
              {relationship?.type === 2 ? (
                <button type="button" className="btn-ghost flex items-center gap-1.5 text-sm" onClick={() => void unblockUser(userId)}>
                  <ShieldOff size={15} aria-hidden /> Unblock
                </button>
              ) : (
                <button type="button" className="btn-ghost flex items-center gap-1.5 text-sm text-nebula-danger" onClick={() => void blockUser(userId)}>
                  <ShieldOff size={15} aria-hidden /> Block
                </button>
              )}
            </div>
          )}

          {activeGuildId && !isSelf && !isTargetOwner && (canKick || canBan || canTimeout || canManageNick) && (
            <div className="space-y-2 rounded-md border border-nebula-800 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Moderation</p>

              {canManageNick && (
                <div className="flex items-center gap-2">
                  {nicknameEditing ? (
                    <>
                      <input
                        className="input flex-1 text-sm"
                        placeholder={member?.nickname ?? "Nickname"}
                        value={nickname}
                        autoFocus
                        onChange={(e) => setNickDraft(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn-primary text-xs"
                        onClick={async () => {
                          await setNickname(activeGuildId, userId, nickname.trim() || null);
                          setNicknameEditing(false);
                        }}
                      >
                        Save
                      </button>
                      <button type="button" className="btn-ghost text-xs" onClick={() => setNicknameEditing(false)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn-ghost text-xs" onClick={() => setNicknameEditing(true)}>
                      Change nickname
                    </button>
                  )}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {canTimeout && (
                  <Dropdown
                    align="left"
                    trigger={({ toggle }) => (
                      <button type="button" className="btn-ghost flex items-center gap-1.5 text-xs" onClick={toggle}>
                        <Clock size={14} aria-hidden /> Timeout
                      </button>
                    )}
                  >
                    {(close) => (
                      <>
                        {TIMEOUTS.map((t) => (
                          <MenuItem
                            key={t.seconds}
                            onClick={() => {
                              close();
                              void timeoutMember(activeGuildId, userId, t.seconds);
                            }}
                          >
                            {t.label}
                          </MenuItem>
                        ))}
                        <MenuItem
                          onClick={() => {
                            close();
                            void timeoutMember(activeGuildId, userId, 0);
                          }}
                        >
                          Remove timeout
                        </MenuItem>
                      </>
                    )}
                  </Dropdown>
                )}
                {canKick && (
                  <button
                    type="button"
                    className="btn-ghost flex items-center gap-1.5 text-xs text-nebula-danger"
                    onClick={() => void kickMember(activeGuildId, userId)}
                  >
                    <UserMinus size={14} aria-hidden /> Kick
                  </button>
                )}
                {canBan && (
                  <button
                    type="button"
                    className="btn-ghost flex items-center gap-1.5 text-xs text-nebula-danger"
                    onClick={() => void banMember(activeGuildId, userId)}
                  >
                    <Ban size={14} aria-hidden /> Ban
                  </button>
                )}
              </div>

              {canManageRoles && assignableRoles.length > 0 && (
                <div className="space-y-1 pt-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Assign roles</p>
                  <div className="max-h-40 space-y-0.5 overflow-y-auto">
                    {assignableRoles.map((role) => {
                      const active = memberRoles.includes(role.id);
                      return (
                        <button
                          key={role.id}
                          type="button"
                          onClick={() => void toggleRole(role.id)}
                          className={cx(
                            "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm",
                            active ? "bg-nebula-accent/15 text-slate-100" : "text-slate-400 hover:bg-white/5",
                          )}
                        >
                          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: roleColor(role.color) ?? "#6b7280" }} aria-hidden />
                          <span className="flex-1 truncate">{role.name}</span>
                          {active && <Check size={14} className="text-nebula-accent" aria-hidden />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
