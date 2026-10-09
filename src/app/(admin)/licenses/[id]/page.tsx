import Link from "next/link";
import { notFound } from "next/navigation";

import { Notice, readNotice } from "~/app/_components/notice";
import {
  describeExpiry,
  deviceLocation,
  effectiveLicenseState,
  formatDate,
  formatDateTime,
  shortId,
  toDateInputValue,
} from "~/app/_lib/format";
import {
  approveDeviceAction,
  deactivateDeviceAction,
  reactivateDeviceAction,
  rejectDeviceAction,
} from "~/server/actions/devices";
import {
  regenerateLicenseKeyAction,
  setLicenseStatusAction,
  updateLicenseAction,
} from "~/server/actions/licenses";
import { db } from "~/server/db";
import { websiteAddress } from "~/server/shop-connection";

export const dynamic = "force-dynamic";

/**
 * Everything known about one license: its terms, the tills on it, and what has
 * happened to it.
 *
 * The device table is the centre of the page because that is what a support
 * call is about. The terms sit above it as a short record, and the editable
 * form sits below it, so changing a limit is a deliberate scroll rather than
 * something to fat-finger while reading.
 */
export default async function LicenseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const { notice, tone } = readNotice(await searchParams);

  const license = await db.license.findUnique({
    where: { id },
    include: {
      shop: true,
      devices: { orderBy: [{ status: "asc" }, { firstSeenAt: "asc" }] },
      auditEvents: { orderBy: { createdAt: "desc" }, take: 50 },
    },
  });

  if (!license) notFound();

  const now = new Date();
  const state = effectiveLicenseState(license, now);
  const approved = license.devices.filter((d) => d.status === "approved");
  const returnTo = `/licenses/${license.id}`;

  return (
    <>
      <section className="vbg-section">
        <p className="vbg-meta">
          <Link href="/licenses">Licenses</Link>
        </p>
        <h1 className="vbg-title">{license.shop.name}</h1>

        <dl className="vbg-custom-facts vbg-span-12">
          <div className="vbg-custom-fact">
            <dt>Shop</dt>
            <dd>
              {license.shop.customerId ? (
                <Link href={`/shops/${license.shop.customerId}/shop/${license.shop.id}`}>{license.shop.name}</Link>
              ) : (
                license.shop.name
              )}
              <br />
              <span className="vbg-meta">
                {websiteAddress(license.shop) ?? "no website yet"}
              </span>
            </dd>
          </div>
          <div className="vbg-custom-fact">
            <dt>License key</dt>
            <dd className="vbg-mono">{license.key}</dd>
          </div>
          <div className="vbg-custom-fact">
            <dt>Status</dt>
            <dd>
              <span className="vbg-custom-status" data-state={state}>
                {state}
              </span>
            </dd>
          </div>
          <div className="vbg-custom-fact">
            <dt>Devices</dt>
            <dd className="vbg-numeric">
              {approved.length} of {license.maxDevices}
            </dd>
          </div>
          <div className="vbg-custom-fact">
            <dt>Valid until</dt>
            <dd>
              {formatDate(license.validUntil)}
              <br />
              <span className="vbg-meta">
                {describeExpiry(license.validUntil, now)}
              </span>
            </dd>
          </div>
          <div className="vbg-custom-fact">
            <dt>Issued</dt>
            <dd>{formatDate(license.issuedAt)}</dd>
          </div>
          <div className="vbg-custom-fact">
            <dt>Label on the till</dt>
            <dd>{license.shopLabel || license.shop.name}</dd>
          </div>
        </dl>

        <Notice notice={notice} tone={tone} />
      </section>

      <section className="vbg-section">
        <h2 className="vbg-heading-24">Devices</h2>
        <p className="vbg-reading vbg-span-7">
          {license.devices.length === 0
            ? "No till has activated against this key yet. The first one to do so is approved automatically and sets the location later tills are measured against."
            : "Deactivating frees a slot for a hardware swap and refuses that device from its next check-in. Generating a license file needs the device id the customer reads off their own License screen."}
        </p>

        {license.devices.length > 0 && (
          <div className="vbg-table-wrap vbg-span-12">
            <table>
              <caption className="vbg-visually-hidden">
                Devices seen on this license
              </caption>
              <thead>
                <tr>
                  <th scope="col">Till</th>
                  <th scope="col">Device</th>
                  <th scope="col">Status</th>
                  <th scope="col">Location</th>
                  <th scope="col">Last check-in</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {license.devices.map((device) => (
                  <tr key={device.id}>
                    {/* The document-number block this till counts inside. Shown
                        first because it is the column support actually needs: a
                        shop asking "which till issued invoice 1000042?" is
                        asking about this number, and nothing else here answers
                        it. Unallocated until a device is approved. */}
                    <td>
                      {device.terminalNumber === null ? (
                        <span className="vbg-meta">not assigned</span>
                      ) : (
                        <strong>Till {device.terminalNumber}</strong>
                      )}
                    </td>
                    <td>
                      <span className="vbg-mono">
                        {shortId(device.deviceId, 16)}
                      </span>
                      {device.isBaseline && (
                        <>
                          <br />
                          <span className="vbg-meta">location baseline</span>
                        </>
                      )}
                      {/* Two machines sharing one device id, which is what a
                          copied database leaves behind. Reported, never acted
                          on: forcing a re-activation on a false positive would
                          cost the shop a slot it paid for. */}
                      {device.fingerprintAlternations > 1 && (
                        <>
                          <br />
                          <strong>
                            ⚠ hardware alternating ×{device.fingerprintAlternations} — likely two
                            machines sharing this device id
                          </strong>
                        </>
                      )}
                    </td>
                    <td>
                      <span
                        className="vbg-custom-status"
                        data-state={device.status}
                      >
                        {device.status}
                      </span>
                    </td>
                    <td>
                      {deviceLocation(device)}
                      <br />
                      <span className="vbg-mono vbg-meta">
                        {device.lastKnownIp ?? "no IP recorded"}
                      </span>
                    </td>
                    <td>{formatDateTime(device.lastCheckIn)}</td>
                    <td>
                      <div className="vbg-custom-actions">
                        {device.status === "pending" && (
                          <>
                            <form action={approveDeviceAction}>
                              <input
                                type="hidden"
                                name="deviceRowId"
                                value={device.id}
                              />
                              <input
                                type="hidden"
                                name="returnTo"
                                value={returnTo}
                              />
                              <button type="submit" className="vbg-button">
                                Approve
                              </button>
                            </form>
                            <form action={rejectDeviceAction}>
                              <input
                                type="hidden"
                                name="deviceRowId"
                                value={device.id}
                              />
                              <input
                                type="hidden"
                                name="returnTo"
                                value={returnTo}
                              />
                              <button
                                type="submit"
                                className="vbg-custom-link-action"
                                data-tone="destructive"
                              >
                                Reject
                              </button>
                            </form>
                          </>
                        )}

                        {device.status === "approved" && (
                          <>
                            <a
                              className="vbg-custom-link-action"
                              href={`/licenses/${license.id}/devices/${device.id}/license-file`}
                            >
                              License file
                            </a>
                            <form action={deactivateDeviceAction}>
                              <input
                                type="hidden"
                                name="deviceRowId"
                                value={device.id}
                              />
                              <input
                                type="hidden"
                                name="returnTo"
                                value={returnTo}
                              />
                              <button
                                type="submit"
                                className="vbg-custom-link-action"
                                data-tone="destructive"
                              >
                                Deactivate
                              </button>
                            </form>
                          </>
                        )}

                        {device.status === "deactivated" && (
                          <form action={reactivateDeviceAction}>
                            <input
                              type="hidden"
                              name="deviceRowId"
                              value={device.id}
                            />
                            <input
                              type="hidden"
                              name="returnTo"
                              value={returnTo}
                            />
                            <button type="submit" className="vbg-button">
                              Reactivate
                            </button>
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="vbg-section">
        <h2 className="vbg-heading-24">License file</h2>
        <p className="vbg-reading vbg-span-7">
          For a shop that cannot reach this server. The customer reads their
          device ID off Settings &rsaquo; License and you send back the file,
          which they load from the same screen. A till that activates online
          never needs this; use the link on its row above instead.
        </p>
        <p className="vbg-reading vbg-span-7">
          The file is signed when you press the button and downloaded straight
          away. No copy is kept here, so regenerating one costs nothing. A
          device ID not already on this license is enrolled and takes a slot,
          because the file grants the same access an activation would.
        </p>

        <form
          method="post"
          action={`/licenses/${license.id}/license-file`}
          className="vbg-span-7"
        >
          <div className="vbg-field">
            <label className="vbg-label" htmlFor="deviceId">
              Device ID
            </label>
            <input
              id="deviceId"
              name="deviceId"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="32 characters, for example a1b2c3d4e5f6..."
              required
            />
            <p className="vbg-helper">
              Hyphens and capitals are fine; they are stripped before matching.
            </p>
          </div>

          <div
            className="vbg-custom-actions"
            style={{ marginTop: "var(--vbg-space-5)" }}
          >
            <button type="submit" className="vbg-button">
              Generate and download
            </button>
          </div>
        </form>
      </section>

      <section className="vbg-section">
        <h2 className="vbg-heading-24">Terms</h2>

        <form action={updateLicenseAction} className="vbg-span-7">
          <input type="hidden" name="id" value={license.id} />

          <div className="vbg-custom-form-row">
            <div className="vbg-field">
              <label className="vbg-label" htmlFor="maxDevices">
                Device limit
              </label>
              <input
                id="maxDevices"
                name="maxDevices"
                type="number"
                min={1}
                max={50}
                defaultValue={license.maxDevices}
                required
              />
              <p className="vbg-helper">
                Cannot go below the {approved.length} already approved.
              </p>
            </div>

            <div className="vbg-field">
              <label className="vbg-label" htmlFor="validUntil">
                Valid until
              </label>
              <input
                id="validUntil"
                name="validUntil"
                type="date"
                defaultValue={toDateInputValue(license.validUntil)}
                required
              />
            </div>

            <div className="vbg-field">
              <label className="vbg-label" htmlFor="shopLabel">
                Label on the till
              </label>
              <input
                id="shopLabel"
                name="shopLabel"
                type="text"
                maxLength={120}
                defaultValue={license.shopLabel ?? ""}
              />
            </div>
          </div>

          <div
            className="vbg-custom-actions"
            style={{ marginTop: "var(--vbg-space-6)" }}
          >
            <button type="submit" className="vbg-button">
              Save terms
            </button>
          </div>
        </form>
      </section>

      <section className="vbg-section">
        <h2 className="vbg-heading-24">
          {license.status === "blocked"
            ? "This license is blocked"
            : "Revoking access"}
        </h2>
        <p className="vbg-reading vbg-span-7">
          {license.status === "blocked"
            ? "Every till on this key is refused at its next check-in. Unblocking restores them without the customer re-entering anything."
            : "Blocking refuses every till on this key from its next check-in. Regenerating the key does the same and additionally requires the customer to type a new key into every till, so it is for a leaked key rather than for a non-paying customer."}
        </p>

        <div className="vbg-custom-actions">
          <form action={setLicenseStatusAction}>
            <input type="hidden" name="id" value={license.id} />
            <input
              type="hidden"
              name="status"
              value={license.status === "blocked" ? "active" : "blocked"}
            />
            <button type="submit" className="vbg-button">
              {license.status === "blocked"
                ? "Unblock license"
                : "Block license"}
            </button>
          </form>

          <form action={regenerateLicenseKeyAction}>
            <input type="hidden" name="id" value={license.id} />
            <button
              type="submit"
              className="vbg-custom-link-action"
              data-tone="destructive"
            >
              Regenerate key
            </button>
          </form>
        </div>
      </section>

      <section className="vbg-section">
        <h2 className="vbg-heading-24">History</h2>

        {license.auditEvents.length === 0 ? (
          <p className="vbg-reading">
            Nothing has happened on this license yet.
          </p>
        ) : (
          <ul className="vbg-custom-feed vbg-span-12">
            {license.auditEvents.map((event) => (
              <li key={event.id} className="vbg-custom-feed-item">
                <span className="vbg-mono vbg-meta">
                  {formatDateTime(event.createdAt)}
                </span>
                <span>
                  {event.summary}
                  <br />
                  <span className="vbg-custom-feed-detail">
                    {event.actor}
                    {event.geo ? ` · ${event.geo}` : ""}
                    {event.ip ? ` · ${event.ip}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
