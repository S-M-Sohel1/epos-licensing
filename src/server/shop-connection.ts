import type { TemplateId } from "generated/prisma";
import { db } from "~/server/db";
import { effectiveLicenseState, type EffectiveLicenseState } from "~/app/_lib/format";

/**
 * How one shop's three parts fit together: its website, its licence(s) and the menu its tills
 * send. The admin's shop page shows this, so a licence issued to the wrong shop, or a website
 * nobody connected a till to, is visible in a sentence rather than discovered by the owner.
 *
 * A shop's tills reach its website only through the licence: a till sends with its licence key,
 * and the menu is filed under the shop that licence belongs to. So "which shop is this licence
 * on" is the whole connection, and this module is the one place that describes it.
 */

/**
 * The domain shops' websites are served under: `<subdomain>.epos-365.com`. The web platform's
 * `APP_DOMAIN`; this app never needs it for anything but showing the address.
 */
export const STOREFRONT_DOMAIN = "epos-365.com";

type WebsiteFields = { subdomain: string | null; customDomain: string | null; isPublished: boolean };

/** "royalkebab.epos-365.com", the shop's own domain when it has one, or null with neither. */
export function websiteAddress(shop: WebsiteFields): string | null {
  if (shop.customDomain) return shop.customDomain;
  if (shop.subdomain) return `${shop.subdomain}.${STOREFRONT_DOMAIN}`;
  return null;
}

/**
 * One line naming a shop well enough to tell it from a similar one: the name, its website and
 * its owner. Used wherever an admin picks a shop.
 */
export function describeShop(shop: WebsiteFields & { name: string; customer?: { name: string | null } | null }): string {
  const parts = [shop.name, websiteAddress(shop) ?? "no website yet"];
  const owner = shop.customer?.name;
  if (owner && owner !== shop.name) parts.push(owner);
  return parts.join(" · ");
}

/**
 * The storefronts a shop's website can show, named the way the owner's own sign-up wizard names
 * them (epos_corporate_web, dashboard/subdomain/_lib/templates.ts).
 */
export const TEMPLATE_LABELS: Record<TemplateId, { name: string; description: string }> = {
  restaurant: {
    name: "Restaurant or takeaway",
    description: "The full website: menu, online ordering, delivery and pickup, and the shop's own admin for orders and the menu.",
  },
  general: {
    name: "Simple page",
    description: "Only the shop's name on a coloured page. No menu, no ordering and no admin.",
  },
};

export type WebsiteState = "live" | "not_published" | "none";

export type ShopConnection = {
  website: { address: string | null; state: WebsiteState };
  licences: {
    id: string;
    key: string;
    state: EffectiveLicenseState;
    validUntil: Date;
    tills: number;
    maxDevices: number;
  }[];
  menu: {
    items: number;
    groups: number;
    lastSentAt: Date | null;
    /** "Till 2 · Dublin": the till that sends this shop's menu, if one does. */
    sentBy: string | null;
  };
  /** Plain sentences for whatever is missing or doubtful, most important first. */
  problems: ShopProblem[];
};

export type ShopProblem = {
  text: string;
  /** What to press to fix it, when the fix is in this panel. */
  action?: { label: string; href: string };
};

/** Bigint counts from raw queries. */
const n = (value: unknown) => Number(value ?? 0);

