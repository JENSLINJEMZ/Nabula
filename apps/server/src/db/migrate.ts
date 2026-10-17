import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../logger.js";
import { closePool, pool } from "./pool.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Idempotent, ordered, transactional SQL migration runner.
 *
 * Each `NNNN_name.sql` file is applied once (tracked in `schema_migrations`)
 * inside its own transaction, so a failed migration leaves the schema unchanged.
 * Migrations must be append-only: never edit an applied file.
 */
export async function runMigrations(): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await pool.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
  );

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  const newlyApplied: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      newlyApplied.push(file);
      logger.info("migration applied", { file });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      logger.error("migration failed", {
        file,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      client.release();
    }
  }

  if (newlyApplied.length === 0) logger.info("database already up to date", { migrations: files.length });
  return newlyApplied;
}

// Allow `tsx src/db/migrate.ts` / `npm run db:migrate`.
const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) {
  runMigrations()
    .then((applied) => {
      logger.info("migrations complete", { applied });
      return closePool();
    })
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error("migration run failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });
}
