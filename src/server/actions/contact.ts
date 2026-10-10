"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { AuditEventType } from "generated/prisma";
import { CONTACT_DETAILS_ID } from "~/server/contact-details";
import { db } from "~/server/db";

import { formValue, redirectWithNotice, requireAdmin } from "./shared";

/**
 * How a visitor to the corporate website reaches the business, and who the
 * business is where the website has to say so (its privacy policy and terms).
 * See schema.prisma's `ContactDetails` and GET /api/contact.
 *
 * Every field is optional. Blank is stored as null, "not given", and the
 * website shows its own default for it.
 */

/** Blank becomes null; anything else is kept trimmed. */
function optionalText(max: number, tooLong: string) {
  return z
    .string()
    .trim()
    .max(max, tooLong)
    .transform((value) => (value === "" ? null : value));
}

function optionalEmail(wrong: string) {
  return z
    .string()
    .trim()
    .max(254, wrong)
    .refine((value) => value === "" || z.string().email().safeParse(value).success, wrong)
    .transform((value) => (value === "" ? null : value.toLowerCase()));
}

const contactSchema = z.object({
  // Digits with the usual punctuation, as someone would write it on a shop
  // sign: "01 234 5678", "+353 (0)1 234 5678". The website prints it as typed
  // and strips everything but digits and "+" for the dial link.
  salesPhone: z
    .string()
    .trim()
    .max(30, "That phone number is too long.")
    .refine(
      (value) => value === "" || (/^\+?[\d\s()-]+$/.test(value) && value.replace(/\D/g, "").length >= 6),
      "Enter a phone number using digits, spaces, brackets or dashes, like 01 234 5678.",
    )
    .transform((value) => (value === "" ? null : value)),
  salesEmail: optionalEmail("The sales email is not an email address."),
  privacyEmail: optionalEmail("The privacy email is not an email address."),
  legalName: optionalText(160, "That business name is too long."),
  companyNumber: optionalText(40, "That company number is too long."),
  // One line on the website, so line breaks typed here become ", ".
  address: z
    .string()
    .trim()
    .max(300, "That address is too long.")
    .transform((value) => {
      const oneLine = value
        .split(/\r?\n/)
        .map((part) => part.trim().replace(/,$/, ""))
        .filter(Boolean)
        .join(", ");
      return oneLine === "" ? null : oneLine;
    }),
});

/** What each field is called in the audit log's one-line summary. */
const FIELD_NAMES = {
  salesPhone: "phone number",
  salesEmail: "sales email",
  privacyEmail: "privacy email",
  legalName: "business name",
  companyNumber: "company number",
  address: "address",
} as const;

type FieldKey = keyof typeof FIELD_NAMES;

export async function saveContactDetailsAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();

  const parsed = contactSchema.safeParse({
    salesPhone: formValue(formData, "salesPhone"),
    salesEmail: formValue(formData, "salesEmail"),
    privacyEmail: formValue(formData, "privacyEmail"),
    legalName: formValue(formData, "legalName"),
    companyNumber: formValue(formData, "companyNumber"),
    address: formValue(formData, "address"),
  });

  if (!parsed.success) {
    redirectWithNotice("/contact", parsed.error.issues[0]?.message ?? "Check the form and try again.");
  }

  const next = parsed.data;
  const before = await db.contactDetails.findUnique({ where: { id: CONTACT_DETAILS_ID } });

  const changed: FieldKey[] = [];
  for (const key of Object.keys(FIELD_NAMES) as FieldKey[]) {
    const previous = before ? before[key] : null;
    if (previous !== next[key]) changed.push(key);
  }

  if (changed.length === 0) {
    redirectWithNotice("/contact", "Nothing was changed.", "success");
  }

  await db.contactDetails.upsert({
    where: { id: CONTACT_DETAILS_ID },
    create: { id: CONTACT_DETAILS_ID, ...next, updatedBy: actor },
    update: { ...next, updatedBy: actor },
  });

  await db.auditEvent.create({
    data: {
      type: AuditEventType.contact_details_updated,
      actor,
      summary: `Contact details changed: ${changed.map((key) => FIELD_NAMES[key]).join(", ")}`,
      meta: Object.fromEntries(changed.map((key) => [key, next[key]])),
    },
  });

  revalidatePath("/contact");
  redirectWithNotice("/contact", "Saved. The website shows the change within a minute or two.", "success");
}
