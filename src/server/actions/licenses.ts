"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { AuditEventType } from "generated/prisma";
import { db } from "~/server/db";
import { generateLicenseKey } from "~/server/licensing/license-key";

import { formValue, redirectWithNotice, requireAdmin } from "./shared";

const createSchema = z.object({
  shopId: z.string().min(1, "Choose a customer."),
  shopLabel: z.string().trim().max(120).optional(),
  maxDevices: z.coerce.number().int().min(1).max(50),
  validUntil: z.coerce.date(),
});

export async function createLicenseAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();

  const parsed = createSchema.safeParse({
    shopId: formData.get("shopId"),
    shopLabel: formData.get("shopLabel") ?? undefined,
    maxDevices: formData.get("maxDevices"),
    validUntil: formData.get("validUntil"),
  });

  // Back to the same form, with the shop still chosen when it came from the shop's page.
  const shopIdValue = formValue(formData, "shopId");
  const formPath = shopIdValue ? `/licenses/new?shopId=${encodeURIComponent(shopIdValue)}` : "/licenses/new";

  if (!parsed.success) {
    redirectWithNotice(
      formPath,
      parsed.error.issues[0]?.message ?? "Check the form and try again.",
    );
  }

  const shop = await db.shop.findUnique({ where: { id: parsed.data.shopId } });
  if (!shop)
    redirectWithNotice("/licenses/new", "That shop no longer exists.");

  const license = await db.license.create({
    data: {
      key: await allocateUniqueKey(),
      shopId: shop.id,
      // The label is what the cashier sees on their own License screen, so it
      // defaults to the customer's name rather than being left blank.
      // || and not ??: the form sends an untouched box as "", which is not "absent".
      shopLabel: parsed.data.shopLabel?.trim() || shop.name,
      maxDevices: parsed.data.maxDevices,
      validUntil: endOfDay(parsed.data.validUntil),
    },
  });

  await db.auditEvent.create({
    data: {
      type: AuditEventType.license_created,
      licenseId: license.id,
      actor,
      summary: `License ${license.key} issued to ${shop.name}, ${license.maxDevices} devices, valid until ${license.validUntil.toISOString().slice(0, 10)}`,
    },
  });

  revalidatePath("/licenses");
  redirect(`/licenses/${license.id}`);
}

const updateSchema = z.object({
  id: z.string().min(1),
  shopLabel: z.string().trim().max(120).optional(),
  maxDevices: z.coerce.number().int().min(1).max(50),
  validUntil: z.coerce.date(),
});

export async function updateLicenseAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();

  const parsed = updateSchema.safeParse({
    id: formData.get("id"),
    shopLabel: formData.get("shopLabel") ?? undefined,
    maxDevices: formData.get("maxDevices"),
    validUntil: formData.get("validUntil"),
  });

  if (!parsed.success) {
    redirectWithNotice(
      `/licenses/${formValue(formData, "id")}`,
      parsed.error.issues[0]?.message ?? "Check the form and try again.",
    );
  }

  const before = await db.license.findUnique({ where: { id: parsed.data.id } });
  if (!before)
    redirectWithNotice("/licenses", "That license no longer exists.");

  const approvedCount = await db.device.count({
    where: { licenseId: before.id, status: "approved" },
  });

  // Lowering the cap below what is already approved would leave the license in
  // a state the endpoints cannot produce and the device list cannot explain.
  // Deactivating a device is the deliberate way to get there.
  if (parsed.data.maxDevices < approvedCount) {
    redirectWithNotice(
      `/licenses/${before.id}`,
      `This license already has ${approvedCount} approved devices. Deactivate one before lowering the limit to ${parsed.data.maxDevices}.`,
    );
  }

  const shopName =
    (await db.shop.findUnique({ where: { id: before.shopId }, select: { name: true } }))?.name ?? null;

  const license = await db.license.update({
    where: { id: before.id },
    data: {
      // A cleared box goes back to the shop's name, never to a blank on the till's screen.
      shopLabel: parsed.data.shopLabel?.trim() || shopName,
      maxDevices: parsed.data.maxDevices,
      validUntil: endOfDay(parsed.data.validUntil),
    },
  });

  await db.auditEvent.create({
    data: {
      type: AuditEventType.license_updated,
      licenseId: license.id,
      actor,
      summary: describeLicenseChange(before, license),
      meta: {
        before: {
          maxDevices: before.maxDevices,
          validUntil: before.validUntil.toISOString(),
          shopLabel: before.shopLabel,
        },
        after: {
          maxDevices: license.maxDevices,
          validUntil: license.validUntil.toISOString(),
          shopLabel: license.shopLabel,
        },
      },
    },
  });

  revalidatePath(`/licenses/${license.id}`);
  redirectWithNotice(`/licenses/${license.id}`, "License updated.", "success");
}

