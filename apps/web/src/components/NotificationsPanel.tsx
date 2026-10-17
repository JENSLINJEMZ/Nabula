import { useMemo } from "react";
import { AtSign, Bell, CheckCheck, MessageSquare, UserPlus } from "lucide-react";
import type { Notification } from "@nebula/shared";
import { useApp } from "../store";
import { formatRelative } from "../lib/ui";
import { Modal } from "./primitives";

const ICONS: Record<Notification["type"], typeof Bell> = {
  mention: AtSign,
  dm: MessageSquare,
  friend_request: UserPlus,
  guild_invite: Bell,
  system: Bell,
};

export function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const notifications = useApp((s) => s.notifications);
  const ackNotifications = useApp((s) => s.ackNotifications);
  const channelsByGuild = useApp((s) => s.channelsByGuild);
  const selectGuild = useApp((s) => s.selectGuild);
  const selectChannel = useApp((s) => s.selectChannel);
  const activeGuildId = useApp((s) => s.activeGuildId);

  const guildForChannel = useMemo(() => {
    const map = new Map<string, string>();
    for (const [guildId, list] of Object.entries(channelsByGuild)) for (const c of list) map.set(c.id, guildId);
    return map;
  }, [channelsByGuild]);

  async function open(n: Notification) {
    if (!n.channelId) return;
    const guildId = guildForChannel.get(n.channelId);
    if (guildId && guildId !== activeGuildId) await selectGuild(guildId);
    await selectChannel(n.channelId);
    await ackNotifications([n.id]);
    onClose();
  }

  return (
    <Modal
      title="Notifications"
      onClose={onClose}
      footer={
        notifications.some((n) => !n.read) ? (
          <button type="button" className="btn-ghost flex items-center gap-1.5 text-sm" onClick={() => void ackNotifications()}>
            <CheckCheck size={15} aria-hidden /> Mark all as read
          </button>
        ) : undefined
      }
    >
      {notifications.length === 0 ? (
        <p className="text-sm text-slate-500">You're all caught up.</p>
      ) : (
        <ul className="space-y-1">
          {notifications.map((n) => {
            const Icon = ICONS[n.type] ?? Bell;
            return (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => void open(n)}
                  className={`flex w-full items-start gap-3 rounded-md px-3 py-2 text-left hover:bg-white/5 ${n.read ? "opacity-60" : ""}`}
                >
                  <span className="mt-0.5 text-nebula-accent" aria-hidden>
                    <Icon size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-slate-200">{n.title}</span>
                      {!n.read && <span className="h-2 w-2 shrink-0 rounded-full bg-nebula-danger" aria-label="Unread" />}
                      <span className="ml-auto shrink-0 text-xs text-slate-500">{formatRelative(n.createdAt)}</span>
                    </span>
                    {n.body && <span className="line-clamp-2 block text-sm text-slate-400">{n.body}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
