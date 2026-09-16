"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { AuditEventType } from "generated/prisma";
import { db } from "~/server/db";

import { formValue, redirectWithNotice, requireAdmin } from "./shared";

/**
 * The corporate website's price calculator — one platform-wide plan, billable
 * three ways, plus a list of hardware add-ons. See schema.prisma's "Pricing"
 * section for why each cycle is nullable independently rather than one
 * always-required monthly figure.
 */

/** "29.99" -> 2999 cents. Blank means "not offered under this cycle", not free. */
const priceField = z
  .string()
  .trim()
  .optional()
  .or(z.literal("").transform(() => undefined))
  .refine(
    (value) => value === undefined || /^\d+(\.\d{1,2})?$/.test(value),
    "Enter a price like 29.99, or leave it blank if this isn't offered that way.",
  )
  .transform((value) => (value === undefined ? null : Math.round(Number(value) * 100)));

const planSchema = z.object({
  name: z.string().trim().min(1, "Give the plan a name.").max(80),
  description: z
    .string()
    .trim()
    .max(300)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  oneTime: priceField,
  monthly: priceField,
  yearly: priceField,
});

export async function savePlanAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();

  const parsed = planSchema.safeParse({
    name: formValue(formData, "name"),
    description: formValue(formData, "description"),
    oneTime: formValue(formData, "oneTime"),
    monthly: formValue(formData, "monthly"),
    yearly: formValue(formData, "yearly"),
  });

  if (!parsed.success) {
    redirectWithNotice("/pricing", parsed.error.issues[0]?.message ?? "Check the plan form and try again.");
  }

  if (!parsed.data.oneTime && !parsed.data.monthly && !parsed.data.yearly) {
    redirectWithNotice("/pricing", "Set at least one price — one-time, monthly, or yearly.");
  }

  // Effectively a singleton today (one product, billed three ways). Modelled
  // as a table rather than fixed columns so a second plan is a new row later,
  // not a schema change — but there's only ever one to edit from this form.
  const existing = await db.pricingPlan.findFirst({ orderBy: { sortOrder: "asc" } });

  const plan = existing
    ? await db.pricingPlan.update({
        where: { id: existing.id },
        data: {
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          oneTimeCents: parsed.data.oneTime,
          monthlyCents: parsed.data.monthly,
          yearlyCents: parsed.data.yearly,
        },
      })
    : await db.pricingPlan.create({
        data: {
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          oneTimeCents: parsed.data.oneTime,
          monthlyCents: parsed.data.monthly,
          yearlyCents: parsed.data.yearly,
        },
      });

  await db.auditEvent.create({
    data: {
      type: AuditEventType.pricing_plan_updated,
      actor,
      summary: `Plan "${plan.name}" pricing updated`,
      meta: {
        planId: plan.id,
        oneTimeCents: plan.oneTimeCents,
        monthlyCents: plan.monthlyCents,
        yearlyCents: plan.yearlyCents,
      },
    },
  });

  revalidatePath("/pricing");
  redirectWithNotice("/pricing", "Plan pricing saved.", "success");
}

const hardwareSchema = z
  .object({
    name: z.string().trim().min(1, "Give the item a name.").max(80),
    note: z
      .string()
      .trim()
      .max(160)
      .optional()
      .or(z.literal("").transform(() => undefined)),
    oneTime: priceField,
    monthly: priceField,
    yearly: priceField,
    minQuantity: z.coerce.number().int().min(0).max(50),
    maxQuantity: z.coerce.number().int().min(0).max(50),
  })
  .refine((data) => data.maxQuantity >= data.minQuantity, {
    message: "Max must be at least min.",
    path: ["maxQuantity"],
  })
  .refine(
    (data) => data.oneTime !== null || data.monthly !== null || data.yearly !== null,
    { message: "Set at least one price — one-time, monthly, or yearly.", path: ["monthly"] },
  );

