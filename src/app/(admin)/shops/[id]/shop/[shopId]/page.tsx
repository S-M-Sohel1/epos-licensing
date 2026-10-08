import Link from "next/link";
import { notFound } from "next/navigation";

import { Notice, readNotice } from "~/app/_components/notice";
import { describeExpiry, formatDate, formatDateTime } from "~/app/_lib/format";
import { setShopTemplateAction, updateShopAction } from "~/server/actions/shops";
import { db } from "~/server/db";
import { getShopConnection, TEMPLATE_LABELS, type WebsiteState } from "~/server/shop-connection";

export const dynamic = "force-dynamic";

const WEBSITE_STATE: Record<WebsiteState, { text: string; mark: string }> = {
  live: { text: "Live", mark: "approved" },
  not_published: { text: "Set up, not published yet", mark: "pending" },
  none: { text: "No website yet", mark: "none" },
};

const LICENCE_STATE = {
  active: { text: "Active", mark: "approved" },
  blocked: { text: "Blocked", mark: "blocked" },
  expired: { text: "Expired", mark: "blocked" },
} as const;

/**
 * One shop: its website, its licence(s) and the menu its tills send, side by side, with a
 * sentence for anything missing. A shop's tills reach its website only through the licence, so
 * this page is where a licence on the wrong shop, or a website with no till behind it, shows up.
 * The shop's own details are edited further down.
 */