export async function setLicenseStatusAction(
  formData: FormData,
): Promise<void> {
  const actor = await requireAdmin();

  const id = formValue(formData, "id");
  const block = formData.get("status") === "blocked";

  const license = await db.license.update({
    where: { id },
    data: { status: block ? "blocked" : "active" },
  });

  await db.auditEvent.create({
    data: {
      type: block
        ? AuditEventType.license_blocked
        : AuditEventType.license_unblocked,
      licenseId: license.id,
      actor,
      summary: block
        ? `License ${license.key} blocked. Every device on it is refused from its next check-in.`
        : `License ${license.key} unblocked.`,
    },
  });

  revalidatePath(`/licenses/${license.id}`);
  redirectWithNotice(
    `/licenses/${license.id}`,
    block ? "License blocked." : "License unblocked.",
    "success",
  );
}

/**
 * Issues a new key for an existing license, for the case where a key has leaked.
 *
 * Every till on the license stops checking in successfully the moment this
 * runs, because the key they hold no longer resolves. That is the point, but it
 * means the customer needs the new key before their grace window runs out, so
 * the audit line records both halves for the support conversation.
 */
export async function regenerateLicenseKeyAction(
  formData: FormData,
): Promise<void> {
  const actor = await requireAdmin();
  const id = formValue(formData, "id");

  const before = await db.license.findUnique({ where: { id } });
  if (!before)
    redirectWithNotice("/licenses", "That license no longer exists.");

  const license = await db.license.update({
    where: { id },
    data: { key: await allocateUniqueKey() },
  });

  await db.auditEvent.create({
    data: {
      type: AuditEventType.license_key_regenerated,
      licenseId: license.id,
      actor,
      summary: `License key regenerated. ${before.key} is dead; the customer must enter ${license.key} on every till.`,
    },
  });

  revalidatePath(`/licenses/${license.id}`);
  redirectWithNotice(
    `/licenses/${license.id}`,
    `New key issued. Every till must be given ${license.key} before its grace window expires.`,
    "success",
  );
}

/**
 * The key is the customer-visible identifier and collides with probability
 * ~2^-80, but a unique constraint that can fail an activation is worth one
 * extra read to avoid.
 */
async function allocateUniqueKey(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = generateLicenseKey();
    const existing = await db.license.findUnique({ where: { key } });
    if (!existing) return key;
  }

  throw new Error("Could not allocate an unused license key.");
}

/**
 * `validUntil` comes from a date input with no time, and a license bought
 * through the last of the month should work on the last of the month. Storing
 * the end of that day rather than its start is the difference between the
 * customer's expectation and a till that locks up at breakfast.
 */
function endOfDay(value: Date): Date {
  const end = new Date(value);
  end.setUTCHours(23, 59, 59, 0);
  return end;
}

function describeLicenseChange(
  before: { maxDevices: number; validUntil: Date },
  after: { maxDevices: number; validUntil: Date },
): string {
  const changes: string[] = [];

  if (before.maxDevices !== after.maxDevices) {
    changes.push(`device limit ${before.maxDevices} to ${after.maxDevices}`);
  }

  if (before.validUntil.getTime() !== after.validUntil.getTime()) {
    changes.push(
      `expiry ${before.validUntil.toISOString().slice(0, 10)} to ${after.validUntil.toISOString().slice(0, 10)}`,
    );
  }

  return changes.length > 0
    ? `License updated: ${changes.join(", ")}`
    : "License details updated";
}
