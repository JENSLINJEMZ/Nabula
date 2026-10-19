import { describe, expect, it } from "vitest";
import { TestClient, useTestServer, waitFor } from "./helpers.js";

const server = useTestServer();

interface ErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}
interface WebhookBody {
  webhook?: {
    id: string;
    channelId: string;
    name: string;
    tokenPrefix: string;
    disabled: boolean;
    avatarUrl: string | null;
    rotatedAt: string | null;
    lastUsedAt: string | null;
  };
  token?: string;
  webhooks?: Array<{ id: string; name: string; tokenPrefix: string; disabled: boolean }>;
  message?: { id: string; content: string; channelId: string; webhookId: string | null; embeds?: unknown[] };
  duplicate?: boolean;
  deliveries?: Array<{ id: string; statusCode: number; success: boolean; messageId: string | null; error: string | null }>;
}
interface MessageBody {
  messages?: Array<{ id: string; content: string; embeds?: unknown[] }>;
}
interface ChannelBody {
  channels?: Array<{ id: string; type: number; name?: string }>;
}
interface AuditBody {
  entries?: Array<{ actionType: number; targetId: string | null }>;
}

async function createGuildWithGeneral(client: TestClient, name: string) {
  const created = await client.post<{ guild?: { id: string } }>("/api/guilds", { name });
  expect(created.status).toBe(201);
  const guildId = created.body.guild!.id;
  const channels = await client.get<ChannelBody>(`/api/guilds/${guildId}/channels`);
  const general = created.body.guild && channels.body.channels!.find((c) => c.type === 0)!;
  return { guildId, generalId: general.id };
}

