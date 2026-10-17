import { useEffect, useRef, useState } from "react";
import { Headphones, Mic, MicOff, PhoneOff, Volume2 } from "lucide-react";
import { useApp } from "../store";
import { VoiceMesh, type VoicePeer } from "../lib/voice";
import { avatarColor, memberName } from "../lib/ui";

function PeerTile({ peer, name }: { peer: VoicePeer; name: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const el = audioRef.current;
    if (el && el.srcObject !== peer.stream) {
      el.srcObject = peer.stream;
      void el.play().catch(() => {
        // Autoplay may be blocked until the first user gesture; the join click covers this.
      });
    }
  }, [peer.stream]);

  return (
    <div className="flex items-center gap-2 rounded-md bg-nebula-850 px-2 py-1.5">
      <div
        className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold text-white"
        style={{ backgroundColor: avatarColor(peer.userId) }}
        aria-hidden
      >
        {name.slice(0, 2).toUpperCase()}
      </div>
      <span className="min-w-0 flex-1 truncate text-xs text-slate-200">{name}</span>
      <Volume2 size={14} className="text-nebula-accent2" aria-hidden />
      <audio ref={audioRef} autoPlay />
    </div>
  );
}

export function VoicePanel() {
  const selfVoice = useApp((s) => s.selfVoice);
  const me = useApp((s) => s.me);
  const voiceStates = useApp((s) => s.voiceStates);
  const membersByGuild = useApp((s) => s.membersByGuild);
  const activeGuildId = useApp((s) => s.activeGuildId);
  const leaveVoice = useApp((s) => s.leaveVoice);
  const toggleMute = useApp((s) => s.toggleMute);
  const toggleDeaf = useApp((s) => s.toggleDeaf);

  const [peers, setPeers] = useState<VoicePeer[]>([]);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const meshRef = useRef<VoiceMesh | null>(null);

  const channelId = selfVoice?.channelId ?? null;

  useEffect(() => {
    if (!channelId || !me) {
      meshRef.current?.dispose();
      meshRef.current = null;
      setPeers([]);
      return;
    }

    const existing = voiceStates.filter((v) => v.channelId === channelId && v.userId !== me.id).map((v) => v.userId);
    const mesh = new VoiceMesh(me.id, channelId);
    meshRef.current = mesh;
    const unsubscribe = mesh.onPeers(setPeers);

    mesh
      .connect(existing)
      .then(() => setMediaError(null))
      .catch((err: unknown) => {
        setMediaError(err instanceof Error ? err.message : "Microphone access was denied.");
      });

    return () => {
      unsubscribe();
      mesh.dispose();
      meshRef.current = null;
    };
    // Re-run only when the channel or self changes; peer list is handled by VOICE_SIGNAL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, me?.id]);

  useEffect(() => {
    meshRef.current?.setMuted(selfVoice?.selfMute ?? false);
  }, [selfVoice?.selfMute]);

  if (!selfVoice || !channelId) return null;

  const guildMembers = activeGuildId ? membersByGuild[activeGuildId] ?? [] : [];
  const nameFor = (userId: string) => {
    if (userId === me?.id) return "You";
    const found = guildMembers.find((m) => m.userId === userId);
    return found ? memberName(found) : userId.slice(-4);
  };

  const others = voiceStates.filter((v) => v.channelId === channelId && v.userId !== me?.id);

  return (
    <section className="border-t border-nebula-800 bg-nebula-900/60 p-2" aria-label="Voice connection">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-nebula-accent2">Voice connected</span>
        <button
          type="button"
          title="Disconnect"
          className="rounded p-1 text-slate-400 hover:bg-nebula-danger/10 hover:text-nebula-danger"
          onClick={() => void leaveVoice()}
        >
          <PhoneOff size={14} aria-hidden />
        </button>
      </div>

      {mediaError && <p className="px-1 pb-1.5 text-[11px] text-nebula-warn">{mediaError}</p>}

      <div className="space-y-1">
        <div className="flex items-center gap-2 rounded-md bg-nebula-800/70 px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-slate-200">{nameFor(me?.id ?? "")}</span>
          {selfVoice.selfMute ? <MicOff size={14} className="text-nebula-danger" aria-hidden /> : <Mic size={14} className="text-slate-400" aria-hidden />}
        </div>
        {peers.map((peer) => (
          <PeerTile key={peer.userId} peer={peer} name={nameFor(peer.userId)} />
        ))}
        {others
          .filter((o) => !peers.some((p) => p.userId === o.userId))
          .map((o) => (
            <div key={o.userId} className="flex items-center gap-2 rounded-md bg-nebula-850 px-2 py-1.5 opacity-70">
              <span className="min-w-0 flex-1 truncate text-xs text-slate-300">{nameFor(o.userId)}</span>
              <span className="text-[10px] text-slate-500">connecting…</span>
            </div>
          ))}
      </div>

      <div className="mt-2 flex gap-1">
        <button
          type="button"
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs ${
            selfVoice.selfMute ? "bg-nebula-danger/15 text-nebula-danger" : "bg-nebula-800 text-slate-300 hover:bg-nebula-700"
          }`}
          onClick={() => void toggleMute()}
          aria-pressed={selfVoice.selfMute}
        >
          {selfVoice.selfMute ? <MicOff size={14} aria-hidden /> : <Mic size={14} aria-hidden />}
          {selfVoice.selfMute ? "Unmute" : "Mute"}
        </button>
        <button
          type="button"
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs ${
            selfVoice.selfDeaf ? "bg-nebula-danger/15 text-nebula-danger" : "bg-nebula-800 text-slate-300 hover:bg-nebula-700"
          }`}
          onClick={() => void toggleDeaf()}
          aria-pressed={selfVoice.selfDeaf}
        >
          <Headphones size={14} aria-hidden />
          {selfVoice.selfDeaf ? "Undeafen" : "Deafen"}
        </button>
      </div>
    </section>
  );
}
