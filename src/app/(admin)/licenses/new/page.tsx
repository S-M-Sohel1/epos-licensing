import Link from "next/link";

import { Notice, readNotice } from "~/app/_components/notice";
import { toDateInputValue } from "~/app/_lib/format";
import { createLicenseAction } from "~/server/actions/licenses";
import { db } from "~/server/db";
import { describeShop } from "~/server/shop-connection";

export const dynamic = "force-dynamic";

/**
 * Issuing a license: the most frequent day-to-day action in the panel.
 *
 * The key is generated on submit rather than chosen, so the form is only the
 * three things that vary per customer. Nothing here asks for a device: a
 * license exists before any till has been seen, and the first till to activate
 * claims the baseline slot on its own.
 *
 * Usually reached from a shop's own page ("Give this shop a license"), which passes `shopId` so
 * there is no shop to pick. Picked from the list, each shop is named with its website and owner:
 * a licence on the wrong shop sends that shop's menu to the wrong website.
 */
export default async function NewLicensePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const { notice, tone } = readNotice(query);
  const chosenId = typeof query.shopId === "string" ? query.shopId : null;
  const shops = await db.shop.findMany({
    orderBy: { name: "asc" },
    include: { customer: true },
  });

  const chosen = chosenId ? (shops.find((shop) => shop.id === chosenId) ?? null) : null;

  const defaultExpiry = new Date();
  defaultExpiry.setUTCFullYear(defaultExpiry.getUTCFullYear() + 1);

  return (
    <section className="vbg-section">
      <h1 className="vbg-title">Issue a license</h1>

      {shops.length === 0 ? (
        <>
          <p className="vbg-lede vbg-span-7">
            A license belongs to a shop, and there are no shops on file yet.
          </p>
          <p className="vbg-reading">
            <Link href="/shops">Add a customer first</Link> — creating one adds
            a shop too — then come back here.
          </p>
        </>
      ) : (
        <>
          <p className="vbg-lede vbg-span-7">
            The key is generated on save. The customer types it into Settings
            &rsaquo; License on their first till, which claims the first device
            slot and sets the location every later till is measured against.
          </p>

          <form action={createLicenseAction} className="vbg-span-7">
            <div className="vbg-custom-form-row">
              {chosen ? (
                <div className="vbg-field">
                  <span className="vbg-label">Shop</span>
                  <input type="hidden" name="shopId" value={chosen.id} />
                  <p className="vbg-reading" style={{ margin: 0 }}>
                    <strong>{chosen.name}</strong>
                    <br />
                    {describeShop(chosen).split(" · ").slice(1).join(" · ")}
                  </p>
                  <p className="vbg-helper">
                    This shop&rsquo;s tills will send its menu to this website.{" "}
                    <Link href="/licenses/new">Choose a different shop</Link>
                  </p>
                </div>
              ) : (
                <div className="vbg-field">
                  <label className="vbg-label" htmlFor="shopId">
                    Shop
                  </label>
                  <select id="shopId" name="shopId" required defaultValue="">
                    <option value="" disabled>
                      Choose a shop
                    </option>
                    {shops.map((shop) => (
                      <option key={shop.id} value={shop.id}>
                        {describeShop(shop)}
                      </option>
                    ))}
                  </select>
                  <p className="vbg-helper">
                    The shop&rsquo;s tills send its menu to the website shown. Easiest from the
                    shop&rsquo;s own page: Customers &rsaquo; the owner &rsaquo; the shop.
                  </p>
                </div>
              )}

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
                  defaultValue={2}
                  required
                />
                <p className="vbg-helper">
                  Two tills unless the customer has paid for more. A device
                  beyond this is refused outright, not queued for review.
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
                  defaultValue={toDateInputValue(defaultExpiry)}
                  required
                />
                <p className="vbg-helper">
                  The till keeps working for a 14 day grace window past this
                  date before it blocks payment.
                </p>
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
                  placeholder="Defaults to the shop name"
                />
                <p className="vbg-helper">
                  Shown on the cashier&rsquo;s own License screen.
                </p>
              </div>
            </div>

            <div
              className="vbg-custom-actions"
              style={{ marginTop: "var(--vbg-space-6)" }}
            >
              <button type="submit" className="vbg-button">
                Issue license
              </button>
              <Link href="/licenses" className="vbg-custom-link-action">
                Cancel
              </Link>
            </div>
          </form>

          <Notice notice={notice} tone={tone} />
        </>
      )}
    </section>
  );
}