export async function getShopConnection(shopId: string, now = new Date()): Promise<ShopConnection | null> {
  const shop = await db.shop.findUnique({
    where: { id: shopId },
    include: {
      licenses: {
        orderBy: { issuedAt: "asc" },
        include: { devices: { where: { status: "approved" } } },
      },
      customer: {
        include: {
          shops: {
            where: { id: { not: shopId } },
            include: { _count: { select: { licenses: true } } },
            orderBy: { name: "asc" },
          },
        },
      },
    },
  });
  if (!shop) return null;

  const [counts] = await db.$queryRaw<{ items: bigint; groups: bigint; at: Date | null }[]>`
    SELECT
      (SELECT count(*) FROM pos_sync.catalog_item WHERE "shopId" = ${shopId} AND "deletedAt" IS NULL) AS items,
      (SELECT count(*) FROM pos_sync.catalog_category WHERE "shopId" = ${shopId} AND "deletedAt" IS NULL) AS groups,
      (SELECT "updatedAt" FROM pos_sync.catalog_state WHERE "shopId" = ${shopId}) AS at`;

  const publisher = shop.licenses.flatMap((l) => l.devices).find((d) => d.canPublishCatalog) ?? null;
  const sentBy = publisher
    ? [publisher.terminalNumber === null ? "A till" : `Till ${publisher.terminalNumber}`, publisher.geoCity]
        .filter(Boolean)
        .join(" · ")
    : null;

  const address = websiteAddress(shop);
  const website: ShopConnection["website"] = {
    address,
    state: !address ? "none" : shop.isPublished ? "live" : "not_published",
  };

  const licences = shop.licenses.map((l) => ({
    id: l.id,
    key: l.key,
    state: effectiveLicenseState(l, now),
    validUntil: l.validUntil,
    tills: l.devices.length,
    maxDevices: l.maxDevices,
  }));
  const usable = licences.filter((l) => l.state === "active");

  const menu: ShopConnection["menu"] = {
    items: n(counts?.items),
    groups: n(counts?.groups),
    lastSentAt: counts?.at ?? null,
    sentBy,
  };

  const problems: ShopProblem[] = [];
  const giveLicence = { label: "Give this shop a license", href: `/licenses/new?shopId=${shop.id}` };

  if (address && licences.length === 0) {
    problems.push({
      text: "This shop has a website but no license, so no till can send its menu or take its online orders.",
      action: giveLicence,
    });
  } else if (address && usable.length === 0) {
    problems.push({
      text: "Every license of this shop is blocked or expired, so its website is not taking orders and its tills cannot send the menu.",
    });
  }

  if (!address && licences.length > 0) {
    problems.push({
      text: "This shop has a license but no website yet. The owner sets the website up from their own account.",
    });
  }

  if (address && shop.templateId !== "restaurant") {
    problems.push({
      text: `This shop's website uses the “${TEMPLATE_LABELS[shop.templateId].name}” template: only its name on a coloured page, with no menu, no ordering and no admin.${
        menu.items > 0 ? ` Its till has sent ${menu.items.toLocaleString("en-GB")} products that the website cannot show.` : ""
      }`,
      action: { label: "Change the template", href: "#template" },
    });
  }

  if (address && usable.length > 0 && menu.lastSentAt === null) {
    problems.push({
      text: "No till has sent this shop's menu yet. On the till: Settings › License › Turn on online publishing.",
    });
  }

  // The same owner with the other half on a different shop is how a licence ends up on the
  // wrong shop: the till then fills a website nobody looks at.
  for (const other of shop.customer?.shops ?? []) {
    const otherAddress = websiteAddress(other);
    const otherHasLicence = other._count.licenses > 0;
    const thisHasLicence = licences.length > 0;
    const openOther = { label: `Open “${other.name}”`, href: `/shops/${shop.customerId}/shop/${other.id}` };
    if (address && !thisHasLicence && otherHasLicence && !otherAddress) {
      problems.push({
        text: `The same owner's shop “${other.name}” has a license but no website. If they are the same shop, its tills are not connected to this website.`,
        action: openOther,
      });
    } else if (!address && thisHasLicence && otherAddress && !otherHasLicence) {
      problems.push({
        text: `The same owner's shop “${other.name}” has the website ${otherAddress} but no license. If they are the same shop, this license should be on that one.`,
        action: openOther,
      });
    } else if (address && otherAddress && thisHasLicence !== otherHasLicence) {
      problems.push({
        text: thisHasLicence
          ? `The same owner also has “${other.name}” (${otherAddress}), which has no license. This shop's tills send the menu to ${address}, not to that website. If the owner expects ${otherAddress}, the license is on the wrong shop.`
          : `The same owner also has “${other.name}” (${otherAddress}), and that is where their tills send the menu, not to ${address}. If the owner expects ${address}, the license is on the wrong shop.`,
        action: openOther,
      });
    }
  }

  return { website, licences, menu, problems };
}
