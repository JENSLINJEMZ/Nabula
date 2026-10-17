import { SnowflakeGenerator } from "@nebula/shared";

/**
 * Process-wide snowflake generator. Worker/process ids are derived from the
 * environment so that multiple server processes do not collide.
 */
const workerId = Number.parseInt(process.env.SNOWFLAKE_WORKER_ID ?? "", 10);
const processId = Number.parseInt(process.env.SNOWFLAKE_PROCESS_ID ?? "", 10);

export const ids = new SnowflakeGenerator({
  ...(Number.isInteger(workerId) && workerId >= 0 && workerId <= 31 ? { workerId } : {}),
  ...(Number.isInteger(processId) && processId >= 0 && processId <= 31 ? { processId } : {}),
});

export function nextId(): string {
  return ids.next();
}
