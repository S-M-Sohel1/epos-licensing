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
