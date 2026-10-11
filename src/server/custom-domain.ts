import { Resolver } from "node:dns/promises";
import { request } from "node:https";

import { z } from "zod";

import { AuditEventType } from "generated/prisma";
import { db } from "~/server/db";
import { STOREFRONT_DOMAIN } from "~/server/shop-connection";
import type { ShopActor } from "~/server/shops";

/**
 * A shop's own domain (`www.royalkebab.ie`), beside the subdomain it always has.
 *
 * The owner saves it from their dashboard, or staff here; nothing is registered anywhere else. The web platform's server answers
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

/**
 * Saves a shop's own domain, or with a blank takes it away. The owner (the shop has to be
 * theirs) or staff.
 *
 * An owner needs no proof that the domain is theirs: saving it shows nothing anywhere until
 * the domain's DNS points at our server, and only whoever controls the domain can do that.
 * What saving does do is keep the name from every other shop, so a domain that is already
 * saved elsewhere is refused and staff sort out whose it is.
 */
export async function setCustomDomain(shopId: string, input: unknown, by: ShopActor): Promise<SetCustomDomainResult> {
  const shop = await db.shop.findUnique({ where: { id: shopId } });
  if (!shop || ("customerId" in by && shop.customerId !== by.customerId)) return { ok: false, error: "Shop not found." };
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
      return { ok: false, error: "This shop needs a subdomain first." };
    }
    const clash = await db.shop.findFirst({
      where: { id: { not: shopId }, customDomain: { in: [domain, otherForm(domain)] } },
      select: { name: true },
    });
    if (clash) {
      return {
        ok: false,
        // An owner is not told whose: that is another customer's business.
        error: "admin" in by ? `That domain is already on another shop (${clash.name}).` : "That domain is already in use. Contact us if it is yours.",
      };
    }
  }

  if (domain === previous) return { ok: true, domain, previous };

  await db.$transaction([
    db.shop.update({ where: { id: shopId }, data: { customDomain: domain } }),
    db.auditEvent.create({
      data: {
        type: AuditEventType.shop_updated,
        actor: "admin" in by ? by.admin : "client",
        summary: domain
          ? `Own domain of ${shop.name} set to ${domain}${previous ? ` (was ${previous})` : ""}`
          : `Own domain ${previous} removed from ${shop.name}`,
      },
    }),
  ]);

  return { ok: true, domain, previous };
}

/** What an owner's record points at. */
const TARGET = CUSTOM_DOMAIN_TARGET;

/** One DNS record for the owner to add, and whether it is there yet. */
export interface DnsRecord {
  type: "CNAME" | "A";
  /** As a DNS provider's form wants it: the part before the owner's domain, or "@" for the domain itself. */
  name: string;
  /** The whole name, for anyone unsure what `name` is short for. */
  host: string;
  value: string;
  /**
   * `valid`: the name leads to our server. `missing`: the name does not exist. `proxied`: it
   * leads to Cloudflare, which is what a record left on "Proxied" there looks like, and the
   * commonest way to get this wrong. `elsewhere`: it leads somewhere else, named in `found`.
   * `unknown`: it could not be checked.
   */
  state: "valid" | "missing" | "proxied" | "elsewhere" | "unknown";
  found: string | null;
}

export interface DomainSetup {
  /**
   * `live`: the domain shows this shop. `starting`: the record is right and the website is not
   * answering there yet, which is the minute or two it takes to notice the domain and get its
   * certificate. `waiting`: the record is not right yet.
   */
  status: "live" | "starting" | "waiting";
  /** The one record that makes the domain work. */
  record: DnsRecord;
  /**
   * The same domain with or without "www.", which is sent on to the saved one if the owner
   * points it here too. Worth having, never needed.
   */
  optional: DnsRecord;
}

// Short waits: this runs while a page is being built.
const dns = new Resolver({ timeout: 3000, tries: 2 });

/**
 * The domain a name is managed under: `nanitex.com` for `test.nanitex.com`, `royalkebab.co.uk`
 * for itself. Found by asking which of the name and its parents has name servers of its own,
 * which needs no list of what counts as a domain ending. Falls back to the last two labels.
 */
async function zoneOf(host: string): Promise<string> {
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join(".");
    const found = await dns.resolveNs(candidate).then((servers) => servers.length > 0, () => false);
    if (found) return candidate;
  }
  return labels.slice(-2).join(".");
}

/**
 * The record that points `host` at us, and whether it is in place. The domain itself (the top
 * of its zone) cannot be a CNAME at most providers, so it is an A record to the server's
 * address; any name under it is a CNAME to ours, which follows the server if it ever moves.
 *
 * "In place" is judged by where the name leads, not by the record's type: an owner whose
 * provider flattens a CNAME, or who used an A record under a domain, has done it right.
 */
