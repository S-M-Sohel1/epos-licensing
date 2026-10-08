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

/**
 * Side-effect-free — safe to call on every keystroke from the dashboard's
 * live-typing check. Does not distinguish "reserved" from "taken" in the
 * public message, so a caller can't use this to enumerate reserved words
 * beyond what's already public knowledge.
 */
export async function checkSlugAvailability(slugInput: unknown): Promise<SlugCheckResult> {
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

  const check = await checkSlugAvailability(slugInput);
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
