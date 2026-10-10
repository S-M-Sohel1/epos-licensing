"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { AuditEventType } from "generated/prisma";
import { CONTACT_DETAILS_ID } from "~/server/contact-details";
import { db } from "~/server/db";

import { formValue, redirectWithNotice, requireAdmin } from "./shared";

/**
 * How a visitor to the corporate website reaches the business. See
 * schema.prisma's `ContactDetails` and GET /api/contact.
 */

const contactSchema = z.object({
  // Digits with the usual punctuation, as someone would write it on a shop
  // sign: "01 234 5678", "+353 (0)1 234 5678". The website prints it as typed
  // and strips everything but digits and "+" for the dial link. Blank clears it.
  salesPhone: z
    .string()
    .trim()
    .max(30, "That phone number is too long.")
    .refine(
      (value) => value === "" || (/^\+?[\d\s()-]+$/.test(value) && value.replace(/\D/g, "").length >= 6),
      "Enter a phone number using digits, spaces, brackets or dashes, like 01 234 5678.",
    ),
});

export async function saveContactDetailsAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();

  const parsed = contactSchema.safeParse({ salesPhone: formValue(formData, "salesPhone") });

  if (!parsed.success) {
    redirectWithNotice("/contact", parsed.error.issues[0]?.message ?? "Check the form and try again.");
  }

  const salesPhone = parsed.data.salesPhone === "" ? null : parsed.data.salesPhone;

  await db.contactDetails.upsert({
    where: { id: CONTACT_DETAILS_ID },
    create: { id: CONTACT_DETAILS_ID, salesPhone, updatedBy: actor },
    update: { salesPhone, updatedBy: actor },
  });

  await db.auditEvent.create({
    data: {
      type: AuditEventType.contact_details_updated,
      actor,
      summary: salesPhone ? `Website phone number set to ${salesPhone}` : "Website phone number removed",
      meta: { salesPhone },
    },
  });

  revalidatePath("/contact");
  redirectWithNotice(
    "/contact",
    salesPhone
      ? "Phone number saved. The website shows it within a minute."
      : "Phone number removed. The website goes back to its stand-in number within a minute.",
    "success",
  );
}
