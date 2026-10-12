import { NextResponse } from "next/server";

import { db } from "~/server/db";

/**
 * Public, unauthenticated: where to get the till's installer, for the corporate
 * website's dashboard to link to (see the Epos365 repo's `~/server/app-download.ts`).
 * Nothing here is private: every till is told the same address on each check-in.
 *
 * The newest published release, chosen as `currentUpdateAnnouncement` chooses it
 * (by when it was published, not by comparing version strings), so the website
 * never offers a build that tills are not also being offered. Null when nothing
 * is published.
 *
 * Read fresh on every call, like GET /api/contact and for the same reason: a
 * prerendered route is run during the build, against whatever database the build
 * has. The website keeps its own one-minute cache of the answer.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const release = await db.appRelease.findFirst({
    where: { isPublished: true },
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
    select: { version: true, downloadUrl: true, publishedAt: true },
  });

  return NextResponse.json(
    release
      ? { version: release.version, url: release.downloadUrl, publishedAt: release.publishedAt?.toISOString() ?? null }
      : null,
  );
}