describe("Webhooks", () => {
  it("creates, lists and delivers a webhook message and records an audit entry", async () => {
    const owner = new TestClient(server.url);
    await owner.register("wh_create");
    const { guildId, generalId } = await createGuildWithGeneral(owner, "Webhook Create Guild");

    const created = await owner.post<WebhookBody>(`/api/channels/${generalId}/webhooks`, { name: "Deploy Bot" });
    expect(created.status).toBe(201);
    expect(created.body.token).toBeTruthy();
    expect((created.body.token as string).length).toBeGreaterThanOrEqual(20);
    expect(created.body.webhook!.tokenPrefix).toBe(created.body.token!.slice(0, 8));
    expect(created.body.webhook!.disabled).toBe(false);

    const webhookId = created.body.webhook!.id;
    const token = created.body.token!;

    const list = await owner.get<WebhookBody>(`/api/channels/${generalId}/webhooks`);
    expect(list.status).toBe(200);
    expect(list.body.webhooks!.some((w) => w.id === webhookId)).toBe(true);

    // Deliver a message.
    const delivered = await owner.post<WebhookBody>(`/api/webhooks/${webhookId}/${token}`, {
      content: "Deployment finished ✅",
    });
    expect(delivered.status).toBe(201);
    expect(delivered.body.message!.content).toBe("Deployment finished ✅");
    expect(delivered.body.message!.channelId).toBe(generalId);

    // Persisted in channel history.
    const history = await owner.get<MessageBody>(`/api/channels/${generalId}/messages`);
    expect(history.body.messages!.some((m) => m.id === delivered.body.message!.id)).toBe(true);

    // Delivery is recorded.
    const deliveries = await owner.get<WebhookBody>(
      `/api/guilds/${guildId}/webhooks/${webhookId}/deliveries`,
    );
    expect(deliveries.status).toBe(200);
    expect(deliveries.body.deliveries![0]!.success).toBe(true);
    expect(deliveries.body.deliveries![0]!.messageId).toBe(delivered.body.message!.id);

    // Creation is audited.
    const audit = await owner.get<AuditBody>(`/api/guilds/${guildId}/audit-logs`);
    expect(audit.body.entries!.some((e) => e.actionType === 50 && e.targetId === webhookId)).toBe(true);
  });

  it("rejects an invalid or missing token and unknown webhook", async () => {
    const owner = new TestClient(server.url);
    await owner.register("wh_token");
    const { generalId } = await createGuildWithGeneral(owner, "Wh Token Guild");
    const created = await owner.post<WebhookBody>(`/api/channels/${generalId}/webhooks`, { name: "token-check" });
    const webhookId = created.body.webhook!.id;

    const wrong = await owner.post<ErrorBody>(`/api/webhooks/${webhookId}/${"x".repeat(43)}`, { content: "nope" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error?.code).toBe("UNAUTHENTICATED");

    const unknown = await owner.post<ErrorBody>(`/api/webhooks/999999999999/${"y".repeat(43)}`, { content: "nope" });
    expect(unknown.status).toBe(404);
  });

  it("rotates the token, invalidating the previous credential", async () => {
    const owner = new TestClient(server.url);
    await owner.register("wh_rotate");
    const { guildId, generalId } = await createGuildWithGeneral(owner, "Wh Rotate Guild");
    const created = await owner.post<WebhookBody>(`/api/channels/${generalId}/webhooks`, { name: "rotate" });
    const webhookId = created.body.webhook!.id;
    const oldToken = created.body.token!;

    const rotated = await owner.post<WebhookBody>(`/api/guilds/${guildId}/webhooks/${webhookId}/rotate`);
    expect(rotated.status).toBe(200);
    const newToken = rotated.body.token!;
    expect(newToken).not.toBe(oldToken);
    expect(rotated.body.webhook!.rotatedAt).not.toBeNull();

    const oldAttempt = await owner.post<ErrorBody>(`/api/webhooks/${webhookId}/${oldToken}`, { content: "old" });
    expect(oldAttempt.status).toBe(401);

    const newAttempt = await owner.post<WebhookBody>(`/api/webhooks/${webhookId}/${newToken}`, { content: "new" });
    expect(newAttempt.status).toBe(201);

    // Rotation is audited as an update.
    const audit = await owner.get<AuditBody>(`/api/guilds/${guildId}/audit-logs`);
    expect(audit.body.entries!.some((e) => e.actionType === 51 && e.targetId === webhookId)).toBe(true);
  });

  it("disables and re-enables a webhook", async () => {
    const owner = new TestClient(server.url);
    await owner.register("wh_disable");
    const { guildId, generalId } = await createGuildWithGeneral(owner, "Wh Disable Guild");
    const created = await owner.post<WebhookBody>(`/api/channels/${generalId}/webhooks`, { name: "toggle" });
    const webhookId = created.body.webhook!.id;
    const token = created.body.token!;

    const disabled = await owner.patch<WebhookBody>(`/api/guilds/${guildId}/webhooks/${webhookId}`, { disabled: true });
    expect(disabled.status).toBe(200);
    expect(disabled.body.webhook!.disabled).toBe(true);

    const blocked = await owner.post<ErrorBody>(`/api/webhooks/${webhookId}/${token}`, { content: "should fail" });
    expect(blocked.status).toBe(403);

    await owner.patch(`/api/guilds/${guildId}/webhooks/${webhookId}`, { disabled: false });
    const allowed = await owner.post<WebhookBody>(`/api/webhooks/${webhookId}/${token}`, { content: "works again" });
    expect(allowed.status).toBe(201);
  });

  it("cannot deliver once deleted", async () => {
    const owner = new TestClient(server.url);
    await owner.register("wh_delete");
    const { guildId, generalId } = await createGuildWithGeneral(owner, "Wh Delete Guild");
    const created = await owner.post<WebhookBody>(`/api/channels/${generalId}/webhooks`, { name: "doomed" });
    const webhookId = created.body.webhook!.id;
    const token = created.body.token!;

    const removed = await owner.del(`/api/guilds/${guildId}/webhooks/${webhookId}`);
    expect(removed.status).toBe(204);

    const after = await owner.post<ErrorBody>(`/api/webhooks/${webhookId}/${token}`, { content: "gone" });
    expect(after.status).toBe(404);

    const audit = await owner.get<AuditBody>(`/api/guilds/${guildId}/audit-logs`);
    expect(audit.body.entries!.some((e) => e.actionType === 52 && e.targetId === webhookId)).toBe(true);
  });

  it("enforces MANAGE_WEBHOOKS and blocks cross-guild management", async () => {
    const owner = new TestClient(server.url);
    await owner.register("wh_authz_owner");
    const member = new TestClient(server.url);
    await member.register("wh_authz_member");
    const { guildId, generalId } = await createGuildWithGeneral(owner, "Wh Authz Guild");
    const invite = await owner.post<{ invite: { code: string } }>(`/api/channels/${generalId}/invites`, {});
    await member.post(`/api/invites/${invite.body.invite.code}`, {});

    const created = await owner.post<WebhookBody>(`/api/channels/${generalId}/webhooks`, { name: "owner-only" });
    const webhookId = created.body.webhook!.id;

    // Members cannot list, create, rotate or delete.
    expect((await member.get<ErrorBody>(`/api/channels/${generalId}/webhooks`)).status).toBe(403);
    expect((await member.post<ErrorBody>(`/api/channels/${generalId}/webhooks`, { name: "nope" })).status).toBe(403);
    expect((await member.post<ErrorBody>(`/api/guilds/${guildId}/webhooks/${webhookId}/rotate`)).status).toBe(403);
    expect((await member.del<ErrorBody>(`/api/guilds/${guildId}/webhooks/${webhookId}`)).status).toBe(403);
    expect((await member.patch<ErrorBody>(`/api/guilds/${guildId}/webhooks/${webhookId}`, { disabled: true })).status).toBe(403);

    // A webhook cannot be managed from a different guild.
    const otherGuild = await owner.post<{ guild: { id: string } }>("/api/guilds", { name: "Other Guild" });
    const otherGuildId = otherGuild.body.guild.id;
    const cross = await owner.post<ErrorBody>(`/api/guilds/${otherGuildId}/webhooks/${webhookId}/rotate`);
    expect([403, 404]).toContain(cross.status);
  });

  it("validates content and embeds, and rejects a channel override", async () => {
    const owner = new TestClient(server.url);
    await owner.register("wh_validate");
    const { generalId } = await createGuildWithGeneral(owner, "Wh Validate Guild");
    const created = await owner.post<WebhookBody>(`/api/channels/${generalId}/webhooks`, { name: "validator" });
    const webhookId = created.body.webhook!.id;
    const token = created.body.token!;
    const url = `/api/webhooks/${webhookId}/${token}`;

    // Empty payload is rejected.
    const empty = await owner.post<ErrorBody>(url, {});
    expect(empty.status).toBe(400);
    expect(empty.body.error?.code).toBe("MESSAGE_EMPTY");

    // Oversized content is rejected by validation.
    const tooLong = await owner.post<ErrorBody>(url, { content: "a".repeat(2001) });
    expect(tooLong.status).toBe(400);

    // A valid, self-contained embed is accepted and persisted.
    const withEmbed = await owner.post<WebhookBody>(url, {
      embeds: [{ title: "Build", description: "All checks passed", color: 0x57f287, url: "https://example.com/build/1" }],
    });
    expect(withEmbed.status).toBe(201);
    expect(Array.isArray(withEmbed.body.message!.embeds)).toBe(true);
    expect(withEmbed.body.message!.embeds!.length).toBe(1);

    // A non-http(s) embed URL is rejected (no other schemes, no fetching).
    const badUrl = await owner.post<ErrorBody>(url, { embeds: [{ title: "x", url: "ftp://example.com" }] });
    expect(badUrl.status).toBe(400);
    expect(badUrl.body.error?.field).toBeUndefined;
    expect(badUrl.body.error?.details?.field).toBe("embeds");

    // An embed with no renderable content is rejected.
    const emptyEmbed = await owner.post<ErrorBody>(url, { embeds: [{}] });
    expect(emptyEmbed.status).toBe(400);

    // Callers cannot redirect delivery to another channel.
    const channelOverride = await owner.post<ErrorBody>(url, { content: "hijack", channelId: generalId });
    expect(channelOverride.status).toBe(400);
  });

  it("rate limits deliveries per webhook", async () => {
    const owner = new TestClient(server.url);
    await owner.register("wh_rate");
    const { generalId } = await createGuildWithGeneral(owner, "Wh Rate Guild");
    const created = await owner.post<WebhookBody>(`/api/channels/${generalId}/webhooks`, { name: "noisy" });
    const webhookId = created.body.webhook!.id;
    const token = created.body.token!;
    const url = `/api/webhooks/${webhookId}/${token}`;

    let limited = 0;
    for (let i = 0; i < 35; i++) {
      const res = await owner.post<ErrorBody>(url, { content: `msg ${i}` });
      if (res.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });

  it("treats a repeated idempotency key as the same delivery", async () => {
    const owner = new TestClient(server.url);
    await owner.register("wh_idem");
    const { generalId } = await createGuildWithGeneral(owner, "Wh Idem Guild");
    const created = await owner.post<WebhookBody>(`/api/channels/${generalId}/webhooks`, { name: "idempotent" });
    const webhookId = created.body.webhook!.id;
    const token = created.body.token!;
    const url = `/api/webhooks/${webhookId}/${token}`;
    const headers = { "x-idempotency-key": "delivery-abc-1" };

    const before = (await owner.get<MessageBody>(`/api/channels/${generalId}/messages`)).body.messages!.length;
    const first = await owner.post<WebhookBody>(url, { content: "only once" }, headers);
    const second = await owner.post<WebhookBody>(url, { content: "only once" }, headers);
    expect(first.status).toBe(201);
    expect(first.body.duplicate).toBe(false);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    const after = (await owner.get<MessageBody>(`/api/channels/${generalId}/messages`)).body.messages!.length;
    expect(after).toBe(before + 1);
  });

  it("broadcasts the webhook message to channel members in real time", async () => {
    const owner = new TestClient(server.url);
    await owner.register("wh_rt_owner");
    const { generalId } = await createGuildWithGeneral(owner, "Wh RT Guild");
    const created = await owner.post<WebhookBody>(`/api/channels/${generalId}/webhooks`, { name: "realtime" });
    const webhookId = created.body.webhook!.id;
    const token = created.body.token!;

    const socket = await owner.socket();
    const ready = waitFor(socket, "READY");
    socket.emit("IDENTIFY");
    await ready;

    const arrival = waitFor<{ content: string; channelId: string }>(
      socket,
      "MESSAGE_CREATE",
      (m) => m?.content === "realtime webhook" && m?.channelId === generalId,
    );
    const delivered = await owner.post<WebhookBody>(`/api/webhooks/${webhookId}/${token}`, {
      content: "realtime webhook",
    });
    expect(delivered.status).toBe(201);
    const event = await arrival;
    expect(event.content).toBe("realtime webhook");
    socket.disconnect();
  });

  it("never exposes the token or its hash through the API", async () => {
    const owner = new TestClient(server.url);
    await owner.register("wh_secret");
    const { generalId } = await createGuildWithGeneral(owner, "Wh Secret Guild");
    const created = await owner.post<WebhookBody>(`/api/channels/${generalId}/webhooks`, { name: "secretive" });
    const token = created.body.token!;

    const list = await owner.get(`/api/channels/${generalId}/webhooks`);
    const serialized = JSON.stringify(list.body);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("token_hash");
    // Only the display prefix is exposed.
    expect(serialized).toContain(created.body.webhook!.tokenPrefix);
  });

  it("sends a permission-checked test delivery without exposing the token", async () => {
    const owner = new TestClient(server.url);
    await owner.register("wh_test_send");
    const { guildId, generalId } = await createGuildWithGeneral(owner, "Wh Test Guild");
    const created = await owner.post<WebhookBody>(`/api/channels/${generalId}/webhooks`, { name: "tester" });
    const webhookId = created.body.webhook!.id;
    const token = created.body.token!;

    const sent = await owner.post<WebhookBody>(`/api/guilds/${guildId}/webhooks/${webhookId}/execute`);
    expect(sent.status).toBe(201);
    expect(sent.body.message!.content).toContain("Test delivery");
    // The management path must not leak the secret.
    expect(JSON.stringify(sent.body)).not.toContain(token);

    // A disabled webhook can still be tested so misconfiguration is diagnosable...
    const disabled = await owner.patch<WebhookBody>(`/api/guilds/${guildId}/webhooks/${webhookId}`, {
      disabled: true,
    });
    expect(disabled.status).toBe(200);
    const whileDisabled = await owner.post<WebhookBody>(`/api/guilds/${guildId}/webhooks/${webhookId}/execute`);
    expect(whileDisabled.status).toBe(201);

    // ...but the public token path stays closed while disabled.
    const viaToken = await owner.post<ErrorBody>(`/api/webhooks/${webhookId}/${token}`, { content: "blocked" });
    expect(viaToken.status).toBe(403);
  });
});

