"use server";

import { revalidatePath } from "next/cache";

import { db } from "~/server/db";

import { formValue, redirectWithNotice, requireAdmin } from "./shared";

/**
 * Marks a quote request as contacted, or puts it back. The Quote requests page
 * (`/quotes`) is its only caller. Who did it and when are kept on the row, so
 * two admins can see which of them rang a shop.
 */
export async function setQuoteContactedAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();

  const id = formValue(formData, "id");
  const contacted = formValue(formData, "contacted") === "yes";
  const page = Math.max(1, Number(formValue(formData, "page")) || 1);
  const back = page > 1 ? `/quotes?page=${page}` : "/quotes";

  const updated = await db.quoteRequest.updateMany({
    where: { id },
    data: contacted ? { contactedAt: new Date(), contactedBy: actor } : { contactedAt: null, contactedBy: null },
  });
  if (updated.count === 0) redirectWithNotice(back, "That quote request no longer exists.");

  revalidatePath("/quotes");
  redirectWithNotice(back, contacted ? "Marked as contacted." : "Marked as not contacted.", "success");
}
