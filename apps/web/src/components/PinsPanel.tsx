import { useEffect } from "react";
import { PinOff } from "lucide-react";
import { useApp } from "../store";
import { displayName, formatTime } from "../lib/ui";
import { Avatar, Modal } from "./primitives";

export function PinsPanel({ onClose }: { onClose: () => void }) {
  const activeChannelId = useApp((s) => s.activeChannelId);
  const pinnedByChannel = useApp((s) => s.pinnedByChannel);
  const loadPins = useApp((s) => s.loadPins);
  const unpinMessage = useApp((s) => s.unpinMessage);

  useEffect(() => {
    if (activeChannelId) void loadPins(activeChannelId);
  }, [activeChannelId, loadPins]);

  if (!activeChannelId) return null;
  const pins = pinnedByChannel[activeChannelId] ?? [];

  return (
    <Modal title="Pinned messages" onClose={onClose}>
      {pins.length === 0 ? (
        <p className="text-sm text-slate-500">No pinned messages in this channel.</p>
      ) : (
        <ul className="space-y-2">
          {pins.map((m) => (
            <li key={m.id} className="group flex items-start gap-3 rounded-md border border-nebula-800 p-3">
              <Avatar user={m.author} size={32} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm">
                  <span className="font-medium text-slate-200">{displayName(m.author)}</span>
                  <span className="text-xs text-slate-500">{formatTime(m.timestamp)}</span>
                </p>
                <p className="whitespace-pre-wrap break-words text-sm text-slate-300">{m.content}</p>
              </div>
              <button
                type="button"
                title="Unpin"
                aria-label="Unpin message"
                className="text-slate-500 hover:text-nebula-danger"
                onClick={() => void unpinMessage(m.id)}
              >
                <PinOff size={16} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
