import { db } from "~/server/db";

/** The one ContactDetails row. See schema.prisma for why it is a row at all. */
export const CONTACT_DETAILS_ID = "platform";

/** Null until an admin has saved the Contact details page once. */
export async function getContactDetails() {
  return db.contactDetails.findUnique({ where: { id: CONTACT_DETAILS_ID } });
}
