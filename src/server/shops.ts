import { z } from "zod";

import { AuditEventType, TemplateId } from "generated/prisma";
import { db } from "~/server/db";

/** Keep in sync with the `TemplateId` enum — Zod can't read it from the Prisma enum directly. */
const templateIdRule = z.nativeEnum(TemplateId).default(TemplateId.general);

/**
 * Subdomain activation for a customer's own shop — the self-serve half of
 * Milestone 1 (see ../../../Epos365/SUBDOMAIN_ARCHITECTURE.md). Registration
 * already creates the Shop; this is what turns it into a live storefront,
 * gated on `Customer.shopLimit`.
 */

// "lic" is the licensing backend (lic.epos-365.com); the other three are near-misses of it.
const RESERVED_SUBDOMAINS = new Set(["www", "dashboard", "admin", "api", "store", "lic", "licensing", "license", "licence"]);

export const slugRule = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Use at least 3 characters.")
  .max(63, "That's too long — 63 characters max.")
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Lowercase letters, numbers, and single hyphens only.");

export type SlugCheckResult = { available: boolean; reason?: string };

/** How long a subdomain a shop has given up stays out of reach of every other shop. */
const RETIRED_FOR_DAYS = 30;
/** How many times an owner may change one shop's subdomain within those days. Staff are not limited. */
const OWNER_CHANGES_ALLOWED = 3;