async function recordFor(
  host: string,
  zone: string,
  serverAddress: string | null,
  zoneServers: Resolver | null,
): Promise<DnsRecord> {
  const top = host === zone;
  const base = {
    type: top ? ("A" as const) : ("CNAME" as const),
    name: top ? "@" : host.slice(0, -(zone.length + 1)),
    host,
    value: top ? (serverAddress ?? "") : TARGET,
  };
  if (!serverAddress) return { ...base, state: "unknown", found: null };

  try {
    const addresses = await addressesOf(host, zoneServers);
    if (addresses.includes(serverAddress)) return { ...base, state: "valid", found: null };
    const found = addresses[0] ?? null;
    return { ...base, state: found && isCloudflare(found) ? "proxied" : "elsewhere", found };
  } catch (error) {
    const code = (error as { code?: string }).code;
    return { ...base, state: code === "ENOTFOUND" || code === "ENODATA" ? "missing" : "unknown", found: null };
  }
}

/**
 * A resolver that asks the zone's own name servers, or null if they cannot be found.
 *
 * The ordinary resolver remembers a "no such name" for as long as the zone says, half an hour
 * at Cloudflare. This page asks about a name before its record exists, so the ordinary
 * resolver would then go on saying "not found" long after the owner had added it, and "Check
 * again" would be a lie. The zone's own servers remember nothing: they are where the record is.
 */
async function serversOf(zone: string): Promise<Resolver | null> {
  const names = await dns.resolveNs(zone).catch(() => [] as string[]);
  const found = await Promise.all(names.slice(0, 2).map((name) => dns.resolve4(name).catch(() => [] as string[])));
  const addresses = found.flat();
  if (addresses.length === 0) return null;
  const servers = new Resolver({ timeout: 3000, tries: 2 });
  servers.setServers(addresses);
  return servers;
}

/**
 * Where a name leads. Throws as `resolve4` does for a name that does not exist.
 *
 * A zone's own server answers for its own names only. So a CNAME is read from it, and the name
 * it points at (ours, in the right case) is then looked up the ordinary way.
 */
async function addressesOf(host: string, zoneServers: Resolver | null): Promise<string[]> {
  if (!zoneServers) return dns.resolve4(host);
  const alias = await zoneServers.resolveCname(host).then(
    (names) => names[0] ?? null,
    (error: { code?: string }) => {
      if (error.code === "ENODATA") return null;
      throw error;
    },
  );
  return alias ? dns.resolve4(alias) : zoneServers.resolve4(host);
}

/**
 * Which shop our server shows for a domain, or null: a request to the server's own address
 * that names the domain, so it does not depend on any resolver having caught up. The
 * certificate is checked against the domain, so "shows the shop" means over a working https.
 *
 * Only to be asked once the domain's record is right. The server gets a certificate the first
 * time a saved domain is asked for, and asking on behalf of a domain that does not lead to it
 * yet would have it try, fail, and use up the few attempts the certificate authority allows.
 */
function shopShownAt(domain: string, serverAddress: string): Promise<string | null> {
  return new Promise((resolve) => {
    const call = request(
      { host: serverAddress, servername: domain, method: "HEAD", path: "/", headers: { host: domain }, timeout: 8000 },
      (response) => {
        response.resume();
        const shown = response.headers["x-epos-shop"];
        resolve(typeof shown === "string" ? shown : null);
      },
    );
    call.on("timeout", () => call.destroy());
    call.on("error", () => resolve(null));
    call.end();
  });
}

/** Cloudflare's published IPv4 ranges (https://www.cloudflare.com/ips/), as [first address, prefix length]. */
const CLOUDFLARE: [string, number][] = [
  ["173.245.48.0", 20], ["103.21.244.0", 22], ["103.22.200.0", 22], ["103.31.4.0", 22], ["141.101.64.0", 18],
  ["108.162.192.0", 18], ["190.93.240.0", 20], ["188.114.96.0", 20], ["197.234.240.0", 22], ["198.41.128.0", 17],
  ["162.158.0.0", 15], ["104.16.0.0", 13], ["104.24.0.0", 14], ["172.64.0.0", 13], ["131.0.72.0", 22],
];

function toNumber(address: string): number {
  return address.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
}

function isCloudflare(address: string): boolean {
  const value = toNumber(address);
  return CLOUDFLARE.some(([first, bits]) => {
    const size = 2 ** (32 - bits);
    return Math.floor(value / size) === Math.floor(toNumber(first) / size);
  });
}

/**
 * Everything the owner's side of a domain comes to: the record to add, whether it is there,
 * and whether the domain shows the shop yet.
 *
 * "Shows the shop" is asked of the server itself (`shopShownAt`). The web platform marks every
 * page it serves on a shop's own domain with that shop's subdomain (`x-epos-shop`).
 */
export async function domainSetup(domain: string, subdomain: string | null): Promise<DomainSetup> {
  const other = domain.startsWith("www.") ? domain.slice(4) : `www.${domain}`;
  const [serverAddress, zone] = await Promise.all([
    dns.resolve4(TARGET).then((found) => found[0] ?? null, () => null),
    zoneOf(domain),
  ]);
  const zoneServers = await serversOf(zone);
  const [record, optional] = await Promise.all([
    recordFor(domain, zone, serverAddress, zoneServers),
    recordFor(other, zone, serverAddress, zoneServers),
  ]);

  const shown = serverAddress && record.state === "valid" ? await shopShownAt(domain, serverAddress) : null;
  const live = shown !== null && shown === subdomain;
  return { status: live ? "live" : record.state === "valid" ? "starting" : "waiting", record, optional };
}
