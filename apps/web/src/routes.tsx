import { useEffect, useRef } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { ChatShell } from "./components/Chat";
import { ApiError } from "./lib/api";
import { LAST_CHANNEL_KEY, LAST_DM_KEY, LAST_GUILD_KEY, setRouterNavigator, useApp } from "./store";

/**
 * Registers the store's navigation bridge with React Router so that store
 * actions (selectGuild / selectChannel / selectDm) can update the URL.
 *
 * Pushing the URL the app is already on would create a duplicate history entry
 * and truncate the forward stack (breaking browser Back/Forward), so identical
 * navigations are ignored.
 */
function NavigationBridge() {
  const navigate = useNavigate();
  const location = useLocation();
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;
  useEffect(() => {
    setRouterNavigator((path) => {
      // Skip navigation when the target equals the current path so repeated
      // store-driven calls don't push duplicate history entries (which breaks
      // Back/Forward). The URL is the source of truth; useRouteSync syncs
      // state to it without ever navigating back (silent), preventing loops.
      if (path === pathRef.current) return;
      navigate(path);
    });
    return () => setRouterNavigator(null);
  }, [navigate]);
  return null;
}

type RouteTarget = { home?: boolean; guildId?: string; channelId?: string; dmId?: string; threadId?: string };

/**
 * URL is the single source of truth for the active location. On every URL
 * change we reconcile the store with the URL target. We read store state
 * imperatively (useApp.getState()) so that store updates made by our own
 * actions do not re-trigger this effect (which would create a feedback loop).
 */
function useRouteSync(target: RouteTarget) {
  const { home, guildId, channelId, dmId, threadId } = target;
  const navigate = useNavigate();

  useEffect(() => {
    void (async () => {
      const state = useApp.getState();
      try {
        if (home) {
          if (state.activeGuildId || state.activeChannelId || state.activeDmId)
            await state.selectGuild(null, { silent: true });
          return;
        }
        if (dmId) {
          if (state.activeDmId !== dmId) await state.selectDm(dmId, { silent: true });
          return;
        }
        if (guildId && channelId) {
          let fresh = useApp.getState();
          if (fresh.activeGuildId !== guildId) await fresh.selectGuild(guildId, { channelId, silent: true });
          fresh = useApp.getState();
          if (fresh.activeChannelId !== channelId) await fresh.selectChannel(channelId, { silent: true });
          if (threadId) {
            fresh = useApp.getState();
            if (fresh.activeThreadId !== threadId) await fresh.openThread(threadId, { silent: true });
          }
          return;
        }
        if (guildId) {
          const fresh = useApp.getState();
          if (fresh.activeGuildId !== guildId) await fresh.selectGuild(guildId, { silent: true });
        }
      } catch (error) {
        // A definitive "not found / not allowed" deep link goes home. Transient
        // failures (rate limiting, 5xx, network) must not destroy the deep
        // link: the URL is kept and a reload retries the restore.
        if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) {
          navigate("/channels/@me", { replace: true });
        }
      }
    })();
  }, [home, guildId, channelId, dmId, threadId, navigate]);
}

function HomeRoute() {
  useRouteSync({ home: true });
  return <ChatShell />;
}

function DmRoute() {
  const { dmId } = useParams<{ dmId: string }>();
  useRouteSync({ dmId });
  return <ChatShell />;
}

function GuildChannelRoute() {
  const { guildId, channelId } = useParams<{ guildId: string; channelId: string }>();
  useRouteSync({ guildId, channelId });
  return <ChatShell />;
}

function ThreadRoute() {
  const { guildId, channelId, threadId } = useParams<{ guildId: string; channelId: string; threadId: string }>();
  useRouteSync({ guildId, channelId, threadId });
  return <ChatShell />;
}

function GuildRoute() {
  const { guildId } = useParams<{ guildId: string }>();
  useRouteSync({ guildId });
  return <ChatShell />;
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** `/` redirects to the user's last viewed location (or the friends home). */
function LastViewRedirect() {
  const lastGuild = readStored(LAST_GUILD_KEY);
  const lastChannel = readStored(LAST_CHANNEL_KEY);
  const lastDm = readStored(LAST_DM_KEY);
  let to = "/channels/@me";
  if (lastGuild && lastChannel) to = `/channels/${lastGuild}/${lastChannel}`;
  else if (lastDm) to = `/channels/@me/${lastDm}`;
  return <Navigate to={to} replace />;
}

function NotFound() {
  const me = useApp((s) => s.me);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-nebula-950 px-6 text-center">
      <div className="text-5xl font-black text-nebula-accent">404</div>
      <h1 className="text-lg font-semibold text-slate-100">This page drifted out of orbit</h1>
      <p className="max-w-sm text-sm text-slate-400">
        The link you followed doesn&apos;t point to a channel, direct message or view in Nebula.
      </p>
      <Link
        to={me ? "/channels/@me" : "/"}
        className="rounded bg-nebula-accent px-4 py-2 text-sm font-semibold text-white hover:bg-nebula-500"
      >
        {me ? "Back to Nebula" : "Go to sign in"}
      </Link>
    </div>
  );
}

export function AppRoutes() {
  return (
    <>
      <NavigationBridge />
      <Routes>
        <Route path="/" element={<LastViewRedirect />} />
        <Route path="/channels/@me" element={<HomeRoute />} />
        <Route path="/channels/@me/:dmId" element={<DmRoute />} />
        <Route path="/channels/:guildId/:channelId/threads/:threadId" element={<ThreadRoute />} />
        <Route path="/channels/:guildId/:channelId" element={<GuildChannelRoute />} />
        <Route path="/channels/:guildId" element={<GuildRoute />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </>
  );
}
