import { describe, expect, it } from "vitest";
import { TestClient, useTestServer, waitFor } from "./helpers.js";

const server = useTestServer();

interface ErrorBody {
  error?: { code?: string; message?: string };
}
interface ChannelBody {
  channel?: {
    id: string;
    type?: number;
    ownerId?: string | null;
    guildId?: string | null;
    recipients?: Array<{ id: string; username: string }>;
  };
  channels?: Array<{
    id: string;
    type?: number;
    ownerId?: string | null;
    recipients?: Array<{ id: string }>;
  }>;
  deleted?: boolean;
}
interface MessageBody {
  message?: { id: string; content: string; channelId: string };
  messages?: Array<{ id: string; content: string }>;
}

function recipientIds(body: ChannelBody | undefined): string[] {
  return (body?.channel?.recipients ?? []).map((r) => r.id).sort();
}

async function createGroupDm(owner: TestClient, recipients: string[]) {
  const res = await owner.post<ChannelBody>("/api/users/@me/channels", { recipients });
  expect(res.status).toBe(201);
  return res.body.channel!;
}

describe("Group DMs", () => {
  it("creates a group DM with all participants as recipients and an owner", async () => {
    const a = new TestClient(server.url);
    const b = new TestClient(server.url);
    const c = new TestClient(server.url);
    const d = new TestClient(server.url);
    const { userId: aId } = await a.register("gd_create_a");
    const { userId: bId } = await b.register("gd_create_b");
    const { userId: cId } = await c.register("gd_create_c");
    await d.register("gd_create_d");

    const group = await createGroupDm(a, [bId, cId]);
    expect(group.type).toBe(3);
    expect(group.ownerId).toBe(aId);
    expect(recipientIds({ channel: group })).toEqual([aId, bId, cId].sort());

    // Every participant sees the group in their DM list.
    for (const client of [a, b, c]) {
      const list = await client.get<ChannelBody>("/api/users/@me/channels");
      expect(list.status).toBe(200);
      expect(list.body.channels!.map((ch) => ch.id)).toContain(group.id);
    }

    // Messages between participants persist and are readable by members.
    const posted = await b.post<MessageBody>(`/api/channels/${group.id}/messages`, { content: "hello group" });
    expect(posted.status).toBe(201);
    const read = await c.get<MessageBody>(`/api/channels/${group.id}/messages`);
    expect(read.status).toBe(200);
    expect(read.body.messages!.map((m) => m.content)).toContain("hello group");

    // Non-participants get no channel view and cannot read or post.
    const view = await d.get<ChannelBody>(`/api/channels/${group.id}`);
    expect(view.status).toBe(403);
    const readDenied = await d.get<MessageBody>(`/api/channels/${group.id}/messages`);
    expect(readDenied.status).toBe(403);
    const postDenied = await d.post<ErrorBody>(`/api/channels/${group.id}/messages`, { content: "intruder" });
    expect(postDenied.status).toBe(403);
  });

  it("refuses to put a blocked pair into the same group DM", async () => {
    const a = new TestClient(server.url);
    const b = new TestClient(server.url);
    const c = new TestClient(server.url);
    await a.register("gd_block_a");
    const { userId: bId } = await b.register("gd_block_b");
    const { userId: cId } = await c.register("gd_block_c");

    const blocked = await c.put(`/api/users/@me/relationships/${bId}/block`);
    expect(blocked.status).toBe(204);

    const res = await a.post<ErrorBody>("/api/users/@me/channels", { recipients: [bId, cId] });
    expect(res.status).toBe(403);
    expect(res.body.error!.code).toBe("BLOCKED");

    // And a blocked user cannot be added to an existing group either.
    const group = await createGroupDm(a, [bId]);
    const add = await a.post<ErrorBody>(`/api/channels/${group.id}/recipients`, { userId: cId });
    expect(add.status).toBe(403);
    expect(add.body.error!.code).toBe("BLOCKED");
  });

  it("lets any member add people and enforces membership, duplicates and blocks", async () => {
    const a = new TestClient(server.url);
    const b = new TestClient(server.url);
    const c = new TestClient(server.url);
    const d = new TestClient(server.url);
    const outsider = new TestClient(server.url);
    const blocker = new TestClient(server.url);
    const blockedTarget = new TestClient(server.url);
    const { userId: aId } = await a.register("gd_add_a");
    const { userId: bId } = await b.register("gd_add_b");
    const { userId: cId } = await c.register("gd_add_c");
    const { userId: dId } = await d.register("gd_add_d");
    const { userId: outsiderId } = await outsider.register("gd_add_out");
    const { userId: blockerId } = await blocker.register("gd_add_blk");
    const { userId: targetId } = await blockedTarget.register("gd_add_tgt");

    const group = await createGroupDm(a, [bId, cId]);

    // The owner adds a fourth member; they gain access immediately.
    const added = await a.post<ChannelBody>(`/api/channels/${group.id}/recipients`, { userId: dId });
    expect(added.status).toBe(200);
    expect(recipientIds(added.body)).toEqual([aId, bId, cId, dId].sort());
    const access = await d.get<ChannelBody>(`/api/channels/${group.id}`);
    expect(access.status).toBe(200);

    // A plain (non-owner) member may add people too.
    const addedByMember = await b.post<ChannelBody>(`/api/channels/${group.id}/recipients`, { userId: outsiderId });
    expect(addedByMember.status).toBe(200);
    expect(recipientIds(addedByMember.body)).toContain(outsiderId);

    // Adding an existing member is rejected.
    const duplicate = await a.post<ErrorBody>(`/api/channels/${group.id}/recipients`, { userId: dId });
    expect(duplicate.status).toBe(400);

    // Adding yourself is rejected.
    const selfAdd = await a.post<ErrorBody>(`/api/channels/${group.id}/recipients`, { userId: aId });
    expect(selfAdd.status).toBe(400);

    // A non-owner member may add people: blocker joins the group via outsider.
    const addedByNonOwner = await outsider.post<ChannelBody>(`/api/channels/${group.id}/recipients`, {
      userId: blockerId,
    });
    expect(addedByNonOwner.status).toBe(200);

    // Users outside the group cannot add anyone.
    const external = await blockedTarget.post<ErrorBody>(`/api/channels/${group.id}/recipients`, {
      userId: blockerId,
    });
    expect(external.status).toBe(403);

    // A blocked user cannot be added — blocker is now a member of the group.
    const block = await blocker.put(`/api/users/@me/relationships/${targetId}/block`);
    expect(block.status).toBe(204);
    const blockedAdd = await a.post<ErrorBody>(`/api/channels/${group.id}/recipients`, { userId: targetId });
    expect(blockedAdd.status).toBe(403);
    expect(blockedAdd.body.error!.code).toBe("BLOCKED");

    // Unknown users are rejected with 404, not a foreign-key crash.
    const unknown = await a.post<ErrorBody>(`/api/channels/${group.id}/recipients`, { userId: "9999999999999" });
    expect(unknown.status).toBe(404);
  });

  it("enforces the 10-participant cap", async () => {
    const owner = new TestClient(server.url);
    await owner.register("gd_cap_own");
    const members: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const client = new TestClient(server.url);
      const { userId } = await client.register(`gd_cap_${i}`);
      members.push(userId);
    }

    // Owner + 9 participants is allowed.
    const group = await createGroupDm(owner, members.slice(0, 9));
    expect(recipientIds({ channel: group })).toHaveLength(10);

    // An 11th participant is not.
    const overflow = await owner.post<ErrorBody>(`/api/channels/${group.id}/recipients`, { userId: members[9] });
    expect(overflow.status).toBe(400);

    // Creating a group with more than 9 recipients is rejected outright.
    const tooMany = await owner.post<ErrorBody>("/api/users/@me/channels", { recipients: members });
    expect(tooMany.status).toBe(400);
  });

  it("supports leaving, owner removal and permission enforcement", async () => {
    const a = new TestClient(server.url);
    const b = new TestClient(server.url);
    const c = new TestClient(server.url);
    const d = new TestClient(server.url);
    const { userId: aId } = await a.register("gd_rm_a");
    const { userId: bId } = await b.register("gd_rm_b");
    const { userId: cId } = await c.register("gd_rm_c");
    const { userId: dId } = await d.register("gd_rm_d");

    const group = await createGroupDm(a, [bId, cId]);
    const added = await a.post<ChannelBody>(`/api/channels/${group.id}/recipients`, { userId: dId });
    expect(added.status).toBe(200);

    // Anyone may remove themselves (leave).
    const left = await d.del<ChannelBody>(`/api/channels/${group.id}/recipients/${dId}`);
    expect(left.status).toBe(200);
    expect(recipientIds(left.body)).toEqual([aId, bId, cId].sort());
    const dAccess = await d.get<ErrorBody>(`/api/channels/${group.id}`);
    expect(dAccess.status).toBe(403);
    const dMessages = await d.get<ErrorBody>(`/api/channels/${group.id}/messages`);
    expect(dMessages.status).toBe(403);
    const dList = await d.get<ChannelBody>("/api/users/@me/channels");
    expect(dList.body.channels!.map((ch) => ch.id)).not.toContain(group.id);

    // Only the owner may remove somebody else.
    const nonOwnerRemoval = await b.del<ErrorBody>(`/api/channels/${group.id}/recipients/${cId}`);
    expect(nonOwnerRemoval.status).toBe(403);
    expect(nonOwnerRemoval.body.error!.code).toBe("MISSING_PERMISSIONS");

    // Removing a user who is not in the group is rejected.
    const notMember = await a.del<ErrorBody>(`/api/channels/${group.id}/recipients/${dId}`);
    expect(notMember.status).toBe(400);

    // Outsiders can remove nobody.
    const outsiderRemoval = await d.del<ErrorBody>(`/api/channels/${group.id}/recipients/${bId}`);
    expect(outsiderRemoval.status).toBe(403);

    // The owner removes another member.
    const removed = await a.del<ChannelBody>(`/api/channels/${group.id}/recipients/${bId}`);
    expect(removed.status).toBe(200);
    expect(recipientIds(removed.body)).toEqual([aId, cId].sort());
    const bAccess = await b.get<ErrorBody>(`/api/channels/${group.id}`);
    expect(bAccess.status).toBe(403);
  });

  it("transfers ownership when the owner leaves and closes the group below two members", async () => {
    const a = new TestClient(server.url);
    const b = new TestClient(server.url);
    const c = new TestClient(server.url);
    const { userId: aId } = await a.register("gd_own_a");
    const { userId: bId } = await b.register("gd_own_b");
    const { userId: cId } = await c.register("gd_own_c");

    const group = await createGroupDm(a, [bId, cId]);

    // The owner leaves: ownership passes to a remaining member.
    const ownerLeft = await a.del<ChannelBody>(`/api/channels/${group.id}/recipients/${aId}`);
    expect(ownerLeft.status).toBe(200);
    expect(ownerLeft.body.channel!.ownerId).not.toBe(aId);
    expect([bId, cId]).toContain(ownerLeft.body.channel!.ownerId);

    // The new owner can still manage the group: removing the last other member
    // drops the group below two participants and closes it for everyone.
    const newOwner = ownerLeft.body.channel!.ownerId!;
    const ownerClient = newOwner === bId ? b : c;
    const otherId = newOwner === bId ? cId : bId;
    const lastClient = otherId === bId ? b : c;
    const removal = await ownerClient.del<ChannelBody>(`/api/channels/${group.id}/recipients/${otherId}`);
    expect(removal.status).toBe(200);
    expect(removal.body.deleted).toBe(true);

    // The group closed for the last participant and left nobody's sidebar.
    const lastList = await lastClient.get<ChannelBody>("/api/users/@me/channels");
    expect(lastList.body.channels!.map((ch) => ch.id)).not.toContain(group.id);
    const bList = await b.get<ChannelBody>("/api/users/@me/channels");
    expect(bList.body.channels!.map((ch) => ch.id)).not.toContain(group.id);
    const aList = await a.get<ChannelBody>("/api/users/@me/channels");
    expect(aList.body.channels!.map((ch) => ch.id)).not.toContain(group.id);
    // The removed participant lost access entirely.
    const lastAccess = await lastClient.get<ErrorBody>(`/api/channels/${group.id}`);
    expect(lastAccess.status).toBe(403);
  });

  it("refuses participant management on non-group channels", async () => {
    const a = new TestClient(server.url);
    const b = new TestClient(server.url);
    const c = new TestClient(server.url);
    await a.register("gd_nm_a");
    const { userId: bId } = await b.register("gd_nm_b");
    const { userId: cId } = await c.register("gd_nm_c");

    // 1:1 DMs are not group DMs.
    const dm = await a.post<ChannelBody>("/api/users/@me/channels", { recipientId: bId });
    expect(dm.status).toBe(201);
    const dmId = dm.body.channel!.id;
    const dmAdd = await a.post<ErrorBody>(`/api/channels/${dmId}/recipients`, { userId: cId });
    expect(dmAdd.status).toBe(404);
    const dmRemove = await a.del<ErrorBody>(`/api/channels/${dmId}/recipients/${bId}`);
    expect(dmRemove.status).toBe(404);

    // Guild channels are not group DMs either.
    const guild = await a.post<{ guild: { id: string } }>("/api/guilds", { name: "GD Not A DM" });
    const channels = await a.get<{ channels: Array<{ id: string; type: number }> }>(
      `/api/guilds/${guild.body.guild!.id}/channels`,
    );
    const general = channels.body.channels!.find((ch) => ch.type === 0)!;
    const guildAdd = await a.post<ErrorBody>(`/api/channels/${general.id}/recipients`, { userId: cId });
    expect(guildAdd.status).toBe(404);
  });

  it("delivers group DMs and membership changes to connected clients in real time", async () => {
    const a = new TestClient(server.url);
    const b = new TestClient(server.url);
    const c = new TestClient(server.url);
    const { userId: bId } = await b.register("gd_rt_b");
    const { userId: cId } = await c.register("gd_rt_c");
    await a.register("gd_rt_a");

    const socketA = await a.socket();
    const socketB = await b.socket();
    const socketC = await c.socket();
    // The gateway re-emits READY on IDENTIFY; registering the waiters first
    // makes this race-free (the connect-time READY may already be gone).
    const readyA = waitFor(socketA, "READY");
    const readyB = waitFor(socketB, "READY");
    const readyC = waitFor(socketC, "READY");
    socketA.emit("IDENTIFY");
    socketB.emit("IDENTIFY");
    socketC.emit("IDENTIFY");
    await Promise.all([readyA, readyB, readyC]);

    // Collected message stream for the negative assertion after leaving.
    const seenByC: string[] = [];
    socketC.on("MESSAGE_CREATE", (message: { id?: string }) => {
      if (message?.id) seenByC.push(message.id);
    });

    // b is online before the group exists: creation must reach their client and
    // subscribe their socket to the new channel room without a reconnect.
    const createForB = waitFor<{ id: string; type?: number; recipients?: Array<{ id: string }> }>(
      socketB,
      "CHANNEL_CREATE",
      (payload) => payload?.type === 3,
    );
    const group = await createGroupDm(a, [bId]);
    const created = await createForB;
    expect(created.id).toBe(group.id);
    expect((created.recipients ?? []).map((r) => r.id).sort()).toEqual([a.userId!, bId].sort());

    // Adding c notifies c (CHANNEL_CREATE) and the existing members (CHANNEL_UPDATE).
    const createForC = waitFor<{ id: string }>(socketC, "CHANNEL_CREATE", (p) => p?.id === group.id);
    const updateForB = waitFor<{ id: string; recipients?: Array<{ id: string }> }>(
      socketB,
      "CHANNEL_UPDATE",
      (p) => p?.id === group.id,
    );
    const added = await a.post<ChannelBody>(`/api/channels/${group.id}/recipients`, { userId: cId });
    expect(added.status).toBe(200);
    const [fromC, fromB] = await Promise.all([createForC, updateForB]);
    expect(fromC.id).toBe(group.id);
    expect((fromB.recipients ?? []).map((r) => r.id)).toContain(cId);

    // A message right after the add reaches the newly added participant —
    // proving their socket was joined to the channel room without reconnecting.
    const firstMessage = waitFor<{ id: string; channelId: string }>(
      socketC,
      "MESSAGE_CREATE",
      (m) => m?.channelId === group.id,
    );
    const posted = await a.post<MessageBody>(`/api/channels/${group.id}/messages`, { content: "realtime hello" });
    expect(posted.status).toBe(201);
    const delivered = await firstMessage;
    expect(delivered.id).toBe(posted.body.message!.id);

    // c leaves: their client is told and they stop receiving messages.
    const deleteForC = waitFor<{ id: string; guildId: string | null }>(
      socketC,
      "CHANNEL_DELETE",
      (p) => p?.id === group.id,
    );
    const left = await c.del<ChannelBody>(`/api/channels/${group.id}/recipients/${cId}`);
    expect(left.status).toBe(200);
    expect((await deleteForC).guildId).toBeNull();

    // Registered before posting: same-channel broadcasts are ordered, so once
    // the barrier arrives on a still-subscribed socket, "after leave" would
    // have arrived first if c were still in the room.
    const barrier = waitFor<{ content?: string }>(socketB, "MESSAGE_CREATE", (m) => m?.content === "sync barrier");
    const messageOne = await a.post<MessageBody>(`/api/channels/${group.id}/messages`, { content: "after leave" });
    await a.post<MessageBody>(`/api/channels/${group.id}/messages`, { content: "sync barrier" });
    await barrier;
    expect(seenByC).toContain(posted.body.message!.id);
    expect(seenByC).not.toContain(messageOne.body.message!.id);

    socketA.disconnect();
    socketB.disconnect();
    socketC.disconnect();
  });
});
