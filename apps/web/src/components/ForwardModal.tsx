import { useMemo, useState } from "react";
import { Check, Forward, Hash, Users } from "lucide-react";
import { ChannelType } from "@nebula/shared";
import { useApp } from "../store";
import { cx, displayName } from "../lib/ui";
import { Modal } from "./primitives";

interface Target {
  id: string;
  label: string;
  group: string;
  kind: "channel" | "dm";
}

/**
 * Target picker for forwarding a message. Lists the guild text/announcement
 * channels and DMs the user is in; multi-select sends one copy per target.
 * Authorization (send permission, membership, blocks, slowmode) is enforced
 * server-side and surfaces as a toast.
 */
export function ForwardModal({ messageId, onClose }: { messageId: string; onClose: () => void }) {
  const me = useApp((s) => s.me);
  const guilds = useApp((s) => s.guilds);
  const channelsByGuild = useApp((s) => s.channelsByGuild);
  const dms = useApp((s) => s.dms);
  const forwardMessage = useApp((s) => s.forwardMessage);

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const targets = useMemo<Target[]>(() => {
    const rows: Target[] = [];
    for (const guild of guilds) {
      for (const c of channelsByGuild[guild.id] ?? []) {
        if (c.type !== ChannelType.GUILD_TEXT && c.type !== ChannelType.GUILD_ANNOUNCEMENT) continue;
        rows.push({ id: c.id, label: c.name ?? "channel", group: guild.name, kind: "channel" });
      }
    }
    for (const dm of dms) {
      const others = (dm.recipients ?? []).filter((u) => u.id !== me?.id);
      const label =
        dm.type === ChannelType.GROUP_DM
          ? others.map((u) => displayName(u)).join(", ") || "Group"
          : others[0]
            ? displayName(others[0])
            : dm.name || "Direct message";
      // Group DMs get their own category so a group that happens to have the
      // same member label as a 1:1 (e.g. a group containing only Bob) is still
      // a distinguishable, unambiguous target.
      rows.push({ id: dm.id, label, group: dm.type === ChannelType.GROUP_DM ? "Group DMs" : "Direct messages", kind: "dm" });
    }
    const q = query.trim().toLowerCase();
    if (q === "") return rows;
    return rows.filter((r) => r.label.toLowerCase().includes(q) || r.group.toLowerCase().includes(q));
  }, [guilds, channelsByGuild, dms, me?.id, query]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    try {
      const forwarded = await forwardMessage(messageId, [...selected]);
      if (forwarded > 0) onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Forward message"
      subtitle="Choose one or more conversations to send a copy to."
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-slate-500">
            {selected.size === 0 ? "Select at least one conversation." : `${selected.size} selected.`}
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost text-sm" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary text-sm disabled:opacity-50"
              disabled={selected.size === 0 || busy}
              onClick={() => void submit()}
            >
              <Forward size={14} aria-hidden className="mr-1 inline" />
              Forward
            </button>
          </div>
        </div>
      }
    >
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search conversations"
        aria-label="Search conversations"
        className="mb-3 w-full rounded-md border border-nebula-700 bg-nebula-950 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-nebula-accent focus:outline-none"
      />
      <ul className="space-y-0.5">
        {targets.map((t) => {
          const active = selected.has(t.id);
          return (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => toggle(t.id)}
                aria-pressed={active}
                className={cx(
                  "flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left",
                  active ? "bg-nebula-800" : "hover:bg-white/5",
                )}
              >
                <span aria-hidden className="text-slate-500">
                  {t.kind === "dm" ? <Users size={16} /> : <Hash size={16} />}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{t.label}</span>
                <span className="shrink-0 text-xs text-slate-500">{t.group}</span>
                <span
                  aria-hidden
                  className={cx(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                    active ? "border-nebula-accent bg-nebula-accent text-white" : "border-slate-600",
                  )}
                >
                  {active && <Check size={12} />}
                </span>
              </button>
            </li>
          );
        })}
        {targets.length === 0 && (
          <p className="px-2 py-3 text-xs text-slate-500">
            {query ? "No conversations match your search." : "Nowhere to forward yet."}
          </p>
        )}
      </ul>
    </Modal>
  );
}
