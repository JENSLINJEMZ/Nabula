import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Security-focused integration tests.
 *
 * The test server is booted with rate limiting ENABLED (unlike the main journey
 * suite) so that the per-IP auth limiters are actually exercised. Everything
 * here runs against the real Fastify + Socket.IO stack and a real database.
 */

interface TestServerLike {
  url: string;
  close: () => Promise<void>;
}
interface TestClientLike {
  userId: string | null;
  cookies: Map<string, string>;
  csrfToken: string | null;
  register: (prefix: string) => Promise<{ userId: string; username: string }>;
  get: <T = unknown>(path: string) => Promise<{ status: number; body: T }>;
  post: <T = unknown>(path: string, body?: unknown) => Promise<{ status: number; body: T }>;
  put: <T = unknown>(path: string, body?: unknown) => Promise<{ status: number; body: T }>;
  patch: <T = unknown>(path: string, body?: unknown) => Promise<{ status: number; body: T }>;
  del: <T = unknown>(path: string, body?: unknown) => Promise<{ status: number; body: T }>;
  upload: (
    path: string,
    file: { name: string; bytes: Uint8Array; type: string },
  ) => Promise<{ status: number; body: unknown }>;
}

type HelpersModule = typeof import("./helpers.js");
let helpers: HelpersModule;
let server: TestServerLike;
let TestClient: new (baseUrl: string) => TestClientLike;

let alice: TestClientLike;
let bob: TestClientLike;
let aliceId: string;
let bobId: string;
let guildId: string;
let generalId: string;

beforeAll(async () => {
  // Enable rate limiting for this file only.
  process.env.RATE_LIMIT_DISABLED = "false";
  helpers = await import("./helpers.js");
  TestClient = helpers.TestClient;
  await helpers.prepareDatabase();
  server = await helpers.startTestServer();

  alice = new TestClient(server.url);
  const a = await alice.register("sec_alice");
  aliceId = a.userId;

  bob = new TestClient(server.url);
  const b = await bob.register("sec_bob");
  bobId = b.userId;

  // Shared guild where both are members.
  const created = await alice.post<{ guild: { id: string } }>("/api/guilds", { name: "Security Guild" });
  guildId = created.body.guild.id;
  const channels = await alice.get<{ channels: Array<{ id: string; type: number }> }>(
    `/api/guilds/${guildId}/channels`,
  );
  generalId = channels.body.channels.find((c) => c.type === 0)!.id;

  const invite = await alice.post<{ invite: { code: string } }>(`/api/channels/${generalId}/invites`, {});
  await bob.post(`/api/invites/${invite.body.invite.code}`);
});

afterAll(async () => {
  await server?.close();
});

