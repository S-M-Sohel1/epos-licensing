import { createHash } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";

import { db } from "~/server/db";
import { storage } from "~/server/pos-sync/images";

/**
 * A shop's own pictures for its storefront: the photo behind the front page's
 * heading and the two beside its "about" text. Uploaded by the shop's owner
 * from the web platform's Site screen, which sends them here because this
 * service holds the bucket.
 *
 * Kept apart from the till's menu pictures in the same bucket by the key:
 * `<shopId>/site/<sha256>.<ext>`, against the till's `<shopId>/<sha256>.<ext>`.
 * Nothing is recorded in the database here. The web platform keeps the
 * address it is given in the shop's branding, and that is the only reference.
 */

/**
 * The web platform shrinks a picture to at most 1600 pixels on its long side
 * before sending, which comes to a few hundred KB. This leaves room and still
 * stops the route being used to fill the bucket.
 */
export const MAX_SITE_IMAGE_BYTES = 2 * 1024 * 1024;

function sniff(bytes: Buffer): { contentType: string; ext: string } | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: "image/png", ext: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: "image/jpeg", ext: "jpg" };
  }
  // RIFF....WEBP
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    return { contentType: "image/webp", ext: "webp" };
  }
  return null;
}

export type SiteImageResult =
  | { ok: true; url: string }
  | { ok: false; status: 400 | 404 | 413 | 415 | 503; error: string };

/**
 * Stores one picture for a shop and returns its public address.
 *
 * What the bytes are is decided by looking at them, never by what the sender
 * says they are. The key holds the hash of the bytes, so the same picture
 * sent twice lands on the same object and what is at an address never changes.
 */
export async function storeSiteImage(shopId: string, bytes: Buffer): Promise<SiteImageResult> {
  if (bytes.length === 0) return { ok: false, status: 400, error: "No picture was sent." };
  if (bytes.length > MAX_SITE_IMAGE_BYTES) {
    return { ok: false, status: 413, error: `A picture may be at most ${MAX_SITE_IMAGE_BYTES / (1024 * 1024)} MB.` };
  }
  const kind = sniff(bytes);
  if (!kind) return { ok: false, status: 415, error: "Only JPEG, PNG and WebP pictures are accepted." };

  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { id: true } });
  if (!shop) return { ok: false, status: 404, error: "No such shop." };

  const store = storage();
  if (!store) return { ok: false, status: 503, error: "Picture storage is not set up on this server yet." };

  const hash = createHash("sha256").update(bytes).digest("hex");
  const key = `${shopId}/site/${hash}.${kind.ext}`;
  await store.client.send(
    new PutObjectCommand({
      Bucket: store.bucket,
      Key: key,
      Body: bytes,
      ContentType: kind.contentType,
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
  return { ok: true, url: `${store.publicBase}/${key}` };
}
