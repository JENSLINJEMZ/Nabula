import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  Bell,
  Forward,
  Hash,
  LogOut,
  MessageSquarePlus,
  MessagesSquare,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Reply,
  Search,
  Send,
  Smile,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { ChannelType, MessageType, Permissions, type Channel, type Message, type PublicUser } from "@nebula/shared";
import { useApp } from "../store";
import { hasBits } from "../lib/perms";
import { renderMarkdown } from "../lib/markdown";
import { avatarColor, cx, displayName, formatBytes, formatClock, dayKey, formatDayDivider, isSameGroup } from "../lib/ui";
import { Avatar, IconButton } from "./primitives";
import { ForwardModal } from "./ForwardModal";
import { GroupDmModal } from "./GroupDmModal";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "🚀", "👀", "🔥", "✅", "😮", "😢", "🙏", "💯"];
const EMOJI_PALETTE = [
  "😀", "😂", "🥰", "😎", "🤔", "😭", "😡", "🥳", "👍", "👎", "👏", "🙏",
  "❤️", "🔥", "✨", "🎉", "🚀", "💯", "✅", "❌", "⚠️", "👀", "💡", "🎯",
  "🍕", "☕", "🐍", "🦀", "🌈", "⭐", "🌙", "☀️", "🎮", "🎵", "📎", "📌",
];

/** Message types rendered as compact, author-prefixed timeline entries. */
const SYSTEM_MESSAGE_TYPES: ReadonlySet<number> = new Set([
  MessageType.RECIPIENT_ADD,
  MessageType.RECIPIENT_REMOVE,
  MessageType.CALL,
  MessageType.CHANNEL_NAME_CHANGE,
  MessageType.CHANNEL_ICON_CHANGE,
  MessageType.CHANNEL_PINNED_MESSAGE,
  MessageType.USER_JOIN,
]);

/* --------------------------------------------------------- attachments */