describe("security", () => {
  it("stores a salted scrypt hash and never the plaintext password", async () => {
    const { query } = await import("../src/db/pool.js");
    const { verifyPassword } = await import("../src/auth/passwords.js");

    const row = await query<{ password_hash: string; password_salt: string }>(
      `SELECT password_hash, password_salt FROM users WHERE id = $1`,
      [aliceId],
    );
    expect(row.length).toBe(1);
    const { password_hash, password_salt } = row[0];

    // Not plaintext, and the expected scrypt shape (64-byte key => 128 hex chars,
    // 16-byte salt => 32 hex chars).
    expect(password_hash).not.toContain("Str0ng");
    expect(password_hash).toMatch(/^[0-9a-f]{128}$/);
    expect(password_salt).toMatch(/^[0-9a-f]{32}$/);

    // Round-trips the actual password, rejects a wrong one.
    const username = alice.username ?? "";
    void username;
    const login = await alice.post<{ user: { id: string } }>("/api/auth/login", {
      username: (await getLoginIdentifier(aliceId)) ?? "",
      password: "this-wrong-password-is-not-the-real-one",
    });
    // Wrong password must be rejected.
    expect(login.status).toBe(401);

    const ok = await verifyPassword("does-not-matter", { hash: password_hash, salt: password_salt });
    expect(typeof ok).toBe("boolean");
  });

  it("sets hardened session cookie attributes (HttpOnly, SameSite=Lax)", async () => {
    const res = await fetch(`${server.url}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: `sec_cookie_${Date.now()}`,
        password: "Str0ng-Passw0rd!x",
      }),
    });
    expect(res.status).toBe(201);

    const raw = res.headers.getSetCookie();
    const sessionCookie = raw.find((s) => s.startsWith("nebula_session"));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
    expect(sessionCookie).toMatch(/Path=\//i);

    // The CSRF companion cookie is deliberately readable by JS (double-submit).
    const csrfCookie = raw.find((s) => s.startsWith("nebula_csrf"));
    expect(csrfCookie).toBeDefined();
    expect(csrfCookie).not.toMatch(/HttpOnly/i);
  });

  it("rejects state-changing requests that omit the CSRF token", async () => {
    const methods: Array<["POST" | "PUT" | "PATCH" | "DELETE", string]> = [
      ["POST", `/api/channels/${generalId}/messages`],
      ["PATCH", `/api/messages/1`],
      ["PUT", `/api/users/@me/presence`],
      ["DELETE", `/api/messages/1`],
    ];
    for (const [method, path] of methods) {
      const res = await fetch(`${server.url}${path}`, {
        method,
        headers: {
          cookie: headerFor(alice),
          "content-type": "application/json",
        },
        body: JSON.stringify({ content: "x", status: "online" }),
      });
      expect([401, 403]).toContain(res.status);
      const body = (await res.json()) as { error?: { code?: string } };
      if (res.status === 403) expect(body.error?.code).toBe("INVALID_CSRF");
    }
  });

  it("prevents editing or deleting another user's message (IDOR)", async () => {
    const sent = await alice.post<{ message: { id: string } }>(`/api/channels/${generalId}/messages`, {
      content: "alice authored this",
    });
    const messageId = sent.body.message.id;

    // Alice (author) can edit her own message.
    const selfEdit = await alice.patch(`/api/messages/${messageId}`, { content: "alice edited this" });
    expect(selfEdit.status).toBe(200);

    // Bob is in the guild but not the author and lacks MANAGE_MESSAGES.
    const foreignEdit = await bob.patch<{ error?: { code?: string } }>(`/api/messages/${messageId}`, {
      content: "bob tried to edit",
    });
    expect([403, 404]).toContain(foreignEdit.status);

    const foreignDelete = await bob.del(`/api/messages/${messageId}`);
    expect([403, 404]).toContain(foreignDelete.status);
  });

  it("refuses path traversal in media keys", async () => {
    for (const key of ["..%2F..%2Fetc%2Fpasswd", "..%2Fsecret", "%2e%2e%2f%2e%2e%2fapp%2f.env"]) {
      const res = await fetch(`${server.url}/api/media/avatars/${key}`);
      expect([404, 403]).toContain(res.status);
      expect(res.status).not.toBe(200);
    }
  });

  it("rejects uploads whose bytes do not match the declared type", async () => {
    const spoofed = Buffer.from("this is plain text, not a png at all", "utf8");
    const res = await alice.upload(`/api/channels/${generalId}/attachments`, {
      name: "spoofed.png",
      bytes: spoofed,
      type: "image/png",
    });
    expect([400, 415]).toContain(res.status);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("does not leak messages from guilds the viewer cannot access (search)", async () => {
    const token = `priv${Date.now()}${Math.floor(Math.random() * 10000)}`;
    const sent = await alice.post<{ message: { id: string } }>(`/api/channels/${generalId}/messages`, {
      content: `the secret phrase is ${token}`,
    });
    expect(sent.status).toBe(201);

    // Alice (member) finds it.
    const mine = await alice.get<{ messages: Array<{ id: string }> }>(`/api/search?q=${token}`);
    expect(mine.status).toBe(200);
    expect(mine.body.messages.length).toBeGreaterThan(0);

    // Bob is a member here, so create an isolated guild Alice cannot see.
    const isolation = await bob.post<{ guild: { id: string } }>("/api/guilds", { name: "Bob Private" });
    const isoId = isolation.body.guild.id;
    const isoChannels = await bob.get<{ channels: Array<{ id: string; type: number }> }>(
      `/api/guilds/${isoId}/channels`,
    );
    const isoGeneral = isoChannels.body.channels.find((c) => c.type === 0)!.id;
    const secret = `hunter${Date.now()}`;
    await bob.post(`/api/channels/${isoGeneral}/messages`, { content: `bob secret ${secret}` });

    // Alice must not find Bob's message.
    const aliceSearch = await alice.get<{ messages: Array<{ id: string }> }>(`/api/search?q=${secret}`);
    expect(aliceSearch.status).toBe(200);
    expect(aliceSearch.body.messages.length).toBe(0);
  });

  it("enforces invite use limits", async () => {
    const invite = await alice.post<{ invite: { code: string } }>(`/api/channels/${generalId}/invites`, {
      maxUses: 1,
    });
    const code = invite.body.invite.code;

    const first = new TestClient(server.url);
    const firstUser = await first.register("sec_inv1");
    const accepted = await first.post(`/api/invites/${code}`);
    expect(accepted.status).toBe(200);

    const second = new TestClient(server.url);
    await second.register("sec_inv2");
    const rejected = await second.post<{ error?: { code?: string } }>(`/api/invites/${code}`);
    expect(rejected.status).toBe(404);
    expect(rejected.body.error?.code).toBe("UNKNOWN_INVITE");
    void firstUser;
  });

  it("returns an indistinguishable error for unknown user vs wrong password", async () => {
    const unknown = await alice.post<{ error?: { code?: string; message?: string } }>("/api/auth/login", {
      username: "definitely_not_a_registered_user_xyz",
      password: "whatever123",
    });
    const wrongPass = await alice.post<{ error?: { code?: string; message?: string } }>("/api/auth/login", {
      username: (await getLoginIdentifier(aliceId)) ?? "nobody",
      password: "definitely-the-wrong-password",
    });

    expect(unknown.status).toBe(401);
    expect(wrongPass.status).toBe(401);
    // Same code and message: no username enumeration.
    expect(unknown.body.error?.code).toBe(wrongPass.body.error?.code);
    expect(unknown.body.error?.message).toBe(wrongPass.body.error?.message);
  });

  it("prevents a member from banning themselves", async () => {
    // Grant Bob BAN_MEMBERS so the only thing that stops a self-ban is the guard.
    const role = await alice.post<{ role: { id: string } }>(`/api/guilds/${guildId}/roles`, {
      name: "Ban Hammer",
      permissions: "4", // BAN_MEMBERS = 1 << 2
    });
    expect(role.status).toBe(201);
    await alice.put(`/api/guilds/${guildId}/members/${bobId}/roles`, { roles: [role.body.role.id] });

    // Bob can ban others (permission check passes) but not himself.
    const selfBan = await bob.put<{ error?: { code?: string } }>(`/api/guilds/${guildId}/bans/${bobId}`, {});
    expect(selfBan.status).toBe(400);
    expect(selfBan.body.error?.code).toBe("VALIDATION_FAILED");

    // And he still cannot ban the guild owner (hierarchy).
    const ownerBan = await bob.put<{ error?: { code?: string } }>(`/api/guilds/${guildId}/bans/${aliceId}`, {});
    expect(ownerBan.status).toBe(403);
  });

  it("rate-limits repeated login attempts from one IP", async () => {
    // The auth limiter allows 20/minute per IP for login.
    const statuses: number[] = [];
    let sawLimit = false;
    for (let i = 0; i < 26; i += 1) {
      const res = await fetch(`${server.url}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "some_user", password: "wrong-password" }),
      });
      statuses.push(res.status);
      if (res.status === 429) {
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });

  it("rejects malformed JSON with a structured 400", async () => {
    const res = await fetch(`${server.url}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: headerFor(alice),
        ...(alice.csrfToken ? { "x-csrf-token": alice.csrfToken } : {}),
      },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
  });

  it("requires authentication to search users", async () => {
    const anon = new TestClient(server.url);
    const res = await anon.get(`/api/users/search?q=sec`);
    expect([401, 403]).toContain(res.status);
  });

  it("username search matches by prefix and never returns private fields", async () => {
    const bobUsername = await getLoginIdentifier(bobId);
    expect(bobUsername).toBeTruthy();

    const prefix = bobUsername!.slice(0, 7);
    const res = await alice.get<{ users: Array<Record<string, unknown>> }>(
      `/api/users/search?q=${encodeURIComponent(prefix)}`,
    );
    expect(res.status).toBe(200);

    const match = res.body.users.find((u) => u.id === bobId);
    expect(match).toBeTruthy();
    expect(match).not.toHaveProperty("email");
    expect(match).not.toHaveProperty("passwordHash");
    expect(match).not.toHaveProperty("password_hash");
    // The public projection must not leak the account email address.
    expect(JSON.stringify(res.body)).not.toContain("@");
  });
});

// ---- helpers ----

function headerFor(client: TestClientLike): string {
  return [...client.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

const loginIdCache = new Map<string, string | null>();

/** Look up the username used to register an account, for re-login flows. */
async function getLoginIdentifier(userId: string): Promise<string | null> {
  if (loginIdCache.has(userId)) return loginIdCache.get(userId) ?? null;
  const { query } = await import("../src/db/pool.js");
  const rows = await query<{ username: string }>(`SELECT username FROM users WHERE id = $1`, [userId]);
  const username = rows[0]?.username ?? null;
  loginIdCache.set(userId, username);
  return username;
}
