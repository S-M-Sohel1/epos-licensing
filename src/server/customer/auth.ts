import { randomBytes } from "node:crypto";

import { compare, hash } from "bcryptjs";
import { z } from "zod";

import { AuditEventType, TemplateId } from "generated/prisma";
import { BCRYPT_COST, emailRule } from "~/server/admins";
import { db } from "~/server/db";

/**
 * Customer accounts, as plain functions — same shape as `admins.ts`: the rules
 * live here rather than in a route handler so the test suite can drive them
 * directly. See ../../../SELF_REGISTRATION_DESIGN.md for why `Customer` is a
 * separate identity from the admin `User` model rather than a role on it.
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Deliberately lower than admins.ts's 12-character bar: an admin holds
 * authority over every license in the system, a customer only their own shop,
 * and this buyer is not tech-savvy (WEBSITE_BRIEF.md §3) — 12 characters would
 * cost real signups for a threat model that doesn't justify it here.
 */
export const customerPasswordRule = z
  .string()
  .min(8, "Use a password of at least 8 characters.")
  .max(200, "That password is too long.");

export interface CustomerShopSummary {
  id: string;
  name: string;
  subdomain: string | null;
  isPublished: boolean;
  templateId: TemplateId;
}

export interface CustomerAccount {
  id: string;
  email: string;
  name: string | null;
  /** First shop on the account — kept for existing single-shop callers (leads.ts, license lookup). */
  shopId: string;
  shopName: string;
  /** How many of this account's shops may have an active subdomain. */
  shopLimit: number;
  /** This shop's own subdomain, once activated — null until then. */
  subdomain: string | null;
  isPublished: boolean;
  /** Whether the owner has shown the email address is theirs, by following a link sent to it. */
  emailVerified: boolean;
  /** Every shop this account owns — empty-or-single-element until multi-shop accounts are used in practice. */
  shops: CustomerShopSummary[];
}

function toShopSummary(shop: {
  id: string;
  name: string;
  subdomain: string | null;
  isPublished: boolean;
  templateId: TemplateId;
}): CustomerShopSummary {
  return {
    id: shop.id,
    name: shop.name,
    subdomain: shop.subdomain,
    isPublished: shop.isPublished,
    templateId: shop.templateId,
  };
}

export interface CustomerAuthResult {
  ok: boolean;
  error?: string;
  token?: string;
  expires?: Date;
  customer?: CustomerAccount;
}

const registerSchema = z.object({
  businessName: z.string().trim().min(1, "Business name is required.").max(120),
  contactName: z.string().trim().max(120).optional(),
  email: emailRule,
  phone: z.string().trim().max(40).optional(),
  password: customerPasswordRule,
});

const signInSchema = z.object({
  email: emailRule,
  password: z.string().min(1, "Password is required."),
});

function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}

async function createSession(customerId: string): Promise<{ token: string; expires: Date }> {
  const token = newSessionToken();
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await db.customerSession.create({ data: { token, customerId, expires } });
  return { token, expires };
}

/**
 * Creates the shop owner's login and their `Shop` row — never a `License`.
 * The shop lands in the admin's existing `/shops` list and pending-review
 * posture exactly as if typed in by hand; an admin still issues the license.
 * See SELF_REGISTRATION_DESIGN.md's "What registration actually creates".
 */
