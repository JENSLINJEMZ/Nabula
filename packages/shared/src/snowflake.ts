/**
 * Discord-style 64-bit snowflake identifiers.
 *
 * Layout (identical to Discord, for interoperability of ordering semantics):
 *   timestamp_ms - EPOCH  (42 bits) | worker (5 bits) | process (5 bits) | increment (12 bits)
 *
 * IDs are time-sortable, which gives strict chronological ordering for messages
 * and enables keyset pagination via `before`/`after` id comparison.
 *
 * They are always transported as decimal strings because they exceed
 * Number.MAX_SAFE_INTEGER.
 */
export const DISCORD_EPOCH = 1420070400000n;

export interface SnowflakeGeneratorOptions {
  /** 0-31 */
  workerId?: number;
  /** 0-31 */
  processId?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export class SnowflakeGenerator {
  private readonly workerId: bigint;
  private readonly processId: bigint;
  private readonly now: () => number;
  private increment = 0n;
  private lastTimestamp = -1n;

  constructor(options: SnowflakeGeneratorOptions = {}) {
    const worker = options.workerId ?? Math.floor(Math.random() * 32);
    const process = options.processId ?? Math.floor(Math.random() * 32);
    if (worker < 0 || worker > 31) throw new Error("workerId must be 0-31");
    if (process < 0 || process > 31) throw new Error("processId must be 0-31");
    this.workerId = BigInt(worker);
    this.processId = BigInt(process);
    this.now = options.now ?? Date.now;
  }

  next(): string {
    let timestamp = BigInt(this.now());
    if (timestamp === this.lastTimestamp) {
      this.increment = (this.increment + 1n) & 0xfffn;
      if (this.increment === 0n) {
        // Increment exhausted within the same millisecond: spin to the next ms.
        while (timestamp <= this.lastTimestamp) timestamp = BigInt(this.now());
      }
    } else if (timestamp < this.lastTimestamp) {
      // Clock moved backwards; keep monotonicity by pinning to the last timestamp.
      timestamp = this.lastTimestamp;
      this.increment = (this.increment + 1n) & 0xfffn;
    } else {
      this.increment = 0n;
    }
    this.lastTimestamp = timestamp;

    const id =
      ((timestamp - DISCORD_EPOCH) << 22n) |
      (this.workerId << 17n) |
      (this.processId << 12n) |
      this.increment;
    return id.toString();
  }
}

/** Extract the creation time (ms since Unix epoch) from a snowflake string. */
export function snowflakeTimestamp(id: string): number {
  const value = BigInt(id);
  return Number((value >> 22n) + DISCORD_EPOCH);
}

export function snowflakeToDate(id: string): Date {
  return new Date(snowflakeTimestamp(id));
}

const SNOWFLAKE_RE = /^\d{1,20}$/;

export function isValidSnowflake(id: string): boolean {
  if (!SNOWFLAKE_RE.test(id)) return false;
  try {
    const value = BigInt(id);
    return value > 0n && value < 1n << 64n;
  } catch {
    return false;
  }
}

/** Compare two snowflakes numerically. Returns <0, 0 or >0. */
export function compareSnowflakes(a: string, b: string): number {
  const av = BigInt(a);
  const bv = BigInt(b);
  return av < bv ? -1 : av > bv ? 1 : 0;
}
