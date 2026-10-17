/**
 * WebRTC mesh manager for voice channels.
 *
 * The server relays signaling only (VOICE_SIGNAL); media flows peer-to-peer.
 * For N participants this is a full mesh (N-1 connections) — correct for small
 * channels, and the documented scaling path is an SFU. See docs/SYSTEM_ARCHITECTURE.md.
 */
import { getSocket } from "./socket";

export interface VoicePeer {
  userId: string;
  stream: MediaStream;
}

const DEFAULT_ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

function iceServers(): RTCIceServer[] {
  const raw = import.meta.env.VITE_ICE_SERVERS as string | undefined;
  if (!raw) return DEFAULT_ICE;
  try {
    const parsed = JSON.parse(raw) as RTCIceServer[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_ICE;
  } catch {
    return DEFAULT_ICE;
  }
}

type PeerListener = (peers: VoicePeer[]) => void;

export class VoiceMesh {
  private local: MediaStream | null = null;
  private readonly peers = new Map<string, RTCPeerConnection>();
  private readonly remoteStreams = new Map<string, MediaStream>();
  private readonly listeners = new Set<PeerListener>();
  private socket = getSocket();
  private selfId: string;
  private channelId: string;
  private signalHandler: ((payload: unknown) => void) | null = null;

  constructor(selfId: string, channelId: string) {
    this.selfId = selfId;
    this.channelId = channelId;
  }

  onPeers(listener: PeerListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  private snapshot(): VoicePeer[] {
    return [...this.remoteStreams.entries()]
      .filter(([, stream]) => stream.getTracks().length > 0)
      .map(([userId, stream]) => ({ userId, stream }));
  }

  private emitPeers(): void {
    const snap = this.snapshot();
    for (const listener of this.listeners) listener(snap);
  }

  /** Acquire the microphone and begin signalling with existing participants. */
  async connect(existingUserIds: string[]): Promise<MediaStream> {
    this.local = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.attachSignalling();
    for (const userId of existingUserIds) {
      if (userId !== this.selfId) await this.createOffer(userId);
    }
    return this.local;
  }

  private attachSignalling(): void {
    const socket = this.socket ?? getSocket();
    this.socket = socket;
    if (!socket) return;
    this.signalHandler = (raw: unknown) => {
      const payload = raw as { fromUserId?: string; kind?: string; payload?: unknown; channelId?: string };
      if (!payload || payload.channelId !== this.channelId || !payload.fromUserId) return;
      if (payload.fromUserId === this.selfId) return;
      void this.onSignal(payload.fromUserId, payload.kind ?? "", payload.payload);
    };
    socket.on("VOICE_SIGNAL", this.signalHandler);
  }

  private sendSignal(toUserId: string, kind: string, payload: unknown): void {
    this.socket?.emit("VOICE_SIGNAL", { channelId: this.channelId, toUserId, kind, payload });
  }

  private getPeer(userId: string): RTCPeerConnection {
    const existing = this.peers.get(userId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    this.peers.set(userId, pc);

    for (const track of this.local?.getTracks() ?? []) pc.addTrack(track, this.local as MediaStream);

    pc.onicecandidate = (event) => {
      if (event.candidate) this.sendSignal(userId, "candidate", event.candidate.toJSON());
    };
    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) {
        this.remoteStreams.set(userId, stream);
        this.emitPeers();
      }
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        this.remoteStreams.delete(userId);
        this.emitPeers();
      }
    };
    return pc;
  }

  async createOffer(userId: string): Promise<void> {
    const pc = this.getPeer(userId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.sendSignal(userId, "offer", offer);
  }

  private async onSignal(fromUserId: string, kind: string, payload: unknown): Promise<void> {
    const pc = this.getPeer(fromUserId);
    try {
      if (kind === "offer") {
        await pc.setRemoteDescription(payload as RTCSessionDescriptionInit);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.sendSignal(fromUserId, "answer", answer);
      } else if (kind === "answer") {
        await pc.setRemoteDescription(payload as RTCSessionDescriptionInit);
      } else if (kind === "candidate") {
        await pc.addIceCandidate(payload as RTCIceCandidateInit);
      }
    } catch {
      // A failed renegotiation should not tear down the whole session.
    }
  }

  setMuted(muted: boolean): void {
    for (const track of this.local?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  dispose(): void {
    const socket = this.socket ?? getSocket();
    if (socket && this.signalHandler) socket.off("VOICE_SIGNAL", this.signalHandler);
    this.signalHandler = null;
    for (const pc of this.peers.values()) pc.close();
    this.peers.clear();
    this.remoteStreams.clear();
    for (const track of this.local?.getTracks() ?? []) track.stop();
    this.local = null;
    this.listeners.clear();
  }
}
