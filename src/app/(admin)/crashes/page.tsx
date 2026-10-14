import Link from "next/link";

import { formatDateTime } from "~/app/_lib/format";
import { listRecentCrashes } from "~/server/crashes";

export const dynamic = "force-dynamic";

/**
 * The tills' unexpected crashes, newest first, read from the crash collector
 * (crash.epos-365.com). Only what a till did not expect is here: a printer that
 * was off or no internet stays in that till's own log.
 *
 * Each row names the shop and till the newest occurrence came from, so a support
 * call can start from "your till 2 crashed at 14:10". The full detail (where in
 * the code, the log lines before it) is one click away in the collector itself.
 */
export default async function CrashesPage() {
  const result = await listRecentCrashes();

  return (
    <>
      <section className="vbg-section">
        <h1 className="vbg-title">Crashes</h1>
        <p className="vbg-lede vbg-span-7">
          Errors the tills did not expect, most recently seen first. Open one in
          the crash collector for where in the code it happened and what the
          till was doing just before.
        </p>
      </section>

      <section className="vbg-section">
        {!result.ok ? (
          <p className="vbg-reading">
            {result.reason === "not_configured"
              ? "The crash collector is not connected: CRASH_COLLECTOR_TOKEN is not set."
              : "The crash collector could not be reached just now. Try again in a minute."}
          </p>
        ) : result.crashes.length === 0 ? (
          <p className="vbg-reading">No till has reported a crash.</p>
        ) : (
          <ul className="vbg-custom-feed vbg-span-12">
            {result.crashes.map((crash) => (
              <li key={crash.id} className="vbg-custom-feed-item">
                <span className="vbg-mono vbg-meta">{formatDateTime(crash.lastSeen)}</span>
                <span>
                  <strong>{crash.type.replace(/^System\./, "")}</strong>: {crash.message}
                  <br />
                  <span className="vbg-custom-feed-detail">
                    {crash.till ? (
                      <>
                        <Link href={`/licenses/${crash.till.licenseId}`}>{crash.till.shopName}</Link>
                        {crash.till.terminalNumber ? `, till ${crash.till.terminalNumber}` : ""}
                      </>
                    ) : (
                      "Till not known"
                    )}
                    {crash.version ? ` · version ${crash.version}` : ""}
                    {crash.debugBuild ? " · developer build" : ""}
                    {` · ${crash.count === 1 ? "once" : `${crash.count} times`} since ${formatDateTime(crash.firstSeen)}`}
                    {crash.resolved ? " · marked fixed" : ""}
                    {" · "}
                    <a href={crash.link} target="_blank" rel="noreferrer">
                      Open {crash.reference}
                    </a>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
