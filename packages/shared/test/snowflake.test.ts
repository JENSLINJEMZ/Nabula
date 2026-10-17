import { describe, expect, it } from "vitest";
import { SnowflakeGenerator, compareSnowflakes, isValidSnowflake, snowflakeTimestamp } from "../src/snowflake.js";

describe("snowflake", () => {
  it("encodes the timestamp so ids sort chronologically", () => {
    let clock = 1_700_000_000_000;
    const gen = new SnowflakeGenerator({ workerId: 1, processId: 1, now: () => clock });
    const a = gen.next();
    clock += 1000;
    const b = gen.next();
    expect(compareSnowflakes(a, b)).toBe(-1);
    expect(snowflakeTimestamp(a)).toBe(1_700_000_000_000);
    expect(snowflakeTimestamp(b)).toBe(1_700_000_001_000);
  });

  it("stays monotonic when the clock moves backwards", () => {
    let clock = 1_700_000_000_000;
    const gen = new SnowflakeGenerator({ now: () => clock });
    const a = gen.next();
    clock -= 5000;
    const b = gen.next();
    expect(compareSnowflakes(a, b)).toBe(-1);
  });

  it("produces unique ids under load", () => {
    const gen = new SnowflakeGenerator();
    const seen = new Set<string>();
    for (let i = 0; i < 20000; i++) seen.add(gen.next());
    expect(seen.size).toBe(20000);
  });

  it("validates snowflake strings", () => {
    expect(isValidSnowflake("123456789012345678")).toBe(true);
    expect(isValidSnowflake("abc")).toBe(false);
    expect(isValidSnowflake("")).toBe(false);
    expect(isValidSnowflake("-1")).toBe(false);
  });
});