export async function registerCustomer(input: unknown): Promise<CustomerAuthResult> {
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message };
  }
  const { businessName, contactName, email, phone, password } = parsed.data;

  const existing = await db.customer.findUnique({ where: { email } });
  if (existing) {
    return { ok: false, error: `${email} already has an account. Sign in instead.` };
  }

  // Hashed before the transaction opens: bcrypt at cost 12 is deliberately slow,
  // and doing that work while holding a pooled connection just spends the
  // transaction's timeout budget on CPU rather than queries.
  const passwordHash = await hash(password, BCRYPT_COST);

  const { customer, shop } = await db.$transaction(
    async (tx) => {
      // Customer created first now that Shop.customerId is the FK (was the
      // reverse — Customer.shopId — before shops became one-to-many).
      const customer = await tx.customer.create({
        data: {
          email,
          passwordHash,
          name: contactName ?? null,
        },
      });
      const shop = await tx.shop.create({
        data: { name: businessName, email, phone: phone ?? null, customerId: customer.id },
      });
      await tx.auditEvent.create({
        data: {
          type: AuditEventType.customer_registered,
          actor: "client",
          summary: `${businessName} signed up`,
        },
      });
      return { customer, shop };
    },
    // Prisma's 5s default has been observed to fail here against the Tokyo
    // pooler from a distant client; the deployed function runs in the same
    // region (vercel.json's hnd1) so this is headroom, not a fix for a
    // latency problem that exists in production.
    { timeout: 15_000 },
  );

  const session = await createSession(customer.id);

  return {
    ok: true,
    token: session.token,
    expires: session.expires,
    customer: {
      id: customer.id,
      // Non-null: `email` was just passed into this same tx.customer.create
      // call above. The field is nullable on the model in general (an
      // admin-created customer may have none) but this branch always has one.
      email: customer.email!,
      name: customer.name,
      shopId: shop.id,
      shopName: shop.name,
      // A brand-new customer starts at the schema default (0) and with no
      // shops that have a subdomain yet — no extra query needed here.
      shopLimit: customer.shopLimit,
      subdomain: shop.subdomain,
      isPublished: shop.isPublished,
      emailVerified: false,
      shops: [toShopSummary(shop)],
    },
  };
}

export async function signInCustomer(input: unknown): Promise<CustomerAuthResult> {
  const parsed = signInSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message };
  }
  const { email, password } = parsed.data;

  const customer = await db.customer.findUnique({
    where: { email },
    include: { shops: true },
  });

  // Same message whether the email is unknown or the password is wrong, so a
  // caller cannot use this endpoint to enumerate registered emails.
  const invalid = { ok: false, error: "Incorrect email or password." } as const;

  // No hash set — an admin-created customer with no self-service login yet.
  // Reject before calling compare(), which throws on a null hash.
  if (!customer?.passwordHash) return invalid;
  const matches = await compare(password, customer.passwordHash);
  if (!matches) return invalid;

  // `shops[0]` — the "primary" shop for callers that only expect one; the
  // full list is returned separately below for the dashboard's shop picker.
  const shop = customer.shops[0];
  if (!shop) return invalid;

  const session = await createSession(customer.id);

  return {
    ok: true,
    token: session.token,
    expires: session.expires,
    customer: {
      id: customer.id,
      // Non-null: reaching this line already required a successful
      // compare() against customer.passwordHash, which itself required
      // finding this row `where: { email }` on the email the caller signed
      // in with — this customer has both an email and a working login.
      email: customer.email!,
      name: customer.name,
      shopId: shop.id,
      shopName: shop.name,
      shopLimit: customer.shopLimit,
      subdomain: shop.subdomain,
      isPublished: shop.isPublished,
      emailVerified: customer.emailVerifiedAt !== null,
      shops: customer.shops.map(toShopSummary),
    },
  };
}

/** Resolves a bearer token to its customer, or null if missing/expired/unknown. */
export async function customerFromSessionToken(
  token: string | null,
): Promise<CustomerAccount | null> {
  if (!token) return null;

  const session = await db.customerSession.findUnique({
    where: { token },
    include: { customer: { include: { shops: true } } },
  });

  if (!session || session.expires < new Date()) return null;

  // `shops[0]` — the "primary" shop for callers that only expect one.
  const shop = session.customer.shops[0];
  if (!shop) return null;

  return {
    id: session.customer.id,
    // Non-null: a CustomerSession only ever gets created by createSession(),
    // called from registerCustomer/signInCustomer, both of which already
    // required a real email on this row.
    email: session.customer.email!,
    name: session.customer.name,
    shopId: shop.id,
    shopName: shop.name,
    shopLimit: session.customer.shopLimit,
    subdomain: shop.subdomain,
    isPublished: shop.isPublished,
    emailVerified: session.customer.emailVerifiedAt !== null,
    shops: session.customer.shops.map(toShopSummary),
  };
}

