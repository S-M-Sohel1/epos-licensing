import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { hash } from "bcryptjs";

import { env } from "~/env";
import { BCRYPT_COST, emailRule } from "~/server/admins";
import { customerPasswordRule } from "~/server/customer/auth";
import { db } from "~/server/db";

/**
 * "Forgot password" for a shop owner's account.
 *
 * The owner asks on the corporate website. That site's server calls this
 * service, which mints a single-use link token for the account and hands it
 * back; the website emails the link. Following the link lets the owner choose
 * a new password.
 *
 * This service never sends email. It owns the account and so it owns the
 * token, but one app sends all of the platform's email, and that is the
 * website. Because the token leaves here in a reply, the route that returns it
 * is not public: it takes the secret the two servers share. Anyone could
 * otherwise ask for a token for any address and take the account over.
 *
 * Only the token's SHA-256 is stored, so reading this database does not yield
 * a working link.
 */

/** A reset is wanted now; a link that works for a day is a link that works for whoever finds the email later. */
const LIFETIME_MS = 30 * 60 * 1000;

/** However often the form is submitted, at most this many links per account per hour. */
const MAX_PER_HOUR = 3;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Whether a request carries the secret shared with the corporate website
 * (`Authorization: Bearer <INTERNAL_API_SECRET>`). Constant-time. False when
 * the secret is not set, so an unconfigured server refuses everyone.
 */
export function isInternalRequest(request: Request): boolean {
  const secret = env.INTERNAL_API_SECRET;
  const sent = request.headers.get("authorization");
  if (!secret || !sent?.startsWith("Bearer ")) return false;
  const a = Buffer.from(sent.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface IssuedReset {
  token: string;
  email: string;
  name: string | null;
  /** Minutes the link works for, so the email can say so without a second source for the number. */
  validForMinutes: number;
}

/**
 * Mints a reset link token for the account with this email, or returns null
 * when there is nothing to send: no such account, or the hourly limit has
 * been reached. The caller must answer its own caller the same way in both
 * cases, or the form becomes a way to find out who has an account.
 *
 * An account that has never had a password (one an admin created as a record)
 * is given a link too. The email address is theirs; choosing a password
 * through it is how such an account gets its first login.
 */
export async function requestCustomerPasswordReset(rawEmail: unknown): Promise<IssuedReset | null> {
  const parsed = emailRule.safeParse(rawEmail);
  if (!parsed.success) return null;

  const customer = await db.customer.findUnique({ where: { email: parsed.data } });
  if (!customer?.email) return null;

  const recent = await db.customerPasswordReset.count({
    where: { customerId: customer.id, createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) } },
  });
  if (recent >= MAX_PER_HOUR) return null;

  const token = randomBytes(32).toString("base64url");
  await db.customerPasswordReset.create({
    data: { tokenHash: sha256(token), customerId: customer.id, expiresAt: new Date(Date.now() + LIFETIME_MS) },
  });
  return { token, email: customer.email, name: customer.name, validForMinutes: LIFETIME_MS / 60_000 };
}

/** Whether a link is still usable, for the page that shows the form. Does not use it up. */
export async function customerPasswordResetIsLive(token: unknown): Promise<boolean> {
  if (typeof token !== "string" || token.length < 20) return false;
  const row = await db.customerPasswordReset.findUnique({ where: { tokenHash: sha256(token) } });
  return !!row && row.usedAt === null && row.expiresAt.getTime() > Date.now();
}

/**
 * Uses a link: sets the account's password.
 *
 * Claiming the token is one conditional update, so a link opened twice at
 * once sets the password once. Then, together: the password is replaced,
 * every session is ended (whoever had the old password is out), every other
 * outstanding link dies, and the email counts as verified, since following a
 * link sent to it is exactly what verifying an address means.
 */
export async function resetCustomerPassword(token: unknown, newPassword: unknown): Promise<{ ok: boolean; error?: string }> {
  // The password is checked before the link is touched: a password that is too short must
  // not cost the owner their one link.
  const password = customerPasswordRule.safeParse(newPassword);
  if (!password.success) return { ok: false, error: password.error.issues[0]?.message };
  if (typeof token !== "string" || token.length < 20) return { ok: false, error: EXPIRED };

  const tokenHash = sha256(token);
  const claimed = await db.customerPasswordReset.updateMany({
    where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) return { ok: false, error: EXPIRED };

  const row = await db.customerPasswordReset.findUnique({ where: { tokenHash } });
  if (!row) return { ok: false, error: EXPIRED };

  const passwordHash = await hash(password.data, BCRYPT_COST);
  const customer = await db.customer.findUnique({ where: { id: row.customerId }, select: { emailVerifiedAt: true } });
  await db.$transaction([
    db.customer.update({
      where: { id: row.customerId },
      data: { passwordHash, ...(customer?.emailVerifiedAt ? {} : { emailVerifiedAt: new Date() }) },
    }),
    db.customerSession.deleteMany({ where: { customerId: row.customerId } }),
    db.customerPasswordReset.updateMany({ where: { customerId: row.customerId, usedAt: null }, data: { usedAt: new Date() } }),
  ]);
  return { ok: true };
}

const EXPIRED = "This link has expired or has already been used. Ask for a new one.";
