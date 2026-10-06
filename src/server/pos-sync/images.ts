import { createHash } from "node:crypto";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";

import { env } from "~/env";
import { db } from "~/server/db";

import type { PosCaller } from "./guard";

/**
 * Product pictures, published by a till.
 *
 * Two calls, so bytes are only ever sent when they are needed:
 *
 *   1. Manifest. The till lists the picture each product has now, by hash, and
 *      which products have had theirs cleared. No bytes. The server records
 *      which picture each staged item points at, and answers with the hashes
 *      it does not hold.
 *   2. Upload. One picture per request, raw bytes, for exactly those hashes.
 *
 * The till keeps its own note of what it has uploaded, but that is a cache.
 * The manifest reply is the truth, so a picture lost here is asked for again,
 * and a second till in the same shop is not asked for pictures the first
 * already sent.
 *
 * See Epos365/POS_INTEGRATION_ARCHITECTURE.md §5.3.
 */

/**
 * The till resizes every picture to at most 420x260 before storing it, which
 * measures around 37 KB. This is far above that and far below anything that
 * could be used to fill the bucket.
 */
export const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_MANIFEST_ENTRIES = 20_000;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** .NET writes PascalCase and this codebase reads either. */
function lowerKeys(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) out[key.toLowerCase()] = inner;
  return out;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

let client: S3Client | null = null;

/** Null until all five R2 settings are present. Callers answer 503, they do not throw. */
function storage(): { client: S3Client; bucket: string; publicBase: string } | null {
  const { R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PUBLIC_BASE_URL } = env;
  if (!R2_ACCOUNT_ID || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_PUBLIC_BASE_URL) return null;

  client ??= new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  return { client, bucket: R2_BUCKET, publicBase: R2_PUBLIC_BASE_URL.replace(/\/$/, "") };
}

export function isStorageConfigured(): boolean {
  return storage() !== null;
}

/**
 * What the bytes actually are, from their first bytes. The till only ever
 * produces PNG or JPEG; a declared Content-Type is not trusted, since it is
 * just a header the sender chose.
 */
function sniff(bytes: Buffer): { contentType: string; ext: string } | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: "image/png", ext: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: "image/jpeg", ext: "jpg" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const manifestSchema = z.object({
  items: z
    .array(z.unknown())
    .max(MAX_MANIFEST_ENTRIES)
    .default([]),
  cleared: z.array(z.string()).max(MAX_MANIFEST_ENTRIES).default([]),
});

export type ManifestResult =
  | { ok: true; missing: string[]; updated: number; cleared: number; version: number; rejected: number }
  | { ok: false; status: 400 | 403; code: string; error: string };

/**
 * Records which picture each of the shop's staged items has, and reports which
 * of those pictures still have to be uploaded.
 */