function retiredSince(): Date {
  return new Date(Date.now() - RETIRED_FOR_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Side-effect-free — safe to call on every keystroke from the dashboard's
 * live-typing check. Does not distinguish "reserved" from "taken" in the
 * public message, so a caller can't use this to enumerate reserved words
 * beyond what's already public knowledge.
 *
 * `forShopId` is the shop the name is wanted for. A name that shop itself gave
 * up is still its own to take back; without it, every recently given-up name
 * is unavailable.
 */
export async function checkSlugAvailability(slugInput: unknown, forShopId?: string): Promise<SlugCheckResult> {
  const parsed = slugRule.safeParse(slugInput);
  if (!parsed.success) {
    return { available: false, reason: parsed.error.issues[0]?.message };
  }
  const slug = parsed.data;

  if (RESERVED_SUBDOMAINS.has(slug)) {
    return { available: false, reason: "That name isn't available." };
  }

  const existing = await db.shop.findUnique({ where: { subdomain: slug } });
  if (existing) {
    return { available: false, reason: "That name is already taken." };
  }

  const retired = await db.retiredSubdomain.findUnique({ where: { subdomain: slug } });
  if (retired && retired.shopId !== forShopId && retired.retiredAt > retiredSince()) {
    return { available: false, reason: "That name isn't available." };
  }

  return { available: true };
}

const createShopSchema = z.object({
  businessName: z.string().trim().min(1, "Business name is required.").max(120),
  templateId: templateIdRule,
});

export type CreateShopResult =
  | {
      ok: true;
      shop: { id: string; name: string; subdomain: string | null; isPublished: boolean; templateId: TemplateId };
    }
  | { ok: false; error: string };

/**
 * Adds another Shop to an existing customer's account — the self-serve path
 * for using a `shopLimit` slot beyond the one Shop registration already
 * creates. Gated on the same `shopLimit` number that gates subdomain
 * activation: a slot only matters once it can carry a live storefront, so
 * capping row creation there too keeps "N of shopLimit" in the dashboard
 * meaningful instead of letting shops accumulate with nowhere to go.
 */
export async function createShop(customerId: string, input: unknown): Promise<CreateShopResult> {
  const parsed = createShopSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid business name." };
  }

  const customer = await db.customer.findUnique({
    where: { id: customerId },
    include: { shops: true },
  });
  if (!customer) return { ok: false, error: "Customer not found." };
  if (customer.shops.length >= customer.shopLimit) {
    return { ok: false, error: "You've used all of your available shop slots — contact support." };
  }

  const shop = await db.shop.create({
    data: {
      name: parsed.data.businessName,
      email: customer.email,
      customerId,
      templateId: parsed.data.templateId,
    },
  });
  await db.auditEvent.create({
    data: {
      type: AuditEventType.shop_updated,
      actor: "client",
      summary: `${shop.name} added as a new shop (${shop.templateId})`,
    },
  });

  return {
    ok: true,
    shop: {
      id: shop.id,
      name: shop.name,
      subdomain: shop.subdomain,
      isPublished: shop.isPublished,
      templateId: shop.templateId,
    },
  };
}

export type ActivateSubdomainResult =
  | { ok: true; subdomain: string }
  | { ok: false; error: string };

/**
 * The only place `Shop.subdomain` is ever written to a non-null value.
 * `customerId` must be the caller's own — enforced by the route handler
 * resolving it from the session token, never trusted from the request body.
 *
 * `templateIdInput` is optional: a shop created via self-registration never
 * got a template choice (it defaults to `general`), so activation is the
 * first moment one can be picked. A shop created through `createShop`
 * already has its real template — passing nothing here leaves it alone
 * rather than silently resetting it back to `general`.
 */
export async function activateSubdomain(
  customerId: string,
  shopId: string,
  slugInput: unknown,
  templateIdInput?: unknown,
): Promise<ActivateSubdomainResult> {
  const shop = await db.shop.findUnique({ where: { id: shopId } });
  if (shop?.customerId !== customerId) {
    return { ok: false, error: "Shop not found." };
  }
  if (shop.subdomain) {
    return { ok: false, error: "This shop already has a subdomain." };
  }

  const check = await checkSlugAvailability(slugInput, shopId);
  if (!check.available) {
    return { ok: false, error: check.reason ?? "That name isn't available." };
  }
  const slug = slugRule.parse(slugInput);

  const parsedTemplateId = z.nativeEnum(TemplateId).optional().safeParse(templateIdInput);
  const templateId = parsedTemplateId.success ? parsedTemplateId.data : undefined;

  const customer = await db.customer.findUnique({
    where: { id: customerId },
    include: { shops: { where: { subdomain: { not: null } } } },
  });
  if (!customer) return { ok: false, error: "Customer not found." };
  if (customer.shops.length >= customer.shopLimit) {
    return {
      ok: false,
      error: "This account isn't cleared for a subdomain yet — contact support.",
    };
  }

  const updated = await db.$transaction(async (tx) => {
    // Re-checked inside the transaction: closes the race between two
    // concurrent activations both passing the availability check above for
    // the same slug.
    const clash = await tx.shop.findUnique({ where: { subdomain: slug } });
    if (clash) return null;

    const updated = await tx.shop.update({
      where: { id: shopId },
      data: {
        subdomain: slug,
        isPublished: true,
        publishedAt: new Date(),
        ...(templateId ? { templateId } : {}),
      },
    });
    // The shop's own old name, taken back: it is in use again, not given up.
    await tx.retiredSubdomain.deleteMany({ where: { subdomain: slug } });
    await tx.auditEvent.create({
      data: {
        type: AuditEventType.shop_updated,
        actor: "client",
        summary: `${shop.name} activated subdomain ${slug}`,
      },
    });
    return updated;
  });

  if (!updated?.subdomain) {
    return { ok: false, error: "That name was just taken — try another." };
  }

  return { ok: true, subdomain: updated.subdomain };
}

/**
 * Who is changing a shop's website address: its owner, from their dashboard
 * (`customerId` from the session, and the shop must be theirs), or a member of
 * staff from this panel (their email, as on an AuditEvent).
 */
export type ShopActor = { customerId: string } | { admin: string };

type OwnedShop = { id: string; name: string; subdomain: string | null; isPublished: boolean };

async function shopFor(shopId: string, by: ShopActor): Promise<OwnedShop | null> {
  const shop = await db.shop.findUnique({ where: { id: shopId } });
  if (!shop) return null;
  if ("customerId" in by && shop.customerId !== by.customerId) return null;
  return shop;
}

function auditActor(by: ShopActor): string {
  return "admin" in by ? by.admin : "client";
}

export type ChangeSubdomainResult =
  /** `previous` is the address that has just stopped working, for the website to forget. */
  | { ok: true; subdomain: string; previous: string }
  | { ok: false; error: string };

/**
 * Moves a shop's website to a different subdomain. The old address stops
 * working at once and is kept out of every other shop's reach for
 * RETIRED_FOR_DAYS (see RetiredSubdomain).
 *
 * Nothing else about the shop changes, because nothing else is filed under the
 * name: the menu, orders, staff and tills all belong to the shop's id. Staff
 * and customers are signed out, as their sessions are cookies of the old
 * address.
 */
export async function changeSubdomain(shopId: string, slugInput: unknown, by: ShopActor): Promise<ChangeSubdomainResult> {
  const shop = await shopFor(shopId, by);
  if (!shop) return { ok: false, error: "Shop not found." };
  const previous = shop.subdomain;
  if (!previous) return { ok: false, error: "This shop has no subdomain to change yet." };

  const parsed = slugRule.safeParse(slugInput);
  if (parsed.success && parsed.data === previous) {
    return { ok: false, error: "That is already this shop's subdomain." };
  }

  const check = await checkSlugAvailability(slugInput, shopId);
  if (!check.available) {
    return { ok: false, error: check.reason ?? "That name isn't available." };
  }
  const slug = slugRule.parse(slugInput);

  // Each change leaves a name nobody else can use for a month. Staff can still make the change
  // for an owner who has a real reason for a fourth.
  if ("customerId" in by) {
    const recent = await db.retiredSubdomain.count({ where: { shopId, retiredAt: { gt: retiredSince() } } });
    if (recent >= OWNER_CHANGES_ALLOWED) {
      return {
        ok: false,
        error: `This shop's subdomain has been changed ${OWNER_CHANGES_ALLOWED} times in the last ${RETIRED_FOR_DAYS} days. Contact us to change it again.`,
      };
    }
  }

  const changed = await db.$transaction(async (tx) => {
    // Re-checked inside the transaction, as in activateSubdomain.
    const clash = await tx.shop.findUnique({ where: { subdomain: slug } });
    if (clash) return false;

    await tx.shop.update({ where: { id: shopId }, data: { subdomain: slug } });
    await tx.retiredSubdomain.upsert(retired(previous, shopId));
    await tx.retiredSubdomain.deleteMany({ where: { subdomain: slug } });
    await tx.auditEvent.create({
      data: {
        type: AuditEventType.shop_updated,
        actor: auditActor(by),
        summary: `Subdomain of ${shop.name} changed from ${previous} to ${slug}`,
      },
    });
    return true;
  });

  if (!changed) return { ok: false, error: "That name was just taken — try another." };
  return { ok: true, subdomain: slug, previous };
}

export type RemoveSubdomainResult = { ok: true; previous: string } | { ok: false; error: string };

/**
 * Takes a shop's website address away altogether, which frees one of the
 * account's subdomain slots. Staff only: an owner who wants the website to
 * stop showing takes it offline (`setShopPublished`), which is undone with one
 * click and keeps the address.
 *
 * Nothing is deleted. The shop can be given a subdomain again from the owner's
 * dashboard, and its menu, orders and staff are there when it is.
 */
export async function removeSubdomain(shopId: string, by: { admin: string }): Promise<RemoveSubdomainResult> {
  const shop = await shopFor(shopId, by);
  if (!shop) return { ok: false, error: "Shop not found." };
  const previous = shop.subdomain;
  if (!previous) return { ok: false, error: "This shop has no subdomain." };

  await db.$transaction(async (tx) => {
    await tx.shop.update({ where: { id: shopId }, data: { subdomain: null, isPublished: false } });
    await tx.retiredSubdomain.upsert(retired(previous, shopId));
    await tx.auditEvent.create({
      data: {
        type: AuditEventType.shop_updated,
        actor: auditActor(by),
        summary: `Subdomain ${previous} removed from ${shop.name}`,
      },
    });
  });

  return { ok: true, previous };
}

export type SetPublishedResult =
  | { ok: true; subdomain: string; isPublished: boolean }
  | { ok: false; error: string };

/**
 * Takes a shop's website offline, or puts it back. Offline, every page of the
 * website answers "not found", the shop's own admin included; the address stays
 * the shop's and nothing is deleted.
 */
export async function setShopPublished(shopId: string, published: boolean, by: ShopActor): Promise<SetPublishedResult> {
  const shop = await shopFor(shopId, by);
  if (!shop) return { ok: false, error: "Shop not found." };
  if (!shop.subdomain) return { ok: false, error: "This shop has no website yet." };
  if (shop.isPublished === published) {
    return { ok: true, subdomain: shop.subdomain, isPublished: published };
  }

  await db.$transaction([
    db.shop.update({
      where: { id: shopId },
      data: { isPublished: published, ...(published ? { publishedAt: new Date() } : {}) },
    }),
    db.auditEvent.create({
      data: {
        type: AuditEventType.shop_updated,
        actor: auditActor(by),
        summary: published ? `Website of ${shop.name} put back online` : `Website of ${shop.name} taken offline`,
      },
    }),
  ]);

  return { ok: true, subdomain: shop.subdomain, isPublished: published };
}

/** The row recording that `shopId` has given `subdomain` up, now. A name given up before is dated again. */
function retired(subdomain: string, shopId: string) {
  return {
    where: { subdomain },
    create: { subdomain, shopId },
    update: { shopId, retiredAt: new Date() },
  };
}
