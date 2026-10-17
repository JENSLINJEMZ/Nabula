import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import {
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_UPLOAD_MIME_TYPES,
  Errors,
} from "@nebula/shared";
import { env } from "../config.js";
import { execute, queryOne, withTransaction, txQuery } from "../db/pool.js";
import { nextId } from "../ids.js";
import { logger } from "../logger.js";
import type { AttachmentRow } from "./mappers.js";

const STORAGE_ROOT = resolve(process.cwd(), env.STORAGE_LOCAL_DIR);

export async function ensureStorageReady(): Promise<void> {
  await mkdir(STORAGE_ROOT, { recursive: true });
}

/**
 * Sniff a file's type from its magic bytes. Returns null when nothing matches.
 * This is the authoritative type check — a client-declared Content-Type is only
 * ever a hint.
 */
export function sniffMimeType(buffer: Buffer, declared: string | null): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString("latin1") === "GIF87a" || buffer.subarray(0, 6).toString("latin1") === "GIF89a")) {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WAVE"
  ) {
    return "audio/wav";
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("latin1");
    if (brand.startsWith("avif") || brand.startsWith("avis") || brand.startsWith("mif1")) return "image/avif";
    return "video/mp4";
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return declared === "audio/webm" ? "audio/webm" : "video/webm";
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString("latin1") === "OggS") {
    return declared === "audio/ogg" ? "audio/ogg" : "audio/ogg";
  }
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)) {
    return "application/zip";
  }
  if (buffer.length >= 3 && buffer.subarray(0, 3).toString("latin1") === "ID3") return "audio/mpeg";
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] === 0xfb || buffer[1] === 0xf3 || buffer[1] === 0xf2)) {
    return "audio/mpeg";
  }

  // Text-like formats have no magic bytes: accept only when the declared type is
  // an allowed text type AND the content looks textual (no NUL / few controls).
  const textTypes = new Set(["text/plain", "text/markdown", "application/json"]);
  if (declared && textTypes.has(declared)) {
    const sample = buffer.subarray(0, 4096);
    let controls = 0;
    for (const byte of sample) {
      if (byte === 0) return null;
      if (byte < 9 || (byte > 13 && byte < 32)) controls++;
    }
    if (controls / Math.max(sample.length, 1) < 0.02) return declared;
  }
  return null;
}

export interface UploadValidation {
  contentType: string;
  isImage: boolean;
}

export function validateUpload(buffer: Buffer, declared: string | null): UploadValidation {
  if (buffer.length === 0) throw Errors.UNSUPPORTED_MEDIA_TYPE(undefined, "Empty upload.");
  if (buffer.length > env.MAX_UPLOAD_BYTES) throw Errors.PAYLOAD_TOO_LARGE();

  const sniffed = sniffMimeType(buffer, declared);
  if (!sniffed) throw Errors.UNSUPPORTED_MEDIA_TYPE(undefined, "Unrecognised or disallowed file type.");
  if (!ALLOWED_UPLOAD_MIME_TYPES.includes(sniffed)) {
    throw Errors.UNSUPPORTED_MEDIA_TYPE({ contentType: sniffed });
  }
  return { contentType: sniffed, isImage: ALLOWED_IMAGE_MIME_TYPES.includes(sniffed) };
}

/** Best-effort image dimension extraction for common formats. */
export function readImageDimensions(buffer: Buffer, contentType: string): { width: number | null; height: number | null } {
  try {
    if (contentType === "image/png" && buffer.length >= 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (contentType === "image/gif" && buffer.length >= 10) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (contentType === "image/jpeg") {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset++;
          continue;
        }
        const marker = buffer[offset + 1] ?? 0;
        const length = buffer.readUInt16BE(offset + 2);
        // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
        }
        offset += 2 + length;
      }
    }
    if (contentType === "image/webp" && buffer.length >= 30) {
      const fourcc = buffer.subarray(12, 16).toString("latin1");
      if (fourcc === "VP8X") {
        const width = 1 + (buffer[24]! | (buffer[25]! << 8) | (buffer[26]! << 16));
        const height = 1 + (buffer[27]! | (buffer[28]! << 8) | (buffer[29]! << 16));
        return { width, height };
      }
      if (fourcc === "VP8 ") {
        return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
      }
    }
  } catch {
    // fall through
  }
  return { width: null, height: null };
}

function storageKeyFor(checksum: string, id: string): string {
  return join(checksum.slice(0, 2), checksum.slice(2, 4), id);
}

function absolutePathFor(storageKey: string): string {
  const target = resolve(STORAGE_ROOT, normalize(storageKey));
  // Defence in depth against path traversal via crafted storage keys.
  if (!target.startsWith(STORAGE_ROOT)) throw Errors.INTERNAL(undefined, "Invalid storage path");
  return target;
}

export interface SaveAttachmentInput {
  buffer: Buffer;
  filename: string;
  declaredContentType: string | null;
  uploaderId: string;
  channelId: string;
  guildId: string | null;
  isSpoiler?: boolean;
}

