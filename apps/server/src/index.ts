import { env } from "./config.js";
import { logger } from "./logger.js";
import { closePool, pingDatabase } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { buildApp } from "./http/app.js";
import { attachGateway, shutdownGateway } from "./realtime/gateway.js";
import { ensureStorageReady } from "./domain/storage.js";
import { ensureBuiltinCommands } from "./domain/slashCommands.js";
import { purgeExpiredSessions } from "./auth/sessions.js";

async function main(): Promise<void> {
  logger.info("starting nebula server", { env: env.NODE_ENV, port: env.PORT });

  const dbUp = await pingDatabase();
  if (!dbUp) {
    logger.error("database unreachable", { database_url: "redacted" });
    process.exit(1);
  }

  // Apply pending migrations before serving traffic.
  const applied = await runMigrations();
  if (applied.length > 0) logger.info("applied migrations", { files: applied });

  await ensureStorageReady();
  await ensureBuiltinCommands();

  const app = await buildApp();
  await app.listen({ port: env.PORT, host: env.HOST });

  const io = attachGateway(app.server);
  logger.info("nebula server ready", { port: env.PORT, origin: env.PUBLIC_WEB_ORIGIN });

  // Housekeeping loop: purge long-expired sessions hourly.
  const housekeeping = setInterval(() => {
    void purgeExpiredSessions()
      .then((count) => {
        if (count > 0) logger.info("purged expired sessions", { count });
      })
      .catch((error) => logger.warn("session purge failed", { error: String(error) }));
  }, 60 * 60 * 1000);
  housekeeping.unref();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });
    clearInterval(housekeeping);
    try {
      await shutdownGateway(io);
      await app.close();
      await closePool();
    } catch (error) {
      logger.error("shutdown error", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error("fatal startup error", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
