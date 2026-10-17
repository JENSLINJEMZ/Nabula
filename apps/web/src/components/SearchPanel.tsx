import { useEffect, useMemo, useState } from "react";
import { Hash, Search, X } from "lucide-react";
import { useApp } from "../store";
import { displayName, formatTime } from "../lib/ui";
import { Avatar } from "./primitives";

export function SearchPanel({ onClose }: { onClose: () => void }) {
  const search = useApp((s) => s.search);
  const searchResults = useApp((s) => s.searchResults);
  const searchBusy = useApp((s) => s.searchBusy);
  const searchQuery = useApp((s) => s.searchQuery);
  const channelsByGuild = useApp((s) => s.channelsByGuild);
  const dms = useApp((s) => s.dms);
  const me = useApp((s) => s.me);
  const selectGuild = useApp((s) => s.selectGuild);
  const selectChannel = useApp((s) => s.selectChannel);
  const activeGuildId = useApp((s) => s.activeGuildId);

  const [query, setQuery] = useState(searchQuery);

  const channelNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const list of Object.values(channelsByGuild)) for (const c of list) if (c.name) map.set(c.id, c.name);
    for (const dm of dms) {
      const other = (dm.recipients ?? []).find((u) => u.id !== me?.id);
      map.set(dm.id, other ? displayName(other) : dm.name || "DM");
    }
    return map;
  }, [channelsByGuild, dms, me?.id]);

  const guildForChannel = useMemo(() => {
    const map = new Map<string, string>();
    for (const [guildId, list] of Object.entries(channelsByGuild)) for (const c of list) map.set(c.id, guildId);
    return map;
  }, [channelsByGuild]);

  useEffect(() => {
    const timer = setTimeout(() => void search(query), 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  async function openResult(channelId: string, messageId: string) {
    const guildId = guildForChannel.get(channelId);
    if (guildId && guildId !== activeGuildId) await selectGuild(guildId);
    await selectChannel(channelId);
    onClose();
    setTimeout(() => {
      document.getElementById(`msg-${messageId}`)?.scrollIntoView({ block: "center" });
    }, 400);
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/60 p-4 pt-20" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Search messages" className="flex max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-nebula-700 bg-nebula-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-nebula-800 px-4 py-3">
          <Search size={18} className="text-slate-500" aria-hidden />
          <input
            autoFocus
            className="flex-1 bg-transparent text-sm text-slate-100 placeholder-slate-500 outline-none"
            placeholder="Search messages…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" aria-label="Close search" className="text-slate-500 hover:text-slate-200" onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {searchBusy && <p className="px-3 py-4 text-sm text-slate-500">Searching…</p>}
          {!searchBusy && query && searchResults.length === 0 && (
            <p className="px-3 py-4 text-sm text-slate-500">No results for “{query}”.</p>
          )}
          {!query && <p className="px-3 py-4 text-sm text-slate-500">Type to search across your servers and DMs.</p>}
          <ul className="space-y-0.5">
            {searchResults.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => void openResult(m.channelId, m.id)}
                  className="flex w-full items-start gap-3 rounded px-3 py-2 text-left hover:bg-white/5"
                >
                  <Avatar user={m.author} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-slate-200">{displayName(m.author)}</span>
                      <span className="flex items-center gap-0.5 text-xs text-slate-500">
                        <Hash size={11} aria-hidden />
                        {channelNames.get(m.channelId) ?? "channel"}
                      </span>
                      <span className="text-xs text-slate-500">{formatTime(m.timestamp)}</span>
                    </span>
                    <span className="line-clamp-2 text-sm text-slate-400">{m.content}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
