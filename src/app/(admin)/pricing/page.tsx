import Link from "next/link";

import { Notice, readNotice } from "~/app/_components/notice";
import { centsToInputValue, formatCents } from "~/app/_lib/format";
import {
  createHardwareItemAction,
  savePlanAction,
  toggleHardwareItemActiveAction,
} from "~/server/actions/pricing";
import { db } from "~/server/db";

export const dynamic = "force-dynamic";

/**
 * Everything the corporate website's price calculator reads: the plan (one
 * product, billed three ways) and the hardware add-ons on top of it. See
 * GET /api/pricing, the endpoint the Epos365 repo actually fetches this
 * through — never the DB directly, since it's a separate deployment.
 */
export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { notice, tone } = readNotice(await searchParams);

  const [plan, hardware] = await Promise.all([
    db.pricingPlan.findFirst({ orderBy: { sortOrder: "asc" } }),
    db.hardwareItem.findMany({ orderBy: { sortOrder: "asc" } }),
  ]);

  return (
    <>
      <section className="vbg-section">
        <h1 className="vbg-title">Pricing</h1>
        <p className="vbg-lede vbg-span-7">
          What the corporate website&rsquo;s calculator shows a visitor — the plan
          and the hardware they can add to it. Leave a cycle blank if it
          isn&rsquo;t offered that way; the calculator hides it rather than
          showing a free price.
        </p>
        <Notice notice={notice} tone={tone} />
      </section>

      <section className="vbg-section">
        <h2 className="vbg-heading-24">Plan</h2>

        <form action={savePlanAction} className="vbg-span-7">
          <div className="vbg-field">
            <label className="vbg-label" htmlFor="name">
              Plan name
            </label>
            <input
              id="name"
              name="name"
              type="text"
              defaultValue={plan?.name ?? "EPos 365"}
              required
            />
          </div>

          <div className="vbg-field" style={{ marginTop: "var(--vbg-space-4)" }}>
            <label className="vbg-label" htmlFor="description">
              Description (optional)
            </label>
            <input
              id="description"
              name="description"
              type="text"
              defaultValue={plan?.description ?? ""}
              placeholder="Till software and support"
            />
          </div>

          <div className="vbg-custom-form-row" style={{ marginTop: "var(--vbg-space-4)" }}>
            <div className="vbg-field">
              <label className="vbg-label" htmlFor="oneTime">
                One-time (€)
              </label>
              <input
                id="oneTime"
                name="oneTime"
                type="text"
                inputMode="decimal"
                placeholder="e.g. 299.00"
                defaultValue={centsToInputValue(plan?.oneTimeCents)}
              />
            </div>
            <div className="vbg-field">
              <label className="vbg-label" htmlFor="monthly">
                Monthly (€)
              </label>
              <input
                id="monthly"
                name="monthly"
                type="text"
                inputMode="decimal"
                placeholder="e.g. 29.99"
                defaultValue={centsToInputValue(plan?.monthlyCents)}
              />
            </div>
            <div className="vbg-field">
              <label className="vbg-label" htmlFor="yearly">
                Yearly (€)
              </label>
              <input
                id="yearly"
                name="yearly"
                type="text"
                inputMode="decimal"
                placeholder="e.g. 299.00"
                defaultValue={centsToInputValue(plan?.yearlyCents)}
              />
            </div>
          </div>

          <div className="vbg-custom-actions" style={{ marginTop: "var(--vbg-space-6)" }}>
            <button type="submit" className="vbg-button">
              Save plan
            </button>
          </div>
        </form>
      </section>

      <section className="vbg-section">
        <h2 className="vbg-heading-24">Add hardware</h2>

        <form action={createHardwareItemAction} className="vbg-span-7">
          <div className="vbg-custom-form-row">
            <div className="vbg-field">
              <label className="vbg-label" htmlFor="hw-name">
                Name
              </label>
              <input id="hw-name" name="name" type="text" placeholder="Extra till" required />
            </div>
            <div className="vbg-field">
              <label className="vbg-label" htmlFor="hw-note">
                Note (optional)
              </label>
              <input id="hw-note" name="note" type="text" placeholder='15" touch screen' />
            </div>
          </div>

          <div className="vbg-custom-form-row" style={{ marginTop: "var(--vbg-space-4)" }}>
            <div className="vbg-field">
              <label className="vbg-label" htmlFor="hw-oneTime">
                One-time (€)
              </label>
              <input id="hw-oneTime" name="oneTime" type="text" inputMode="decimal" placeholder="e.g. 249.00" />
            </div>
            <div className="vbg-field">
              <label className="vbg-label" htmlFor="hw-monthly">
                Monthly (€)
              </label>
              <input id="hw-monthly" name="monthly" type="text" inputMode="decimal" placeholder="e.g. 19.99" />
            </div>
            <div className="vbg-field">
              <label className="vbg-label" htmlFor="hw-yearly">
                Yearly (€)
              </label>
              <input id="hw-yearly" name="yearly" type="text" inputMode="decimal" placeholder="e.g. 199.00" />
            </div>
          </div>

          <div className="vbg-custom-form-row" style={{ marginTop: "var(--vbg-space-4)" }}>
            <div className="vbg-field">
              <label className="vbg-label" htmlFor="hw-min">
                Min quantity
              </label>
              <input id="hw-min" name="minQuantity" type="number" min={0} max={50} defaultValue={0} />
              <p className="vbg-helper">Above 0 makes it always-on and not removable, e.g. a till bundled into the plan.</p>
            </div>
            <div className="vbg-field">
              <label className="vbg-label" htmlFor="hw-max">
                Max quantity
              </label>
              <input id="hw-max" name="maxQuantity" type="number" min={0} max={50} defaultValue={1} />
            </div>
          </div>

          <div className="vbg-custom-actions" style={{ marginTop: "var(--vbg-space-6)" }}>
            <button type="submit" className="vbg-button">
              Add item
            </button>
          </div>
        </form>
      </section>

      {hardware.length > 0 && (
        <section className="vbg-section">
          <h2 className="vbg-heading-24">Hardware</h2>

          <div className="vbg-table-wrap vbg-span-12">
            <table>
              <caption className="vbg-visually-hidden">Hardware add-ons offered on the calculator</caption>
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">One-time</th>
                  <th scope="col">Monthly</th>
                  <th scope="col">Yearly</th>
                  <th scope="col">Qty</th>
                  <th scope="col">Shown</th>
                  <th scope="col">
                    <span className="vbg-visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {hardware.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.name}</strong>
                      {item.note ? <div>{item.note}</div> : null}
                    </td>
                    <td>{formatCents(item.oneTimeCents)}</td>
                    <td>{formatCents(item.monthlyCents)}</td>
                    <td>{formatCents(item.yearlyCents)}</td>
                    <td>
                      {item.minQuantity}–{item.maxQuantity}
                    </td>
                    <td>{item.isActive ? "Yes" : "No"}</td>
                    <td>
                      <div className="vbg-custom-actions">
                        <Link href={`/pricing/hardware/${item.id}/edit`} className="vbg-button">
                          Edit
                        </Link>
                        <form action={toggleHardwareItemActiveAction}>
                          <input type="hidden" name="id" value={item.id} />
                          <button type="submit" className="vbg-button">
                            {item.isActive ? "Hide" : "Show"}
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
