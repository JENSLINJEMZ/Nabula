import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  Permissions,
  applyImplicitPermissions,
  applyTimeout,
  computeBasePermissions,
  computeChannelPermissions,
  deserializePermissions,
  hasPermission,
  serializePermissions,
} from "../src/permissions.js";

const EVERYONE = "1000";

describe("permission bitfield", () => {
  it("uses Discord's documented bit values", () => {
    expect(Permissions.VIEW_CHANNEL).toBe(0x400n);
    expect(Permissions.SEND_MESSAGES).toBe(0x800n);
    expect(Permissions.ADMINISTRATOR).toBe(0x8n);
    expect(Permissions.ADD_REACTIONS).toBe(0x40n);
    expect(Permissions.MANAGE_THREADS).toBe(1n << 34n);
    expect(Permissions.BYPASS_SLOWMODE).toBe(1n << 52n);
    // Bit 47 is intentionally unused by Discord.
    expect(Object.values(Permissions).some((v) => v === 1n << 47n)).toBe(false);
  });

  it("serializes and deserializes as a string", () => {
    const bits = Permissions.SEND_MESSAGES | Permissions.ADD_REACTIONS;
    expect(serializePermissions(bits)).toBe("2112");
    expect(deserializePermissions("2112")).toBe(2112n);
  });

  it("hasPermission honours ADMINISTRATOR", () => {
    expect(hasPermission(Permissions.ADMINISTRATOR, Permissions.BAN_MEMBERS)).toBe(true);
    expect(hasPermission(Permissions.SEND_MESSAGES, Permissions.BAN_MEMBERS)).toBe(false);
  });
});

describe("computeBasePermissions", () => {
  it("grants all permissions to the guild owner", () => {
    const result = computeBasePermissions({ isOwner: true, everyoneRolePermissions: 0n, rolePermissions: [] });
    expect(result).toBe(ALL_PERMISSIONS);
  });

  it("ORs the @everyone role with member roles", () => {
    const result = computeBasePermissions({
      isOwner: false,
      everyoneRolePermissions: Permissions.VIEW_CHANNEL,
      rolePermissions: [Permissions.SEND_MESSAGES, Permissions.ADD_REACTIONS],
    });
    expect(result).toBe(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.ADD_REACTIONS);
  });

  it("collapses ADMINISTRATOR in a role to ALL", () => {
    const result = computeBasePermissions({
      isOwner: false,
      everyoneRolePermissions: Permissions.VIEW_CHANNEL,
      rolePermissions: [Permissions.ADMINISTRATOR],
    });
    expect(result).toBe(ALL_PERMISSIONS);
  });
});

describe("computeChannelPermissions", () => {
  const base = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.READ_MESSAGE_HISTORY;

  it("applies @everyone deny then allow", () => {
    const result = computeChannelPermissions({
      basePermissions: base,
      everyoneRoleId: EVERYONE,
      memberRoleIds: [EVERYONE],
      memberId: "42",
      overwrites: [{ targetId: EVERYONE, type: 0, deny: Permissions.SEND_MESSAGES, allow: 0n }],
    });
    expect(result & Permissions.SEND_MESSAGES).toBe(0n);
  });

  it("ORs role denies and allows across all member roles", () => {
    const result = computeChannelPermissions({
      basePermissions: base,
      everyoneRoleId: EVERYONE,
      memberRoleIds: [EVERYONE, "roleA", "roleB"],
      memberId: "42",
      overwrites: [
        { targetId: "roleA", type: 0, allow: 0n, deny: Permissions.SEND_MESSAGES },
        { targetId: "roleB", type: 0, allow: Permissions.SEND_MESSAGES, deny: 0n },
      ],
    });
    // Member-specific order: role denies OR'd, then role allows OR'd.
    expect(result & Permissions.SEND_MESSAGES).toBe(Permissions.SEND_MESSAGES);
  });

  it("member overwrite is applied last and can override roles", () => {
    const result = computeChannelPermissions({
      basePermissions: base,
      everyoneRoleId: EVERYONE,
      memberRoleIds: [EVERYONE, "roleA"],
      memberId: "42",
      overwrites: [
        { targetId: "roleA", type: 0, allow: Permissions.SEND_MESSAGES, deny: 0n },
        { targetId: "42", type: 1, allow: 0n, deny: Permissions.SEND_MESSAGES },
      ],
    });
    expect(result & Permissions.SEND_MESSAGES).toBe(0n);
  });

  it("ADMINISTRATOR bypasses all overwrites", () => {
    const result = computeChannelPermissions({
      basePermissions: ALL_PERMISSIONS,
      everyoneRoleId: EVERYONE,
      memberRoleIds: [EVERYONE],
      memberId: "42",
      overwrites: [{ targetId: "42", type: 1, allow: 0n, deny: ALL_PERMISSIONS }],
    });
    expect(result).toBe(ALL_PERMISSIONS);
  });
});

describe("implicit permissions", () => {
  it("VIEW_CHANNEL denial removes every other channel permission", () => {
    const bits = Permissions.SEND_MESSAGES | Permissions.READ_MESSAGE_HISTORY;
    expect(applyImplicitPermissions(bits)).toBe(0n);
  });

  it("SEND_MESSAGES denial removes mention-everyone, tts, attach and embed", () => {
    const bits =
      Permissions.VIEW_CHANNEL |
      Permissions.MENTION_EVERYONE |
      Permissions.SEND_TTS_MESSAGES |
      Permissions.ATTACH_FILES |
      Permissions.EMBED_LINKS |
      Permissions.READ_MESSAGE_HISTORY;
    const result = applyImplicitPermissions(bits);
    expect(result & Permissions.MENTION_EVERYONE).toBe(0n);
    expect(result & Permissions.ATTACH_FILES).toBe(0n);
    expect(result & Permissions.READ_MESSAGE_HISTORY).toBe(Permissions.READ_MESSAGE_HISTORY);
  });
});

describe("timeouts", () => {
  it("strips all but view/history", () => {
    const bits = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.READ_MESSAGE_HISTORY;
    const result = applyTimeout(bits, true);
    expect(result).toBe(Permissions.VIEW_CHANNEL | Permissions.READ_MESSAGE_HISTORY);
  });

  it("exempts administrators", () => {
    const bits = ALL_PERMISSIONS;
    expect(applyTimeout(bits, true)).toBe(ALL_PERMISSIONS);
  });
});
