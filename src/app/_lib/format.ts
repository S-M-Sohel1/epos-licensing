import type { Device, License } from "generated/prisma";

/**
 * A calendar date, such as the last day of a licence. Read in UTC on purpose: a
 * licence's last day is stored as 23:59:59 UTC on that day, which in Irish summer
 * time is already the next morning, so reading it in Irish time would show every
 * licence ending a day late.
 */
export function formatDate(value: Date | null | undefined): string {
  if (!value) return "never";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(value);
}

/**
 * A moment, such as when a till checked in or crashed, on the clock in Ireland
 * (Irish summer time from late March to late October, otherwise the same as UTC),
 * where the shops and the people answering their calls are. Every stored
 * timestamp is UTC; this is the one place it is turned into a time to read.
 */
export function formatDateTime(value: Date | null | undefined): string {
  if (!value) return "never";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Dublin",
    hour12: false,
  }).format(value);
}

/** The value an <input type="date"> expects. */
export function toDateInputValue(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function daysUntil(value: Date, now = new Date()): number {
  return Math.ceil((value.getTime() - now.getTime()) / 86_400_000);
}

/**
 * The state a license is actually in, combining the stored status with expiry.
 * Expiry is derived here rather than stored so the two can never disagree.
 */
export type EffectiveLicenseState = "active" | "blocked" | "expired";

export function effectiveLicenseState(
  license: Pick<License, "status" | "validUntil">,
  now = new Date(),
): EffectiveLicenseState {
  if (license.status === "blocked") return "blocked";
  if (license.validUntil.getTime() < now.getTime()) return "expired";
  return "active";
}

export function describeExpiry(validUntil: Date, now = new Date()): string {
  const days = daysUntil(validUntil, now);
  if (days < 0) return `expired ${Math.abs(days)} days ago`;
  if (days === 0) return "expires today";
  if (days === 1) return "expires tomorrow";
  return `${days} days remaining`;
}

/** 2999 -> "€29.99". Null/undefined means "not offered this way", shown as an em dash. */
export function formatCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return `€${(cents / 100).toFixed(2)}`;
}

/** The value a price <input> should default to: 2999 -> "29.99", null -> "". */
export function centsToInputValue(cents: number | null | undefined): string {
  return cents == null ? "" : (cents / 100).toFixed(2);
}

/** Device ids are 32 hex characters. Tables only need enough to tell them apart. */
export function shortId(value: string, length = 12): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

export function deviceLocation(
  device: Pick<Device, "geoCity" | "geoRegion" | "geoCountry">,
): string {
  const parts = [device.geoCity, device.geoRegion, device.geoCountry].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(", ") : "unknown";
}