export default async function ShopPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; shopId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id, shopId } = await params;
  const { notice, tone } = readNotice(await searchParams);

  const shop = await db.shop.findUnique({ where: { id: shopId }, include: { customer: true } });
  if (shop?.customerId !== id) notFound();
  const connection = await getShopConnection(shop.id);
  if (!connection) notFound();

  const { website, licences, menu, problems } = connection;
  const websiteState = WEBSITE_STATE[website.state];

  return (
    <>
      <section className="vbg-section">
        <p className="vbg-meta">
          <Link href={`/shops/${id}`}>{shop.customer?.name ?? "Back to customer"}</Link>
        </p>
        <h1 className="vbg-title">{shop.name}</h1>

        <Notice notice={notice} tone={tone} />

        <dl className="vbg-custom-facts vbg-span-12">
          <div className="vbg-custom-fact">
            <dt>Website</dt>
            <dd>
              {website.address ? (
                <a href={`https://${website.address}`} target="_blank" rel="noreferrer">
                  {website.address}
                  <span className="vbg-visually-hidden"> (opens in a new tab)</span>
                </a>
              ) : (
                <span className="vbg-meta">none</span>
              )}
              <br />
              <span className="vbg-custom-status" data-state={websiteState.mark}>
                {websiteState.text}
              </span>
            </dd>
          </div>

          <div className="vbg-custom-fact">
            <dt>{licences.length > 1 ? "Licenses" : "License"}</dt>
            <dd>
              {licences.length === 0 ? (
                <>
                  <span className="vbg-custom-status" data-state="none">
                    None
                  </span>
                  {/* The button is under "Needs attention" when the missing license is a problem. */}
                  {!problems.some((p) => p.action?.href.startsWith("/licenses/new")) && (
                    <>
                      <br />
                      <Link href={`/licenses/new?shopId=${shop.id}`}>Give this shop a license</Link>
                    </>
                  )}
                </>
              ) : (
                licences.map((licence) => (
                  <span key={licence.id} style={{ display: "block" }}>
                    <Link href={`/licenses/${licence.id}`} className="vbg-mono">
                      {licence.key}
                    </Link>
                    <br />
                    <span className="vbg-custom-status" data-state={LICENCE_STATE[licence.state].mark}>
                      {LICENCE_STATE[licence.state].text}
                    </span>
                    <br />
                    <span className="vbg-meta">
                      {licence.tills} of {licence.maxDevices} tills · until {formatDate(licence.validUntil)} (
                      {describeExpiry(licence.validUntil)})
                    </span>
                  </span>
                ))
              )}
            </dd>
          </div>

          <div className="vbg-custom-fact">
            <dt>Menu from the till</dt>
            <dd>
              {menu.lastSentAt ? (
                <>
                  <span className="vbg-numeric">{menu.items.toLocaleString("en-GB")}</span> products in{" "}
                  <span className="vbg-numeric">{menu.groups}</span> groups
                  <br />
                  <span className="vbg-meta">
                    {menu.sentBy ?? "A till"} · last sent {formatDateTime(menu.lastSentAt)}
                  </span>
                </>
              ) : (
                <span className="vbg-custom-status" data-state="none">
                  Not sent yet
                </span>
              )}
            </dd>
          </div>
        </dl>
      </section>

      <section className="vbg-section">
        <h2 className="vbg-heading-24">
          {problems.length === 0 ? "Everything is connected" : "Needs attention"}
        </h2>
        {problems.length === 0 ? (
          <p className="vbg-reading vbg-span-7">
            {website.state === "none"
              ? "Nothing to connect yet: this shop has no website and no license."
              : "This shop's tills send its menu to its website, and its online orders go to its tills."}
          </p>
        ) : (
          <ul className="vbg-custom-attention vbg-span-7">
            {problems.map((problem) => (
              <li key={problem.text}>
                <p className="vbg-reading">{problem.text}</p>
                {problem.action && (
                  <Link href={problem.action.href} className="vbg-button">
                    {problem.action.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="vbg-section" id="template">
        <h2 className="vbg-heading-24">Website template</h2>
        <p className="vbg-reading vbg-span-7">
          What the shop&rsquo;s website shows. The owner picks it once, when the website is first
          switched on, and cannot change it themselves. Changing it here deletes nothing: the menu,
          orders, staff and photos stay and come back with the restaurant template.
        </p>
        <form action={setShopTemplateAction} className="vbg-span-7">
          <input type="hidden" name="id" value={shop.id} />
          <input type="hidden" name="customerId" value={id} />
          <fieldset className="vbg-custom-choices">
            <legend className="vbg-visually-hidden">Website template</legend>
            {(Object.keys(TEMPLATE_LABELS) as (keyof typeof TEMPLATE_LABELS)[]).map((templateId) => (
              <label key={templateId} className="vbg-custom-choice">
                <input
                  type="radio"
                  name="templateId"
                  value={templateId}
                  defaultChecked={shop.templateId === templateId}
                />
                <span>
                  <strong>{TEMPLATE_LABELS[templateId].name}</strong>
                  {shop.templateId === templateId && <span className="vbg-meta"> · in use now</span>}
                  <br />
                  <span className="vbg-meta">{TEMPLATE_LABELS[templateId].description}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="vbg-custom-actions" style={{ marginTop: "var(--vbg-space-5)" }}>
            <button type="submit" className="vbg-button">
              Save template
            </button>
          </div>
        </form>
      </section>

      <section className="vbg-section">
        <h2 className="vbg-heading-24">Details</h2>
        <form action={updateShopAction} className="vbg-span-7">
          <input type="hidden" name="id" value={shop.id} />
          <input type="hidden" name="customerId" value={id} />

          <div className="vbg-custom-form-row">
            <div className="vbg-field">
              <label className="vbg-label" htmlFor="name">
                Shop name
              </label>
              <input id="name" name="name" type="text" defaultValue={shop.name} required />
            </div>
            <div className="vbg-field">
              <label className="vbg-label" htmlFor="email">
                Email
              </label>
              <input id="email" name="email" type="email" defaultValue={shop.email ?? ""} />
            </div>
            <div className="vbg-field">
              <label className="vbg-label" htmlFor="phone">
                Phone
              </label>
              <input id="phone" name="phone" type="tel" defaultValue={shop.phone ?? ""} />
            </div>
            <div className="vbg-field">
              <label className="vbg-label" htmlFor="notes">
                Note
              </label>
              <input id="notes" name="notes" type="text" maxLength={500} defaultValue={shop.notes ?? ""} />
            </div>
          </div>

          <div className="vbg-custom-actions" style={{ marginTop: "var(--vbg-space-6)" }}>
            <button type="submit" className="vbg-button">
              Save
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
