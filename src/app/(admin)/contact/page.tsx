import { Notice, readNotice } from "~/app/_components/notice";
import { formatDateTime } from "~/app/_lib/format";
import { saveContactDetailsAction } from "~/server/actions/contact";
import { getContactDetails } from "~/server/contact-details";

export const dynamic = "force-dynamic";

/**
 * How a visitor to the corporate website reaches the business, and who the
 * business is where the website has to say so: its privacy policy and terms.
 * The website reads all of it through GET /api/contact.
 *
 * It is here, and not written into the website's code, so the business can
 * change its own details without a release.
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
          How people reach you from the website, and the business details its privacy policy and terms
          state. Every field is optional. Changes show on the website within a minute or two.
        </p>
        <Notice notice={notice} tone={tone} />
      </section>

      <form action={saveContactDetailsAction}>
        <section className="vbg-section">
          <h2 className="vbg-heading-24">Getting in touch</h2>

          <div className="vbg-span-7">
            <div className="vbg-field">
              <label className="vbg-label" htmlFor="salesPhone">
                Phone number
              </label>
              <input
                id="salesPhone"
                name="salesPhone"
                type="tel"
                autoComplete="off"
                maxLength={30}
                placeholder="e.g. 01 234 5678"
                defaultValue={details?.salesPhone ?? ""}
                aria-describedby="salesPhone-help"
              />
              <p id="salesPhone-help" className="vbg-helper">
                Shown on the website&rsquo;s &ldquo;Call&rdquo; buttons and to new customers waiting for a
                licence. Write it as you want it read. Left blank, the website shows a stand-in number
                that nobody answers, so set this before the website is promoted.
              </p>
            </div>

            <div className="vbg-field" style={{ marginTop: "var(--vbg-space-4)" }}>
              <label className="vbg-label" htmlFor="salesEmail">
                Sales email
              </label>
              <input
                id="salesEmail"
                name="salesEmail"
                type="email"
                autoComplete="off"
                maxLength={254}
                placeholder="sales@epos-365.com"
                defaultValue={details?.salesEmail ?? ""}
                aria-describedby="salesEmail-help"
              />
              <p id="salesEmail-help" className="vbg-helper">
                Where the website sends quote requests, licence requests and news of each new account,
                and the address it shows to a customer who wants to write. Left blank, it uses
                sales@epos-365.com. Check the address is right: mail sent to a wrong one is not
                reported anywhere.
              </p>
            </div>
          </div>
        </section>

        <section className="vbg-section">
          <h2 className="vbg-heading-24">Business details</h2>
          <p className="vbg-span-7">
            Printed in the website&rsquo;s privacy policy and terms of service, which have to say who is
            responsible and how to reach them. The privacy policy stays out of search results until
            an address is saved here.
          </p>

          <div className="vbg-span-7" style={{ marginTop: "var(--vbg-space-4)" }}>
            <div className="vbg-custom-form-row">
              <div className="vbg-field">
                <label className="vbg-label" htmlFor="legalName">
                  Registered business name
                </label>
                <input
                  id="legalName"
                  name="legalName"
                  type="text"
                  autoComplete="off"
                  maxLength={160}
                  placeholder="Epos Till Tech"
                  defaultValue={details?.legalName ?? ""}
                />
              </div>
              <div className="vbg-field">
                <label className="vbg-label" htmlFor="companyNumber">
                  Company number
                </label>
                <input
                  id="companyNumber"
                  name="companyNumber"
                  type="text"
                  autoComplete="off"
                  maxLength={40}
                  defaultValue={details?.companyNumber ?? ""}
                />
              </div>
            </div>
            <p className="vbg-helper">
              The name exactly as registered. Left blank, the website uses &ldquo;Epos Till Tech&rdquo;.
              The company number is only for a registered company.
            </p>

            <div className="vbg-field" style={{ marginTop: "var(--vbg-space-4)" }}>
              <label className="vbg-label" htmlFor="address">
                Business address
              </label>
              <textarea
                id="address"
                name="address"
                rows={3}
                maxLength={300}
                defaultValue={details?.address ?? ""}
                aria-describedby="address-help"
              />
              <p id="address-help" className="vbg-helper">
                The registered or trading address. The website prints it on one line.
              </p>
            </div>

            <div className="vbg-field" style={{ marginTop: "var(--vbg-space-4)" }}>
              <label className="vbg-label" htmlFor="privacyEmail">
                Privacy email
              </label>
              <input
                id="privacyEmail"
                name="privacyEmail"
                type="email"
                autoComplete="off"
                maxLength={254}
                placeholder="privacy@epos-365.com"
                defaultValue={details?.privacyEmail ?? ""}
                aria-describedby="privacyEmail-help"
              />
              <p id="privacyEmail-help" className="vbg-helper">
                Where people write about their personal information. It must be read by a person. Left
                blank, the website gives privacy@epos-365.com.
              </p>
            </div>

            <div className="vbg-custom-actions" style={{ marginTop: "var(--vbg-space-6)" }}>
              <button type="submit" className="vbg-button">
                Save
              </button>
            </div>

            {details?.updatedBy ? (
              <p className="vbg-helper" style={{ marginTop: "var(--vbg-space-4)" }}>
                Last changed {formatDateTime(details.updatedAt)} by {details.updatedBy}.
              </p>
            ) : null}
          </div>
        </section>
      </form>
    </>
  );
}
