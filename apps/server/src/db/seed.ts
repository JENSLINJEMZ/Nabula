import { randomBytes } from "node:crypto";
import { env } from "../config.js";
import { logger } from "../logger.js";
import { closePool } from "./pool.js";
import { runMigrations } from "./migrate.js";
import { createUser } from "../domain/users.js";
import { createGuild, getGuildRow, updateGuild } from "../domain/guilds.js";
import { listGuildChannelsForUser } from "../domain/channels.js";
import { sendFriendRequest, acceptFriendRequest } from "../domain/relationships.js";
import { forTesting, deriveSeedPassword } from "./seed.util.js";

/**
 * Development/demo seed. Deterministic, idempotent-by-email: re-running will not
 * duplicate users or guilds (it checks for an existing marker user first).
 *
 * Passwords are only logged in non-production. In production this script refuses
 * to run unless SEED_ALLOW_PRODUCTION=true, because it creates known credentials.
 */
async function main(): Promise<void> {
  if (env.NODE_ENV === "production" && process.env.SEED_ALLOW_PRODUCTION !== "true") {
    logger.error("refusing to seed a production database without SEED_ALLOW_PRODUCTION=true");
    process.exit(1);
  }

  await runMigrations();

  const existing = await forTesting.findUserByUsername("nebula_alice");
  if (existing) {
    logger.info("seed already applied; skipping", { userId: existing.id });
    await closePool();
    return;
  }

  const password = deriveSeedPassword();
  logger.info("seeding demo data", { password: env.NODE_ENV === "production" ? "redacted" : password });

  const alice = await createUser({
    username: "nebula_alice",
    password,
    email: "alice@example.test",
    displayName: "Alice",
  });
  const bob = await createUser({
    username: "nebula_bob",
    password,
    email: "bob@example.test",
    displayName: "Bob",
  });
  const carol = await createUser({
    username: "nebula_carol",
    password,
    email: "carol@example.test",
    displayName: "Carol",
  });

  const guild = await createGuild(alice.id, { name: "Nebula Labs", description: "The demo server." });
  await getGuildRow(guild.id);

  // Bob and Carol join.
  const { addGuildMember } = await import("../domain/guilds.js");
  await addGuildMember(guild.id, bob.id);
  await addGuildMember(guild.id, carol.id);

  const channels = await listGuildChannelsForUser(guild.id, alice.id);
  const general = channels.find((c) => c.name === "general");
  const voice = channels.find((c) => c.type === 2 && c.name === "General");

  if (general) {
    const { createMessage } = await import("../domain/messages.js");
    await createMessage({
      channelId: general.id,
      authorId: alice.id,
      content: "Welcome to **Nebula**! This server was created by the seed script.",
    });
    await createMessage({
      channelId: general.id,
      authorId: bob.id,
      content: "Hey <@" + alice.id + "> — glad to be here.",
    });
    await createMessage({
      channelId: general.id,
      authorId: carol.id,
      content: "This is a real message stored in PostgreSQL, delivered over Socket.IO.",
    });
  }

  if (voice) logger.info("voice channel ready", { channelId: voice.id });

  // Friendships: Alice <-> Bob accepted, Carol outgoing to Alice.
  await sendFriendRequest(alice.id, bob.id);
  await acceptFriendRequest(bob.id, alice.id);
  await sendFriendRequest(carol.id, alice.id);

  await updateGuild(guild.id, alice.id, { description: "The demo server." });

  logger.info("seed complete", {
    users: { alice: alice.id, bob: bob.id, carol: carol.id },
    guildId: guild.id,
    generalChannelId: general?.id ?? null,
  });

  await closePool();
}

main().catch((error) => {
  logger.error("seed failed", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});

void randomBytes;
