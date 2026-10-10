import { Notice, readNotice } from "~/app/_components/notice";
import { formatDateTime } from "~/app/_lib/format";
import { saveContactDetailsAction } from "~/server/actions/contact";
import { getContactDetails } from "~/server/contact-details";

export const dynamic = "force-dynamic";

/**
 * How a visitor to the corporate website reaches the business: today, the
 * phone number on its "Call" buttons and beside "get in touch" wording on a
 * new customer's dashboard. The website reads it through GET /api/contact.
 *
 * It is here, and not written into the website's code, so the business can
 * change its own number without a release.
 */
export default async function ContactPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { notice, tone } = readNotice(await searchParams);
  const details = await getContactDetails();

  return (
    <>
      <section className="vbg-section">
        <h1 className="vbg-title">Contact details</h1>
        <p className="vbg-lede vbg-span-7">
          How people reach you from the website. Changes show there within a minute.
        </p>
        <Notice notice={notice} tone={tone} />
      </section>

      <section className="vbg-section">
        <form action={saveContactDetailsAction} className="vbg-span-7">
          <div className="vbg-field">
            <label className="vbg-label" htmlFor="salesPhone">
              Phone number
            </label>
            <input
              id="salesPhone"
              name="salesPhone"
              type="tel"
              autoComplete="tel"
              maxLength={30}
              placeholder="e.g. 01 234 5678"
              defaultValue={details?.salesPhone ?? ""}
              aria-describedby="salesPhone-help"
            />
            <p id="salesPhone-help" className="vbg-helper">
              Shown on the website&rsquo;s &ldquo;Call&rdquo; buttons and to new customers waiting for a licence.
              Write it as you want it read. Leave it blank and the website shows a stand-in number
              that nobody answers, so set this before the website is promoted.
            </p>
          </div>

          <div className="vbg-custom-actions" style={{ marginTop: "var(--vbg-space-6)" }}>
            <button type="submit" className="vbg-button">
              Save
            </button>
          </div>
        </form>

        {details?.updatedBy ? (
          <p className="vbg-helper vbg-span-7" style={{ marginTop: "var(--vbg-space-4)" }}>
            Last changed {formatDateTime(details.updatedAt)} by {details.updatedBy}.
          </p>
        ) : null}
      </section>
    </>
  );
}
