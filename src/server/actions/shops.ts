"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { AuditEventType, TemplateId } from "generated/prisma";
import { db } from "~/server/db";
import { TEMPLATE_LABELS } from "~/server/shop-connection";
import { refreshShopOnWebsite, type WebRefresh } from "~/server/web-platform";

import { formValue, redirectWithNotice, requireAdmin } from "./shared";

/**
 * A Shop's own fields, kept to what makes a license list readable and
 * supportable. No billing, no tickets, no notes beyond a free-text line, per
 * the design doc's "not a full CRM" scope. Every Shop belongs to a Customer
 * now (see Epos365/SUBDOMAIN_ARCHITECTURE.md) — these actions only ever
 * touch a Shop nested under one, never a standalone one.
 */
const shopSchema = z.object({
  name: z.string().trim().min(1, "A shop name is required."),
  email: z
    .string()
    .trim()
    .email("That email address is not valid.")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  phone: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(500).optional(),
});

export async function createShopAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const customerId = formValue(formData, "customerId");
  const newPath = `/shops/${customerId}/shop/new`;
  const parsed = shopSchema.safeParse(readShopForm(formData));

  if (!parsed.success) {
    redirectWithNotice(newPath, parsed.error.issues[0]?.message ?? "Check the form and try again.");
  }

  const shop = await db.shop.create({
    data: {
      name: parsed.data.name,
      email: parsed.data.email ?? null,
      phone: parsed.data.phone ?? null,
      notes: parsed.data.notes ?? null,
      customerId,
    },
  });

  await db.auditEvent.create({
    data: {
      type: AuditEventType.shop_created,
      actor,
      summary: `Shop ${shop.name} added`,
    },
  });

  revalidatePath("/shops");
  redirectWithNotice(`/shops/${customerId}`, `${shop.name} added.`, "success");
}

export async function updateShopAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const id = formValue(formData, "id");
  const customerId = formValue(formData, "customerId");
  const editPath = `/shops/${customerId}/shop/${id}`;
  const parsed = shopSchema.safeParse(readShopForm(formData));

  if (!parsed.success) {
    redirectWithNotice(editPath, parsed.error.issues[0]?.message ?? "Check the form and try again.");
  }

  const shop = await db.shop.update({
    where: { id },
    data: {
      name: parsed.data.name,
      email: parsed.data.email ?? null,
      phone: parsed.data.phone ?? null,
      notes: parsed.data.notes ?? null,
    },
  });

  await db.auditEvent.create({
    data: {
      type: AuditEventType.shop_updated,
      actor,
      summary: `Shop ${shop.name} updated`,
    },
  });

  revalidatePath("/shops");
  redirectWithNotice(editPath, `${shop.name} updated.`, "success");
}

/**
 * Changes which storefront a shop's website shows: the restaurant one (menu, ordering, the
 * shop's own admin) or the simple page. The owner picks one when the website is first switched
 * on and cannot change it afterwards, so a shop that ended up on the simple page is put right
 * here.
 *
 * Nothing is deleted either way: the menu, orders, staff and photos stay in the database and
 * come back with the restaurant template.
 */
export async function setShopTemplateAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const id = formValue(formData, "id");
  const customerId = formValue(formData, "customerId");
  const shopPath = `/shops/${customerId}/shop/${id}`;

  const parsed = z.nativeEnum(TemplateId).safeParse(formData.get("templateId"));
  if (!parsed.success) redirectWithNotice(shopPath, "Choose a template.");

  const before = await db.shop.findUnique({ where: { id } });
  if (before?.customerId !== customerId) redirectWithNotice("/shops", "That shop no longer exists.");
  if (before.templateId === parsed.data) {
    redirectWithNotice(shopPath, `${before.name} already uses ${TEMPLATE_LABELS[parsed.data].name}.`, "success");
  }

  const shop = await db.shop.update({ where: { id }, data: { templateId: parsed.data } });

  await db.auditEvent.create({
    data: {
      type: AuditEventType.shop_updated,
      actor,
      summary: `Website template of ${shop.name} changed from ${TEMPLATE_LABELS[before.templateId].name} to ${TEMPLATE_LABELS[shop.templateId].name}`,
    },
  });

  const refresh: WebRefresh | null = shop.subdomain ? await refreshShopOnWebsite(shop.subdomain) : null;

  revalidatePath(shopPath);
  redirectWithNotice(
    shopPath,
    `${shop.name} now uses ${TEMPLATE_LABELS[shop.templateId].name}. ${websiteNotice(refresh)}`.trim(),
    refresh === null || refresh === "refreshed" ? "success" : "error",
  );
}

/** What the admin is told about the shop's website after a change to the Shop row. */
function websiteNotice(refresh: WebRefresh | null): string {
  switch (refresh) {
    case null:
      return "";
    case "refreshed":
      return "The website shows it now.";
    case "not_configured":
      return "The website could not be told (WEB_PLATFORM_URL is not set on this server), so it may show the old version for up to 30 days.";
    case "failed":
      return "The website could not be reached, so it may show the old version for up to 30 days. Try again in a minute.";
  }
}

function readShopForm(formData: FormData) {
  return {
    name: formData.get("name"),
    email: formData.get("email") ?? undefined,
    phone: formData.get("phone") ?? undefined,
    notes: formData.get("notes") ?? undefined,
  };
}
