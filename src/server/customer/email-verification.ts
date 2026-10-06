import { createHash, randomBytes } from "node:crypto";

import { emailRule } from "~/server/admins";
import { db } from "~/server/db";

/**
 * Confirming that a shop owner's email address is theirs.
 *
 * Shaped like the password reset beside it (password-reset.ts), for the same
 * reasons: this service owns the account and so mints the link's token, the
 * corporate website sends the email, and the route that hands the token over
 * takes the secret the two servers share. If it took the owner's own session
 * instead, an owner could ask for the token directly and "confirm" an address
 * they cannot read.
 *
 * The link records the address it was sent to. An owner who changes their
 * address afterwards has not confirmed the new one, and the old link says so
 * by no longer working.
 *
 * Nothing is refused to an account that has not confirmed. This records the
 * fact; what, if anything, should wait for it is the website's decision.
 */

const LIFETIME_MS = 24 * 60 * 60 * 1000;

/** However often "send it again" is pressed, at most this many links per account per hour. */
const MAX_PER_HOUR = 3;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export interface IssuedVerification {
  token: string;
  email: string;
  name: string | null;
  /** Hours the link works for, so the email can say so without a second source for the number. */
  validForHours: number;
}

/**
 * Mints a confirmation link token for the account with this email, or returns
 * null when there is nothing to send: no such account, the address is already
 * confirmed, or the hourly limit has been reached.
 */
export async function requestEmailVerification(rawEmail: unknown): Promise<IssuedVerification | null> {
  const parsed = emailRule.safeParse(rawEmail);
  if (!parsed.success) return null;

  const customer = await db.customer.findUnique({ where: { email: parsed.data } });
  if (!customer?.email || customer.emailVerifiedAt) return null;

  const recent = await db.customerEmailVerification.count({
    where: { customerId: customer.id, createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) } },
  });
  if (recent >= MAX_PER_HOUR) return null;

  const token = randomBytes(32).toString("base64url");
  await db.customerEmailVerification.create({
    data: { tokenHash: sha256(token), customerId: customer.id, email: customer.email, expiresAt: new Date(Date.now() + LIFETIME_MS) },
  });
  return { token, email: customer.email, name: customer.name, validForHours: LIFETIME_MS / 3_600_000 };
}

export type VerificationOutcome =
  | { ok: true; email: string; alreadyVerified: boolean }
  | { ok: false; error: string };

/**
 * Uses a link: marks the account's address as confirmed.
 *
 * A link that was already used answers as a success when the address it was
 * for is still the account's and is confirmed. Mail programs open links
 * before their reader does, and the owner who then clicks the same link has
 * done nothing wrong; "this link has expired" would be a lie to them.
 */
export async function confirmEmailVerification(token: unknown): Promise<VerificationOutcome> {
  if (typeof token !== "string" || token.length < 20) return { ok: false, error: EXPIRED };

  const row = await db.customerEmailVerification.findUnique({
    where: { tokenHash: sha256(token) },
    include: { customer: { select: { email: true, emailVerifiedAt: true } } },
  });
  if (!row) return { ok: false, error: EXPIRED };
  if (row.customer.email !== row.email) return { ok: false, error: CHANGED };
  if (row.usedAt) {
    return row.customer.emailVerifiedAt ? { ok: true, email: row.email, alreadyVerified: true } : { ok: false, error: EXPIRED };
  }
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, error: EXPIRED };

  await db.$transaction([
    db.customerEmailVerification.updateMany({ where: { customerId: row.customerId, usedAt: null }, data: { usedAt: new Date() } }),
    // Only while the address is still the one the link was sent to.
    db.customer.updateMany({ where: { id: row.customerId, email: row.email, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } }),
  ]);
  return { ok: true, email: row.email, alreadyVerified: false };
}

const EXPIRED = "This link has expired or is not valid. Sign in and ask for a new one.";
const CHANGED = "The email address on this account has changed since this link was sent. Sign in and ask for a new one.";