export async function applyManifest(caller: PosCaller, body: unknown): Promise<ManifestResult> {
  if (!caller.canPublishCatalog) {
    return { ok: false, status: 403, code: "not_publisher", error: "This till is not allowed to publish the catalogue." };
  }
  const parsed = manifestSchema.safeParse(lowerKeys(body));
  if (!parsed.success) {
    return { ok: false, status: 400, code: "invalid_body", error: "Expected { Items: [{ PosId, Hash }], Cleared: [PosId] }." };
  }

  const items: { posId: string; hash: string }[] = [];
  let rejected = 0;
  for (const raw of parsed.data.items) {
    const entry = lowerKeys(raw);
    const posId = typeof entry.posid === "string" ? entry.posid.trim() : "";
    const hash = typeof entry.hash === "string" ? entry.hash.trim().toLowerCase() : "";
    if (!posId || !SHA256_HEX.test(hash)) {
      rejected++;
      continue;
    }
    items.push({ posId, hash });
  }
  const cleared = parsed.data.cleared.map((id) => id.trim()).filter(Boolean);
  const { shopId } = caller;

  return db.$transaction(async (tx): Promise<ManifestResult> => {
    // Same lock a catalogue push takes, so the two cannot interleave for one shop.
    const [state] = await tx.$queryRaw<{ version: bigint }[]>`
      SELECT "version" FROM pos_sync.catalog_state WHERE "shopId" = ${shopId} FOR UPDATE`;
    if (!state) {
      // No catalogue has been pushed yet, so there is nothing for a picture to belong to.
      // The till pushes rows first and pictures second; it will ask again.
      return { ok: true, missing: [], updated: 0, cleared: 0, version: 0, rejected };
    }
    const version = Number(state.version) + 1;

    // Only items that exist and whose picture actually differs are touched. A picture is
    // identified by its hash alone, so there is no timestamp to compare: the till's current
    // picture for a product is simply what the product has.
    const updated =
      items.length === 0
        ? 0
        : await tx.$executeRaw`
            UPDATE pos_sync.catalog_item t
            SET "imageHash" = x."hash", "changedVersion" = ${version}
            FROM jsonb_to_recordset(${JSON.stringify(items)}::jsonb) AS x("posId" text, "hash" text)
            WHERE t."shopId" = ${shopId} AND t."posId" = x."posId" AND t."imageHash" IS DISTINCT FROM x."hash"`;

    const clearedCount =
      cleared.length === 0
        ? 0
        : await tx.$executeRaw`
            UPDATE pos_sync.catalog_item t
            SET "imageHash" = NULL, "changedVersion" = ${version}
            WHERE t."shopId" = ${shopId} AND t."posId" = ANY(${cleared}::text[]) AND t."imageHash" IS NOT NULL`;

    if (updated + clearedCount > 0) {
      await tx.$executeRaw`
        UPDATE pos_sync.catalog_state SET "version" = ${version}, "updatedAt" = now() WHERE "shopId" = ${shopId}`;
    }

    // What this shop needs and does not hold. The object is deliberately never deleted when a
    // picture is cleared, so putting the same picture back later costs no upload.
    const wanted = [...new Set(items.map((i) => i.hash))];
    const held =
      wanted.length === 0
        ? []
        : await tx.$queryRaw<{ hash: string }[]>`
            SELECT "hash" FROM pos_sync.catalog_image WHERE "shopId" = ${shopId} AND "hash" = ANY(${wanted}::text[])`;
    const have = new Set(held.map((h) => h.hash));
    const missing = wanted.filter((hash) => !have.has(hash));

    await tx.$executeRaw`
      INSERT INTO pos_sync.sync_log ("shopId", "deviceRowId", "kind", "detail")
      VALUES (${shopId}, ${caller.deviceRowId}, 'image_manifest',
              ${JSON.stringify({ listed: items.length, updated, cleared: clearedCount, missing: missing.length, rejected })}::jsonb)`;

    return {
      ok: true,
      missing,
      updated,
      cleared: clearedCount,
      version: updated + clearedCount > 0 ? version : Number(state.version),
      rejected,
    };
  });
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export type UploadResult =
  | { ok: true; hash: string; alreadyHeld: boolean }
  | { ok: false; status: 400 | 403 | 413 | 415 | 503; code: string; error: string };

/**
 * Stores one picture for the caller's shop.
 *
 * Every check that does not need the bucket runs before the bucket is touched,
 * so a bad upload is refused the same way whether or not storage is set up.
 */
export async function storeImage(caller: PosCaller, claimedHash: string, bytes: Buffer): Promise<UploadResult> {
  if (!caller.canPublishCatalog) {
    return { ok: false, status: 403, code: "not_publisher", error: "This till is not allowed to publish the catalogue." };
  }
  const hash = claimedHash.trim().toLowerCase();
  if (!SHA256_HEX.test(hash)) {
    return { ok: false, status: 400, code: "invalid_hash", error: "The hash in the address is not a SHA-256 in hex." };
  }
  if (bytes.length === 0) return { ok: false, status: 400, code: "empty_body", error: "No picture was sent." };
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { ok: false, status: 413, code: "too_large", error: `A picture may be at most ${MAX_IMAGE_BYTES / 1024} KB.` };
  }
  const kind = sniff(bytes);
  if (!kind) return { ok: false, status: 415, code: "not_an_image", error: "Only PNG and JPEG pictures are accepted." };

  // The hash is the picture's identity for everything downstream. If it were taken on the
  // till's word, a faulty till could store bytes Y under hash X and every product pointing at
  // X would show the wrong picture.
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== hash) {
    return { ok: false, status: 400, code: "hash_mismatch", error: "The picture's bytes do not match the hash it was sent under." };
  }

  const { shopId } = caller;
  const [existing] = await db.$queryRaw<{ hash: string }[]>`
    SELECT "hash" FROM pos_sync.catalog_image WHERE "shopId" = ${shopId} AND "hash" = ${hash}`;
  if (existing) return { ok: true, hash, alreadyHeld: true };

  const store = storage();
  if (!store) {
    return { ok: false, status: 503, code: "storage_not_configured", error: "Picture storage is not set up on this server yet." };
  }

  const objectKey = `${shopId}/${hash}.${kind.ext}`;
  await store.client.send(
    new PutObjectCommand({
      Bucket: store.bucket,
      Key: objectKey,
      Body: bytes,
      ContentType: kind.contentType,
      // The key contains the hash of the bytes, so what is at a key can never change.
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );

  // Recorded only after the bytes are in the bucket: a row here is a promise the picture exists.
  await db.$executeRaw`
    INSERT INTO pos_sync.catalog_image ("shopId", "hash", "objectKey", "contentType", "bytes")
    VALUES (${shopId}, ${hash}, ${objectKey}, ${kind.contentType}, ${bytes.length})
    ON CONFLICT ("shopId", "hash") DO NOTHING`;
  // The manifest already told the items which picture they have, and the website may have
  // applied those rows before these bytes arrived, finding no picture to show. Marking the
  // items changed again is what makes the website come back for the address.
  await db.$transaction(async (tx) => {
    const [state] = await tx.$queryRaw<{ version: bigint }[]>`
      SELECT "version" FROM pos_sync.catalog_state WHERE "shopId" = ${shopId} FOR UPDATE`;
    if (!state) return;
    const version = Number(state.version) + 1;
    const touched = await tx.$executeRaw`
      UPDATE pos_sync.catalog_item SET "changedVersion" = ${version}
      WHERE "shopId" = ${shopId} AND "imageHash" = ${hash}`;
    if (touched > 0) {
      await tx.$executeRaw`
        UPDATE pos_sync.catalog_state SET "version" = ${version}, "updatedAt" = now() WHERE "shopId" = ${shopId}`;
    }
  });

  await db.$executeRaw`
    INSERT INTO pos_sync.sync_log ("shopId", "deviceRowId", "kind", "detail")
    VALUES (${shopId}, ${caller.deviceRowId}, 'image_upload', ${JSON.stringify({ hash, bytes: bytes.length })}::jsonb)`;

  return { ok: true, hash, alreadyHeld: false };
}
