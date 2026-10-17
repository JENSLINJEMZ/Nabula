import { io as createIoClient, type Socket as ClientSocket } from "socket.io-client";
import { createServer, type Server as HttpServer } from "node:http";
import { afterAll, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/http/app.js";
import { attachGateway, shutdownGateway } from "../src/realtime/gateway.js";
import { closePool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";
import { ensureStorageReady } from "../src/domain/storage.js";
import { ensureBuiltinCommands } from "../src/domain/slashCommands.js";

export interface TestContext {
  url: string;
  app: FastifyInstance;
  close: () => Promise<void>;
}

/**
 * Boot the real HTTP server (Fastify + Socket.IO gateway) on an ephemeral port
 * against the isolated test database. Tests therefore exercise the same routing,
 * auth, CSRF and permission code that production runs — not mocks.
 */
export async function startTestServer(): Promise<TestContext> {
  const app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });

  const httpServer = app.server ?? (await getHttpServer(app));
  const io = attachGateway(httpServer);

  const address = httpServer.address();
  if (address === null || typeof address === "string") throw new Error("Test server failed to bind a port");

  return {
    url: `http://127.0.0.1:${address.port}`,
    app,
    close: async () => {
      await shutdownGateway(io);
      await app.close();
    },
  };
}

/** Fastify exposes the underlying server only after listen in some versions. */
async function getHttpServer(app: FastifyInstance): Promise<HttpServer> {
  return (app as unknown as { server: HttpServer }).server;
}

export async function prepareDatabase(): Promise<void> {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://nebula:nebula@127.0.0.1:55432/nebula_test";
  await runMigrations();
  await ensureStorageReady();
  await ensureBuiltinCommands();
}

export async function teardownDatabase(): Promise<void> {
  await closePool().catch(() => undefined);
}

/** Shared lifecycle for a test file. */
export function useTestServer(): TestContext {
  let ctx: TestContext | null = null;
  beforeAll(async () => {
    await prepareDatabase();
    ctx = await startTestServer();
  });
  afterAll(async () => {
    await ctx?.close();
    await teardownDatabase();
  });
  return {
    get url() {
      if (!ctx) throw new Error("Test server not started");
      return ctx.url;
    },
    app: null as unknown as FastifyInstance,
    close: async () => ctx?.close(),
  } as unknown as TestContext;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

/**
 * A scripted HTTP client with a cookie jar and CSRF handling, so tests exercise
 * the exact browser-facing auth contract (session cookie + double-submit token).
 */
export class TestClient {
  readonly cookies = new Map<string, string>();
  csrfToken: string | null = null;
  userId: string | null = null;
  username: string | null = null;

  constructor(readonly baseUrl: string) {}

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private absorb(response: Response): void {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const cookie of raw) {
      const [pair] = cookie.split(";");
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || /Max-Age=0/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    options: { headers?: Record<string, string>; raw?: BodyInit; formData?: FormData } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      ...(this.cookieHeader() ? { cookie: this.cookieHeader() } : {}),
      ...options.headers,
    };

    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
    if (mutating && this.csrfToken) headers["x-csrf-token"] = this.csrfToken;

    let payload: BodyInit | undefined;
    if (options.formData) {
      payload = options.formData;
    } else if (options.raw !== undefined) {
      payload = options.raw;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }

    const response = await fetch(this.baseUrl + path, {
      method,
      headers,
      body: payload,
      redirect: "manual",
    });
    this.absorb(response);

    const text = await response.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, body: parsed as T, headers: response.headers };
  }

  get<T = unknown>(path: string, headers?: Record<string, string>) {
    return this.request<T>("GET", path, undefined, { headers });
  }
  post<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>("POST", path, body, { headers });
  }
  patch<T = unknown>(path: string, body?: unknown) {
    return this.request<T>("PATCH", path, body);
  }
  put<T = unknown>(path: string, body?: unknown) {
    return this.request<T>("PUT", path, body);
  }
  del<T = unknown>(path: string, body?: unknown) {
    return this.request<T>("DELETE", path, body);
  }
  upload<T = unknown>(path: string, file: { name: string; bytes: Uint8Array; type: string }) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
    return this.request<T>("POST", path, undefined, { formData: form });
  }

  /** Register a fresh account and capture the session cookie + CSRF token. */
  async register(prefix: string): Promise<{ userId: string; username: string }> {
    const username = `${prefix}_${Math.random().toString(36).slice(2, 9)}`.slice(0, 24);
    const password = `Str0ng-${Math.random().toString(36).slice(2, 10)}!a`;
    const res = await this.post<{ user: { id: string; username: string }; csrfToken: string }>(
      "/api/auth/register",
      { username, password },
    );
    if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
    this.csrfToken = res.body.csrfToken;
    this.userId = res.body.user.id;
    this.username = res.body.user.username;
    return { userId: this.userId, username: this.username };
  }

  async login(username: string, password: string) {
    const res = await this.post<{ user: { id: string }; csrfToken: string }>("/api/auth/login", {
      username,
      password,
    });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
    this.csrfToken = res.body.csrfToken;
    this.userId = res.body.user.id;
    return res.body.user;
  }

  /** Connect an authenticated Socket.IO client using this client's cookie jar. */
  async socket(timeoutMs = 8000): Promise<ClientSocket> {
    const socket = createIoClient(this.baseUrl, {
      path: "/socket.io",
      transports: ["websocket"],
      extraHeaders: { cookie: this.cookieHeader() },
      reconnection: false,
      timeout: timeoutMs,
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket connect timeout")), timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("connect_error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    return socket;
  }
}

/** Wait for a specific event, optionally filtering by predicate. */
export function waitFor<T = unknown>(
  socket: ClientSocket,
  event: string,
  predicate: (payload: T) => boolean = () => true,
  timeoutMs = 8000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);

    function handler(payload: T) {
      try {
        if (!predicate(payload)) return;
      } catch {
        return;
      }
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }

    socket.on(event, handler);
  });
}

/** Wait for one of several events. */
export function waitForAny(
  socket: ClientSocket,
  events: string[],
  timeoutMs = 8000,
): Promise<{ event: string; payload: unknown }> {
  return new Promise((resolve, reject) => {
    const handlers: Array<() => void> = [];
    const cleanup = () => handlers.forEach((fn) => fn());
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for any of ${events.join(", ")}`));
    }, timeoutMs);

    for (const event of events) {
      const handler = (payload: unknown) => {
        clearTimeout(timer);
        cleanup();
        resolve({ event, payload });
      };
      socket.on(event, handler);
      handlers.push(() => socket.off(event, handler));
    }
  });
}

export { createServer };
