import { describe, expect, it } from "vitest";
import { TestClient, useTestServer, waitFor } from "./helpers.js";

const server = useTestServer();

const SEND_MESSAGES = "2048";

interface ErrorBody {
  error?: { code?: string; message?: string };
}
interface ChannelBody {
  channel?: { id: string; type?: number; name?: string };
  channels?: Array<{ id: string; type: number; name?: string }>;
}
interface MessageBody {
  message?: {
    id: string;
    content: string;
    channelId: string;
    type?: number;
    attachments?: Array<{ id: string; filename: string }>;
    referencedMessage?: { id: string; channelId: string; content: string } | null;
  };
  messages?: Array<{
    id: string;
    content: string;
    channelId: string;
    type?: number;
    referencedMessage?: { id: string; channelId: string } | null;
  }>;
}

async function createGuildWithGeneral(client: TestClient, name: string) {
  const created = await client.post<{ guild?: { id: string } }>("/api/guilds", { name });
  expect(created.status).toBe(201);
  const guildId = created.body.guild!.id;
  const channels = await client.get<ChannelBody>(`/api/guilds/${guildId}/channels`);
  const general = channels.body.channels!.find((c) => c.type === 0)!;
  return { guildId, generalId: general.id };
}

async function inviteAndJoin(owner: TestClient, joiner: TestClient, channelId: string) {
  const invite = await owner.post<{ invite: { code: string } }>(`/api/channels/${channelId}/invites`, {});
  expect(invite.status).toBe(201);
  const joined = await joiner.post<{ guildId: string }>(`/api/invites/${invite.body.invite.code}`);
  expect(joined.status).toBe(200);
  return joined.body;
}

async function createTextChannel(client: TestClient, guildId: string, name: string): Promise<string> {
  const created = await client.post<ChannelBody>(`/api/guilds/${guildId}/channels`, { type: 0, name });
  expect(created.status).toBe(201);
  return created.body.channel!.id;
}

