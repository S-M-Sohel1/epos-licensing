import {
  AuditEventType,
  DeviceStatus,
  type Device,
  type License,
} from "generated/prisma";

import { db } from "~/server/db";

import { formatGeo, geoMatchesCluster, type RequestGeo } from "./geo";
import { normalizeLicenseKey } from "./license-key";
import {
  signBlob,
  signTerminalNumber,
  type ApprovalState,
  type SignedLicenseBlob,
} from "./signing";

/**
 * The body of every machine-facing response, matching
 * `Pos.Core.Domain.LicenseServerResponse` field-for-field.
 *
 * PascalCase is not a style choice. The client deserializes with
 * `System.Text.Json`'s defaults, where `PropertyNameCaseInsensitive` is false,
 * so `licenseKey` or `approval_state` would silently bind to nothing and the
 * client would read every response as an empty approval state.
 */
export interface LicenseServerResponseBody {
  License: SignedLicenseBlob | null;
  ApprovalState: string;
  Error: string | null;
  /** Only present on a device-limit rejection, per the design doc's 403 shape. */
  MaxDevices?: number;
  ApprovedCount?: number;
  /**
   * Which document-number block this till owns, and a signature over
   * (deviceId, number) proving this server said so. Present only on an approved
   * response, because only an approved device holds a block.
   */
  TerminalNumber?: number;
  TerminalNumberSignature?: string;
}

export interface LicenseServerResult {
  status: number;
  body: LicenseServerResponseBody;
}

export interface ClientRequest {
  licenseKey: string;
  deviceId: string;
  hardwareFingerprint: string;
  businessName?: string | null;
  geo: RequestGeo;
}

/**
 * An `ApprovalState` the client's `ApplyServerResponseAsync` does not recognise
 * falls through its switch without touching cached state, which is the right
 * outcome here and the reason this does not reuse "blocked": a mistyped key must
 * not leave a till permanently displaying "Blocked".
 *
 * There was a "device_limit" state alongside this one until over-limit devices
 * started being held for review instead of refused. They now answer "pending",
 * which the client DOES recognise — so the till stops taking payment and says it
 * is waiting, rather than sitting on an unrecognised state that changed nothing.
 */
const STATE_UNKNOWN_KEY = "invalid_key";

/**
 * How long an approved device may go without checking in before its slot can be
 * reclaimed to let another till activate.
 *
 * 90 days is not arbitrary. The client's own offline grace is 14 days
 * (`LicenseService.GraceWindow`), so anything near that would reclaim tills that
 * are still legitimately running offline. More importantly the client's
 * check-in is driven by a timer that only advances while the app is running, so
 * `lastCheckIn` lags real usage by however long a shop leaves the till closed.
 * The number has to sit far outside both, and reclaiming a slot a month too
 * late costs nothing, while reclaiming one a day too early takes a working till
 * off the air mid-service.
 */
const RECLAIM_AFTER_DAYS = 90;

/*
 * There was a 24-hour cooldown between two self-releases of the same device
 * here, aimed at the release → re-activate → release loop that would let a shop
 * time-share more tills than it bought.
 *
 * Removed deliberately. It punished the honest case far harder than the abusive
 * one: a shop replacing a till, re-imaging one, or recovering from a failed
 * activation hits it immediately and is then locked out of its own licence for a
 * day, with no way for anyone to clear it. The loop it guarded against is better
 * handled by `lastSelfReleaseAt`, which is still written on every release and is
 * visible in the panel — a device releasing itself over and over is a support
 * conversation, not a reason to take a working till off the air.
 *
 * `RetryAfterUtc` stays in the response shape, always null, because tills in the
 * field still read it. Do not reintroduce a hard block without giving the vendor
 * a way to clear it from the panel.
 */

// ---------------------------------------------------------------------------
// POST /activate
// ---------------------------------------------------------------------------