/**
 * Persist an upload. Order:
 *   1. validate bytes (magic + size + allowlist),
 *   2. reserve quota transactionally (guild channels only),
 *   3. write to disk,
 *   4. record the row.
 * If the disk write or insert fails, any reserved quota is released.
 */
export async function saveAttachment(input: SaveAttachmentInput): Promise<AttachmentRow> {
  const { contentType, isImage } = validateUpload(input.buffer, input.declaredContentType);
  const dimensions = isImage ? readImageDimensions(input.buffer, contentType) : { width: null, height: null };
  const checksum = createHash("sha256").update(input.buffer).digest("hex");
  const id = nextId();
  const storageKey = storageKeyFor(checksum, id);
  const sanitizedFilename = sanitizeFilename(input.filename, contentType);

  if (input.guildId) {
    await withTransaction(async (tx) => {
      const row = await txQuery<{ used_bytes: string }>(
        tx,
        `SELECT used_bytes FROM guild_storage WHERE guild_id = $1 FOR UPDATE`,
        [input.guildId],
      );
      const used = BigInt(row[0]?.used_bytes ?? "0");
      if (used + BigInt(input.buffer.length) > BigInt(env.STORAGE_QUOTA_BYTES_PER_GUILD)) {
        throw Errors.QUOTA_EXCEEDED();
      }
      await txQuery(
        tx,
        `UPDATE guild_storage SET used_bytes = used_bytes + $2 WHERE guild_id = $1`,
        [input.guildId, input.buffer.length],
      );
    });
  }

  const absolute = absolutePathFor(storageKey);
  try {
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, input.buffer, { mode: 0o640 });
  } catch (error) {
    if (input.guildId) {
      await execute(`UPDATE guild_storage SET used_bytes = GREATEST(used_bytes - $2, 0) WHERE guild_id = $1`, [
        input.guildId,
        input.buffer.length,
      ]);
    }
    throw error;
  }

  try {
    const row = await queryOne<AttachmentRow & { uploader_id: string }>(
      `INSERT INTO attachments (id, uploader_id, channel_id, guild_id, filename, content_type, size_bytes,
                                width, height, storage_key, checksum, is_spoiler)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, message_id, filename, content_type, size_bytes, width, height, is_spoiler, uploader_id`,
      [
        id,
        input.uploaderId,
        input.channelId,
        input.guildId,
        sanitizedFilename,
        contentType,
        input.buffer.length,
        dimensions.width,
        dimensions.height,
        storageKey,
        checksum,
        input.isSpoiler ?? false,
      ],
    );
    if (!row) throw Errors.INTERNAL(undefined, "Failed to record attachment");
    return row;
  } catch (error) {
    await unlink(absolute).catch(() => undefined);
    if (input.guildId) {
      await execute(`UPDATE guild_storage SET used_bytes = GREATEST(used_bytes - $2, 0) WHERE guild_id = $1`, [
        input.guildId,
        input.buffer.length,
      ]);
    }
    throw error;
  }
}

export function sanitizeFilename(filename: string, contentType: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "_").trim().slice(0, 200);
  if (cleaned.length > 0) return cleaned;
  const ext = contentType.split("/")[1] ?? "bin";
  return `file.${ext}`;
}

export interface AttachmentWithStorage extends AttachmentRow {
  storage_key: string;
  channel_id: string | null;
  guild_id: string | null;
  uploader_id: string | null;
  content_type: string | null;
  size_bytes: string | number;
}

export async function getAttachmentRow(id: string): Promise<AttachmentWithStorage | null> {
  return queryOne<AttachmentWithStorage>(
    `SELECT id, message_id, filename, content_type, size_bytes, width, height, is_spoiler,
            storage_key, channel_id, guild_id, uploader_id
       FROM attachments WHERE id = $1`,
    [id],
  );
}

export async function readAttachmentBytes(row: AttachmentWithStorage): Promise<Buffer> {
  return readFile(absolutePathFor(row.storage_key));
}

export async function deleteAttachmentHard(id: string): Promise<void> {
  const row = await getAttachmentRow(id);
  if (!row) return;
  await unlink(absolutePathFor(row.storage_key)).catch(() => undefined);
  await execute(`DELETE FROM attachments WHERE id = $1`, [id]);
  if (row.guild_id) {
    await execute(`UPDATE guild_storage SET used_bytes = GREATEST(used_bytes - $2, 0) WHERE guild_id = $1`, [
      row.guild_id,
      Number(row.size_bytes),
    ]);
  }
}

export async function saveKeyedBlob(prefix: string, buffer: Buffer, extension: string): Promise<string> {
  const checksum = createHash("sha256").update(buffer).digest("hex");
  const key = `${prefix}/${checksum.slice(0, 16)}${randomBytes(4).toString("hex")}${extension}`;
  const absolute = absolutePathFor(key);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, buffer, { mode: 0o640 });
  logger.debug("stored blob", { key, bytes: buffer.length });
  return key;
}

export async function readKeyedBlob(key: string): Promise<Buffer> {
  return readFile(absolutePathFor(key));
}

export { STORAGE_ROOT };