async function befriend(a: TestClient, b: TestClient) {
  const sent = await a.post("/api/users/@me/relationships", { userId: b.userId });
  expect(sent.status).toBe(201);
  const accepted = await b.put(`/api/users/@me/relationships/${a.userId}`);
  expect(accepted.status).toBe(204);
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("Message forwarding", () => {
  it("forwards a guild message into another channel with a cross-channel reference", async () => {
    const owner = new TestClient(server.url);
    await owner.register("fwd_owner");
    const { guildId, generalId } = await createGuildWithGeneral(owner, "Fwd Guild");
    const targetId = await createTextChannel(owner, guildId, "announcements");

    const original = await owner.post<MessageBody>(`/api/channels/${generalId}/messages`, {
      content: "portable news",
    });
    expect(original.status).toBe(201);

    const forwarded = await owner.post<MessageBody>(`/api/messages/${original.body.message!.id}/forward`, {
      channelIds: [targetId],
    });
    expect(forwarded.status).toBe(201);
    const copy = forwarded.body.messages![0];
    expect(copy.channelId).toBe(targetId);
    expect(copy.content).toBe("portable news");
    // Cross-channel reference marks it as a forward (the channel differs).
    expect(copy.referencedMessage?.id).toBe(original.body.message!.id);
    expect(copy.referencedMessage?.channelId).toBe(generalId);

    // The copy is a real message in the destination history.
    const history = await owner.get<MessageBody>(`/api/channels/${targetId}/messages`);
    expect(history.status).toBe(200);
    expect(history.body.messages!.some((m) => m.id === copy.id)).toBe(true);

    // It does not leak the referenced author's original into the source channel twice.
    const source = await owner.get<MessageBody>(`/api/channels/${generalId}/messages`);
    expect(source.body.messages!.filter((m) => m.id === original.body.message!.id)).toHaveLength(1);
  });

  it("dedupes targets, refuses the source channel, and caps the fan-out", async () => {
    const owner = new TestClient(server.url);
    await owner.register("fwd_validate");
    const { guildId, generalId } = await createGuildWithGeneral(owner, "Fwd Validate Guild");
    const targetId = await createTextChannel(owner, guildId, "dupes");

    const original = await owner.post<MessageBody>(`/api/channels/${generalId}/messages`, { content: "once" });
    const messageId = original.body.message!.id;

    // Duplicate ids collapse to a single copy.
    const deduped = await owner.post<MessageBody>(`/api/messages/${messageId}/forward`, {
      channelIds: [targetId, targetId],
    });
    expect(deduped.status).toBe(201);
    expect(deduped.body.messages).toHaveLength(1);

    // Forwarding into the source channel is rejected.
    const sameChannel = await owner.post<ErrorBody>(`/api/messages/${messageId}/forward`, {
      channelIds: [generalId],
    });
    expect(sameChannel.status).toBe(400);
    expect(sameChannel.body.error?.code).toBe("VALIDATION_FAILED");

    // More than 10 destinations is rejected (Zod max on the array).
    const many = Array.from({ length: 11 }, (_, i) => `${targetId}${i}`);
    const tooMany = await owner.post<ErrorBody>(`/api/messages/${messageId}/forward`, { channelIds: many });
    expect(tooMany.status).toBe(400);
  });

  it("refuses a target the actor may not post in and a source they cannot read", async () => {
    const owner = new TestClient(server.url);
    await owner.register("fwd_authz_owner");
    const member = new TestClient(server.url);
    await member.register("fwd_authz_member");
    const outsider = new TestClient(server.url);
    await outsider.register("fwd_authz_outsider");

    const { guildId, generalId } = await createGuildWithGeneral(owner, "Fwd Authz Guild");
    await inviteAndJoin(owner, member, generalId);
    const targetId = await createTextChannel(owner, guildId, "read-only");

    // Deny SEND_MESSAGES for @everyone in the target channel.
    const roles = await owner.get<{ roles: Array<{ id: string; isEveryone?: boolean }> }>(
      `/api/guilds/${guildId}/roles`,
    );
    const everyone = roles.body.roles.find((r) => r.isEveryone === true)!;
    const overwrite = await owner.put(`/api/channels/${targetId}/permissions/${everyone.id}`, {
      type: 0,
      allow: "0",
      deny: SEND_MESSAGES,
    });
    expect(overwrite.status).toBe(204);

    const original = await owner.post<MessageBody>(`/api/channels/${generalId}/messages`, {
      content: "members only",
    });
    const messageId = original.body.message!.id;

    const deniedTarget = await member.post<ErrorBody>(`/api/messages/${messageId}/forward`, {
      channelIds: [targetId],
    });
    expect(deniedTarget.status).toBe(403);
    expect(deniedTarget.body.error?.code).toBe("MISSING_PERMISSIONS");

    // An outsider cannot even read the source message.
    const deniedSource = await outsider.post<ErrorBody>(`/api/messages/${messageId}/forward`, {
      channelIds: [generalId],
    });
    expect(deniedSource.status).toBe(403);
  });

  it("copies attachments into the target channel's authorization scope", async () => {
    const owner = new TestClient(server.url);
    await owner.register("fwd_att_owner");
    const { guildId, generalId } = await createGuildWithGeneral(owner, "Fwd Attachment Guild");
    const targetId = await createTextChannel(owner, guildId, "files");
    const outsider = new TestClient(server.url);
    await outsider.register("fwd_att_outsider");

    const uploaded = await owner.upload<{ attachment: { id: string } }>(
      `/api/channels/${generalId}/attachments`,
      { name: "pixel.png", bytes: PNG, type: "image/png" },
    );
    expect(uploaded.status).toBe(201);
    const originalAttachmentId = uploaded.body.attachment.id;

    const original = await owner.post<MessageBody>(`/api/channels/${generalId}/messages`, {
      content: "with a file",
      attachmentIds: [originalAttachmentId],
    });
    expect(original.status).toBe(201);

    const forwarded = await owner.post<MessageBody>(`/api/messages/${original.body.message!.id}/forward`, {
      channelIds: [targetId],
    });
    expect(forwarded.status).toBe(201);
    const copies = forwarded.body.messages![0].attachments ?? [];
    expect(copies).toHaveLength(1);
    // The copy is a distinct attachment row bound to the target channel.
    expect(copies[0].id).not.toBe(originalAttachmentId);

    const downloaded = await owner.get(`/api/media/attachments/${copies[0].id}/pixel.png`);
    expect(downloaded.status).toBe(200);
    // Non-members cannot read the copy through the target channel's authorization.
    const denied = await outsider.get(`/api/media/attachments/${copies[0].id}/pixel.png`);
    expect(denied.status).toBe(403);
  });

  it("forwards into a DM the actor is part of and the other participant sees it", async () => {
    const a = new TestClient(server.url);
    const b = new TestClient(server.url);
    await a.register("fwd_dm_a");
    await b.register("fwd_dm_b");
    await befriend(a, b);

    const { generalId } = await createGuildWithGeneral(a, "Fwd DM Guild");
    const dmRes = await a.post<ChannelBody>("/api/users/@me/channels", { recipients: [b.userId!] });
    expect(dmRes.status).toBe(201);
    const dmId = dmRes.body.channel!.id;

    const original = await a.post<MessageBody>(`/api/channels/${generalId}/messages`, { content: "dm forward" });
    const forwarded = await a.post<MessageBody>(`/api/messages/${original.body.message!.id}/forward`, {
      channelIds: [dmId],
    });
    expect(forwarded.status).toBe(201);
    expect(forwarded.body.messages![0].channelId).toBe(dmId);

    const seenByB = await b.get<MessageBody>(`/api/channels/${dmId}/messages`);
    expect(seenByB.status).toBe(200);
    expect(seenByB.body.messages!.some((m) => m.content === "dm forward")).toBe(true);
  });

  it("refuses to forward into a DM where a recipient blocked the actor", async () => {
    const a = new TestClient(server.url);
    const b = new TestClient(server.url);
    await a.register("fwd_block_a");
    await b.register("fwd_block_b");
    await befriend(a, b);

    const { generalId } = await createGuildWithGeneral(a, "Fwd Block Guild");
    const dmRes = await a.post<ChannelBody>("/api/users/@me/channels", { recipients: [b.userId!] });
    const dmId = dmRes.body.channel!.id;

    const block = await b.put(`/api/users/@me/relationships/${a.userId}/block`);
    expect(block.status).toBe(204);

    const original = await a.post<MessageBody>(`/api/channels/${generalId}/messages`, { content: "blocked" });
    const refused = await a.post<ErrorBody>(`/api/messages/${original.body.message!.id}/forward`, {
      channelIds: [dmId],
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error?.code).toBe("BLOCKED");
  });

  it("marks pins with a system entry that is excluded from search and not editable", async () => {
    const owner = new TestClient(server.url);
    await owner.register("fwd_pin_owner");
    const { generalId } = await createGuildWithGeneral(owner, "Fwd Pin Guild");

    const phrase = `pinned-phrase-${Date.now()}`;
    const original = await owner.post<MessageBody>(`/api/channels/${generalId}/messages`, { content: phrase });
    const messageId = original.body.message!.id;

    const pinned = await owner.put(`/api/messages/${messageId}/pin`);
    expect(pinned.status).toBe(204);

    const history = await owner.get<MessageBody>(`/api/channels/${generalId}/messages`);
    const systemEntry = history.body.messages!.find((m) => m.type === 6);
    expect(systemEntry).toBeDefined();
    expect(systemEntry!.content).toContain(phrase);

    // Search must not surface system entries (only DEFAULT/REPLY are searchable).
    const search = await owner.get<MessageBody>(`/api/search?q=${encodeURIComponent(phrase)}`);
    expect(search.status).toBe(200);
    expect(search.body.messages!.some((m) => m.id === systemEntry!.id)).toBe(false);
    expect(search.body.messages!.some((m) => m.id === messageId)).toBe(true);

    // System messages cannot be edited, even by their author.
    const edit = await owner.patch<ErrorBody>(`/api/messages/${systemEntry!.id}`, { content: "tampered" });
    expect(edit.status).toBe(403);
  });

  it("appends group-DM membership changes as system entries", async () => {
    const a = new TestClient(server.url);
    const b = new TestClient(server.url);
    const c = new TestClient(server.url);
    const { userId: bId } = await b.register("fwd_gd_b");
    const { userId: cId } = await c.register("fwd_gd_c");
    await a.register("fwd_gd_a");

    const group = await a.post<ChannelBody>("/api/users/@me/channels", { recipients: [bId] });
    expect(group.status).toBe(201);
    const groupId = group.body.channel!.id;

    const added = await a.post<ChannelBody>(`/api/channels/${groupId}/recipients`, { userId: cId });
    expect(added.status).toBe(200);
    const addEntries = await a.get<MessageBody>(`/api/channels/${groupId}/messages`);
    const addedEntry = addEntries.body.messages!.find((m) => m.type === 1);
    expect(addedEntry).toBeDefined();
    expect(addedEntry!.content).toContain(c.username!);

    const left = await c.del(`/api/channels/${groupId}/recipients/${cId}`);
    expect(left.status).toBe(200);
    const afterLeave = await a.get<MessageBody>(`/api/channels/${groupId}/messages`);
    const removedEntry = afterLeave.body.messages!.find((m) => m.type === 2);
    expect(removedEntry).toBeDefined();
    expect(removedEntry!.content).toContain("left the group");
  });

  it("broadcasts the forwarded copy to peers in the target channel in real time", async () => {
    const owner = new TestClient(server.url);
    await owner.register("fwd_rt_owner");
    const peer = new TestClient(server.url);
    await peer.register("fwd_rt_peer");
    const { guildId, generalId } = await createGuildWithGeneral(owner, "Fwd RT Guild");
    await inviteAndJoin(owner, peer, generalId);
    const targetId = await createTextChannel(owner, guildId, "rt-target");

    const socket = await peer.socket();
    // IDENTIFY re-issues READY after the listener is registered (race-free).
    const ready = waitFor(socket, "READY");
    socket.emit("IDENTIFY");
    await ready;

    const original = await owner.post<MessageBody>(`/api/channels/${generalId}/messages`, {
      content: "realtime forward",
    });
    const arrival = waitFor<{ id: string; channelId: string; content: string }>(
      socket,
      "MESSAGE_CREATE",
      (m) => m?.content === "realtime forward" && m?.channelId === targetId,
    );
    const forwarded = await owner.post<MessageBody>(`/api/messages/${original.body.message!.id}/forward`, {
      channelIds: [targetId],
    });
    expect(forwarded.status).toBe(201);
    const delivered = await arrival;
    expect(delivered.id).toBe(forwarded.body.messages![0].id);
    socket.disconnect();
  });
});
