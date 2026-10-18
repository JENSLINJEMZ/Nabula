import { describe, expect, it } from "vitest";
import { TestClient, useTestServer, waitFor } from "./helpers.js";

const server = useTestServer();

interface ErrorBody {
  error?: { code?: string; message?: string };
}
interface GuildBody {
  guild?: { id: string };
}
interface ChannelBody {
  channel?: { id: string; type?: number; name?: string; parentId?: string | null; ownerId?: string | null };
  thread?: { id: string; type?: number; name?: string; parentId?: string | null; ownerId?: string | null };
  channels?: Array<{ id: string; type: number; name?: string }>;
  threads?: Array<{ id: string; type: number; name?: string; parentId?: string | null; ownerId?: string | null }>;
}
interface MessageBody {
  message?: { id: string; content: string; channelId: string; type?: number; threadId?: string | null };
  messages?: Array<{ id: string; content: string; channelId: string; type?: number }>;
}

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

describe("Threads", () => {
  it("creates a public thread from a message, promotes the starter, and lists it", async () => {
    const owner = new TestClient(server.url);
    await owner.register("thread_owner");
    const { generalId } = await createGuildWithGeneral(owner, "Thread Guild");

    const starter = await owner.post<MessageBody>(`/api/channels/${generalId}/messages`, { content: "kick off" });
    expect(starter.status).toBe(201);
    const starterId = starter.body.message!.id;

    const created = await owner.post<ChannelBody>(`/api/channels/${generalId}/threads`, {
      name: "kick off thread",
      messageId: starterId,
    });
    expect(created.status).toBe(201);
    const thread = created.body.thread!;
    expect(thread.type).toBe(11);
    expect(thread.parentId).toBe(generalId);

    // The starter message is promoted to THREAD_STARTER_MESSAGE and points at the thread.
    const refreshed = await owner.get<MessageBody>(`/api/channels/${generalId}/messages/${starterId}`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.message!.type).toBe(21);
    expect(refreshed.body.message!.threadId).toBe(thread.id);

    const list = await owner.get<ChannelBody>(`/api/channels/${generalId}/threads`);
    expect(list.status).toBe(200);
    expect(list.body.threads!.map((t) => t.id)).toContain(thread.id);
  });

  it("exposes the promoted thread starter to a connected peer in real time", async () => {
    const owner = new TestClient(server.url);
    await owner.register("thread_rt_owner");
    const peer = new TestClient(server.url);
    await peer.register("thread_rt_peer");
    const { generalId } = await createGuildWithGeneral(owner, "Thread RT Guild");
    await inviteAndJoin(owner, peer, generalId);

    const starter = await owner.post<MessageBody>(`/api/channels/${generalId}/messages`, { content: "thread me" });
    const starterId = starter.body.message!.id;

    const socket = await peer.socket();
    // The gateway subscribes the socket to every accessible channel room on
    // connect, so the peer receives updates for the parent channel.
    await waitFor(socket, "READY");

    // Register the waiter before triggering the broadcast so the event cannot
    // be missed between the request and listener registration.
    const updatedPromise = waitFor<MessageBody["message"]>(
      socket,
      "MESSAGE_UPDATE",
      (m) => !!m && m.id === starterId && m.type === 21,
    );

    const created = await owner.post<ChannelBody>(`/api/channels/${generalId}/threads`, {
      name: "realtime thread",
      messageId: starterId,
    });
    expect(created.status).toBe(201);

    const updated = await updatedPromise;
    expect(updated.threadId).toBe(created.body.thread!.id);
    socket.disconnect();
  });

  it("thread messages persist and are visible to members", async () => {
    const owner = new TestClient(server.url);
    await owner.register("thread_msg_owner");
    const member = new TestClient(server.url);
    await member.register("thread_msg_member");
    const { generalId } = await createGuildWithGeneral(owner, "Thread Msg Guild");
    await inviteAndJoin(owner, member, generalId);

    const created = await owner.post<ChannelBody>(`/api/channels/${generalId}/threads`, { name: "persist" });
    const threadId = created.body.thread!.id;

    const posted = await owner.post<MessageBody>(`/api/channels/${threadId}/messages`, { content: "hello thread" });
    expect(posted.status).toBe(201);
    expect(posted.body.message!.channelId).toBe(threadId);

    const asMember = await member.get<MessageBody>(`/api/channels/${threadId}/messages`);
    expect(asMember.status).toBe(200);
    expect(asMember.body.messages!.some((m) => m.content === "hello thread")).toBe(true);
  });

  it("denies a non-member access to a private thread (REST authorization)", async () => {
    const owner = new TestClient(server.url);
    await owner.register("thread_priv_owner");
    const outsider = new TestClient(server.url);
    await outsider.register("thread_priv_outsider");
    const { generalId } = await createGuildWithGeneral(owner, "Private Thread Guild");
    await inviteAndJoin(owner, outsider, generalId);

    const created = await owner.post<ChannelBody>(`/api/channels/${generalId}/threads`, {
      name: "secret",
      type: 12,
    });
    expect(created.status).toBe(201);
    const threadId = created.body.thread!.id;

    // The outsider is a guild member but not a thread member: reads and writes are refused.
    const read = await outsider.get<MessageBody>(`/api/channels/${threadId}/messages`);
    expect(read.status).toBe(403);

    const write = await outsider.post<ErrorBody>(`/api/channels/${threadId}/messages`, { content: "peek" });
    expect(write.status).toBe(403);

    // ...and the private thread is not listed for them.
    const list = await outsider.get<ChannelBody>(`/api/channels/${generalId}/threads`);
    expect(list.body.threads!.map((t) => t.id)).not.toContain(threadId);

    // The owner retains access.
    const ownerRead = await owner.get<MessageBody>(`/api/channels/${threadId}/messages`);
    expect(ownerRead.status).toBe(200);
  });
});
