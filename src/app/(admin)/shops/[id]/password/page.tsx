import Link from "next/link";
import { notFound } from "next/navigation";

import { Notice, readNotice } from "~/app/_components/notice";
import { setCustomerPasswordAction } from "~/server/actions/customers";
import { db } from "~/server/db";
import { customerDisplayName } from "~/server/customer/display-name";

export const dynamic = "force-dynamic";

/**
 * The only screen that can ever set `Customer.passwordHash` — always a
 * plaintext password in, hashed server-side by `setCustomerPassword`. There
 * is deliberately no way to paste a hash in directly anywhere in this panel.
 */
export default async function CustomerPasswordPage({
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
      <h1 className="vbg-title">
        {customer.passwordHash ? "Reset login password" : "Set login password"}
      </h1>

      <p className="vbg-reading vbg-span-7">
        {customer.email
          ? `This customer will sign in with ${customer.email} and the password set below.`
          : "This customer has no email yet — add one on the edit screen before setting a password, or this will be refused."}
      </p>

      <Notice notice={notice} tone={tone} />

      <form action={setCustomerPasswordAction} className="vbg-span-7">
        <input type="hidden" name="id" value={customer.id} />

        <div className="vbg-field">
          <label className="vbg-label" htmlFor="password">
            {customer.passwordHash ? "New password" : "Password"}
          </label>
          <input
            id="password"
            name="password"
            type="password"
            minLength={8}
            maxLength={200}
            required
            autoComplete="new-password"
          />
          <p className="vbg-helper">At least 8 characters.</p>
        </div>

        <div
          className="vbg-custom-actions"
          style={{ marginTop: "var(--vbg-space-6)" }}
        >
          <button type="submit" className="vbg-button">
            {customer.passwordHash ? "Reset password" : "Set password"}
          </button>
        </div>
      </form>
    </section>
  );
}
