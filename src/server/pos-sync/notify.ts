import { after } from "next/server";

import { env } from "~/env";

/**
 * Tells the web platform (epos_corporate_web) that a shop's staged catalogue has
 * moved, so that shop's menu updates within seconds of a till publishing.
 *
 * One address for every shop: the platform's own, not the shop's storefront
 * subdomain. The shop is named in the body.
 *
 * A hint, not a hand-off. The staged rows and the version number are already
 * committed, and the web platform sweeps for shops that are behind every
 * minute, so a call that is lost, slow or refused costs up to a minute and
 * nothing else. That is why this never throws and is never awaited by the
 * request: a till must not be told its push failed because the web platform
 * was restarting.
 *
 * `after()` rather than a bare un-awaited fetch: on Vercel a function can be
 * frozen the moment its response is sent, and work that was merely "started"
 * then never finishes.
 */
export function notifyWebPlatform(shopId: string): void {
  const { WEB_PLATFORM_URL, INTERNAL_API_SECRET } = env;
  if (!WEB_PLATFORM_URL || !INTERNAL_API_SECRET) return;

  after(async () => {
    try {
      const response = await fetch(`${WEB_PLATFORM_URL.replace(/\/$/, "")}/api/internal/pos-catalog/apply`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${INTERNAL_API_SECRET}` },
        body: JSON.stringify({ shopId }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) console.warn(`[pos-sync] web platform apply for ${shopId} answered ${response.status}`);
    } catch (error) {
      console.warn(`[pos-sync] web platform apply for ${shopId} did not complete:`, error instanceof Error ? error.message : error);
    }
  });
}