function AttachmentGrid({ items }: { items: Message["attachments"] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {items.map((a) => {
        const isImage = (a.contentType ?? "").startsWith("image/");
        const isAudio = (a.contentType ?? "").startsWith("audio/");
        const isVideo = (a.contentType ?? "").startsWith("video/");
        return (
          <div key={a.id} className="max-w-sm overflow-hidden rounded-lg border border-nebula-700 bg-nebula-850">
            {isImage ? (
              <a href={a.url} target="_blank" rel="noreferrer">
                <img src={a.url} alt={a.filename} className="max-h-80 w-auto object-contain" />
              </a>
            ) : isAudio ? (
              <div className="p-2">
                <audio controls src={a.url} className="w-72 max-w-full" />
              </div>
            ) : isVideo ? (
              <video controls src={a.url} className="max-h-80 w-auto" />
            ) : (
              <a href={a.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 px-3 py-2 text-sm hover:underline">
                <Paperclip size={16} aria-hidden />
                <span className="truncate text-nebula-accent">{a.filename}</span>
                <span className="shrink-0 text-xs text-slate-500">{formatBytes(a.size)}</span>
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------- typing line */

function TypingLine({ channelId }: { channelId: string }) {
  const typing = useApp((s) => s.typing);
  const members = useApp((s) => s.membersByGuild);
  const activeGuildId = useApp((s) => s.activeGuildId);
  const me = useApp((s) => s.me);
  const [, tick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1500);
    return () => clearInterval(timer);
  }, []);

  const now = Date.now();
  const userIds = Object.entries(typing)
    .filter(([key, expires]) => key.startsWith(`${channelId}:`) && expires > now)
    .map(([key]) => key.slice(channelId.length + 1))
    .filter((id) => id !== me?.id);

  if (userIds.length === 0) return null;
  const list = activeGuildId ? members[activeGuildId] ?? [] : [];
  const names = userIds.map((id) => {
    const m = list.find((x) => x.userId === id);
    return m?.nickname || m?.user?.displayName || m?.user?.username || "Someone";
  });
  const label = names.length === 1 ? `${names[0]} is typing` : names.length <= 3 ? `${names.join(", ")} are typing` : "Several people are typing";

  return (
    <div className="flex items-center gap-2 px-4 pb-1 text-xs text-slate-400" aria-live="polite">
      <span className="flex gap-0.5">
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-500" style={{ animationDelay: `${i * 120}ms` }} />
        ))}
      </span>
      {label}…
    </div>
  );
}

/* ------------------------------------------------------------- message */

function MessageRow({
  message,
  grouped,
  isMine,
  highlight,
  onReply,
  onThread,
  deps,
  canManage,
  canThread,
}: {
  message: Message;
  grouped: boolean;
  isMine: boolean;
  highlight?: boolean;
  onReply: (m: Message) => void;
  onThread: (m: Message) => void;
  deps: { mentions: PublicUser[]; channels: Map<string, string>; roles: Map<string, { name: string; color: number }>; selfId: string | null };
  canManage: boolean;
  canThread: boolean;
}) {
  const editMessage = useApp((s) => s.editMessage);
  const deleteMessage = useApp((s) => s.deleteMessage);
  const toggleReaction = useApp((s) => s.toggleReaction);
  const pinMessage = useApp((s) => s.pinMessage);
  const unpinMessage = useApp((s) => s.unpinMessage);
  const openMemberProfile = useApp((s) => s.openMemberProfile);
  const pushToast = useApp((s) => s.pushToast);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [forwardOpen, setForwardOpen] = useState(false);

  async function saveEdit() {
    const next = draft.trim();
    if (!next || next === message.content) {
      setEditing(false);
      setDraft(message.content);
      return;
    }
    await editMessage(message.id, next);
    setEditing(false);
  }

  const mentionHighlight = highlight || deps.mentions.some((u) => u.id === deps.selfId) || message.mentionEveryone;
  const isForward = message.referencedMessage
    ? message.referencedMessage.channelId !== message.channelId
    : false;

  // System messages (pins, group-DM membership, joins) render as a compact
  // centered timeline entry with no hover actions.
  if (SYSTEM_MESSAGE_TYPES.has(message.type)) {
    return (
      <div
        id={`msg-${message.id}`}
        className="flex items-center gap-2 px-4 py-1 text-xs text-slate-400"
      >
        <Avatar user={message.author} size={20} />
        <p className="min-w-0 flex-1">
          <span className="font-semibold text-slate-300">{displayName(message.author)}</span>{" "}
          <span className="text-slate-400">{renderMarkdown(message.content, deps)}</span>
          <time className="ml-2 text-[10px] text-slate-600" dateTime={message.timestamp}>
            {formatClock(message.timestamp)}
          </time>
        </p>
      </div>
    );
  }

  return (
    <div
      id={`msg-${message.id}`}
      className={cx(
        "group relative px-4",
        grouped ? "py-0.5" : "mt-4 py-0.5",
        mentionHighlight && "border-l-2 border-nebula-warn/70 bg-nebula-warn/[0.06]",
      )}
    >
      {message.referencedMessage && (
        <div className="mb-0.5 flex items-center gap-1.5 pl-[52px] text-xs text-slate-500">
          {isForward ? (
            <Forward size={12} aria-hidden />
          ) : (
            <Reply size={12} className="rotate-180" aria-hidden />
          )}
          {isForward && <span className="font-medium text-slate-500">Forwarded</span>}
          <span className="font-medium text-slate-400">{displayName(message.referencedMessage.author)}</span>
          <span className="truncate">{message.referencedMessage.content || "(attachment)"}</span>
        </div>
      )}
      <div className="flex gap-3">
        {grouped ? (
          <time className="w-10 shrink-0 pt-1 text-right text-[10px] text-slate-600 opacity-0 group-hover:opacity-100" dateTime={message.timestamp}>
            {formatClock(message.timestamp)}
          </time>
        ) : (
          <button type="button" onClick={() => openMemberProfile(message.author.id)} aria-label={`View ${displayName(message.author)}`}>
            <Avatar user={message.author} size={40} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          {!grouped && (
            <div className="flex items-baseline gap-2">
              <button type="button" className="text-sm font-semibold text-slate-100 hover:underline" onClick={() => openMemberProfile(message.author.id)}>
                {displayName(message.author)}
              </button>
              {message.author.bot && (
                <span className="rounded bg-nebula-accent/20 px-1 text-[10px] font-semibold uppercase text-nebula-accent">bot</span>
              )}
              <time className="text-xs text-slate-500" dateTime={message.timestamp}>
                {formatDayDivider(message.timestamp)} {formatClock(message.timestamp)}
              </time>
            </div>
          )}

          {editing ? (
            <div className="mt-1 flex items-center gap-2">
              <input
                className="input"
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveEdit();
                  if (e.key === "Escape") {
                    setEditing(false);
                    setDraft(message.content);
                  }
                }}
              />
              <button type="button" className="btn-ghost text-xs" onClick={() => void saveEdit()}>
                Save
              </button>
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() => {
                  setEditing(false);
                  setDraft(message.content);
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            message.content && (
              <div className="whitespace-pre-wrap break-words text-sm text-slate-200">
                {renderMarkdown(message.content, deps)}
              </div>
            )
          )}

          <AttachmentGrid items={message.attachments} />

          {(message.reactions?.length ?? 0) > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {message.reactions?.map((r) => (
                <button
                  key={r.emoji}
                  type="button"
                  onClick={() => void toggleReaction(message.channelId, message.id, r.emoji, r.me)}
                  className={cx(
                    "flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs transition-colors",
                    r.me
                      ? "border-nebula-accent/60 bg-nebula-accent/15 text-nebula-accent"
                      : "border-nebula-700 bg-nebula-850 text-slate-300 hover:border-nebula-600",
                  )}
                  aria-pressed={r.me}
                >
                  <span>{r.emoji}</span>
                  <span>{r.count}</span>
                </button>
              ))}
            </div>
          )}

          {message.threadId && (
            <button
              type="button"
              onClick={() => onThread(message)}
              className="mt-1.5 flex items-center gap-1.5 rounded-md border border-nebula-700 bg-nebula-850 px-2 py-0.5 text-xs font-medium text-nebula-accent hover:border-nebula-accent/60"
            >
              <MessagesSquare size={13} aria-hidden />
              Thread
            </button>
          )}
        </div>
      </div>

      <div className="absolute -top-3 right-4 hidden items-center gap-0.5 rounded-md border border-nebula-700 bg-nebula-900 px-1 py-0.5 shadow group-hover:flex">
        <IconButton title="Add reaction" onClick={() => setPickerOpen((v) => !v)}>
          <Smile size={15} aria-hidden />
        </IconButton>
        <IconButton title="Reply" onClick={() => onReply(message)}>
          <Reply size={15} aria-hidden />
        </IconButton>
        <IconButton title="Forward" onClick={() => setForwardOpen(true)}>
          <Forward size={15} aria-hidden />
        </IconButton>
        {canThread && (
          <IconButton title={message.threadId ? "Open thread" : "Create thread"} onClick={() => onThread(message)}>
            <MessageSquarePlus size={15} aria-hidden />
          </IconButton>
        )}
        <IconButton
          title={message.pinned ? "Unpin" : "Pin"}
          onClick={() => void (message.pinned ? unpinMessage(message.id) : pinMessage(message.id))}
        >
          {message.pinned ? <PinOff size={15} aria-hidden /> : <Pin size={15} aria-hidden />}
        </IconButton>
        {(isMine || canManage) && (
          <>
            {isMine && (
              <IconButton title="Edit message" onClick={() => setEditing(true)}>
                <Pencil size={15} aria-hidden />
              </IconButton>
            )}
            <IconButton title="Delete message" tone="danger" onClick={() => void deleteMessage(message.id)}>
              <Trash2 size={15} aria-hidden />
            </IconButton>
          </>
        )}
      </div>

      {pickerOpen && (
        <div className="absolute right-4 top-7 z-20 w-64 rounded-lg border border-nebula-700 bg-nebula-900 p-2 shadow-2xl">
          <div className="mb-1 flex flex-wrap gap-1">
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="rounded p-1 text-lg hover:bg-white/10"
                onClick={() => {
                  void toggleReaction(message.channelId, message.id, emoji, false);
                  setPickerOpen(false);
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-8 gap-0.5 border-t border-nebula-800 pt-1">
            {EMOJI_PALETTE.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="rounded p-1 text-base hover:bg-white/10"
                onClick={() => {
                  void toggleReaction(message.channelId, message.id, emoji, false);
                  setPickerOpen(false);
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}

      {forwardOpen && <ForwardModal messageId={message.id} onClose={() => setForwardOpen(false)} />}
    </div>
  );
}

/* ---------------------------------------------------------- thread panel */

/**
 * Side panel that renders a thread's messages and composer. A thread is itself
 * a channel (server-side type 11/12), so messages are fetched/sent with the
 * thread's channel id and arrive over the normal realtime path.
 */
function ThreadPanel() {
  const activeThreadId = useApp((s) => s.activeThreadId);
  const activeChannelId = useApp((s) => s.activeChannelId);
  const activeGuildId = useApp((s) => s.activeGuildId);
  const threads = useApp((s) => (activeChannelId ? s.threadsByChannel[activeChannelId] : undefined));
  const messagesByChannel = useApp((s) => s.messagesByChannel);
  const channelsByGuild = useApp((s) => s.channelsByGuild);
  const rolesByGuild = useApp((s) => s.rolesByGuild);
  const permissionsByGuild = useApp((s) => s.permissionsByGuild);
  const ownerByGuild = useApp((s) => s.ownerByGuild);
  const me = useApp((s) => s.me);
  const sendMessage = useApp((s) => s.sendMessage);
  const closeThread = useApp((s) => s.closeThread);
  const threadDrafts = useApp((s) => s.threadDrafts);
  const setThreadDraft = useApp((s) => s.setThreadDraft);

  // Draft lives in the store (keyed by thread id) so it survives the
  // component remount triggered by the route change when a thread opens.
  const draft = activeThreadId ? (threadDrafts[activeThreadId] ?? "") : "";
  const setDraft = (value: string) => {
    if (activeThreadId) setThreadDraft(activeThreadId, value);
  };
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const thread = useMemo(() => (threads ?? []).find((t) => t.id === activeThreadId) ?? null, [threads, activeThreadId]);
  const messages = activeThreadId ? messagesByChannel[activeThreadId] ?? [] : [];
  const parent = activeChannelId && activeGuildId ? (channelsByGuild[activeGuildId] ?? []).find((c) => c.id === activeChannelId) ?? null : null;
  const isOwner = activeGuildId ? ownerByGuild[activeGuildId] ?? false : false;
  const canSend = isOwner || hasBits(parent?.permissions, Permissions.SEND_MESSAGES);
  const canManage = isOwner || hasBits(activeGuildId ? permissionsByGuild[activeGuildId] : undefined, Permissions.MANAGE_MESSAGES);

  const deps = useMemo(() => {
    const channels = new Map<string, string>();
    for (const list of Object.values(channelsByGuild)) for (const c of list) if (c.name) channels.set(c.id, c.name);
    const roles = new Map<string, { name: string; color: number }>();
    if (activeGuildId) for (const r of rolesByGuild[activeGuildId] ?? []) roles.set(r.id, { name: r.name, color: r.color });
    return { channels, roles, selfId: me?.id ?? null };
  }, [channelsByGuild, rolesByGuild, activeGuildId, me?.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, activeThreadId]);

  if (!activeThreadId) return null;

  /**
   * Send a message in this thread. The content is passed in explicitly (read
   * from the event) rather than read from `draft`, so a rapid fill-then-Enter
   * cannot race the async state update and send an empty string.
   */
  async function send(content: string, event?: FormEvent) {
    event?.preventDefault();
    if (!activeThreadId || sending || !canSend) return;
    const trimmed = content.trim();
    if (!trimmed) return;
    setSending(true);
    try {
      await sendMessage(activeThreadId, trimmed);
      setDraft("");
    } finally {
      setSending(false);
    }
  }

  const rendered: ReactNode[] = [];
  let prev: Message | null = null;
  for (const m of messages) {
    const grouped = prev ? isSameGroup(prev, m) : false;
    rendered.push(
      <MessageRow
        key={m.id}
        message={m}
        grouped={grouped}
        isMine={m.author.id === me?.id}
        onReply={() => {}}
        onThread={() => {}}
        deps={{ mentions: m.mentions ?? [], ...deps }}
        canManage={canManage}
        canThread={false}
      />,
    );
    prev = m;
  }

  return (
    <aside
      className="flex w-full max-w-md shrink-0 flex-col border-l border-nebula-800 bg-nebula-950 md:w-96"
      aria-label="Thread"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-nebula-800 px-3">
        <MessagesSquare size={17} className="text-slate-500" aria-hidden />
        <h3 className="truncate font-semibold text-slate-100">{thread?.name ?? "Thread"}</h3>
        <button
          type="button"
          aria-label="Close thread"
          className="ml-auto rounded p-1 text-slate-500 hover:bg-white/5 hover:text-slate-200"
          onClick={() => closeThread()}
        >
          <X size={16} aria-hidden />
        </button>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-3">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-slate-500">
            This thread is empty — start the conversation.
          </div>
        ) : (
          rendered
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
        className="shrink-0 px-3 pb-4 pt-1"
      >
        <div className="flex items-end gap-2 rounded-lg border border-nebula-700 bg-nebula-900 px-2 py-1.5 focus-within:border-nebula-accent">
          <textarea
            aria-label="Message thread"
            className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent py-1 text-sm text-slate-100 placeholder-slate-500 outline-none disabled:opacity-50"
            rows={1}
            disabled={!canSend}
            placeholder={canSend ? "Message thread" : "You cannot send messages here"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                // Read the value directly from the event instead of the
                // `draft` closure so a rapid fill-then-Enter can't race the
                // async state update and send an empty string.
                void send(e.currentTarget.value);
              }
            }}
          />
          <button
            type="submit"
            className="btn-primary px-2 py-1.5"
            disabled={sending || !canSend || !draft.trim()}
            aria-label="Send thread message"
          >
            <Send size={16} aria-hidden />
          </button>
        </div>
      </form>
    </aside>
  );
}

/* ------------------------------------------------------------ chat view */

export function ChatView() {
  const activeChannelId = useApp((s) => s.activeChannelId);
  const activeDmId = useApp((s) => s.activeDmId);
  const dms = useApp((s) => s.dms);
  const channelsByGuild = useApp((s) => s.channelsByGuild);
  const rolesByGuild = useApp((s) => s.rolesByGuild);
  const activeGuildId = useApp((s) => s.activeGuildId);
  const messagesByChannel = useApp((s) => s.messagesByChannel);
  const membersByGuild = useApp((s) => s.membersByGuild);
  const permissionsByGuild = useApp((s) => s.permissionsByGuild);
  const ownerByGuild = useApp((s) => s.ownerByGuild);
  const me = useApp((s) => s.me);
  const sendMessage = useApp((s) => s.sendMessage);
  const sendReply = useApp((s) => s.sendReply);
  const sendWithAttachments = useApp((s) => s.sendWithAttachments);
  const uploadAttachment = useApp((s) => s.uploadAttachment);
  const setTyping = useApp((s) => s.setTyping);
  const createInvite = useApp((s) => s.createInvite);
  const setPinnedOpen = useApp((s) => s.setPinnedOpen);
  const setSearchOpen = useApp((s) => s.setSearchOpen);
  const setNotificationsOpen = useApp((s) => s.setNotificationsOpen);
  const loadOlder = useApp((s) => s.loadOlder);
  const unreadNotifications = useApp((s) => s.unreadNotifications);
  const activeThreadId = useApp((s) => s.activeThreadId);
  const createThread = useApp((s) => s.createThread);
  const openThread = useApp((s) => s.openThread);
  const removeDmRecipient = useApp((s) => s.removeDmRecipient);

  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<{ id: string; filename: string }[]>([]);
  const [sending, setSending] = useState(false);
  const [invite, setInvite] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<Message | null>(null);
  const [groupDmOpen, setGroupDmOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastTypedRef = useRef(0);

  const conversationId = activeChannelId ?? activeDmId;
  const isDm = activeChannelId === null && activeDmId !== null;

  const dmRecipient = useMemo(
    () => (isDm ? (dms.find((d) => d.id === activeDmId)?.recipients ?? []).find((u) => u.id !== me?.id) ?? null : null),
    [isDm, dms, activeDmId, me?.id],
  );

  const channel: Channel | null = useMemo(() => {
    if (isDm) return dms.find((d) => d.id === activeDmId) ?? null;
    if (!activeGuildId) return null;
    return (channelsByGuild[activeGuildId] ?? []).find((c) => c.id === activeChannelId) ?? null;
  }, [channelsByGuild, dms, activeGuildId, activeChannelId, activeDmId, isDm]);

  const dmOthers = useMemo(
    () => (isDm && channel ? (channel.recipients ?? []).filter((u) => u.id !== me?.id) : []),
    [isDm, channel, me?.id],
  );
  const isGroupDm = isDm && channel?.type === ChannelType.GROUP_DM;

  async function leaveGroupDm() {
    if (!channel || !me) return;
    if (!window.confirm("Leave this group DM? You will lose access to its messages.")) return;
    await removeDmRecipient(channel.id, me.id);
  }

  const messages = conversationId ? messagesByChannel[conversationId] ?? [] : [];
  const memberCount = activeGuildId ? membersByGuild[activeGuildId]?.length ?? 0 : 0;
  const perms = activeGuildId ? permissionsByGuild[activeGuildId] : undefined;
  const isOwner = activeGuildId ? ownerByGuild[activeGuildId] ?? false : false;

  const channelPerms = channel?.permissions;
  const canSend = isDm || isOwner || hasBits(channelPerms, Permissions.SEND_MESSAGES);
  const canAttach = isDm || isOwner || hasBits(channelPerms, Permissions.ATTACH_FILES);
  const canManageMessages = isOwner || hasBits(perms, Permissions.MANAGE_MESSAGES);
  const canInvite = isDm ? false : isOwner || hasBits(channelPerms, Permissions.CREATE_INSTANT_INVITE);
  const canThread = isDm ? false : isOwner || hasBits(channelPerms, Permissions.CREATE_PUBLIC_THREADS);

  async function onThread(message: Message) {
    if (message.threadId) {
      await openThread(message.threadId);
      return;
    }
    const name = message.content.trim().slice(0, 40) || `${displayName(message.author)}'s thread`;
    await createThread(message.channelId, name, message.id);
  }

  const deps = useMemo(() => {
    const channels = new Map<string, string>();
    for (const list of Object.values(channelsByGuild)) for (const c of list) if (c.name) channels.set(c.id, c.name);
    const roles = new Map<string, { name: string; color: number }>();
    if (activeGuildId) for (const r of rolesByGuild[activeGuildId] ?? []) roles.set(r.id, { name: r.name, color: r.color });
    return { channels, roles, selfId: me?.id ?? null };
  }, [channelsByGuild, rolesByGuild, activeGuildId, me?.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, conversationId]);

  async function submit(content: string, event?: FormEvent) {
    event?.preventDefault();
    if (!conversationId || sending || !canSend) return;
    const trimmed = content.trim();
    if (!trimmed && pending.length === 0) return;
    setSending(true);
    try {
      if (pending.length > 0) {
        await sendWithAttachments(conversationId, trimmed, pending.map((a) => a.id));
      } else if (replyTarget) {
        await sendReply(conversationId, trimmed, replyTarget.id);
      } else {
        await sendMessage(conversationId, trimmed);
      }
      setDraft("");
      setPending([]);
      setReplyTarget(null);
    } finally {
      setSending(false);
    }
  }

  async function onPickFile(files: FileList | null) {
    if (!conversationId || !files) return;
    for (const file of Array.from(files)) {
      const attachment = await uploadAttachment(conversationId, file);
      if (attachment) setPending((prev) => [...prev, attachment]);
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit(e.currentTarget.value);
      return;
    }
    const now = Date.now();
    if (conversationId && now - lastTypedRef.current > 4000) {
      lastTypedRef.current = now;
      setTyping(conversationId);
    }
  }

  if (!conversationId || !channel) {
    return (
      <div className="flex h-full flex-1 items-center justify-center text-slate-500">
        <p>Select a channel to start chatting.</p>
      </div>
    );
  }

  const headerLabel = isDm
    ? isGroupDm
      ? dmOthers.map((u) => displayName(u)).join(", ") || "Group DM"
      : dmRecipient
        ? displayName(dmRecipient)
        : channel.name || "Direct message"
    : channel.name ?? "channel";

  const rendered: ReactNode[] = [];
  let prev: Message | null = null;
  for (const m of messages) {
    const dayChanged = !prev || dayKey(prev.timestamp) !== dayKey(m.timestamp);
    if (dayChanged) {
      rendered.push(
        <div key={`day-${m.id}`} className="my-3 flex items-center gap-3 px-4" role="separator">
          <span className="h-px flex-1 bg-nebula-800" />
          <span className="text-xs font-semibold text-slate-500">{formatDayDivider(m.timestamp)}</span>
          <span className="h-px flex-1 bg-nebula-800" />
        </div>,
      );
    }
    const grouped = !dayChanged && prev ? isSameGroup(prev, m) : false;
    rendered.push(
      <MessageRow
        key={m.id}
        message={m}
        grouped={grouped}
        isMine={m.author.id === me?.id}
        onReply={setReplyTarget}
        onThread={(msg) => void onThread(msg)}
        deps={{ mentions: m.mentions ?? [], ...deps }}
        canManage={canManageMessages}
        canThread={canThread}
      />,
    );
    prev = m;
  }

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col bg-nebula-950">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-nebula-800 px-4">
        {isDm ? (
          <Avatar user={dmRecipient} id={dmRecipient?.id ?? channel.id} name={headerLabel} size={24} />
        ) : (
          <Hash size={20} className="text-slate-500" aria-hidden />
        )}
        <h2 className="font-semibold text-slate-100">{headerLabel}</h2>
        {!isDm && channel.topic && (
          <>
            <span className="mx-1 h-5 w-px bg-nebula-700" aria-hidden />
            <p className="truncate text-sm text-slate-400">{channel.topic}</p>
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          {isGroupDm && channel && (
            <>
              <IconButton title="Add people" onClick={() => setGroupDmOpen(true)}>
                <UserPlus size={17} aria-hidden />
              </IconButton>
              <IconButton title="Leave group DM" onClick={() => void leaveGroupDm()}>
                <LogOut size={17} aria-hidden />
              </IconButton>
            </>
          )}
          {!isDm && memberCount > 0 && <span className="mr-1 hidden text-xs text-slate-500 sm:inline">{memberCount} members</span>}
          {!isDm && (
            <>
              <IconButton title="Pinned messages" onClick={() => setPinnedOpen(true)}>
                <Pin size={17} aria-hidden />
              </IconButton>
              <IconButton title="Search" onClick={() => setSearchOpen(true)}>
                <Search size={17} aria-hidden />
              </IconButton>
            </>
          )}
          <IconButton title="Notifications" onClick={() => setNotificationsOpen(true)}>
            <span className="relative">
              <Bell size={17} aria-hidden />
              {unreadNotifications > 0 && (
                <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-nebula-danger" aria-hidden />
              )}
            </span>
          </IconButton>
          {canInvite && (
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={async () => {
                const code = await createInvite(channel.id);
                setInvite(code);
              }}
            >
              Invite
            </button>
          )}
        </div>
      </header>

      {isGroupDm && channel && groupDmOpen && (
        <GroupDmModal mode="add" channel={channel} onClose={() => setGroupDmOpen(false)} />
      )}

      {invite && (
        <div className="flex items-center gap-2 border-b border-nebula-800 bg-nebula-900/60 px-4 py-2 text-xs text-slate-300">
          <span>Invite code:</span>
          <code className="rounded bg-nebula-800 px-2 py-0.5 font-mono text-nebula-accent2">{invite}</code>
          <button
            type="button"
            className="text-slate-500 hover:text-slate-200"
            onClick={() => void navigator.clipboard?.writeText(invite)}
          >
            Copy
          </button>
          <button type="button" className="ml-auto text-slate-500 hover:text-slate-200" onClick={() => setInvite(null)} aria-label="Dismiss invite">
            <X size={14} aria-hidden />
          </button>
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-3">
        {messages.length > 0 && (
          <div className="px-4 pb-2">
            <button type="button" className="text-xs text-slate-500 hover:text-slate-300" onClick={() => void loadOlder(conversationId)}>
              ↑ Load older messages
            </button>
          </div>
        )}
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">No messages yet — say hello.</div>
        ) : (
          rendered
        )}
      </div>

      <TypingLine channelId={conversationId} />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(draft);
        }}
        className="shrink-0 px-4 pb-5 pt-1"
      >
        {!canSend && (
          <p className="mb-2 rounded-md border border-nebula-700 bg-nebula-900 px-3 py-1.5 text-xs text-slate-400">
            You do not have permission to send messages in this channel.
          </p>
        )}
        {replyTarget && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-nebula-700 bg-nebula-900 px-3 py-1.5 text-xs text-slate-300">
            <Reply size={13} className="rotate-180 text-slate-500" aria-hidden />
            <span>Replying to</span>
            <span className="font-medium text-slate-100">{displayName(replyTarget.author)}</span>
            <span className="min-w-0 flex-1 truncate text-slate-500">{replyTarget.content}</span>
            <button type="button" aria-label="Cancel reply" className="text-slate-500 hover:text-nebula-danger" onClick={() => setReplyTarget(null)}>
              <X size={14} aria-hidden />
            </button>
          </div>
        )}
        {pending.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pending.map((a) => (
              <span key={a.id} className="flex items-center gap-1.5 rounded border border-nebula-700 bg-nebula-850 px-2 py-1 text-xs text-slate-300">
                <Paperclip size={12} aria-hidden />
                {a.filename}
                <button
                  type="button"
                  aria-label={`Remove ${a.filename}`}
                  className="text-slate-500 hover:text-nebula-danger"
                  onClick={() => setPending((prev) => prev.filter((p) => p.id !== a.id))}
                >
                  <X size={12} aria-hidden />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-lg border border-nebula-700 bg-nebula-900 px-2 py-1.5 focus-within:border-nebula-accent">
          {canAttach && (
            <>
              <IconButton title="Attach a file" onClick={() => fileRef.current?.click()}>
                <Paperclip size={18} aria-hidden />
              </IconButton>
              <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => void onPickFile(e.target.files)} />
            </>
          )}
          <textarea
            className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent py-1 text-sm text-slate-100 placeholder-slate-500 outline-none disabled:opacity-50"
            rows={1}
            disabled={!canSend}
            placeholder={canSend ? (isDm ? `Message ${headerLabel}` : `Message #${channel.name}`) : "You cannot send messages here"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button
            type="submit"
            className="btn-primary px-2 py-1.5"
            disabled={sending || !canSend || (!draft.trim() && pending.length === 0)}
            aria-label="Send message"
          >
            <Send size={16} aria-hidden />
          </button>
        </div>
      </form>
      </div>
      {activeThreadId && <ThreadPanel />}
    </div>
  );
}
