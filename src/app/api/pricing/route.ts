import { NextResponse } from "next/server";

import { db } from "~/server/db";

/**
 * Public, unauthenticated — the corporate website's price calculator fetches
 * this server-to-server (see Epos365 repo's `licensing-client.ts`), the same
 * pattern as every other `/api/customer/*` call it makes. No visitor-specific
 * data here, so a short time-based cache is fine: an admin edit in `/pricing`
 * shows up on the site within a minute rather than instantly.
 */
export const revalidate = 60;

export async function GET() {
  const [plan, hardware] = await Promise.all([
    db.pricingPlan.findFirst({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    }),
    db.hardwareItem.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    }),
  ]);

  return NextResponse.json({
    plan: plan
      ? {
          name: plan.name,
          description: plan.description,
          oneTimeCents: plan.oneTimeCents,
          monthlyCents: plan.monthlyCents,
          yearlyCents: plan.yearlyCents,
        }
      : null,
    hardware: hardware.map((item) => ({
      id: item.id,
      name: item.name,
      note: item.note,
      oneTimeCents: item.oneTimeCents,
      monthlyCents: item.monthlyCents,
      yearlyCents: item.yearlyCents,
      minQuantity: item.minQuantity,
      maxQuantity: item.maxQuantity,
    })),
  });
}