export async function activateDevice(
  request: ClientRequest,
): Promise<LicenseServerResult> {
  const license = await findLicense(request.licenseKey);

  if (!license) {
    await recordUnknownKeyAttempt(request);
    return {
      status: 404,
      body: {
        License: null,
        ApprovalState: STATE_UNKNOWN_KEY,
        Error: "unknown license key",
      },
    };
  }

  if (license.status === "blocked") {
    await audit({
      type: AuditEventType.activation_denied_blocked,
      licenseId: license.id,
      summary: `Activation refused for device ${short(request.deviceId)}: license is blocked`,
      request,
    });
    return blockedResult("license blocked");
  }

  const existing = await db.device.findUnique({
    where: {
      licenseId_deviceId: { licenseId: license.id, deviceId: request.deviceId },
    },
  });

  // A device already on file re-runs activation (the customer pressed Activate
  // again, or reinstalled onto the same machine). Its existing verdict stands;
  // re-activating is not a way to get a second opinion on a rejection.
  if (existing?.status === DeviceStatus.approved) {
    const device = await touchDevice(existing.id, request, { checkIn: true });
    await audit({
      type: AuditEventType.activation_approved,
      licenseId: license.id,
      deviceId: device.id,
      summary: `Device ${short(request.deviceId)} re-activated (already approved)`,
      request,
    });
    return await approvedResult(license, device);
  }

  if (existing?.status === DeviceStatus.pending) {
    await touchDevice(existing.id, request, { checkIn: true });
    return pendingResult();
  }

  if (existing?.status === DeviceStatus.rejected) {
    await touchDevice(existing.id, request, { checkIn: true });
    return blockedResult("device rejected");
  }

  // A deactivated row means the slot was freed — by an admin, by the till
  // itself through /release, or by the stale reclaim below. Coming back through
  // /activate is the hardware-swap-back case and is allowed to re-apply from
  // scratch: it still has to clear the device cap and the geo check below.
  const baseline = await resolveLicenseBaseline(license);
  let approved = await findApprovedCluster(license.id);

  // First device ever seen for this key: no approved devices AND no baseline on
  // record, i.e. this license has never approved anything. Auto-approved, and
  // its location becomes the baseline every later device is measured against.
  //
  // The baseline half of that condition is what makes an empty approved set
  // safe. Without it, a license whose devices were all reclaimed or deactivated
  // would treat the next caller — anywhere in the world — as its first device.
  if (approved.length === 0 && baseline === null) {
    const device = await upsertDevice(license.id, request, {
      status: DeviceStatus.approved,
      isBaseline: true,
    });
    await captureLicenseBaseline(license.id, request);
    await audit({
      type: AuditEventType.activation_approved,
      licenseId: license.id,
      deviceId: device.id,
      summary: `Device ${short(request.deviceId)} auto-approved as the first device on this license and is now the geo baseline`,
      request,
    });
    return await approvedResult(license, device);
  }

  // The cap is checked before the geo rule, and deliberately so: the license
  // was sold as N devices full stop, which makes this a deterministic outcome
  // rather than a judgment call.
  if (approved.length >= license.maxDevices) {
    // Before refusing, give back any slot held by a till that stopped checking
    // in months ago. Doing it here rather than on a schedule means it runs at
    // the only moment it matters — someone is standing at a new till waiting —
    // and never quietly demotes a shop that is merely offline and nobody is
    // competing with. See RECLAIM_AFTER_DAYS.
    const reclaimed = await reclaimStaleDevices(license.id);
    if (reclaimed > 0) approved = await findApprovedCluster(license.id);
  }

  // Over the limit: HELD FOR REVIEW, not refused. The till gets no licence blob
  // and cannot take payment until somebody approves it, so the cap still binds —
  // but a shop that has genuinely replaced a machine, or bought a third till, now
  // reaches a human instead of a dead end. Refusing outright left them with a
  // screen that said no and no way to ask.
  //
  // This is not a way around the limit. A pending row does not count towards
  // maxDevices, and approveDevice refuses while the licence is full and tells the
  // admin to free a slot first — so the only route through is deactivating a till
  // that is genuinely gone, which is exactly the decision a person should make.
  if (approved.length >= license.maxDevices) {
    const device = await upsertDevice(license.id, request, {
      status: DeviceStatus.pending,
      isBaseline: false,
    });
    await audit({
      type: AuditEventType.activation_denied_device_limit,
      licenseId: license.id,
      deviceId: device.id,
      summary: `Device ${short(request.deviceId)} held for review: license already has ${approved.length} of ${license.maxDevices} devices approved`,
      request,
      meta: { maxDevices: license.maxDevices, approvedCount: approved.length },
    });
    // The counts ride along on the 202 so the till can say WHY it is waiting.
    // "Pending" on its own reads as a location query, which is the other reason
    // a device lands in that queue and a different conversation with support.
    return {
      status: 202,
      body: {
        License: null,
        ApprovalState: "pending",
        Error: null,
        MaxDevices: license.maxDevices,
        ApprovedCount: approved.length,
      },
    };
  }

  // The license baseline joins the cluster rather than replacing it: a shop that
  // has legitimately moved has its newer approved devices to cluster against,
  // and the baseline only decides the case where nothing else is left.
  const decision = geoMatchesCluster(
    request.geo,
    baseline ? [...approved, baseline] : approved,
  );

  if (decision.matches) {
    const device = await upsertDevice(license.id, request, {
      status: DeviceStatus.approved,
      isBaseline: false,
    });
    await audit({
      type: AuditEventType.activation_approved,
      licenseId: license.id,
      deviceId: device.id,
      summary: `Device ${short(request.deviceId)} auto-approved: ${decision.reason}`,
      request,
      meta: { reason: decision.reason },
    });
    return await approvedResult(license, device);
  }

  const device = await upsertDevice(license.id, request, {
    status: DeviceStatus.pending,
    isBaseline: false,
  });
  await audit({
    type: AuditEventType.activation_pending,
    licenseId: license.id,
    deviceId: device.id,
    summary: `Device ${short(request.deviceId)} held for review: ${decision.reason}`,
    request,
    meta: { reason: decision.reason },
  });
  return pendingResult();
}

