import { resolve4 } from "node:dns/promises";

import { z } from "zod";

import { AuditEventType } from "generated/prisma";
import { db } from "~/server/db";
import { STOREFRONT_DOMAIN } from "~/server/shop-connection";

/**
 * A shop's own domain (`www.royalkebab.ie`), beside the subdomain it always has.
 *
 * Staff save it here; nothing is registered anywhere else. The web platform's server answers
 * for any domain that is saved on a shop and pointed at it: it gets the certificate itself the
 * first time the domain is visited (Caddy, on demand), having asked the web platform whether
 * the domain is a shop's. So "saved here" plus "the owner's DNS points at the server" is the
 * whole of it, and neither half does anything alone.
 *
 * The shop keeps its subdomain, which goes on working, and needs one: its pages are filed
 * under it whichever address they are reached at.
 */

/** What an owner's `www` record points at: a name of ours, so the server can move without every owner changing DNS. */
export const CUSTOM_DOMAIN_TARGET = `shops.${STOREFRONT_DOMAIN}`;

const domainRule = z
  .string()
  .trim()
  .toLowerCase()
  // Pasted from a browser's address bar as often as typed.
  .transform((value) => value.replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/\.$/, ""))
  .pipe(
    z
      .string()
      .max(253, "That is too long to be a domain.")
      .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Enter a domain like www.royalkebab.ie."),
  );

/** `www.x.ie` for `x.ie` and the other way round: the web platform answers at both and sends one to the other. */
function otherForm(domain: string): string {
  return domain.startsWith("www.") ? domain.slice(4) : `www.${domain}`;
}

export type SetCustomDomainResult =
  | { ok: true; domain: string | null; previous: string | null }
  | { ok: false; error: string };

/** Saves a shop's own domain, or with a blank takes it away. Staff only. */
export async function setCustomDomain(shopId: string, input: unknown, admin: string): Promise<SetCustomDomainResult> {
  const shop = await db.shop.findUnique({ where: { id: shopId } });
  if (!shop) return { ok: false, error: "Shop not found." };
  const previous = shop.customDomain;

  let domain: string | null = null;
  if (typeof input === "string" && input.trim() !== "") {
    const parsed = domainRule.safeParse(input);
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Enter a domain." };
    domain = parsed.data;

    if (domain === STOREFRONT_DOMAIN || domain.endsWith(`.${STOREFRONT_DOMAIN}`)) {
      return { ok: false, error: `That is one of our own addresses. To change the part before .${STOREFRONT_DOMAIN}, change the subdomain.` };
    }
    if (!shop.subdomain) {
      return { ok: false, error: "This shop needs a subdomain first. The owner sets one up from their account." };
    }
    const clash = await db.shop.findFirst({
      where: { id: { not: shopId }, customDomain: { in: [domain, otherForm(domain)] } },
      select: { name: true },
    });
    if (clash) return { ok: false, error: `That domain is already on another shop (${clash.name}).` };
  }

  if (domain === previous) return { ok: true, domain, previous };

  await db.$transaction([
    db.shop.update({ where: { id: shopId }, data: { customDomain: domain } }),
    db.auditEvent.create({
      data: {
        type: AuditEventType.shop_updated,
        actor: admin,
        summary: domain
          ? `Own domain of ${shop.name} set to ${domain}${previous ? ` (was ${previous})` : ""}`
          : `Own domain ${previous} removed from ${shop.name}`,
      },
    }),
  ]);

  return { ok: true, domain, previous };
}

export type CustomDomainStatus =
  /** The domain reaches the web platform and shows this shop. */
  | "live"
  /** It reaches the web platform, which does not show this shop there (yet: it can take two minutes after saving). */
  | "not_this_shop"
  /** Nothing of ours answers there: the DNS is not pointed yet, or the certificate is still being got. */
  | "not_reachable";

/**
 * Looks at the domain from outside, the way a visitor's browser would. The web platform marks
 * every page it serves on a shop's own domain with that shop's subdomain (`x-epos-shop`), so
 * this cannot be fooled by a parking page or another host answering there.
 */
export async function customDomainStatus(domain: string, subdomain: string | null): Promise<CustomDomainStatus> {
  try {
    const response = await fetch(`https://${domain}/`, {
      method: "HEAD",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });
    const shown = response.headers.get("x-epos-shop");
    if (!shown) return "not_reachable";
    return shown === subdomain ? "live" : "not_this_shop";
  } catch {
    return "not_reachable";
  }
}

/** The DNS records an owner adds for a domain, in the words their DNS provider uses. */
export interface DnsRecord {
  type: "CNAME" | "A";
  name: string;
  value: string;
}

/**
 * What to ask the owner to add. `www.x.ie` (or any other name under a domain) is a CNAME to
 * ours; the bare `x.ie` cannot be a CNAME at most providers, so it is an A record to the
 * server's address, read from our own DNS so that it is written down in one place only.
 *
 * Which names are "bare" cannot be told from the text (`x.co.uk` is, `order.x.ie` is not), so
 * a domain saved with "www." gets both records and anything else gets the A record, with the
 * CNAME offered as the alternative for a name under a domain.
 */
export async function dnsRecordsFor(domain: string): Promise<{ records: DnsRecord[]; serverAddress: string | null }> {
  const serverAddress = await resolve4(CUSTOM_DOMAIN_TARGET).then((found) => found[0] ?? null, () => null);
  const bare = domain.startsWith("www.") ? domain.slice(4) : domain;
  const records: DnsRecord[] = [{ type: "CNAME", name: `www.${bare}`, value: CUSTOM_DOMAIN_TARGET }];
  if (serverAddress) records.push({ type: "A", name: bare, value: serverAddress });
  return { records, serverAddress };
}
