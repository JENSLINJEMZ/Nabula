import { describe, expect, it } from "vitest";
import { TestClient, useTestServer, waitFor } from "./helpers.js";

const server = useTestServer();

interface ErrorBody {
  error?: { code?: string; message?: string };
}

interface GuildBody {
  guild?: { id: string; ownerId?: string; name?: string };
  guilds?: Array<{ id: string }>;
}

interface ChannelBody {
  channel?: { id: string; type?: number; name?: string };
  channels?: Array<{ id: string; type: number; name?: string }>;
}

interface MessageBody {
  message?: {
    id: string;
    content: string;
    editedTimestamp?: string | null;
    attachments?: Array<{ id: string }>;
    reactions?: unknown[];
  };
  messages?: Array<{ id: string; content: string; reactions?: unknown[] }>;
}

interface RelationshipEntry {
  userId: string;
  type: number;
  user: { id: string };
}

/** Permission bit used by the role tests (Discord: MANAGE_CHANNELS = 1 << 4). */
const MANAGE_CHANNELS = "16";
/** Discord: VIEW_CHANNEL = 1 << 10). */
const VIEW_CHANNEL = "1024";

async function createGuildWithGeneral(client: TestClient, name: string) {
  const created = await client.post<GuildBody>("/api/guilds", { name });
  expect(created.status).toBe(201);
  const guildId = created.body.guild!.id;
  const channels = await client.get<ChannelBody>(`/api/guilds/${guildId}/channels`);
  const general = channels.body.channels!.find((c) => c.type === 0)!;
  return { guildId, generalId: general.id };
}

async function inviteAndJoin(owner: TestClient, joiner: TestClient, channelId: string) {
  const invite = await owner.post<{ invite: { code: string } }>(`/api/channels/${channelId}/invites`, {});
  expect(invite.status).toBe(201);
  const joined = await joiner.post<{ alreadyMember: boolean; guildId: string }>(
    `/api/invites/${invite.body.invite.code}`,
  );
  expect(joined.status).toBe(200);
  return joined.body;
}

/**
 * End-to-end journeys. Every test drives the real Fastify server + Socket.IO
 * gateway against an isolated PostgreSQL database, covering the product's
 * acceptance journeys rather than unit-level internals.
 */
