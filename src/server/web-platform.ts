import { env } from "~/env";

/**
 * Asks the web platform (epos_corporate_web) to forget what it remembers about one shop, so its
 * website reads the Shop row again on the next visit.
 *
 * The web platform keeps each shop for 30 days once looked up, so a change made here (a new
 * template, a new name) is invisible on the shop's website until this is called. Awaited, unlike
 * the catalogue hint in pos-sync/notify.ts: an admin who just changed a template is told whether
 * the website has it.
 */
export type WebRefresh = "refreshed" | "not_configured" | "failed";

export async function refreshShopOnWebsite(subdomain: string): Promise<WebRefresh> {
  const { WEB_PLATFORM_URL, INTERNAL_API_SECRET } = env;
  if (!WEB_PLATFORM_URL || !INTERNAL_API_SECRET) return "not_configured";

  try {
    const response = await fetch(`${WEB_PLATFORM_URL.replace(/\/$/, "")}/api/internal/shop-cache`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INTERNAL_API_SECRET}` },
      body: JSON.stringify({ subdomain }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.warn(`[web-platform] shop-cache for ${subdomain} answered ${response.status}`);
      return "failed";
    }
    return "refreshed";
  } catch (error) {
    console.warn(`[web-platform] shop-cache for ${subdomain} did not complete:`, error instanceof Error ? error.message : error);
    return "failed";
  }
}

/**
 * Asks the web platform to email a shop owner about a change made here: a licence issued, or more
 * web addresses allowed. This service has no email of its own; the web platform does. The email
 * links to the owner's dashboard and never carries the licence key.
 *
 * Awaited, so the admin is told whether the owner was emailed. Never throws.
 */
export type OwnerChange =
  | { kind: "licence_issued"; to: string; name?: string; shopName: string; tills: number; validUntil: string }
  | { kind: "web_address_limit_raised"; to: string; name?: string; limit: number };

export type OwnerEmail = "sent" | "not_configured" | "failed";

export async function emailOwner(change: OwnerChange): Promise<OwnerEmail> {
  const { WEB_PLATFORM_URL, INTERNAL_API_SECRET } = env;
  if (!WEB_PLATFORM_URL || !INTERNAL_API_SECRET) return "not_configured";

  try {
    const response = await fetch(`${WEB_PLATFORM_URL.replace(/\/$/, "")}/api/internal/owner-email`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INTERNAL_API_SECRET}` },
      body: JSON.stringify(change),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.warn(`[web-platform] owner-email ${change.kind} answered ${response.status}`);
      return "failed";
    }
    return "sent";
  } catch (error) {
    console.warn(`[web-platform] owner-email ${change.kind} did not complete:`, error instanceof Error ? error.message : error);
    return "failed";
  }
}

/** The end of an admin's notice after an owner email was attempted, e.g. " The owner was emailed." */
export function ownerEmailNotice(result: OwnerEmail | "no_email"): string {
  switch (result) {
    case "sent":
      return " The owner was emailed.";
    case "no_email":
      return " The owner has no email address, so they were not emailed.";
    case "not_configured":
      return " The owner could not be emailed (WEB_PLATFORM_URL is not set on this server).";
    case "failed":
      return " The email to the owner did not go through. Let them know yourself.";
  }
}
