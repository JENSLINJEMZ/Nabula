import { useEffect, useState } from "react";
import { LogOut, ShieldAlert } from "lucide-react";
import type { NotificationSettings, UserSettings } from "@nebula/shared";
import { useApp } from "../store";
import { apiDelete, apiGet, apiPost } from "../lib/api";
import { cx, displayName } from "../lib/ui";
import { Avatar, Switch } from "./primitives";
import { AccountSecurityTab } from "./AccountSecurity";

interface SessionInfo {
  id: string;
  clientName: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

const PRESENCE_OPTIONS = [
  { value: "online", label: "Online" },
  { value: "idle", label: "Idle" },
  { value: "dnd", label: "Do Not Disturb" },
  { value: "invisible", label: "Invisible" },
];

const TABS = ["account", "security", "profile", "appearance", "notifications", "sessions"] as const;
type TabId = (typeof TABS)[number];

export function Settings({ onClose }: { onClose: () => void }) {
  const me = useApp((s) => s.me);
  const logout = useApp((s) => s.logout);
  const updateProfile = useApp((s) => s.updateProfile);
  const setPresence = useApp((s) => s.setPresence);
  const settings = useApp((s) => s.settings);
  const loadSettings = useApp((s) => s.loadSettings);
  const updateSettings = useApp((s) => s.updateSettings);
  const notificationSettings = useApp((s) => s.notificationSettings);
  const loadNotificationSettings = useApp((s) => s.loadNotificationSettings);
  const updateNotificationSettings = useApp((s) => s.updateNotificationSettings);

  const [tab, setTab] = useState<TabId>("account");
  const [displayNameValue, setDisplayNameValue] = useState(me?.displayName ?? "");
  const [bio, setBio] = useState(me?.bio ?? "");
  const [status, setStatus] = useState("online");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void loadSettings().catch(() => undefined);
    void loadNotificationSettings().catch(() => undefined);
    void apiGet<{ sessions: SessionInfo[] }>("/api/auth/sessions")
      .then((r) => setSessions(r.sessions))
      .catch(() => undefined);
  }, [loadSettings, loadNotificationSettings]);

  useEffect(() => {
    if (me) {
      setDisplayNameValue(me.displayName ?? "");
      setBio(me.bio ?? "");
    }
  }, [me]);

  useEffect(() => {
    if (!settings) return;
    document.documentElement.style.fontSize = `${16 * settings.fontScale}px`;
    document.documentElement.classList.toggle("reduce-motion", settings.reducedMotion);
  }, [settings]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!me) return null;

  function flashSaved() {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const appearance: UserSettings = settings ?? {
    theme: "dark",
    messageDisplay: "cozy",
    reducedMotion: false,
    fontScale: 1,
    locale: "en",
  };
  const notifs: NotificationSettings = notificationSettings ?? {
    desktop: true,
    sounds: true,
    suppressEveryone: false,
    suppressRoles: false,
    suppressFromOthers: false,
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="User settings" className="flex max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-xl border border-nebula-700 bg-nebula-900 shadow-2xl">
        <nav className="w-48 shrink-0 space-y-0.5 border-r border-nebula-800 p-4" aria-label="Settings sections">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cx(
                "w-full rounded px-3 py-1.5 text-left text-sm capitalize",
                tab === t ? "bg-nebula-800 text-slate-100" : "text-slate-400 hover:bg-white/5 hover:text-slate-200",
              )}
            >
              {t === "account" ? "My account" : t}
            </button>
          ))}
          <button
            type="button"
            className="mt-2 flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm text-nebula-danger hover:bg-nebula-danger/10"
            onClick={() => void logout()}
          >
            <LogOut size={15} aria-hidden /> Log out
          </button>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-nebula-800 px-5">
            <h2 className="font-semibold capitalize text-slate-100">{tab === "account" ? "My account" : tab}</h2>
            <button type="button" className="text-sm text-slate-400 hover:text-slate-200" onClick={onClose}>
              Esc
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {tab === "account" && (
              <div className="space-y-5">
                <div className="flex items-center gap-4">
                  <Avatar user={me} size={64} />
                  <div>
                    <p className="font-semibold text-slate-100">{displayName(me)}</p>
                    <p className="text-sm text-slate-500">@{me.username}</p>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">Status</label>
                  <select
                    className="input"
                    value={status}
                    onChange={(e) => {
                      setStatus(e.target.value);
                      void setPresence(e.target.value);
                    }}
                  >
                    {PRESENCE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="rounded-md border border-nebula-800 p-3 text-sm text-slate-400">
                  <p className="flex items-center gap-2 text-slate-300">
                    <ShieldAlert size={15} aria-hidden /> Security
                  </p>
                  <p className="mt-1 text-xs">
                    Manage your password, email verification and two-factor authentication under the Security tab.
                  </p>
                </div>
              </div>
            )}

            {tab === "security" && <AccountSecurityTab />}

            {tab === "profile" && (
              <div className="space-y-5">
                <div className="flex items-center gap-4">
                  <Avatar user={me} size={64} />
                  <p className="text-sm text-slate-400">Your avatar is generated from your account.</p>
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">Display name</label>
                  <input className="input" value={displayNameValue} onChange={(e) => setDisplayNameValue(e.target.value)} placeholder={me.username} />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">About me</label>
                  <textarea className="input min-h-24" value={bio} maxLength={190} onChange={(e) => setBio(e.target.value)} />
                </div>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={async () => {
                      await updateProfile({ displayName: displayNameValue.trim() || null, bio: bio.trim() || null });
                      flashSaved();
                    }}
                  >
                    Save changes
                  </button>
                  {saved && <span className="text-sm text-nebula-accent2">Saved</span>}
                </div>
              </div>
            )}

            {tab === "appearance" && (
              <div className="space-y-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-slate-200">Reduced motion</p>
                    <p className="text-xs text-slate-500">Minimise animations across the app.</p>
                  </div>
                  <Switch label="Reduced motion" checked={appearance.reducedMotion} onChange={(v) => void updateSettings({ reducedMotion: v })} />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">Font scale</label>
                  <input
                    type="range"
                    min={0.85}
                    max={1.3}
                    step={0.05}
                    value={appearance.fontScale}
                    onChange={(e) => void updateSettings({ fontScale: Number(e.target.value) })}
                    className="w-full"
                  />
                  <p className="text-xs text-slate-500">{Math.round(appearance.fontScale * 100)}%</p>
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">Message display</label>
                  <select className="input" value={appearance.messageDisplay} onChange={(e) => void updateSettings({ messageDisplay: e.target.value as UserSettings["messageDisplay"] })}>
                    <option value="cozy">Cozy</option>
                    <option value="compact">Compact</option>
                  </select>
                </div>
              </div>
            )}

            {tab === "notifications" && (
              <div className="space-y-4">
                {(
                  [
                    ["desktop", "Desktop notifications", "Show a notification for mentions and DMs."],
                    ["sounds", "Notification sounds", "Play a sound when a notification arrives."],
                    ["suppressEveryone", "Suppress @everyone and @here", "Do not notify for mass mentions."],
                    ["suppressRoles", "Suppress role mentions", "Do not notify when a role you hold is mentioned."],
                    ["suppressFromOthers", "Suppress DMs from non-friends", "Ignore direct messages from people you have not added."],
                  ] as const
                ).map(([key, title, desc]) => (
                  <div key={key} className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm text-slate-200">{title}</p>
                      <p className="text-xs text-slate-500">{desc}</p>
                    </div>
                    <Switch label={title} checked={notifs[key]} onChange={(v) => void updateNotificationSettings({ [key]: v })} />
                  </div>
                ))}
              </div>
            )}

            {tab === "sessions" && (
              <div className="space-y-4">
                <p className="text-sm text-slate-400">You are signed in on the following devices.</p>
                <ul className="space-y-1">
                  {sessions.map((s) => (
                    <li key={s.id} className="flex items-center gap-3 rounded border border-nebula-800 px-3 py-2 text-sm">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-slate-200">
                          {s.clientName || "Web"} {s.current && <span className="ml-1 rounded bg-nebula-accent2/20 px-1 text-[10px] uppercase text-nebula-accent2">this device</span>}
                        </span>
                        <span className="block truncate text-xs text-slate-500">
                          {s.ip ?? "unknown IP"} · last active {new Date(s.lastSeenAt).toLocaleString()}
                        </span>
                      </span>
                      {!s.current && (
                        <button
                          type="button"
                          className="text-xs text-nebula-danger hover:underline"
                          onClick={async () => {
                            await apiDelete(`/api/auth/sessions/${s.id}`);
                            setSessions((prev) => prev.filter((x) => x.id !== s.id));
                          }}
                        >
                          Revoke
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="btn-ghost text-sm text-nebula-danger"
                  onClick={async () => {
                    await apiPost("/api/auth/logout-all");
                    await logout();
                  }}
                >
                  Log out of all devices
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