export async function createHardwareItemAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();

  const parsed = hardwareSchema.safeParse({
    name: formValue(formData, "name"),
    note: formValue(formData, "note"),
    oneTime: formValue(formData, "oneTime"),
    monthly: formValue(formData, "monthly"),
    yearly: formValue(formData, "yearly"),
    minQuantity: formValue(formData, "minQuantity") || "0",
    maxQuantity: formValue(formData, "maxQuantity") || "1",
  });

  if (!parsed.success) {
    redirectWithNotice("/pricing", parsed.error.issues[0]?.message ?? "Check the hardware form and try again.");
  }

  const count = await db.hardwareItem.count();

  const item = await db.hardwareItem.create({
    data: {
      name: parsed.data.name,
      note: parsed.data.note ?? null,
      oneTimeCents: parsed.data.oneTime,
      monthlyCents: parsed.data.monthly,
      yearlyCents: parsed.data.yearly,
      minQuantity: parsed.data.minQuantity,
      maxQuantity: parsed.data.maxQuantity,
      sortOrder: count,
    },
  });

  await db.auditEvent.create({
    data: {
      type: AuditEventType.hardware_item_created,
      actor,
      summary: `Hardware item "${item.name}" added`,
      meta: { hardwareItemId: item.id },
    },
  });

  revalidatePath("/pricing");
  redirectWithNotice("/pricing", `"${item.name}" added.`, "success");
}

export async function updateHardwareItemAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const id = formValue(formData, "id");

  const existing = await db.hardwareItem.findUnique({ where: { id } });
  if (!existing) redirectWithNotice("/pricing", "That hardware item no longer exists.");

  const parsed = hardwareSchema.safeParse({
    name: formValue(formData, "name"),
    note: formValue(formData, "note"),
    oneTime: formValue(formData, "oneTime"),
    monthly: formValue(formData, "monthly"),
    yearly: formValue(formData, "yearly"),
    minQuantity: formValue(formData, "minQuantity") || "0",
    maxQuantity: formValue(formData, "maxQuantity") || "1",
  });

  if (!parsed.success) {
    redirectWithNotice(
      `/pricing/hardware/${id}/edit`,
      parsed.error.issues[0]?.message ?? "Check the hardware form and try again.",
    );
  }

  const item = await db.hardwareItem.update({
    where: { id },
    data: {
      name: parsed.data.name,
      note: parsed.data.note ?? null,
      oneTimeCents: parsed.data.oneTime,
      monthlyCents: parsed.data.monthly,
      yearlyCents: parsed.data.yearly,
      minQuantity: parsed.data.minQuantity,
      maxQuantity: parsed.data.maxQuantity,
    },
  });

  await db.auditEvent.create({
    data: {
      type: AuditEventType.hardware_item_updated,
      actor,
      summary: `Hardware item "${item.name}" updated`,
      meta: { hardwareItemId: item.id },
    },
  });

  revalidatePath("/pricing");
  redirectWithNotice("/pricing", `"${item.name}" saved.`, "success");
}

export async function toggleHardwareItemActiveAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const id = formValue(formData, "id");

  const existing = await db.hardwareItem.findUnique({ where: { id } });
  if (!existing) redirectWithNotice("/pricing", "That hardware item no longer exists.");

  const item = await db.hardwareItem.update({
    where: { id },
    data: { isActive: !existing.isActive },
  });

  await db.auditEvent.create({
    data: {
      type: AuditEventType.hardware_item_updated,
      actor,
      summary: `Hardware item "${item.name}" ${item.isActive ? "enabled" : "disabled"} on the calculator`,
      meta: { hardwareItemId: item.id, isActive: item.isActive },
    },
  });

  revalidatePath("/pricing");
  redirectWithNotice(
    "/pricing",
    `"${item.name}" is ${item.isActive ? "now shown" : "hidden"} on the calculator.`,
    "success",
  );
}

export async function deleteHardwareItemAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const id = formValue(formData, "id");

  const existing = await db.hardwareItem.findUnique({ where: { id } });
  if (!existing) redirectWithNotice("/pricing", "That hardware item no longer exists.");

  await db.hardwareItem.delete({ where: { id } });

  await db.auditEvent.create({
    data: {
      type: AuditEventType.hardware_item_deleted,
      actor,
      summary: `Hardware item "${existing.name}" deleted`,
      meta: { hardwareItemId: id },
    },
  });

  revalidatePath("/pricing");
  redirectWithNotice("/pricing", `"${existing.name}" deleted.`, "success");
}
