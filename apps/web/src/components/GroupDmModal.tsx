import { useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import { RelationshipType, type Channel, type PublicUser } from "@nebula/shared";
import { useApp } from "../store";
import { cx, displayName } from "../lib/ui";
import { Avatar, Modal } from "./primitives";

/**
 * Modal for creating a group DM (mode "create") or managing an existing one
 * (mode "add"): list current members (the owner can remove them, anyone can
 * leave) and pick friends to add. Blocks and the 10-participant cap are
 * enforced server-side and surface as toasts.
 */
export function GroupDmModal({
  mode,
  channel,
  onClose,
}: {
  mode: "create" | "add";
  channel?: Channel | null;
  onClose: () => void;
}) {
  const me = useApp((s) => s.me);
  const relationships = useApp((s) => s.relationships);
  const presence = useApp((s) => s.presence);
  const createGroupDm = useApp((s) => s.createGroupDm);
  const addDmRecipient = useApp((s) => s.addDmRecipient);
  const removeDmRecipient = useApp((s) => s.removeDmRecipient);

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const members: PublicUser[] = mode === "add" && channel ? channel.recipients ?? [] : [];
  const memberIds = useMemo(() => new Set(members.map((u) => u.id)), [members]);
  const isOwner = channel?.ownerId === me?.id;

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return relationships
      .filter(
        (r) =>
          r.type === RelationshipType.FRIEND &&
          r.userId !== me?.id &&
          !memberIds.has(r.userId) &&
          (q === "" ||
            displayName(r.user).toLowerCase().includes(q) ||
            r.user.username.toLowerCase().includes(q)),
      )
      .sort((a, b) => displayName(a.user).localeCompare(displayName(b.user)));
  }, [relationships, me?.id, memberIds, query]);

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
      if (mode === "create") {
        await createGroupDm([...selected]);
      } else if (channel) {
        for (const id of selected) await addDmRecipient(channel.id, id);
      }
      setSelected(new Set());
      onClose();
    } finally {
      setBusy(false);
    }
  }

  function remove(user: PublicUser) {
    if (!channel) return;
    if (user.id === me?.id) {
      if (!window.confirm("Leave this group DM? You will lose access to its messages.")) return;
    }
    void removeDmRecipient(channel.id, user.id);
  }

  return (
    <Modal
      title={mode === "create" ? "New group DM" : "Add people"}
      subtitle={
        mode === "create" ? "Select friends to start a group conversation." : "Add friends to this conversation."
      }
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-slate-500">
            {selected.size === 0 ? "Select at least one friend." : `${selected.size} selected.`}
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
              {mode === "create" ? "Create DM" : "Add"}
            </button>
          </div>
        </div>
      }
    >
      {mode === "add" && members.length > 0 && (
        <div className="mb-5">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Members · {members.length}
          </h3>
          <ul className="space-y-0.5">
            {members.map((user) => (
              <li key={user.id} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-white/5">
                <Avatar user={user} size={28} presence={presence[user.id] ?? "offline"} />
                <span className="min-w-0 flex-1 truncate text-sm text-slate-200">
                  {displayName(user)}
                  {user.id === me?.id && <span className="ml-2 text-xs text-slate-500">(you)</span>}
                  {user.id === channel?.ownerId && <span className="ml-2 text-xs text-slate-500">(owner)</span>}
                </span>
                {(user.id === me?.id || isOwner) && (
                  <button
                    type="button"
                    className="rounded p-1.5 text-slate-400 hover:bg-white/10 hover:text-slate-100"
                    title={user.id === me?.id ? `Leave group DM` : `Remove ${displayName(user)}`}
                    aria-label={user.id === me?.id ? "Leave group DM" : `Remove ${displayName(user)}`}
                    onClick={() => remove(user)}
                  >
                    <X size={14} aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Friends</h3>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search friends"
        aria-label="Search friends"
        className="mb-3 w-full rounded-md border border-nebula-700 bg-nebula-950 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-nebula-accent focus:outline-none"
      />
      <ul className="space-y-0.5">
        {candidates.map((r) => {
          const active = selected.has(r.userId);
          return (
            <li key={r.userId}>
              <button
                type="button"
                onClick={() => toggle(r.userId)}
                aria-pressed={active}
                className={cx(
                  "flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left",
                  active ? "bg-nebula-800" : "hover:bg-white/5",
                )}
              >
                <Avatar user={r.user} size={28} presence={presence[r.userId] ?? "offline"} />
                <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{displayName(r.user)}</span>
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
        {candidates.length === 0 && (
          <p className="px-2 py-3 text-xs text-slate-500">
            {query ? "No friends match your search." : "No friends to add here."}
          </p>
        )}
      </ul>
    </Modal>
  );
}