/** Idempotent: deleting a token that is already gone is not an error. */
export async function signOutCustomer(token: string | null): Promise<void> {
  if (!token) return;
  await db.customerSession.deleteMany({ where: { token } });
}

/**
 * Sets (or replaces) a customer's login password — the only way
 * `passwordHash` is ever written outside of self-registration. Always hashes
 * here; nothing upstream of this function should ever handle or store a raw
 * hash, so there is exactly one place a plaintext password becomes bcrypt.
 *
 * Requires the customer to already have an email: login is
 * email+password, so a password with no email to pair it with could never
 * actually be used to sign in. The admin panel's "set password" action
 * should ask for an email first if this fails, not silently accept it.
 */
export async function setCustomerPassword(
  customerId: string,
  password: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = customerPasswordRule.safeParse(password);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message };
  }

  const customer = await db.customer.findUnique({ where: { id: customerId } });
  if (!customer) return { ok: false, error: "Customer not found." };
  if (!customer.email) {
    return { ok: false, error: "Add an email for this customer before setting a password." };
  }

  const passwordHash = await hash(parsed.data, BCRYPT_COST);
  await db.customer.update({ where: { id: customerId }, data: { passwordHash } });

  return { ok: true };
}

/**
 * Self-service password change — distinct from `setCustomerPassword`
 * (the admin panel's action, no current-password check, since an admin
 * already carries authority over the account). This one requires proving
 * the current password first: reaching this function only means holding a
 * valid session cookie, and a stolen/leaked session token should not be
 * enough on its own to lock the real owner out by changing their password.
 */
export async function changeCustomerPassword(
  customerId: string,
  currentPassword: string,
  newPassword: unknown,
  /** The session making the change. It is the one session left signed in. */
  keepSessionToken?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const customer = await db.customer.findUnique({ where: { id: customerId } });
  if (!customer?.passwordHash) return { ok: false, error: "Customer not found." };

  const matches = await compare(currentPassword, customer.passwordHash);
  if (!matches) return { ok: false, error: "Current password is incorrect." };

  const parsed = customerPasswordRule.safeParse(newPassword);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message };
  }

  const passwordHash = await hash(parsed.data, BCRYPT_COST);
  // A password is changed because the old one may be known to someone else. Whoever is
  // signed in with it elsewhere is signed out; the person changing it, here, is not.
  await db.$transaction([
    db.customer.update({ where: { id: customerId }, data: { passwordHash } }),
    db.customerSession.deleteMany({
      where: { customerId, ...(keepSessionToken ? { token: { not: keepSessionToken } } : {}) },
    }),
  ]);

  return { ok: true };
}

const updateProfileSchema = z.object({
  name: z.string().trim().max(120).optional(),
  email: emailRule,
});

/** Self-service name/email update — the account-owner's own dashboard, not the admin panel. */
export async function updateCustomerProfile(
  customerId: string,
  input: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = updateProfileSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message };
  }
  const { name, email } = parsed.data;

  const existing = await db.customer.findUnique({ where: { email } });
  if (existing && existing.id !== customerId) {
    return { ok: false, error: `${email} is already in use by another account.` };
  }

  // A new address has not been shown to be theirs, whatever the old one was.
  const current = await db.customer.findUnique({ where: { id: customerId }, select: { email: true } });
  const emailChanged = current?.email !== email;
  await db.customer.update({
    where: { id: customerId },
    data: { name: name ?? null, email, ...(emailChanged ? { emailVerifiedAt: null } : {}) },
  });

  return { ok: true };
}
