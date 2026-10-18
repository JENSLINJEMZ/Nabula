import type { Socket as ClientSocket } from "socket.io-client";
import { describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { TestClient, useTestServer, waitFor } from "./helpers.js";

const server = useTestServer();

interface ErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}
interface CommandBody {
  commands?: Array<{
    id: string;
    name: string;
    usage: string;
    description: string;
    ephemeral: boolean;
    dmCapable: boolean;
    options: Array<{ name: string; description: string; type: number; required: boolean; example?: string }>;
  }>;
  result?: {
    command: string;
    invocationId: string | null;
    channelId: string;
    content: string;
    ephemeral: boolean;
  };
}
interface MessageBody {
  messages?: Array<{
    id: string;
    content: string;
    reactions?: Array<{ emoji: string; count: number; me: boolean }>;
  }>;
}
interface ChannelBody {
  channel?: { id: string; topic?: string | null };
  channels?: Array<{ id: string; type: number; name?: string; topic?: string | null }>;
}

async function createGuildWithGeneral(client: TestClient, name: string) {
  const created = await client.post<{ guild?: { id: string } }>("/api/guilds", { name });
  expect(created.status).toBe(201);
  const guildId = created.body.guild!.id;
  const channels = await client.get<ChannelBody>(`/api/guilds/${guildId}/channels`);
  const general = channels.body.channels!.find((c) => c.type === 0)!;
  return { guildId, generalId: general.id };
}

async function inviteAndJoin(owner: TestClient, member: TestClient, channelId: string) {
  const invite = await owner.post<{ invite: { code: string } }>(`/api/channels/${channelId}/invites`, {});
  expect(invite.status).toBe(201);
  const joined = await member.post(`/api/invites/${invite.body.invite.code}`, {});
  expect(joined.status).toBe(200);
}

/** Fail loudly if an event arrives within `ms`; resolve quietly otherwise. */
function expectNoEvent(socket: ClientSocket, event: string, ms: number) {
  return new Promise<void>((resolve, reject) => {
    const handler = () => {
      socket.off(event, handler);
      reject(new Error(`unexpected ${event}`));
    };
    socket.on(event, handler);
    setTimeout(() => {
      socket.off(event, handler);
      resolve();
    }, ms);
  });
}

