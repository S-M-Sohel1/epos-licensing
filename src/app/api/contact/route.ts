import { NextResponse } from "next/server";

import { getContactDetails } from "~/server/contact-details";

/**
 * Public, unauthenticated: how to reach the business, for the corporate
 * website to print (see the Epos365 repo's `licensing-client.ts`). Same
 * pattern and the same short cache as GET /api/pricing: an edit on the
 * Contact details page shows on the site within a minute.
 *
 * `phone: null` means none has been set. The website decides what to show
 * then; this endpoint never invents one.
 */
export const revalidate = 60;

export async function GET() {
  const details = await getContactDetails();

  return NextResponse.json({ phone: details?.salesPhone ?? null });
}
