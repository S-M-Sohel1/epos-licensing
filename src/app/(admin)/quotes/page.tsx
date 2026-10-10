import Link from "next/link";

import { Notice, readNotice } from "~/app/_components/notice";
import { formatCents, formatDateTime } from "~/app/_lib/format";
import { setQuoteContactedAction } from "~/server/actions/quotes";
import { db } from "~/server/db";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const CYCLE_LABEL: Record<string, string> = {
  oneTime: "one-time",
  monthly: "a month",
  yearly: "a year",
};

/** What the website's calculator had selected, as it was stored: a billing cycle and a quantity per hardware item. */
function readSelection(value: unknown): { cycle: string | null; quantities: Record<string, number> } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { cycle: null, quantities: {} };
  const record = value as Record<string, unknown>;
  const cycle = typeof record.cycle === "string" ? record.cycle : null;
  const raw =
    typeof record.quantities === "object" && record.quantities !== null
      ? (record.quantities as Record<string, unknown>)
      : {};
  const quantities: Record<string, number> = {};
  for (const [id, quantity] of Object.entries(raw)) {
    if (typeof quantity === "number" && quantity > 0) quantities[id] = quantity;
  }
  return { cycle, quantities };
}

function summary(total: number, waiting: number): string {
  if (total === 0) return "Nobody has asked for a quote on the website yet.";
  if (waiting === 0) return "Everyone who asked for a quote has been contacted.";
  if (total === 1) return "One request, not contacted yet.";
  return `${waiting} of ${total} requests have not been contacted yet.`;
}

/**
 * Everyone who asked for a quote on the website, newest first, with the phone
 * number to ring them back on.
 *
 * The quote form has always saved its requests (`~/server/leads.ts`), but
 * nothing showed them: the only trace was one line in the audit log with no
 * phone number. A request from a visitor who is not signed in creates a shop
 * with no customer account, which the Customers list does not show either.
 *
 * "Contacted" is the one thing an admin changes here, so the list answers the
 * question it exists for: who has not been rung back yet.
 */
export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { notice, tone } = readNotice(params);
  const pageParam = Array.isArray(params.page) ? params.page[0] : params.page;
  const page = Math.max(1, Number(pageParam ?? 1) || 1);

  const [quotes, total, waiting, hardware] = await Promise.all([
    db.quoteRequest.findMany({
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { shop: { include: { customer: true } } },
    }),
    db.quoteRequest.count(),
    db.quoteRequest.count({ where: { contactedAt: null } }),
    db.hardwareItem.findMany({ select: { id: true, name: true } }),
  ]);

  const hardwareName = new Map(hardware.map((item) => [item.id, item.name]));
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <section className="vbg-section">
        <h1 className="vbg-title">Quote requests</h1>
        <p className="vbg-lede vbg-span-7">{summary(total, waiting)}</p>

        <Notice notice={notice} tone={tone} />
      </section>

      {quotes.length > 0 && (
        <section className="vbg-section">
          <div className="vbg-table-wrap vbg-span-12">
            <table>
              <caption className="vbg-visually-hidden">
                Quote requests from the website, newest first
              </caption>
              <thead>
                <tr>
                  <th scope="col">Asked</th>
                  <th scope="col">Who</th>
                  <th scope="col">Contact</th>
                  <th scope="col">What they asked for</th>
                  <th scope="col">Estimate</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {quotes.map((quote) => {
                  const { shop } = quote;
                  const selection = readSelection(quote.selection);
                  const chosen = Object.entries(selection.quantities).map(
                    ([id, quantity]) => `${quantity} × ${hardwareName.get(id) ?? "an item since removed"}`,
                  );
                  const contact = shop.contactName ?? shop.customer?.name ?? null;
                  const email = shop.email ?? shop.customer?.email ?? null;
                  const cycle = selection.cycle ? CYCLE_LABEL[selection.cycle] : undefined;

                  return (
                    <tr key={quote.id}>
                      <td className="vbg-mono vbg-meta">{formatDateTime(quote.createdAt)}</td>
                      <td>
                        {shop.customerId ? (
                          <Link href={`/shops/${shop.customerId}/shop/${shop.id}`}>{shop.name}</Link>
                        ) : (
                          shop.name
                        )}
                        {contact ? (
                          <>
                            <br />
                            <span className="vbg-meta">{contact}</span>
                          </>
                        ) : null}
                        {quote.businessType ? (
                          <>
                            <br />
                            <span className="vbg-meta">{quote.businessType}</span>
                          </>
                        ) : null}
                      </td>
                      <td>
                        {shop.phone ? (
                          <a href={`tel:${shop.phone.replace(/\s/g, "")}`}>{shop.phone}</a>
                        ) : (
                          <span className="vbg-meta">no phone given</span>
                        )}
                        {email ? (
                          <>
                            <br />
                            <a href={`mailto:${email}`}>{email}</a>
                          </>
                        ) : null}
                      </td>
                      <td>
                        {quote.message ?? <span className="vbg-meta">No message</span>}
                        {chosen.length > 0 ? (
                          <>
                            <br />
                            <span className="vbg-meta">{chosen.join(", ")}</span>
                          </>
                        ) : null}
                      </td>
                      <td className="vbg-numeric">
                        {quote.estimateCents == null ? (
                          <span className="vbg-meta">none</span>
                        ) : (
                          <>
                            {formatCents(quote.estimateCents)}
                            {cycle ? (
                              <>
                                <br />
                                <span className="vbg-meta">{cycle}</span>
                              </>
                            ) : null}
                          </>
                        )}
                      </td>
                      <td>
                        <span className="vbg-custom-status" data-state={quote.contactedAt ? "approved" : "pending"}>
                          {quote.contactedAt ? "Contacted" : "Not contacted"}
                        </span>
                        {quote.contactedAt ? (
                          <>
                            <br />
                            <span className="vbg-meta">
                              {formatDateTime(quote.contactedAt)}
                              {quote.contactedBy ? ` · ${quote.contactedBy}` : ""}
                            </span>
                          </>
                        ) : null}
                        <div className="vbg-custom-actions">
                          <form action={setQuoteContactedAction}>
                            <input type="hidden" name="id" value={quote.id} />
                            <input type="hidden" name="contacted" value={quote.contactedAt ? "no" : "yes"} />
                            <input type="hidden" name="page" value={page} />
                            {quote.contactedAt ? (
                              <button type="submit" className="vbg-custom-link-action">
                                Mark as not contacted
                              </button>
                            ) : (
                              <button type="submit" className="vbg-button">
                                Mark as contacted
                              </button>
                            )}
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {lastPage > 1 && (
            <p className="vbg-caption">
              Page {page} of {lastPage}.{" "}
              {page > 1 && <Link href={`/quotes?page=${page - 1}`}>Newer</Link>}
              {page > 1 && page < lastPage ? " · " : ""}
              {page < lastPage && <Link href={`/quotes?page=${page + 1}`}>Older</Link>}
            </p>
          )}
        </section>
      )}
    </>
  );
}