// ---------------------------------------------------------------------------
// POST /checkin
// ---------------------------------------------------------------------------

export async function checkInDevice(
  request: ClientRequest,
): Promise<LicenseServerResult> {
  const license = await findLicense(request.licenseKey);

  if (!license || license.status === "blocked") {
    if (license) {
      await audit({
        type: AuditEventType.checkin_denied,
        licenseId: license.id,
        summary: `Check-in refused for device ${short(request.deviceId)}: license is blocked`,
        request,
      });
    }
    return blockedResult("license blocked");
  }

  const existing = await db.device.findUnique({
    where: {
      licenseId_deviceId: { licenseId: license.id, deviceId: request.deviceId },
    },
  });

  if (!existing) {
    await audit({
      type: AuditEventType.checkin_denied,
      licenseId: license.id,
      summary: `Check-in refused: device ${short(request.deviceId)} is not registered on this license`,
      request,
    });
    return blockedResult("device not recognised");
  }

  if (
    existing.status === DeviceStatus.rejected ||
    existing.status === DeviceStatus.deactivated
  ) {
    await audit({
      type: AuditEventType.checkin_denied,
      licenseId: license.id,
      deviceId: existing.id,
      summary: `Check-in refused: device ${short(request.deviceId)} is ${existing.status}`,
      request,
    });
    return blockedResult(
      existing.status === DeviceStatus.rejected
        ? "device rejected"
        : "device deactivated",
    );
  }

  const device = await touchDevice(existing.id, request, { checkIn: true });

  await audit({
    type: AuditEventType.checkin,
    licenseId: license.id,
    deviceId: device.id,
    summary: `Device ${short(request.deviceId)} checked in (${device.status})`,
    request,
  });

  if (device.status === DeviceStatus.pending) return pendingResult();

  return await approvedResult(license, device);
}

// ---------------------------------------------------------------------------
// DELETE /device
// ---------------------------------------------------------------------------

export interface DeactivateResult {
  ok: boolean;
  error?: string;
}

