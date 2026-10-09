import Link from "next/link";

import { Notice, readNotice } from "~/app/_components/notice";
import { db } from "~/server/db";
import { customerDisplayName } from "~/server/customer/display-name";

export const dynamic = "force-dynamic";

/**
 * Every customer, view-only — same shape as `/licenses`: a ledger to scan
 * and click into, not a place to edit fields in place. Every CRUD action
 * (create, edit, set password, add/edit a shop) has its own dedicated
 * screen reachable from here or from a customer's detail page, so this
 * table never has a form embedded in it.
 */
export default async function ShopsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { notice, tone } = readNotice(await searchParams);

  const customers = await db.customer.findMany({
    orderBy: { name: "asc" },
    include: { shops: { include: { licenses: true } } },
  });

  return (
    <>
      <section className="vbg-section">
        <h1 className="vbg-title">Customers</h1>
        <p className="vbg-lede vbg-span-7">
          Who holds which license, and who to ring when a till stops taking
          payment.
        </p>

        <div className="vbg-custom-actions">
          <Link href="/shops/new" className="vbg-button">
            Add customer
          </Link>
        </div>

        <Notice notice={notice} tone={tone} />
      </section>

      {customers.length > 0 && (
        <section className="vbg-section">
          <div className="vbg-table-wrap vbg-span-12">
            <table>
              <caption className="vbg-visually-hidden">
                Customers, their shops, and whether they have a login
              </caption>
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col">Email</th>
                  <th scope="col">Login</th>
                  <th scope="col">Shops</th>
                  <th scope="col">Licenses</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => {
                  const licenseCount = customer.shops.reduce(
                    (sum, shop) => sum + shop.licenses.length,
                    0,
                  );
                  return (
                    <tr key={customer.id}>
                      <td>
                        <Link href={`/shops/${customer.id}`}>
                          {customerDisplayName(customer)}
                        </Link>
                      </td>
                      <td>{customer.email ?? <span className="vbg-meta">none</span>}</td>
                      <td>
                        {customer.passwordHash ? (
                          "Enabled"
                        ) : (
                          <span className="vbg-meta">none</span>
                        )}
                      </td>
                      <td>
                        {customer.shops.length === 0 ? (
                          <span className="vbg-meta">none</span>
                        ) : (
                          customer.shops.map((shop) => shop.name).join(", ")
                        )}
                      </td>
                      <td className="vbg-numeric">{licenseCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
