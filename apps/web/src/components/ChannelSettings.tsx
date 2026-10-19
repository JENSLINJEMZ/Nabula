import { useEffect, useState } from "react";
import { Copy, Plus, RefreshCcw, Trash2, Upload, Webhook } from "lucide-react";
import { Permissions, type ChannelOverwrite, type Webhook as WebhookType } from "@nebula/shared";
import { useApp, type Overwrite } from "../store";
import { hasBits } from "../lib/perms";
import { cx, memberName, roleColor } from "../lib/ui";
import { Modal } from "./primitives";

const CHANNEL_PERMS: { key: keyof typeof Permissions; label: string }[] = [
  { key: "VIEW_CHANNEL", label: "View channel" },
  { key: "SEND_MESSAGES", label: "Send messages" },
  { key: "MANAGE_MESSAGES", label: "Manage messages" },
  { key: "ATTACH_FILES", label: "Attach files" },
  { key: "READ_MESSAGE_HISTORY", label: "Read history" },
  { key: "ADD_REACTIONS", label: "Add reactions" },
  { key: "MENTION_EVERYONE", label: "Mention everyone" },
  { key: "CREATE_INSTANT_INVITE", label: "Create invites" },
  { key: "CONNECT", label: "Connect" },
  { key: "SPEAK", label: "Speak" },
  { key: "MUTE_MEMBERS", label: "Mute members" },
  { key: "MOVE_MEMBERS", label: "Move members" },
];

function bitsOf(value: string | undefined): bigint {
  try {
    return BigInt(value ?? "0");
  } catch {
    return 0n;
  }
}

