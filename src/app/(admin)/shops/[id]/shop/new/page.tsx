import Link from "next/link";
import { notFound } from "next/navigation";

import { Notice, readNotice } from "~/app/_components/notice";
import { createShopAction } from "~/server/actions/shops";
import { db } from "~/server/db";
import { customerDisplayName } from "~/server/customer/display-name";

export const dynamic = "force-dynamic";

export default async function NewShopPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const { notice, tone } = readNotice(await searchParams);

  const customer = await db.customer.findUnique({ where: { id } });
  if (!customer) notFound();

  return (
    <section className="vbg-section">
      <p className="vbg-meta">
        <Link href={`/shops/${customer.id}`}>{customerDisplayName(customer)}</Link>
      </p>
      <h1 className="vbg-title">Add a shop</h1>
      <p className="vbg-lede vbg-span-7">
        A second business/location under this customer&apos;s account
        ({customerDisplayName(customer)}). Each shop gets its own License.
      </p>

      <Notice notice={notice} tone={tone} />

      <form action={createShopAction} className="vbg-span-7">
        <input type="hidden" name="customerId" value={customer.id} />

        <div className="vbg-custom-form-row">
          <div className="vbg-field">
            <label className="vbg-label" htmlFor="name">
              Shop name
            </label>
            <input id="name" name="name" type="text" required />
          </div>
          <div className="vbg-field">
            <label className="vbg-label" htmlFor="email">
              Email
            </label>
            <input id="email" name="email" type="email" />
          </div>
          <div className="vbg-field">
            <label className="vbg-label" htmlFor="phone">
              Phone
            </label>
            <input id="phone" name="phone" type="tel" />
          </div>
          <div className="vbg-field">
            <label className="vbg-label" htmlFor="notes">
              Note
            </label>
            <input id="notes" name="notes" type="text" maxLength={500} />
          </div>
        </div>

        <div
          className="vbg-custom-actions"
          style={{ marginTop: "var(--vbg-space-6)" }}
        >
          <button type="submit" className="vbg-button">
            Add shop
          </button>
        </div>
      </form>
    </section>
  );
}
