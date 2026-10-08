import Link from "next/link";
import { notFound } from "next/navigation";

import { Notice, readNotice } from "~/app/_components/notice";
import { db } from "~/server/db";
import { websiteAddress } from "~/server/shop-connection";

export const dynamic = "force-dynamic";

/**
 * Everything known about one customer: their identity, their login status,
 * and the shop(s) that belong to them. View-only, like `/licenses/[id]`'s
 * top summary — every action (edit, set password, add/edit a shop) links
 * out to its own dedicated screen rather than embedding a form here.
 */
export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const { notice, tone } = readNotice(await searchParams);

  const customer = await db.customer.findUnique({
    where: { id },
    include: { shops: { include: { licenses: true }, orderBy: { name: "asc" } } },
  });

  if (!customer) notFound();

  return (
    <>
      <section className="vbg-section">
        <p className="vbg-meta">
          <Link href="/shops">Customers</Link>
        </p>
        <h1 className="vbg-title">{customer.name ?? "(unnamed)"}</h1>

        <dl className="vbg-custom-facts vbg-span-12">
          <div className="vbg-custom-fact">
            <dt>Email</dt>
            <dd>{customer.email ?? <span className="vbg-meta">none</span>}</dd>
          </div>
          <div className="vbg-custom-fact">
            <dt>Login</dt>
            <dd>{customer.passwordHash ? "Enabled" : "None"}</dd>
          </div>
          <div className="vbg-custom-fact">
            <dt>Subdomains allowed</dt>
            <dd className="vbg-numeric">{customer.shopLimit}</dd>
          </div>
        </dl>

        <Notice notice={notice} tone={tone} />

        <div className="vbg-custom-actions">
          <Link href={`/shops/${customer.id}/edit`} className="vbg-button">
            Edit customer
          </Link>
          <Link href={`/shops/${customer.id}/password`} className="vbg-custom-link-action">
            {customer.passwordHash ? "Reset password" : "Set password"}
          </Link>
        </div>
      </section>

      <section className="vbg-section">
        <h2 className="vbg-heading-24">Shops</h2>

        <div className="vbg-custom-actions">
          <Link href={`/shops/${customer.id}/shop/new`} className="vbg-button">
            Add shop
          </Link>
        </div>

        {customer.shops.length === 0 ? (
          <p className="vbg-reading vbg-span-7">No shops on file yet.</p>
        ) : (
          <div className="vbg-table-wrap vbg-span-12">
            <table>
              <caption className="vbg-visually-hidden">
                Shops belonging to {customer.name ?? "this customer"}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Shop</th>
                  <th scope="col">Website</th>
                  <th scope="col">Email</th>
                  <th scope="col">Phone</th>
                  <th scope="col">Note</th>
                  <th scope="col">Licenses</th>
                </tr>
              </thead>
              <tbody>
                {customer.shops.map((shop) => (
                  <tr key={shop.id}>
                    <td>
                      <Link href={`/shops/${customer.id}/shop/${shop.id}`}>
                        {shop.name}
                      </Link>
                    </td>
                    <td>{websiteAddress(shop) ?? <span className="vbg-meta">none</span>}</td>
                    <td>{shop.email ?? <span className="vbg-meta">none</span>}</td>
                    <td>{shop.phone ?? <span className="vbg-meta">none</span>}</td>
                    <td>{shop.notes ?? <span className="vbg-meta">none</span>}</td>
                    <td>
                      {shop.licenses.length === 0 ? (
                        <span className="vbg-meta">none</span>
                      ) : (
                        shop.licenses.map((license) => (
                          <span key={license.id}>
                            <Link href={`/licenses/${license.id}`} className="vbg-mono">
                              {license.key}
                            </Link>
                            <br />
                          </span>
                        ))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