describe("Slash commands", () => {
  it("discovers built-in commands with usage and argument metadata", async () => {
    const client = new TestClient(server.url);
    await client.register("cmd_discover");
    const res = await client.get<CommandBody>("/api/commands");
    expect(res.status).toBe(200);
    const byName = new Map(res.body.commands!.map((c) => [c.name, c]));

    expect(byName.has("ping")).toBe(true);
    expect(byName.has("me")).toBe(true);
    expect(byName.has("poll")).toBe(true);
    expect(byName.has("topic")).toBe(true);

    // Metadata drives the composer autocomplete + argument hints.
    expect(byName.get("poll")!.usage).toContain("|");
    expect(byName.get("me")!.options[0]!.required).toBe(true);
    expect(byName.get("ping")!.ephemeral).toBe(true);
    expect(byName.get("me")!.ephemeral).toBe(false);
  });

  it("executes a content command and persists the resulting message", async () => {
    const owner = new TestClient(server.url);
    await owner.register("cmd_me");
    const { generalId } = await createGuildWithGeneral(owner, "Cmd Me Guild");

    const res = await owner.post<CommandBody>("/api/interactions", {
      content: "/me waves at the team",
      channelId: generalId,
    });
    expect(res.status).toBe(200);
    expect(res.body.result!.ephemeral).toBe(false);
    expect(res.body.result!.command).toBe("me");

    const history = await owner.get<MessageBody>(`/api/channels/${generalId}/messages`);
    const posted = history.body.messages!.at(-1)!;
    expect(posted.content).toBe("_waves at the team_");
  });

  it("answers informational commands ephemerally, only to the invoker", async () => {
    const owner = new TestClient(server.url);
    await owner.register("cmd_eph_owner");
    const member = new TestClient(server.url);
    await member.register("cmd_eph_member");
    const { generalId } = await createGuildWithGeneral(owner, "Cmd Ephemeral Guild");
    await inviteAndJoin(owner, member, generalId);

    const ownerSocket = await owner.socket();
    const ownerReady = waitFor(ownerSocket, "READY");
    ownerSocket.emit("IDENTIFY");
    await ownerReady;

    const memberSocket = await member.socket();
    const memberReady = waitFor(memberSocket, "READY");
    memberSocket.emit("IDENTIFY");
    await memberReady;

    const before = (await owner.get<MessageBody>(`/api/channels/${generalId}/messages`)).body.messages!.length;

    // Register waiters before triggering the invocation.
    const resultPromise = waitFor<{ command: string; content: string; invocationId: string | null; ephemeral: boolean }>(
      ownerSocket,
      "INTERACTION_RESULT",
      (r) => r?.command === "ping",
    );
    const noLeak = expectNoEvent(memberSocket, "INTERACTION_RESULT", 400);

    const res = await owner.post<CommandBody>("/api/interactions", {
      name: "ping",
      channelId: generalId,
      invocationId: "inv-ping-1",
    });
    expect(res.status).toBe(200);
    expect(res.body.result!.ephemeral).toBe(true);
    expect(res.body.result!.content).toContain("Pong");

    const delivered = await resultPromise;
    expect(delivered.invocationId).toBe("inv-ping-1");
    await noLeak;

    // Ephemeral responses are never persisted.
    const after = (await owner.get<MessageBody>(`/api/channels/${generalId}/messages`)).body.messages!.length;
    expect(after).toBe(before);

    ownerSocket.disconnect();
    memberSocket.disconnect();
  });

  it("validates required, optional and unknown arguments with usage hints", async () => {
    const owner = new TestClient(server.url);
    await owner.register("cmd_args");
    const { generalId } = await createGuildWithGeneral(owner, "Cmd Args Guild");

    // Missing required argument → usage is echoed back.
    const missing = await owner.post<ErrorBody>("/api/interactions", { content: "/me", channelId: generalId });
    expect(missing.status).toBe(400);
    expect(missing.body.error?.code).toBe("VALIDATION_FAILED");
    expect(missing.body.error?.details?.usage).toBe("/me <text>");

    // Optional argument omitted.
    const bare = await owner.post<CommandBody>("/api/interactions", { content: "/shrug", channelId: generalId });
    expect(bare.status).toBe(200);
    const afterBare = await owner.get<MessageBody>(`/api/channels/${generalId}/messages`);
    expect(afterBare.body.messages!.at(-1)!.content).toBe("¯\\_(ツ)_/¯");

    // Optional argument provided (trailing tokens join).
    await owner.post("/api/interactions", { content: "/shrug hello there", channelId: generalId });
    const afterText = await owner.get<MessageBody>(`/api/channels/${generalId}/messages`);
    expect(afterText.body.messages!.at(-1)!.content).toBe("hello there ¯\\_(ツ)_/¯");

    // Unknown structured argument is rejected.
    const unknown = await owner.post<ErrorBody>("/api/interactions", {
      name: "poll",
      channelId: generalId,
      args: { bogus: "x" },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error?.code).toBe("VALIDATION_FAILED");

    // Non-integer where an integer is required.
    const badInt = await owner.post<ErrorBody>("/api/interactions", {
      name: "slowmode",
      channelId: generalId,
      args: { seconds: "not-a-number" },
    });
    expect(badInt.status).toBe(400);
    expect(badInt.body.error?.code).toBe("VALIDATION_FAILED");
  });

  it("rejects unknown and malformed commands", async () => {
    const owner = new TestClient(server.url);
    await owner.register("cmd_bad");
    const { generalId } = await createGuildWithGeneral(owner, "Cmd Bad Guild");

    const unknown = await owner.post<ErrorBody>("/api/interactions", { content: "/definitely-not-real", channelId: generalId });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error?.code).toBe("NOT_FOUND");

    const notCommand = await owner.post<ErrorBody>("/api/interactions", { content: "just a normal message", channelId: generalId });
    expect(notCommand.status).toBe(400);
    expect(notCommand.body.error?.code).toBe("VALIDATION_FAILED");

    const unknownName = await owner.post<ErrorBody>("/api/interactions", { name: "nope", channelId: generalId });
    expect(unknownName.status).toBe(404);

    const nothing = await owner.post<ErrorBody>("/api/interactions", { channelId: generalId });
    expect(nothing.status).toBe(400);
  });

  it("enforces permissions for administrative commands", async () => {
    const owner = new TestClient(server.url);
    await owner.register("cmd_perm_owner");
    const member = new TestClient(server.url);
    await member.register("cmd_perm_member");
    const outsider = new TestClient(server.url);
    await outsider.register("cmd_perm_outsider");
    const { generalId } = await createGuildWithGeneral(owner, "Cmd Perm Guild");
    await inviteAndJoin(owner, member, generalId);

    const slowmode = await member.post<ErrorBody>("/api/interactions", {
      name: "slowmode",
      channelId: generalId,
      args: { seconds: 5 },
    });
    expect(slowmode.status).toBe(403);
    expect(slowmode.body.error?.code).toBe("MISSING_PERMISSIONS");

    const timeout = await member.post<ErrorBody>("/api/interactions", {
      name: "timeout",
      channelId: generalId,
      args: { user: owner.userId, seconds: 60 },
    });
    expect(timeout.status).toBe(403);

    // Setting a topic requires MANAGE_CHANNELS...
    const setTopic = await member.post<ErrorBody>("/api/interactions", { content: "/topic sneaky", channelId: generalId });
    expect(setTopic.status).toBe(403);
    // ...but viewing the topic does not.
    const viewTopic = await member.post<CommandBody>("/api/interactions", { name: "topic", channelId: generalId });
    expect(viewTopic.status).toBe(200);
    expect(viewTopic.body.result!.ephemeral).toBe(true);

    // A non-member cannot run commands in the channel at all.
    const foreign = await outsider.post<ErrorBody>("/api/interactions", { name: "ping", channelId: generalId });
    expect([403, 404]).toContain(foreign.status);

    // Administrative commands are guild-only and rejected in direct messages.
    const dm = await owner.post<{ channel: { id: string } }>("/api/users/@me/channels", { recipientId: member.userId });
    expect([200, 201]).toContain(dm.status);
    const dmSlowmode = await owner.post<ErrorBody>("/api/interactions", {
      name: "slowmode",
      channelId: dm.body.channel.id,
      args: { seconds: 5 },
    });
    expect(dmSlowmode.status).toBe(400);
    expect(dmSlowmode.body.error?.code).toBe("VALIDATION_FAILED");
  });

  it("creates a poll with seeded vote reactions", async () => {
    const owner = new TestClient(server.url);
    await owner.register("cmd_poll");
    const { generalId } = await createGuildWithGeneral(owner, "Cmd Poll Guild");

    const res = await owner.post<CommandBody>("/api/interactions", {
      content: "/poll Best pet? | Cats | Dogs",
      channelId: generalId,
    });
    expect(res.status).toBe(200);

    const history = await owner.get<MessageBody>(`/api/channels/${generalId}/messages`);
    const poll = history.body.messages!.find((m) => m.content.includes("Best pet?"))!;
    expect(poll.content).toContain("Cats");
    expect(poll.content).toContain("Dogs");
    const emojis = (poll.reactions ?? []).map((r) => r.emoji);
    expect(emojis).toContain("1️⃣");
    expect(emojis).toContain("2️⃣");

    const tooFew = await owner.post<ErrorBody>("/api/interactions", { content: "/poll Only a question", channelId: generalId });
    expect(tooFew.status).toBe(400);
    expect(tooFew.body.error?.code).toBe("VALIDATION_FAILED");

    const oneChoice = await owner.post<ErrorBody>("/api/interactions", { content: "/poll Q | only", channelId: generalId });
    expect(oneChoice.status).toBe(400);
  });

  it("does not duplicate a message when a repeated invocation id is replayed", async () => {
    const owner = new TestClient(server.url);
    await owner.register("cmd_idem");
    const { generalId } = await createGuildWithGeneral(owner, "Cmd Idem Guild");

    const before = (await owner.get<MessageBody>(`/api/channels/${generalId}/messages`)).body.messages!.length;
    const body = { content: "/me once only", channelId: generalId, invocationId: "replay-key-1" };
    const first = await owner.post<CommandBody>("/api/interactions", body);
    const second = await owner.post<CommandBody>("/api/interactions", body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.result!.invocationId).toBe("replay-key-1");

    const after = (await owner.get<MessageBody>(`/api/channels/${generalId}/messages`)).body.messages!.length;
    expect(after).toBe(before + 1);
  });

  it("rate limits rapid invocations", async () => {
    const owner = new TestClient(server.url);
    await owner.register("cmd_rate");
    const { generalId } = await createGuildWithGeneral(owner, "Cmd Rate Guild");

    let limited = 0;
    for (let i = 0; i < 25; i++) {
      const res = await owner.post<ErrorBody>("/api/interactions", { name: "ping", channelId: generalId });
      if (res.status === 429) {
        expect(res.body.error?.code).toBe("RATE_LIMITED");
        limited += 1;
      } else {
        expect(res.status).toBe(200);
      }
    }
    expect(limited).toBeGreaterThan(0);
  });
});
