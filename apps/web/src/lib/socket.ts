import { io, type Socket } from "socket.io-client";
import { applyRealtime } from "../store";

let socket: Socket | null = null;
let wired = false;

/**
 * Open the realtime channel. The server authenticates from the session cookie
 * during the handshake, so no token needs to be passed here.
 */
export function connectSocket(): Socket {
  if (socket) return socket;
  socket = io("/", {
    path: "/socket.io",
    withCredentials: true,
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    timeout: 10_000,
  });
  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
  wired = false;
}

export function getSocket(): Socket | null {
  return socket;
}

type SetState = Parameters<typeof applyRealtime>[0];
type GetState = Parameters<typeof applyRealtime>[1];

/** Wire realtime events into the store exactly once per connection. */
export function subscribe(set: SetState, get: GetState): void {
  const s = connectSocket();
  if (wired) return;
  wired = true;
  applyRealtime(set, get);
  s.on("connect", () => {
    // Re-sync after any reconnect: the gateway re-emits READY on IDENTIFY.
    s.emit("IDENTIFY");
  });
}
