import { Permissions } from "@nebula/shared";

/** True when every bit in `flag` is set in the serialized permission string. */
export function hasBits(permissionString: string | undefined | null, flag: bigint): boolean {
  if (!permissionString) return false;
  let bits: bigint;
  try {
    bits = BigInt(permissionString);
  } catch {
    return false;
  }
  if ((bits & Permissions.ADMINISTRATOR) === Permissions.ADMINISTRATOR) return true;
  return (bits & flag) === flag;
}

/** True when any bit in `flag` is set. */
export function hasAnyBit(permissionString: string | undefined | null, flag: bigint): boolean {
  if (!permissionString) return false;
  try {
    return (BigInt(permissionString) & flag) !== 0n;
  } catch {
    return false;
  }
}

export { Permissions };
export type { Permissions as PermissionsType };