/**
 * Frees a slot under `maxDevices`. The row is kept rather than deleted so the
 * audit trail survives, and so the device's next check-in can be answered with
 * a definite 410 instead of the vaguer "not registered".
 */
export async function deactivateDevice(input: {
  licenseKey: string;
  deviceId: string;
  actor: string;
}): Promise<DeactivateResult> {
  const license = await findLicense(input.licenseKey);
  if (!license) return { ok: false, error: "unknown license key" };

  const device = await db.device.findUnique({
    where: {
      licenseId_deviceId: { licenseId: license.id, deviceId: input.deviceId },
    },
  });
  if (!device) return { ok: false, error: "unknown device" };

  await deactivateDeviceRow(device.id, input.actor);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// POST /release — the till freeing its own slot
// ---------------------------------------------------------------------------

export interface ReleaseResult {
  status: number;
  body: { Ok: boolean; Error: string | null; RetryAfterUtc: string | null };
}

/**
 * Lets a till give up its own slot, so a shop replacing hardware doesn't have to
 * wait on support for what is a routine change.
 *
 * Unlike `DELETE /device` this needs no admin session, and it does not need one:
 * the caller can only name its own `deviceId`, which it proves it holds by
 * having it. There is no reachable request that releases somebody else's device,
 * so the authority question the admin endpoint answers with a login simply
 * doesn't arise here.
 *
 * The hardware fingerprint is recorded but not enforced, consistent with the
 * rest of this service treating it as an audit trail rather than the membership
 * signal — a shop that has just replaced a motherboard is exactly who this is
 * for, and they would fail a fingerprint check.
 *
 * Idempotent: releasing an already-released device succeeds without touching
 * anything, so a client retry after a dropped response is not an error.
 */
export async function releaseOwnDevice(
  request: ClientRequest,
): Promise<ReleaseResult> {
  const license = await findLicense(request.licenseKey);
  if (!license) return releaseError(404, "unknown license key");

  const device = await db.device.findUnique({
    where: {
      licenseId_deviceId: { licenseId: license.id, deviceId: request.deviceId },
    },
  });
  if (!device) {
    return releaseError(404, "device not registered on this license");
  }

  if (device.status === DeviceStatus.deactivated) {
    return { status: 200, body: { Ok: true, Error: null, RetryAfterUtc: null } };
  }

  if (device.status !== DeviceStatus.approved) {
    return releaseError(
      409,
      `a ${device.status} device holds no slot to release`,
    );
  }

  await db.device.update({
    where: { id: device.id },
    data: {
      status: DeviceStatus.deactivated,
      isBaseline: false,
      lastSelfReleaseAt: new Date(),
      lastKnownIp: request.geo.ip,
      geoCountry: request.geo.country,
      geoRegion: request.geo.region,
      geoCity: request.geo.city,
    },
  });

  await audit({
    type: AuditEventType.device_deactivated,
    licenseId: license.id,
    deviceId: device.id,
    summary: `Device ${short(device.deviceId)} released its own slot from the till`,
    request,
  });

  return { status: 200, body: { Ok: true, Error: null, RetryAfterUtc: null } };
}

function releaseError(status: number, error: string): ReleaseResult {
  return { status, body: { Ok: false, Error: error, RetryAfterUtc: null } };
}

/** The admin panel's own entry point, which already holds the row id. */
export async function deactivateDeviceRow(
  deviceRowId: string,
  actor: string,
): Promise<void> {
  const device = await db.device.update({
    where: { id: deviceRowId },
    data: { status: DeviceStatus.deactivated, isBaseline: false },
  });

  await audit({
    type: AuditEventType.device_deactivated,
    licenseId: device.licenseId,
    deviceId: device.id,
    actor,
    summary: `Device ${short(device.deviceId)} deactivated, freeing a slot`,
  });
}

/**
 * Undoes a deactivation, taking the slot back.
 *
 * Deactivation is the one reversible verdict here: it means "this till is not in
 * use", not "this till is not trusted", so the way back is an admin saying so
 * rather than the shop re-running activation. Rejection is deliberately not
 * reversible this way — a rejected device failed the location check, and putting
 * it back needs the same evidence the queue shows, so it goes through /activate
 * and lands in the queue again.
 *
 * Re-checks the cap, because the slot this device gave up may have been taken by
 * another till in the meantime, and re-takes the baseline if the license has
 * been left with no approved device to cluster against.
 *
 * Logged as `device_approved` rather than a type of its own: the audit feed
 * reads summaries and this is an approval by another name, so a new enum value
 * would need a schema push to buy nothing.
 */
export async function reactivateDevice(
  deviceRowId: string,
  actor: string,
): Promise<{ ok: boolean; error?: string }> {
  const device = await db.device.findUnique({
    where: { id: deviceRowId },
    include: { license: true },
  });
  if (!device) return { ok: false, error: "unknown device" };

  if (device.status !== DeviceStatus.deactivated) {
    return {
      ok: false,
      error: `Only a deactivated device can be reactivated; this one is ${device.status}.`,
    };
  }

  const approvedCount = await db.device.count({
    where: { licenseId: device.licenseId, status: DeviceStatus.approved },
  });

  if (approvedCount >= device.license.maxDevices) {
    return {
      ok: false,
      error: `This license already has ${approvedCount} of ${device.license.maxDevices} devices approved. Deactivate one first.`,
    };
  }

  await db.device.update({
    where: { id: device.id },
    data: {
      status: DeviceStatus.approved,
      approvedAt: new Date(),
      isBaseline: approvedCount === 0,
    },
  });

  await audit({
    type: AuditEventType.device_approved,
    licenseId: device.licenseId,
    deviceId: device.id,
    actor,
    summary: `Device ${short(device.deviceId)} reactivated, taking a slot back`,
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Admin decisions on the pending queue
// ---------------------------------------------------------------------------

export async function approveDevice(
  deviceRowId: string,
  actor: string,
): Promise<{ ok: boolean; error?: string }> {
  const device = await db.device.findUnique({
    where: { id: deviceRowId },
    include: { license: true },
  });
  if (!device) return { ok: false, error: "unknown device" };

  const approvedCount = await db.device.count({
    where: {
      licenseId: device.licenseId,
      status: DeviceStatus.approved,
      id: { not: device.id },
    },
  });

  // The cap binds a human approving from the queue exactly as it binds the
  // endpoint. Without this an admin could click past the limit the customer
  // actually bought, and the count shown on the license list would stop
  // matching what the license permits.
  if (approvedCount >= device.license.maxDevices) {
    return {
      ok: false,
      error: `This license already has ${approvedCount} of ${device.license.maxDevices} devices approved. Deactivate one first.`,
    };
  }

  await db.device.update({
    where: { id: device.id },
    data: {
      status: DeviceStatus.approved,
      approvedAt: new Date(),
      isBaseline: approvedCount === 0,
    },
  });

  await audit({
    type: AuditEventType.device_approved,
    licenseId: device.licenseId,
    deviceId: device.id,
    actor,
    summary: `Device ${short(device.deviceId)} approved`,
  });

  return { ok: true };
}

export async function rejectDevice(
  deviceRowId: string,
  actor: string,
): Promise<{ ok: boolean; error?: string }> {
  const device = await db.device.findUnique({ where: { id: deviceRowId } });
  if (!device) return { ok: false, error: "unknown device" };

  await db.device.update({
    where: { id: device.id },
    data: { status: DeviceStatus.rejected, isBaseline: false },
  });

  await audit({
    type: AuditEventType.device_rejected,
    licenseId: device.licenseId,
    deviceId: device.id,
    actor,
    summary: `Device ${short(device.deviceId)} rejected`,
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Blob construction
// ---------------------------------------------------------------------------

/**
 * Builds and signs the blob for one device. Shared by the endpoints and by the
 * admin panel's `.lic` generation so a file handed to a customer and a live
 * activation cannot disagree about what the license says.
 */
export function buildSignedBlob(
  license: Pick<License, "key" | "shopLabel" | "validUntil" | "issuedAt">,
  device: Pick<Device, "deviceId">,
  approvalState: ApprovalState = "approved",
): SignedLicenseBlob {
  return signBlob({
    LicenseKey: license.key,
    DeviceId: device.deviceId,
    ShopLabel: license.shopLabel,
    ValidUntil: license.validUntil,
    IssuedAt: license.issuedAt,
    ApprovalState: approvalState,
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function findLicense(rawKey: string) {
  const key = normalizeLicenseKey(rawKey);
  if (!key) return Promise.resolve(null);
  return db.license.findUnique({ where: { key } });
}

/** One entry in the set a candidate device's location is compared against. */
type ClusterEntry = Pick<Device, "geoCountry" | "geoRegion" | "lastKnownIp">;

function findApprovedCluster(licenseId: string): Promise<ClusterEntry[]> {
  return db.device.findMany({
    where: { licenseId, status: DeviceStatus.approved },
    select: { geoCountry: true, geoRegion: true, lastKnownIp: true },
  });
}

/**
 * The license's own locality baseline, backfilling it from the device rows the
 * first time a license issued before this column existed is touched.
 *
 * Returns null only for a license that has genuinely never approved anything —
 * which is the one case `activateDevice` is allowed to treat as "first device
 * ever" and auto-approve.
 */
async function resolveLicenseBaseline(
  license: License,
): Promise<ClusterEntry | null> {
  if (license.baselineCountry ?? license.baselineIp) {
    return {
      geoCountry: license.baselineCountry,
      geoRegion: license.baselineRegion,
      lastKnownIp: license.baselineIp,
    };
  }

  // Prefer the row flagged as the baseline; fall back to the oldest device that
  // was ever approved, including one since deactivated — a license that has
  // approved a device before must never be mistaken for a fresh one.
  const source =
    (await db.device.findFirst({
      where: { licenseId: license.id, isBaseline: true },
      select: { geoCountry: true, geoRegion: true, lastKnownIp: true },
    })) ??
    (await db.device.findFirst({
      where: { licenseId: license.id, approvedAt: { not: null } },
      orderBy: { approvedAt: "asc" },
      select: { geoCountry: true, geoRegion: true, lastKnownIp: true },
    }));

  if (!source) return null;

  await db.license.update({
    where: { id: license.id },
    data: {
      baselineCountry: source.geoCountry,
      baselineRegion: source.geoRegion,
      baselineIp: source.lastKnownIp,
    },
  });

  return source;
}

/** Snapshots the first-ever approved device's location onto the license. */
async function captureLicenseBaseline(
  licenseId: string,
  request: ClientRequest,
): Promise<void> {
  await db.license.update({
    where: { id: licenseId },
    data: {
      baselineCountry: request.geo.country,
      baselineRegion: request.geo.region,
      baselineIp: request.geo.ip,
    },
  });
}

/**
 * Frees the slots of approved devices that have not checked in for
 * {@link RECLAIM_AFTER_DAYS}, so a routine hardware swap doesn't need a support
 * ticket. Returns how many were reclaimed.
 *
 * A device that has never checked in at all is measured from `firstSeenAt`
 * instead, which covers a row created by an admin-side flow that never saw the
 * hardware again.
 *
 * Reclaiming every approved device is deliberately allowed. That would once
 * have reset the license's locality check; it no longer can, because the
 * baseline lives on the License row. Anything that changes here has to keep
 * that invariant — see the `baselineCountry` comment in schema.prisma.
 */
async function reclaimStaleDevices(licenseId: string): Promise<number> {
  const cutoff = new Date(Date.now() - RECLAIM_AFTER_DAYS * 86_400_000);

  const stale = await db.device.findMany({
    where: {
      licenseId,
      status: DeviceStatus.approved,
      OR: [
        { lastCheckIn: { lt: cutoff } },
        { lastCheckIn: null, firstSeenAt: { lt: cutoff } },
      ],
    },
    select: { id: true, deviceId: true, lastCheckIn: true },
  });

  for (const device of stale) {
    await db.device.update({
      where: { id: device.id },
      data: { status: DeviceStatus.deactivated, isBaseline: false },
    });

    await audit({
      type: AuditEventType.device_deactivated,
      licenseId,
      deviceId: device.id,
      actor: "system",
      summary:
        `Device ${short(device.deviceId)} auto-reclaimed after ${RECLAIM_AFTER_DAYS} days without a check-in, ` +
        `freeing a slot (last seen ${device.lastCheckIn?.toISOString() ?? "never"})`,
      meta: {
        reclaimAfterDays: RECLAIM_AFTER_DAYS,
        lastCheckIn: device.lastCheckIn?.toISOString() ?? null,
      },
    });
  }

  return stale.length;
}

// Async because it allocates. Putting the allocation here rather than at each of
// the four call sites is deliberate: every path that tells a till "you are
// approved" is a path that must also tell it which number it is, and a new one
// added later gets that for free.
async function approvedResult(
  license: License,
  approvedDevice: Device,
): Promise<LicenseServerResult> {
  const device = await allocateTerminalNumber(approvedDevice);
  return {
    status: 200,
    body: {
      License: buildSignedBlob(license, device, "approved"),
      ApprovalState: "approved",
      Error: null,
      // Emitted on every approved response, not just the one that allocated it.
      // A till that reinstalls, or loses the setting, or simply checks in daily
      // is told its own number again each time, so the client never has to
      // treat this as a once-only message it must not miss.
      ...(device.terminalNumber === null
        ? {}
        : {
            TerminalNumber: device.terminalNumber,
            TerminalNumberSignature: signTerminalNumber(
              device.deviceId,
              device.terminalNumber,
            ),
          }),
    },
  };
}

/**
 * Gives a device its document-number block, if it does not already have one.
 *
 * `max + 1` over every row this license has ever had, approved or not — never
 * the lowest free number. Reuse is the trap: the till's counter only jumps
 * FORWARD to a new floor (see `CounterRepository.IncrementAndGetAsync`), so a
 * till handed a lower block than it had keeps issuing numbers in its old range,
 * which now belongs to whichever till inherited it. Two tills then print the
 * same invoice numbers and nothing anywhere says so.
 *
 * Idempotent by the `terminalNumber === null` guard: a device that already has a
 * number keeps it through every later re-activation, deactivation and return.
 *
 * The unique constraint on (licenseId, terminalNumber) is what makes this safe
 * against two tills activating at the same instant — both read the same max, one
 * insert loses, and the retry sees the winner's row.
 */
async function allocateTerminalNumber(device: Device): Promise<Device> {
  if (device.terminalNumber !== null) return device;

  for (let attempt = 0; attempt < 5; attempt++) {
    const highest = await db.device.aggregate({
      where: { licenseId: device.licenseId },
      _max: { terminalNumber: true },
    });
    const next = (highest._max.terminalNumber ?? 0) + 1;

    try {
      return await db.device.update({
        where: { id: device.id },
        data: { terminalNumber: next },
      });
    } catch {
      // Lost the race for `next`. Re-read and try again rather than failing the
      // activation: a till without a number falls back to its manual setting,
      // which is the state this exists to get it out of.
    }
  }

  return device;
}

function pendingResult(): LicenseServerResult {
  return {
    status: 202,
    body: { License: null, ApprovalState: "pending", Error: null },
  };
}

function blockedResult(error: string): LicenseServerResult {
  return {
    status: 410,
    body: { License: null, ApprovalState: "blocked", Error: error },
  };
}

async function upsertDevice(
  licenseId: string,
  request: ClientRequest,
  options: { status: DeviceStatus; isBaseline: boolean },
): Promise<Device> {
  const now = new Date();
  const geoFields = {
    lastKnownIp: request.geo.ip,
    geoCountry: request.geo.country,
    geoRegion: request.geo.region,
    geoCity: request.geo.city,
  };

  return db.device.upsert({
    where: { licenseId_deviceId: { licenseId, deviceId: request.deviceId } },
    create: {
      licenseId,
      deviceId: request.deviceId,
      hardwareFingerprint: request.hardwareFingerprint,
      status: options.status,
      isBaseline: options.isBaseline,
      lastCheckIn: now,
      approvedAt: options.status === DeviceStatus.approved ? now : null,
      ...geoFields,
    },
    update: {
      hardwareFingerprint: request.hardwareFingerprint,
      status: options.status,
      isBaseline: options.isBaseline,
      lastCheckIn: now,
      approvedAt: options.status === DeviceStatus.approved ? now : null,
      ...geoFields,
    },
  });
}

/** Refreshes the locality and liveness columns without changing the verdict. */
async function touchDevice(
  deviceRowId: string,
  request: ClientRequest,
  options: { checkIn: boolean },
): Promise<Device> {
  const before = await db.device.findUniqueOrThrow({
    where: { id: deviceRowId },
  });

  const fingerprintChanged =
    !!before.hardwareFingerprint &&
    before.hardwareFingerprint !== request.hardwareFingerprint;

  // Flipping BACK to a fingerprint this device already reported is the tell. One
  // machine replaced or reimaged moves forward and stays there; two machines
  // sharing a device id take turns, so this counter is the only thing that
  // separates the two cases.
  const flippedBack =
    fingerprintChanged &&
    !!before.previousFingerprint &&
    before.previousFingerprint === request.hardwareFingerprint;

  const device = await db.device.update({
    where: { id: deviceRowId },
    data: {
      hardwareFingerprint: request.hardwareFingerprint,
      lastKnownIp: request.geo.ip,
      geoCountry: request.geo.country,
      geoRegion: request.geo.region,
      geoCity: request.geo.city,
      ...(fingerprintChanged
        ? { previousFingerprint: before.hardwareFingerprint }
        : {}),
      ...(flippedBack
        ? { fingerprintAlternations: { increment: 1 } }
        : {}),
      ...(options.checkIn ? { lastCheckIn: new Date() } : {}),
    },
  });

  // Same device id, different hardware, is the signature of a copied database
  // rather than of a hardware upgrade. It does not change the verdict, because
  // the fingerprint is an audit trail and not the shop-membership signal, but
  // it is worth a line in the log for the support conversation that follows.
  if (fingerprintChanged) {
    await audit({
      type: AuditEventType.checkin,
      licenseId: device.licenseId,
      deviceId: device.id,
      summary: flippedBack
        ? `Device ${short(device.deviceId)} is alternating between two sets of hardware (${device.fingerprintAlternations}x) - it looks like two machines sharing one device id`
        : `Device ${short(device.deviceId)} reported different hardware than previously recorded`,
      request,
      meta: {
        previousFingerprint: before.hardwareFingerprint,
        currentFingerprint: request.hardwareFingerprint,
        alternations: device.fingerprintAlternations,
      },
    });
  }

  return device;
}

/**
 * An activation against a key that does not exist has nowhere to hang an audit
 * row, but repeated attempts are worth seeing, so it is recorded unattached.
 */
async function recordUnknownKeyAttempt(request: ClientRequest) {
  await audit({
    type: AuditEventType.activation_denied_blocked,
    summary: `Activation attempted with unknown key ${request.licenseKey}`,
    request,
  });
}

async function audit(input: {
  type: AuditEventType;
  licenseId?: string;
  deviceId?: string;
  summary: string;
  actor?: string;
  request?: ClientRequest;
  meta?: Record<string, unknown>;
}) {
  await db.auditEvent.create({
    data: {
      type: input.type,
      licenseId: input.licenseId ?? null,
      deviceId: input.deviceId ?? null,
      summary: input.summary,
      actor: input.actor ?? "client",
      ip: input.request?.geo.ip ?? null,
      geo: input.request ? formatGeo(input.request.geo) : null,
      meta: input.meta ? (input.meta as object) : undefined,
    },
  });
}

/** Device ids are 32 hex characters; log lines only need enough to tell them apart. */
function short(deviceId: string): string {
  return deviceId.length > 12 ? `${deviceId.slice(0, 12)}…` : deviceId;
}
