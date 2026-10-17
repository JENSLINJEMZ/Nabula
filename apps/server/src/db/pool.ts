import pg from "pg";
import { env } from "../config.js";
import { logger } from "../logger.js";

/**
 * PostgreSQL access layer.
 *
 * - Every query is parameterized; string interpolation into SQL is never used.
 * - BIGINT/NUMERIC columns are returned as strings by node-postgres, which we
 *   treat as opaque ids / serialized bitfields (never coerced to Number).
 */

// node-postgres returns int8 (BIGINT) and numeric as strings by default. We rely
// on that, but assert it explicitly so a future default change cannot silently
// corrupt ids by converting them to imprecise Numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => v);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v: string) => v);

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.NODE_ENV === "test" ? 5 : 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: `nebula-${env.NODE_ENV}`,
});

pool.on("error", (err) => {
  logger.error("postgres pool error", { error: err.message });
});

export type QueryParam = unknown;

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: QueryParam[],
  ): Promise<pg.QueryResult<R>>;
}

export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: QueryParam[] = [],
): Promise<R[]> {
  const started = Date.now();
  const result = await pool.query<R>(text, params);
  const elapsed = Date.now() - started;
  if (elapsed > 200) {
    logger.warn("slow query", { elapsed_ms: elapsed, sql: text.slice(0, 160) });
  }
  return result.rows;
}

export async function queryOne<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: QueryParam[] = [],
): Promise<R | null> {
  const rows = await query<R>(text, params);
  return rows[0] ?? null;
}

export async function execute(text: string, params: QueryParam[] = []): Promise<number> {
  const result = await pool.query(text, params);
  return result.rowCount ?? 0;
}

export type Tx = pg.PoolClient;

/**
 * Run `fn` inside a serializable-enough READ COMMITTED transaction. On throw the
 * transaction is rolled back and the error re-thrown. Use for any multi-step
 * write (e.g. create guild + owner membership + default roles + channels).
 */
export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      logger.error("transaction rollback failed", {
        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function txQuery<R extends pg.QueryResultRow = pg.QueryResultRow>(
  tx: Tx,
  text: string,
  params: QueryParam[] = [],
): Promise<R[]> {
  const result = await tx.query<R>(text, params);
  return result.rows;
}

export async function txQueryOne<R extends pg.QueryResultRow = pg.QueryResultRow>(
  tx: Tx,
  text: string,
  params: QueryParam[] = [],
): Promise<R | null> {
  const rows = await txQuery<R>(tx, text, params);
  return rows[0] ?? null;
}

export async function closePool(): Promise<void> {
  await pool.end();
}

export async function pingDatabase(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
