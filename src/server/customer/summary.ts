import { DeviceStatus } from "generated/prisma";
import { db } from "~/server/db";

export interface CustomerLicenseSummary {
  status: "active" | "blocked";
  validUntil: Date;
  maxDevices: number;
  approvedDeviceCount: number;
}

/**
 * The one license `GET /api/customer/me` shows: the shop's most recently
 * issued one. Most shops will only ever have one; if a replacement is ever
 * issued, the newest is the one that matters to the owner checking their
 * account, not the history of it.
 */
export async function latestLicenseSummary(
  shopId: string,
): Promise<CustomerLicenseSummary | null> {
  const license = await db.license.findFirst({
    where: { shopId },
    orderBy: { createdAt: "desc" },
    include: { devices: { where: { status: DeviceStatus.approved } } },
  });

  if (!license) return null;

  return {
    status: license.status,
    validUntil: license.validUntil,
    maxDevices: license.maxDevices,
    approvedDeviceCount: license.devices.length,
  };
}

/**
 * When this account last asked us for something: a quote on the website, or a
 * licence from its dashboard. Both are a QuoteRequest. The dashboard of an
 * account with no licence shows it as "requested on ...", so an owner who has
 * already asked is told so instead of being offered the same form again.
 */
export async function lastRequestAt(shopIds: string[]): Promise<Date | null> {
  if (shopIds.length === 0) return null;

  const latest = await db.quoteRequest.findFirst({
    where: { shopId: { in: shopIds } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  return latest?.createdAt ?? null;
}