export function ChannelSettings({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const activeGuildId = useApp((s) => s.activeGuildId);
  const channelsByGuild = useApp((s) => s.channelsByGuild);
  const rolesByGuild = useApp((s) => s.rolesByGuild);
  const membersByGuild = useApp((s) => s.membersByGuild);
  const permissionsByGuild = useApp((s) => s.permissionsByGuild);
  const ownerByGuild = useApp((s) => s.ownerByGuild);
  const updateChannel = useApp((s) => s.updateChannel);
  const deleteChannel = useApp((s) => s.deleteChannel);
  const loadOverwrites = useApp((s) => s.loadOverwrites);
  const upsertOverwrite = useApp((s) => s.upsertOverwrite);
  const deleteOverwrite = useApp((s) => s.deleteOverwrite);

  const channel = activeGuildId ? (channelsByGuild[activeGuildId] ?? []).find((c) => c.id === channelId) ?? null : null;
  const channels = activeGuildId ? channelsByGuild[activeGuildId] ?? [] : [];
  const roles = activeGuildId ? rolesByGuild[activeGuildId] ?? [] : [];
  const members = activeGuildId ? membersByGuild[activeGuildId] ?? [] : [];
  const isOwner = activeGuildId ? ownerByGuild[activeGuildId] ?? false : false;
  const perms = activeGuildId ? permissionsByGuild[activeGuildId] : undefined;
  const canManage = isOwner || hasBits(perms, Permissions.MANAGE_CHANNELS);

  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [nsfw, setNsfw] = useState(false);
  const [slowmode, setSlowmode] = useState(0);
  const [userLimit, setUserLimit] = useState(0);
  const [parentId, setParentId] = useState<string>("");
  const [overwrites, setOverwrites] = useState<Overwrite[]>([]);
  const [editingTarget, setEditingTarget] = useState<string | null>(null);

  const loadWebhooks = useApp((s) => s.loadWebhooks);
  const createWebhook = useApp((s) => s.createWebhook);
  const updateWebhook = useApp((s) => s.updateWebhook);
  const rotateWebhook = useApp((s) => s.rotateWebhook);
  const deleteWebhook = useApp((s) => s.deleteWebhook);
  const testWebhook = useApp((s) => s.testWebhook);
  const uploadWebhookAvatar = useApp((s) => s.uploadWebhookAvatar);
  const loadWebhookDeliveries = useApp((s) => s.loadWebhookDeliveries);

  const [webhooks, setWebhooks] = useState<WebhookType[]>([]);
  const [newWebhookName, setNewWebhookName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [activeWebhook, setActiveWebhook] = useState<WebhookType | null>(null);
  const [deliv, setDeliv] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);

  const isVoice = channel?.type === 2 || channel?.type === 13;
  const isCategory = channel?.type === 4;

  useEffect(() => {
    if (channel) {
      setName(channel.name ?? "");
      setTopic(channel.topic ?? "");
      setNsfw(channel.nsfw);
      setSlowmode(channel.rateLimitPerUser);
      setUserLimit(channel.userLimit);
      setParentId(channel.parentId ?? "");
    }
  }, [channel]);

  useEffect(() => {
    void loadOverwrites(channelId).then(setOverwrites).catch(() => undefined);
  }, [channelId, loadOverwrites]);

  useEffect(() => {
    if (!activeGuildId || !canManage) return;
    void loadWebhooks(activeGuildId, channelId).then(setWebhooks).catch(() => undefined);
  }, [activeGuildId, channelId, canManage, loadWebhooks]);

  if (!channel || !activeGuildId) return null;

  function targetLabel(o: ChannelOverwrite): string {
    if (o.type === 1) {
      const m = members.find((x) => x.userId === o.targetId);
      return m ? memberName(m) : o.targetId;
    }
    const role = roles.find((r) => r.id === o.targetId);
    return role ? `@${role.name}` : o.targetId;
  }

  const current = overwrites.find((o) => o.targetId === editingTarget) ?? null;

  function cycle(perm: bigint) {
    if (!current) return;
    const allow = bitsOf(current.allow);
    const deny = bitsOf(current.deny);
    let nextAllow = allow;
    let nextDeny = deny;
    if ((allow & perm) === perm) {
      // allow -> deny
      nextAllow = allow & ~perm;
      nextDeny = deny | perm;
    } else if ((deny & perm) === perm) {
      // deny -> neutral
      nextAllow = allow & ~perm;
      nextDeny = deny & ~perm;
    } else {
      // neutral -> allow
      nextAllow = allow | perm;
      nextDeny = deny & ~perm;
    }
    void upsertOverwrite(channelId, current.targetId, {
      type: current.type,
      allow: nextAllow.toString(),
      deny: nextDeny.toString(),
    });
    setOverwrites((prev) => prev.map((o) => (o.targetId === current.targetId ? { ...o, allow: nextAllow.toString(), deny: nextDeny.toString() } : o)));
  }

  const categories = channels.filter((c) => c.type === 4 && c.id !== channel.id);

  return (
    <Modal title="Channel settings" subtitle={channel.name ?? undefined} onClose={onClose} size="lg">
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">Name</label>
          <input className="input" value={name} disabled={!canManage} onChange={(e) => setName(e.target.value)} />
        </div>

        {!isVoice && !isCategory && (
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">Topic</label>
            <textarea className="input min-h-16" value={topic} disabled={!canManage} onChange={(e) => setTopic(e.target.value)} />
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          {!isCategory && (
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">Category</label>
              <select className="input" value={parentId} disabled={!canManage} onChange={(e) => setParentId(e.target.value)}>
                <option value="">No category</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {!isCategory && !isVoice && (
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">Slowmode (seconds)</label>
              <input
                type="number"
                min={0}
                className="input"
                value={slowmode}
                disabled={!canManage}
                onChange={(e) => setSlowmode(Math.max(0, Number(e.target.value)))}
              />
            </div>
          )}
          {isVoice && (
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">User limit (0 = ∞)</label>
              <input
                type="number"
                min={0}
                max={99}
                className="input"
                value={userLimit}
                disabled={!canManage}
                onChange={(e) => setUserLimit(Math.max(0, Number(e.target.value)))}
              />
            </div>
          )}
        </div>

        {canManage && (
          <button
            type="button"
            className="btn-primary"
            onClick={() =>
              void updateChannel(channelId, {
                name: name.trim() || channel.name,
                ...(isCategory ? {} : { topic: topic || null }),
                nsfw,
                ...(isVoice ? { userLimit } : { rateLimitPerUser: slowmode }),
                parentId: parentId || null,
              })
            }
          >
            Save changes
          </button>
        )}

        {!isCategory && (
          <div className="space-y-3 border-t border-nebula-800 pt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Permissions</p>

            <div className="flex flex-wrap items-center gap-2">
              <select
                className="input w-56"
                value={editingTarget ?? ""}
                onChange={(e) => setEditingTarget(e.target.value || null)}
                disabled={!canManage}
              >
                <option value="">Select a role or member…</option>
                <optgroup label="Roles">
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      @{r.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Members">
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {memberName(m)}
                    </option>
                  ))}
                </optgroup>
              </select>
              {canManage && editingTarget && !overwrites.some((o) => o.targetId === editingTarget) && (
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  onClick={async () => {
                    const isRole = roles.some((r) => r.id === editingTarget);
                    await upsertOverwrite(channelId, editingTarget, { type: isRole ? 0 : 1, allow: "0", deny: "0" });
                    const next = await loadOverwrites(channelId);
                    setOverwrites(next);
                  }}
                >
                  <Plus size={14} className="mr-1 inline" aria-hidden /> Add overwrite
                </button>
              )}
            </div>

            <ul className="space-y-1">
              {overwrites.map((o) => (
                <li
                  key={o.targetId}
                  className={cx(
                    "flex items-center gap-2 rounded px-2 py-1.5 text-sm",
                    editingTarget === o.targetId ? "bg-nebula-800 text-slate-100" : "text-slate-300 hover:bg-white/5",
                  )}
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{
                      backgroundColor:
                        o.type === 0 ? roleColor(roles.find((r) => r.id === o.targetId)?.color ?? 0) ?? "#6b7280" : "#6d5cff",
                    }}
                    aria-hidden
                  />
                  <button type="button" className="flex-1 truncate text-left" onClick={() => setEditingTarget(o.targetId)}>
                    {targetLabel(o)}
                  </button>
                  {canManage && (
                    <button
                      type="button"
                      aria-label="Remove overwrite"
                      className="text-slate-500 hover:text-nebula-danger"
                      onClick={async () => {
                        await deleteOverwrite(channelId, o.targetId);
                        setOverwrites(await loadOverwrites(channelId));
                        if (editingTarget === o.targetId) setEditingTarget(null);
                      }}
                    >
                      <Trash2 size={14} aria-hidden />
                    </button>
                  )}
                </li>
              ))}
              {overwrites.length === 0 && <li className="px-2 py-1 text-xs text-slate-500">No overwrites.</li>}
            </ul>

            {current && canManage && (
              <div className="rounded-md border border-nebula-800 p-3">
                <p className="mb-2 text-xs text-slate-400">
                  Cycling: <span className="text-nebula-accent2">allow</span> → <span className="text-nebula-danger">deny</span> → neutral
                </p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  {CHANNEL_PERMS.map((p) => {
                    const allow = (bitsOf(current.allow) & Permissions[p.key]) === Permissions[p.key];
                    const deny = (bitsOf(current.deny) & Permissions[p.key]) === Permissions[p.key];
                    return (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => cycle(Permissions[p.key])}
                        className="flex items-center justify-between rounded px-1 py-0.5 text-sm text-slate-300 hover:bg-white/5"
                      >
                        {p.label}
                        <span
                          className={cx(
                            "rounded px-1.5 text-[10px] font-semibold uppercase",
                            allow ? "bg-nebula-accent2/20 text-nebula-accent2" : deny ? "bg-nebula-danger/20 text-nebula-danger" : "bg-nebula-800 text-slate-500",
                          )}
                        >
                          {allow ? "allow" : deny ? "deny" : "neutral"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {canManage && (
          <div className="border-t border-nebula-800 pt-4">
            <button
              type="button"
              className="btn-ghost text-sm text-nebula-danger"
              onClick={() => {
                if (confirm(`Delete #${channel.name}?`)) {
                  void deleteChannel(channelId);
                  onClose();
                }
              }}
            >
              <Trash2 size={15} className="mr-1 inline" aria-hidden /> Delete channel
            </button>
          </div>
        )}

        {canManage && (
          <div className="space-y-3 border-t border-nebula-800 pt-4">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Webhooks</p>
              <span className="text-xs text-slate-500">Create and manage integrations</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                className="input w-56"
                placeholder="Webhook name"
                value={newWebhookName}
                onChange={(e) => setNewWebhookName(e.target.value)}
              />
              <button
                type="button"
                className="btn-ghost text-xs"
                disabled={!newWebhookName.trim() || creating}
                onClick={async () => {
                  if (!activeGuildId) return;
                  setCreating(true);
                  const res = await createWebhook(activeGuildId, channelId, newWebhookName.trim());
                  setCreating(false);
                  if (res) {
                    setWebhooks((prev) => [...prev, res.webhook]);
                    setNewToken(res.token);
                    setNewWebhookName("");
                  }
                }}
              >
                <Plus size={14} className="mr-1 inline" aria-hidden /> Create
              </button>
            </div>
            {newToken && (
              <div className="rounded-md border border-nebula-800 bg-nebula-950/60 p-2 text-xs text-slate-300">
                <div className="mb-1 font-semibold text-slate-200">New token (only shown once)</div>
                <code className="break-all font-mono">{newToken}</code>
                <button
                  type="button"
                  className="ml-2 text-slate-500 hover:text-slate-200"
                  onClick={() => void navigator.clipboard?.writeText(newToken)}
                >
                  <Copy size={12} className="inline" aria-hidden /> Copy
                </button>
                <button
                  type="button"
                  className="ml-2 text-slate-500 hover:text-slate-200"
                  onClick={() => setNewToken(null)}
                >
                  Dismiss
                </button>
              </div>
            )}
            <ul className="space-y-1">
              {webhooks.map((w) => (
                <li key={w.id} className="flex items-center gap-2 rounded border border-nebula-800 px-2 py-1.5 text-sm text-slate-300">
                  <Webhook size={14} className="text-slate-500" aria-hidden />
                  <span className="font-medium text-slate-200">{w.name}</span>
                  <span className="text-xs text-slate-500">{w.tokenPrefix}… {w.disabled ? "(disabled)" : ""}</span>
                  <button
                    type="button"
                    className="ml-auto btn-ghost text-xs"
                    onClick={async () => {
                      if (!activeGuildId) return;
                      const deliveries = await loadWebhookDeliveries(activeGuildId, w.id);
                      setActiveWebhook(w);
                      setDeliv(deliveries);
                    }}
                  >
                    Details
                  </button>
                </li>
              ))}
              {webhooks.length === 0 && <li className="px-2 py-1 text-xs text-slate-500">No webhooks.</li>}
            </ul>
            {activeWebhook && (
              <div className="rounded-md border border-nebula-800 p-3 text-sm text-slate-300">
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <div className="font-semibold text-slate-100">{activeWebhook.name}</div>
                    <div className="text-xs text-slate-500">Prefix {activeWebhook.tokenPrefix}… · {activeWebhook.disabled ? "disabled" : "enabled"}</div>
                  </div>
                  <button type="button" className="text-slate-500 hover:text-nebula-danger" onClick={() => setActiveWebhook(null)}>
                    Close
                  </button>
                </div>
                <div className="mb-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    disabled={busy}
                    onClick={async () => {
                      if (!activeGuildId) return;
                      setBusy(true);
                      const res = await rotateWebhook(activeGuildId, activeWebhook.id);
                      setBusy(false);
                      if (res) {
                        setWebhooks((prev) => prev.map((x) => (x.id === res.webhook.id ? res.webhook : x)));
                        setNewToken(res.token);
                        setActiveWebhook(res.webhook);
                      }
                    }}
                  >
                    <RefreshCcw size={12} className="mr-1 inline" aria-hidden /> Rotate
                  </button>
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    disabled={busy}
                    onClick={async () => {
                      if (!activeGuildId) return;
                      setBusy(true);
                      await updateWebhook(activeGuildId, activeWebhook.id, { disabled: !activeWebhook.disabled });
                      setBusy(false);
                      const res = await loadWebhooks(activeGuildId, channelId);
                      setWebhooks(res);
                      setActiveWebhook(res.find((x) => x.id === activeWebhook.id) ?? activeWebhook);
                    }}
                  >
                    {activeWebhook.disabled ? "Enable" : "Disable"}
                  </button>
                  <label className="btn-ghost text-xs cursor-pointer">
                    <Upload size={12} className="mr-1 inline" aria-hidden /> Avatar
                    <input
                      type="file"
                      className="hidden"
                      accept="image/png,image/jpeg,image/gif,image/webp"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (!f || !activeGuildId) return;
                        setBusy(true);
                        const w = await uploadWebhookAvatar(activeGuildId, activeWebhook.id, f);
                        setBusy(false);
                        if (w) {
                          setWebhooks((prev) => prev.map((x) => (x.id === w.id ? w : x)));
                          setActiveWebhook(w);
                        }
                        if (e.target) e.target.value = "";
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    disabled={busy}
                    onClick={async () => {
                      if (!activeGuildId) return;
                      setBusy(true);
                      const ok = await testWebhook(activeGuildId, activeWebhook.id);
                      setBusy(false);
                      if (ok) alert("Test delivery sent.");
                      else alert("Test failed. Check permissions or destination.");
                    }}
                  >
                    Send test
                  </button>
                  <button
                    type="button"
                    className="btn-ghost text-xs text-nebula-danger"
                    disabled={busy}
                    onClick={async () => {
                      if (!activeGuildId || !confirm(`Delete "${activeWebhook.name}"?`)) return;
                      setBusy(true);
                      await deleteWebhook(activeGuildId, activeWebhook.id);
                      setBusy(false);
                      setWebhooks((prev) => prev.filter((x) => x.id !== activeWebhook.id));
                      setActiveWebhook(null);
                    }}
                  >
                    <Trash2 size={12} className="mr-1 inline" aria-hidden /> Delete
                  </button>
                </div>
                <div className="text-xs text-slate-500 mb-1">Recent deliveries</div>
                <ul className="space-y-1 text-xs">
                  {deliv.map((d) => (
                    <li key={d.id} className="flex items-center gap-2">
                      <span className={d.success ? "text-nebula-accent2" : "text-nebula-danger"}>{d.success ? "OK" : "ERR"}</span>
                      <span>{d.statusCode}</span>
                      {d.messageId && <span className="text-slate-500">msg {d.messageId.slice(-6)}</span>}
                      {d.error && <span className="truncate text-slate-500">{d.error}</span>}
                      <span className="ml-auto text-slate-600">{new Date(d.createdAt).toLocaleTimeString()}</span>
                    </li>
                  ))}
                  {deliv.length === 0 && <li className="text-slate-600">No deliveries.</li>}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