describe("E2E journeys", () => {
  it("J1 registers two users, each with a working session", async () => {
    const alice = new TestClient(server.url);
    const a = await alice.register("journey_a");
    expect(a.userId).toMatch(/^\d+$/);

    const bob = new TestClient(server.url);
    const b = await bob.register("journey_b");
    expect(b.userId).toMatch(/^\d+$/);
    expect(b.userId).not.toBe(a.userId);

    const meA = await alice.get<{ user: { id: string } }>("/api/users/@me");
    expect(meA.status).toBe(200);
    expect(meA.body.user.id).toBe(a.userId);

    const meB = await bob.get<{ user: { id: string } }>("/api/users/@me");
    expect(meB.status).toBe(200);
    expect(meB.body.user.id).toBe(b.userId);

    const sessionsA = await alice.get<{ sessions: unknown[] }>("/api/auth/sessions");
    expect(sessionsA.status).toBe(200);
    expect(sessionsA.body.sessions.length).toBeGreaterThan(0);
  });

  it("J2 creates a guild and an invite link, previewable by a guest", async () => {
    const owner = new TestClient(server.url);
    await owner.register("journey_owner");
    const { guildId, generalId } = await createGuildWithGeneral(owner, "Journey Guild");

    const list = await owner.get<GuildBody>("/api/guilds");
    expect(list.body.guilds!.map((g) => g.id)).toContain(guildId);

    const invite = await owner.post<{ invite: { code: string } }>(`/api/channels/${generalId}/invites`, {
      maxUses: 5,
    });
    expect(invite.status).toBe(201);
    const code = invite.body.invite.code;

    const guest = new TestClient(server.url);
    const preview = await guest.get<{ invite: { code: string }; guild: { name: string } }>(`/api/invites/${code}`);
    expect(preview.status).toBe(200);
    expect(preview.body.invite.code).toBe(code);
    expect(preview.body.guild.name).toBe("Journey Guild");
  });

  it("J3 a second user joins via invite; a granted role lets them create channels", async () => {
    const owner = new TestClient(server.url);
    await owner.register("journey_owner3");
    const joiner = new TestClient(server.url);
    await joiner.register("journey_joiner");

    const { guildId, generalId } = await createGuildWithGeneral(owner, "Join Guild");
    const joined = await inviteAndJoin(owner, joiner, generalId);
    expect(joined.alreadyMember).toBe(false);
    expect(joined.guildId).toBe(guildId);

    // Without MANAGE_CHANNELS the joiner is refused.
    const denied = await joiner.post<ErrorBody>(`/api/guilds/${guildId}/channels`, { type: 0, name: "nope" });
    expect(denied.status).toBe(403);
    expect(denied.body.error?.code).toBe("MISSING_PERMISSIONS");

    // Owner creates a role and assigns it.
    const modRole = await owner.post<{ role: { id: string } }>(`/api/guilds/${guildId}/roles`, {
      name: "Moderator",
      permissions: MANAGE_CHANNELS,
    });
    expect(modRole.status).toBe(201);
    const assigned = await owner.put(`/api/guilds/${guildId}/members/${joiner.userId}/roles`, {
      roles: [modRole.body.role.id],
    });
    expect(assigned.status).toBe(204);

    // Now they can create a channel.
    const createdChannel = await joiner.post<ChannelBody>(`/api/guilds/${guildId}/channels`, {
      type: 0,
      name: "mod-log",
    });
    expect(createdChannel.status).toBe(201);
    expect(createdChannel.body.channel?.type).toBe(0);
  });

  it("J4 delivers messages to another connected client in real time", async () => {
    const owner = new TestClient(server.url);
    await owner.register("journey_rt_owner");
    const peer = new TestClient(server.url);
    await peer.register("journey_rt_peer");

    const { generalId } = await createGuildWithGeneral(owner, "RT Guild");
    await inviteAndJoin(owner, peer, generalId);

    const ownerSocket = await owner.socket();
    const peerSocket = await peer.socket();

    // READY is sent on connect; IDENTIFY re-requests it deterministically.
    const ownerReady = waitFor<{ userId?: string }>(ownerSocket, "READY", undefined, 10000);
    const peerReady = waitFor<{ userId?: string }>(peerSocket, "READY", undefined, 10000);
    ownerSocket.emit("IDENTIFY");
    peerSocket.emit("IDENTIFY");
    await Promise.all([ownerReady, peerReady]);

    const peerMessage = waitFor<{ channelId: string; id: string; content: string; author: { id: string } }>(
      peerSocket,
      "MESSAGE_CREATE",
      (p) => p.channelId === generalId,
      10000,
    );
    const sent = await owner.post<{ message: { id: string } }>(`/api/channels/${generalId}/messages`, {
      content: "hello realtime",
    });
    expect(sent.status).toBe(201);

    const received = await peerMessage;
    expect(received.content).toBe("hello realtime");
    expect(received.author.id).toBe(owner.userId);

    const peerTyping = waitFor<{ channelId: string; userId: string }>(
      peerSocket,
      "TYPING_START",
      (p) => p.channelId === generalId,
      10000,
    );
    ownerSocket.emit("TYPING_START", { channelId: generalId });
    const typing = await peerTyping;
    expect(typing.userId).toBe(owner.userId);

    ownerSocket.close();
    peerSocket.close();
  });

  it("J5 edits, deletes, replies to, reacts to and searches messages", async () => {
    const user = new TestClient(server.url);
    await user.register("journey_msg");
    const { guildId, generalId } = await createGuildWithGeneral(user, "Message Guild");

    const sent = await user.post<{ message: { id: string } }>(`/api/channels/${generalId}/messages`, {
      content: "original content",
    });
    expect(sent.status).toBe(201);
    const messageId = sent.body.message.id;

    const edited = await user.patch<MessageBody["message"] & { content: string; editedTimestamp: string | null }>(
      `/api/messages/${messageId}`,
      { content: "edited content" },
    );
    expect(edited.status).toBe(200);
    expect(edited.body.message!.content).toBe("edited content");
    expect(edited.body.message!.editedTimestamp).not.toBeNull();

    const reply = await user.post<{ message: { id: string } }>(`/api/channels/${generalId}/messages`, {
      content: "a reply",
      referenceMessageId: messageId,
    });
    expect(reply.status).toBe(201);

    const react = await user.put(`/api/channels/${generalId}/messages/${messageId}/reactions/%F0%9F%91%8D/@me`);
    expect(react.status).toBe(204);

    const listed = await user.get<MessageBody>(`/api/channels/${generalId}/messages`);
    const target = listed.body.messages!.find((m) => m.id === messageId)!;
    expect(Array.isArray(target.reactions)).toBe(true);
    expect(target.reactions!.length).toBeGreaterThan(0);

    const search = await user.get<{ messages: Array<{ id: string }> }>(
      `/api/search?q=edited&guildId=${guildId}`,
    );
    expect(search.status).toBe(200);
    expect(search.body.messages.some((m) => m.id === messageId)).toBe(true);

    const del = await user.del(`/api/messages/${messageId}`);
    expect(del.status).toBe(204);

    const afterDelete = await user.get<MessageBody>(`/api/channels/${generalId}/messages`);
    expect(afterDelete.body.messages!.some((m) => m.id === messageId)).toBe(false);
  });

  it("J6 enforces role hierarchy and channel permission overwrites", async () => {
    const owner = new TestClient(server.url);
    await owner.register("journey_perm_owner");
    const member = new TestClient(server.url);
    await member.register("journey_perm_member");

    const { guildId, generalId } = await createGuildWithGeneral(owner, "Perm Guild");
    await inviteAndJoin(owner, member, generalId);

    const deniedRole = await member.post<ErrorBody>(`/api/guilds/${guildId}/roles`, { name: "x" });
    expect(deniedRole.status).toBe(403);
    expect(deniedRole.body.error?.code).toBe("MISSING_PERMISSIONS");

    const privateChannel = await owner.post<ChannelBody>(`/api/guilds/${guildId}/channels`, {
      type: 0,
      name: "private",
    });
    const privateId = privateChannel.body.channel!.id;

    const roles = await owner.get<{ roles: Array<{ id: string; isEveryone?: boolean }> }>(
      `/api/guilds/${guildId}/roles`,
    );
    const everyone = roles.body.roles.find((r) => r.isEveryone === true)!;

    const overwrite = await owner.put(`/api/channels/${privateId}/permissions/${everyone.id}`, {
      type: 0,
      allow: "0",
      deny: VIEW_CHANNEL,
    });
    expect(overwrite.status).toBe(204);

    const memberChannels = await member.get<ChannelBody>(`/api/guilds/${guildId}/channels`);
    expect(memberChannels.body.channels!.some((c) => c.id === privateId)).toBe(false);

    const readDenied = await member.get<ErrorBody>(`/api/channels/${privateId}/messages`);
    expect(readDenied.status).toBe(403);

    const readOk = await owner.get(`/api/channels/${privateId}/messages`);
    expect(readOk.status).toBe(200);
  });

  it("J7 sends and accepts a friend request", async () => {
    const a = new TestClient(server.url);
    await a.register("journey_friend_a");
    const b = new TestClient(server.url);
    await b.register("journey_friend_b");

    const sent = await a.post<{ result: string }>("/api/users/@me/relationships", { userId: b.userId });
    expect(sent.status).toBe(201);
    expect(sent.body.result).toBe("pending");

    const incoming = await b.get<{ relationships: RelationshipEntry[] }>("/api/users/@me/relationships");
    const request = incoming.body.relationships.find((r) => r.userId === a.userId);
    expect(request).toBeDefined();
    // Discord relationship type 3 = INCOMING_REQUEST.
    expect(request!.type).toBe(3);

    const accepted = await b.put(`/api/users/@me/relationships/${a.userId}`);
    expect(accepted.status).toBe(204);

    const friendsA = await a.get<{ relationships: RelationshipEntry[] }>("/api/users/@me/relationships");
    const friend = friendsA.body.relationships.find((r) => r.userId === b.userId);
    expect(friend?.type).toBe(1);
  });

  it("J8 opens a DM and exchanges messages with realtime delivery", async () => {
    const a = new TestClient(server.url);
    await a.register("journey_dm_a");
    const b = new TestClient(server.url);
    await b.register("journey_dm_b");

    await a.post("/api/users/@me/relationships", { userId: b.userId });
    await b.put(`/api/users/@me/relationships/${a.userId}`);

    const opened = await a.post<ChannelBody>("/api/users/@me/channels", { recipientId: b.userId });
    expect(opened.status).toBe(201);
    const dmId = opened.body.channel!.id;

    const socketA = await a.socket();
    const socketB = await b.socket();
    const readyA = waitFor(socketA, "READY", undefined, 10000);
    const readyB = waitFor(socketB, "READY", undefined, 10000);
    socketA.emit("IDENTIFY");
    socketB.emit("IDENTIFY");
    await Promise.all([readyA, readyB]);

    const bReceived = waitFor<{ channelId: string; content: string }>(
      socketB,
      "MESSAGE_CREATE",
      (p) => p.channelId === dmId,
      10000,
    );
    const sent = await a.post<{ message: { id: string } }>(`/api/channels/${dmId}/messages`, {
      content: "hi dm",
    });
    expect(sent.status).toBe(201);

    const received = await bReceived;
    expect(received.content).toBe("hi dm");

    const history = await b.get<MessageBody>(`/api/channels/${dmId}/messages`);
    expect(history.body.messages!.some((m) => m.content === "hi dm")).toBe(true);

    socketA.close();
    socketB.close();
  });

  it("J9 joins a voice channel and relays WebRTC signalling", async () => {
    const owner = new TestClient(server.url);
    await owner.register("journey_voice_owner");
    const joiner = new TestClient(server.url);
    await joiner.register("journey_voice_peer");

    const { guildId, generalId } = await createGuildWithGeneral(owner, "Voice Guild");
    await inviteAndJoin(owner, joiner, generalId);

    // Default guild includes a voice channel (type 2); create one if not.
    let channels = await owner.get<ChannelBody>(`/api/guilds/${guildId}/channels`);
    let voiceId = channels.body.channels!.find((c) => c.type === 2)?.id;
    if (!voiceId) {
      const made = await owner.post<ChannelBody>(`/api/guilds/${guildId}/channels`, { type: 2, name: "Voice" });
      voiceId = made.body.channel!.id;
    }

    const socketOwner = await owner.socket();
    const socketJoiner = await joiner.socket();
    const readyOwner = waitFor(socketOwner, "READY", undefined, 10000);
    const readyJoiner = waitFor(socketJoiner, "READY", undefined, 10000);
    socketOwner.emit("IDENTIFY");
    socketJoiner.emit("IDENTIFY");
    await Promise.all([readyOwner, readyJoiner]);

    const stateSeenByOwner = waitFor<{ channelId: string; userId: string }>(
      socketOwner,
      "VOICE_STATE_UPDATE",
      (p) => p.channelId === voiceId,
      10000,
    );
    const joined = await joiner.post(`/api/channels/${voiceId}/voice/join`, { selfMute: false });
    expect([200, 201]).toContain(joined.status);
    const state = await stateSeenByOwner;
    expect(state.userId).toBe(joiner.userId);

    // WebRTC signalling only relays between peers in the same voice channel, so
    // the owner must join too before a signal can be delivered.
    const ownerJoined = await owner.post(`/api/channels/${voiceId}/voice/join`, { selfMute: false });
    expect([200, 201]).toContain(ownerJoined.status);

    // WebRTC media negotiation itself depends on external STUN/TURN
    // infrastructure, which is documented as a deployment requirement. What we
    // verify here is the signalling relay that media negotiation rides on.
    const signalSeenByOwner = waitFor<{ fromUserId: string; kind: string; payload: { sdp: string } }>(
      socketOwner,
      "VOICE_SIGNAL",
      (p) => p.fromUserId === joiner.userId,
      10000,
    );
    socketJoiner.emit("VOICE_SIGNAL", {
      channelId: voiceId,
      toUserId: owner.userId,
      kind: "offer",
      payload: { sdp: "qvd-test-sdp" },
    });
    const signal = await signalSeenByOwner;
    expect(signal.kind).toBe("offer");
    expect(signal.payload.sdp).toBe("qvd-test-sdp");

    const left = await joiner.del("/api/users/@me/voice-state");
    expect(left.status).toBe(204);

    socketOwner.close();
    socketJoiner.close();
    channels = channels; // no-op to keep the variable used across the branch
  });

  it("J10 uploads an attachment and restricts access to authorized users", async () => {
    const owner = new TestClient(server.url);
    await owner.register("journey_up_owner");
    const outsider = new TestClient(server.url);
    await outsider.register("journey_up_outsider");

    const { generalId } = await createGuildWithGeneral(owner, "Upload Guild");

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );

    const uploaded = await owner.upload<{ attachment: { id: string; url: string } }>(
      `/api/channels/${generalId}/attachments`,
      { name: "pixel.png", bytes: png, type: "image/png" },
    );
    expect(uploaded.status).toBe(201);
    const attachmentId = uploaded.body.attachment.id;

    const sent = await owner.post<MessageBody>(`/api/channels/${generalId}/messages`, {
      content: "here is the file",
      attachmentIds: [attachmentId],
    });
    expect(sent.status).toBe(201);
    expect(sent.body.message!.attachments!.some((x) => x.id === attachmentId)).toBe(true);

    const fetched = await owner.get(`/api/media/attachments/${attachmentId}/pixel.png`);
    expect(fetched.status).toBe(200);

    const denied = await outsider.get(`/api/media/attachments/${attachmentId}/pixel.png`);
    expect(denied.status).toBe(403);

    const deniedUpload = await outsider.upload(`/api/channels/${generalId}/attachments`, {
      name: "x.png",
      bytes: png,
      type: "image/png",
    });
    expect([403, 404]).toContain(deniedUpload.status);
  });

  it("J11 blocks a user and the restriction is enforced", async () => {
    const a = new TestClient(server.url);
    await a.register("journey_block_a");
    const b = new TestClient(server.url);
    await b.register("journey_block_b");

    const blocked = await a.put(`/api/users/@me/relationships/${b.userId}/block`);
    expect(blocked.status).toBe(204);

    const dmDenied = await b.post<ErrorBody>("/api/users/@me/channels", { recipientId: a.userId });
    expect(dmDenied.status).toBe(403);
    expect(dmDenied.body.error?.code).toBe("BLOCKED");

    const friendDenied = await b.post<ErrorBody>("/api/users/@me/relationships", { userId: a.userId });
    expect([400, 403]).toContain(friendDenied.status);

    const relationships = await a.get<{ relationships: RelationshipEntry[] }>("/api/users/@me/relationships");
    // Blocked relationships (type 2) are intentionally excluded from the list,
    // so assert the block indirectly: an unblock succeeds and the list stays empty.
    expect(relationships.body.relationships.some((r) => r.userId === b.userId)).toBe(false);

    const unblocked = await a.del(`/api/users/@me/relationships/${b.userId}/block`);
    expect(unblocked.status).toBe(204);
  });

  it("J12 denies unauthorized access and moderation actions", async () => {
    const owner = new TestClient(server.url);
    await owner.register("journey_sec_owner");
    const member = new TestClient(server.url);
    await member.register("journey_sec_member");
    const outsider = new TestClient(server.url);
    await outsider.register("journey_sec_outsider");

    const { guildId, generalId } = await createGuildWithGeneral(owner, "Sec Guild");
    await inviteAndJoin(owner, member, generalId);

    const guildDenied = await outsider.get<ErrorBody>(`/api/guilds/${guildId}`);
    expect([403, 404]).toContain(guildDenied.status);

    const messagesDenied = await outsider.get<ErrorBody>(`/api/channels/${generalId}/messages`);
    expect(messagesDenied.status).toBe(403);

    const deleteDenied = await member.del<ErrorBody>(`/api/guilds/${guildId}`);
    expect(deleteDenied.status).toBe(403);

    const kickDenied = await member.post<ErrorBody>(`/api/guilds/${guildId}/members/${owner.userId}/kick`, {});
    expect(kickDenied.status).toBe(403);

    const banDenied = await member.put<ErrorBody>(`/api/guilds/${guildId}/bans/${owner.userId}`, {});
    expect(banDenied.status).toBe(403);

    const anon = new TestClient(server.url);
    const anonDenied = await anon.get<ErrorBody>(`/api/guilds/${guildId}`);
    expect(anonDenied.status).toBe(401);

    // A mutation without the CSRF header is refused. The test client normally
    // attaches the token, so send this one deliberately without it.
    const noCsrfResponse = await fetch(`${server.url}/api/channels/${generalId}/messages`, {
      method: "POST",
      headers: {
        cookie: [...member.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
        "content-type": "application/json",
      },
      body: JSON.stringify({ content: "should fail" }),
    });
    expect(noCsrfResponse.status).toBe(403);
    const noCsrf = { status: noCsrfResponse.status, body: (await noCsrfResponse.json()) as ErrorBody };
    expect(noCsrf.body.error?.code).toBe("INVALID_CSRF");

    // Positive control: the owner can moderate.
    const nick = await owner.patch(`/api/guilds/${guildId}/members/${member.userId}`, { nickname: "renamed" });
    expect(nick.status).toBe(204);
  });

  it("returns a structured 404 for an unknown route", async () => {
    const client = new TestClient(server.url);
    const res = await client.get<ErrorBody>("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("NOT_FOUND");
  });
});
