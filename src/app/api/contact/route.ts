import { NextResponse } from "next/server";

import { getContactDetails } from "~/server/contact-details";

/**
 * Public, unauthenticated: how to reach the business and who it is, for the
 * corporate website to print (see the Epos365 repo's `~/server/company.ts`).
 * Nothing here is private: all of it is published on that website.
 *
 * Read fresh on every call, and not prerendered like GET /api/pricing: a
 * prerendered route is run during the build, against whatever database the
 * build has, and a preview build's database did not have this table. The
 * website keeps its own one-minute cache of the answer, so an edit on the
 * Contact details page still shows there within a minute.
 *
 * A null means that detail has not been set. The website decides what to
 * show then; this endpoint never invents one.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const details = await getContactDetails();

  return NextResponse.json({
    phone: details?.salesPhone ?? null,
    salesEmail: details?.salesEmail ?? null,
    privacyEmail: details?.privacyEmail ?? null,
    legalName: details?.legalName ?? null,
    companyNumber: details?.companyNumber ?? null,
    address: details?.address ?? null,
  });
}
