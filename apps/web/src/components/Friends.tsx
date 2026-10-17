import { useEffect, useMemo, useState } from "react";
import { Check, MessageSquare, Search, ShieldOff, UserPlus, X } from "lucide-react";
import type { PublicUser } from "@nebula/shared";
import { useApp, type Relationship } from "../store";
import { avatarColor, displayName } from "../lib/ui";

const TABS = [
  { id: "online", label: "Online" },
  { id: "all", label: "All" },
  { id: "pending", label: "Pending" },
  { id: "blocked", label: "Blocked" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function RowAvatar({ id, name }: { id: string; name: string }) {
  return (
    <div
      className="flex h-9 w-9 items-center justify-center rounded-full text-xs font-semibold text-white"
      style={{ backgroundColor: avatarColor(id) }}
      aria-hidden
    >
      {name.slice(0, 2).toUpperCase()}
    </div>
  );
}

function RelationshipRow({ rel, presence }: { rel: Relationship; presence: string }) {
  const openDm = useApp((s) => s.openDm);
  const acceptFriend = useApp((s) => s.acceptFriend);
  const blockUser = useApp((s) => s.blockUser);
  const sendFriendRequest = useApp((s) => s.sendFriendRequest);
  const name = displayName(rel.user);

  return (
    <li className="flex items-center gap-3 rounded-md px-3 py-2 hover:bg-white/5">
      <RowAvatar id={rel.user.id} name={name} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-100">{name}</p>
        <p className="truncate text-xs text-slate-500">
          {rel.type === 3
            ? "Incoming friend request"
            : rel.type === 4
              ? "Outgoing friend request"
              : rel.type === 2
                ? "Blocked"
                : (presence ?? "offline")}
        </p>
      </div>
      <div className="flex items-center gap-1">
        {rel.type === 1 && (
          <button
            type="button"
            title={`Message ${name}`}
            className="rounded p-2 text-slate-400 hover:bg-white/5 hover:text-slate-100"
            onClick={() => void openDm(rel.user.id)}
          >
            <MessageSquare size={16} aria-hidden />
          </button>
        )}
        {rel.type === 3 && (
          <button
            type="button"
            title="Accept"
            className="rounded p-2 text-nebula-accent2 hover:bg-white/5"
            onClick={() => void acceptFriend(rel.user.id)}
          >
            <Check size={16} aria-hidden />
          </button>
        )}
        {rel.type === 4 && (
          <button
            type="button"
            title="Resend request"
            className="rounded p-2 text-slate-400 hover:bg-white/5 hover:text-slate-100"
            onClick={() => void sendFriendRequest(rel.user.id)}
          >
            <UserPlus size={16} aria-hidden />
          </button>
        )}
        {rel.type !== 2 && (
          <button
            type="button"
            title="Block"
            className="rounded p-2 text-slate-400 hover:bg-nebula-danger/10 hover:text-nebula-danger"
            onClick={() => void blockUser(rel.user.id)}
          >
            <ShieldOff size={16} aria-hidden />
          </button>
        )}
      </div>
    </li>
  );
}

export function Friends() {
  const relationships = useApp((s) => s.relationships);
  const presence = useApp((s) => s.presence);
  const sendFriendRequest = useApp((s) => s.sendFriendRequest);
  const searchUsers = useApp((s) => s.searchUsers);
  const [tab, setTab] = useState<TabId>("online");
  const [addValue, setAddValue] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [results, setResults] = useState<PublicUser[]>([]);
  const [searching, setSearching] = useState(false);

  // Debounced username search.
  useEffect(() => {
    const value = addValue.trim();
    if (value.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      const users = await searchUsers(value);
      // Exclude people who already have a relationship.
      const existing = new Set(relationships.map((r) => r.userId));
      setResults(users.filter((u) => !existing.has(u.id)));
      setSearching(false);
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addValue, relationships]);

  async function addByUser(user: PublicUser) {
    setAddError(null);
    try {
      await sendFriendRequest(user.id);
      setAddValue("");
      setResults([]);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Could not send request.");
    }
  }

  const buckets = useMemo(() => {
    const friends = relationships.filter((r) => r.type === 1);
    return {
      online: friends.filter((r) => (presence[r.user.id] ?? "offline") !== "offline"),
      all: friends,
      pending: relationships.filter((r) => r.type === 3 || r.type === 4),
      blocked: relationships.filter((r) => r.type === 2),
    } satisfies Record<TabId, Relationship[]>;
  }, [relationships, presence]);

  const list = buckets[tab];

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-nebula-950">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-nebula-800 px-4">
        <span className="font-semibold text-slate-100">Friends</span>
        <nav className="flex items-center gap-1" aria-label="Friend filters">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded-md px-2.5 py-1 text-sm transition-colors ${
                tab === t.id
                  ? "bg-nebula-800 text-slate-100"
                  : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
              }`}
              aria-current={tab === t.id ? "page" : undefined}
            >
              {t.label}
              {buckets[t.id].length > 0 && t.id === "pending" && (
                <span className="ml-1.5 rounded-full bg-nebula-danger px-1.5 text-[10px] text-white">
                  {buckets[t.id].length}
                </span>
              )}
            </button>
          ))}
        </nav>
      </header>

      <div className="p-4">
        <div className="relative">
          <div className="flex items-center rounded-md border border-nebula-700 bg-nebula-900 px-3 focus-within:border-nebula-accent">
            <Search size={16} className="text-slate-500" aria-hidden />
            <input
              className="flex-1 bg-transparent px-2 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none"
              placeholder="Add a friend by username"
              aria-label="Add a friend by username"
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
            />
            {addValue && (
              <button
                type="button"
                aria-label="Clear"
                className="text-slate-500 hover:text-slate-300"
                onClick={() => {
                  setAddValue("");
                  setResults([]);
                }}
              >
                <X size={14} aria-hidden />
              </button>
            )}
          </div>

          {addValue.trim().length >= 2 && (
            <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-nebula-700 bg-nebula-900 shadow-xl">
              {searching && <p className="px-3 py-3 text-sm text-slate-500">Searching…</p>}
              {!searching && results.length === 0 && (
                <p className="px-3 py-3 text-sm text-slate-500">No users found.</p>
              )}
              {!searching &&
                results.map((user) => (
                  <button
                    key={user.id}
                    type="button"
                    onClick={() => void addByUser(user)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-white/5"
                  >
                    <RowAvatar id={user.id} name={displayName(user)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-100">{displayName(user)}</span>
                      <span className="block truncate text-xs text-slate-500">@{user.username}</span>
                    </span>
                    <span className="flex items-center gap-1 text-xs text-nebula-accent2">
                      <UserPlus size={14} aria-hidden /> Add
                    </span>
                  </button>
                ))}
            </div>
          )}
        </div>
        {addError && <p className="mt-2 text-sm text-nebula-danger">{addError}</p>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1">
        {list.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-500">
            {tab === "blocked" ? "You haven't blocked anyone." : "Nothing here yet."}
          </p>
        ) : (
          <ul className="space-y-0.5 px-1">
            {list.map((rel) => (
              <RelationshipRow key={rel.userId} rel={rel} presence={presence[rel.user.id] ?? "offline"} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
