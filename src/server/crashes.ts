import { env } from "~/env";
import { db } from "~/server/db";

/**
 * The tills' crashes, and the problems staff reported from a till's "Report a problem" form, read from the crash collector at crash.epos-365.com (Bugsink; see
 * `pos_customized/Crash_Reporting_Plan.md`, 3c). Read here on the server with a token that may
 * only read the tills' project, never from the browser.
 *
 * A till tags each report with the device id this server knows it by, so each crash can be
 * named by shop and till number rather than by an id nobody recognises.
 */

const PROJECT_ID = 1;
const ISSUES_SHOWN = 25;
const PROBLEM_REPORT_PREFIX = "Problem report: ";

export type Crash = {
  id: string;
  /** "EPOS-365-TILL-3", what the collector calls it. */
  reference: string;
  /** A till's "Report a problem" form rather than a crash. */
  isProblemReport: boolean;
  type: string;
  message: string;
  firstSeen: Date;
  lastSeen: Date;
  count: number;
  resolved: boolean;
  /** The newest occurrence's app version, "4.2.0", or null when it could not be read. */
  version: string | null;
  /** "debug" for a developer's build; null for a shop's. */
  debugBuild: boolean;
  till: { shopName: string; terminalNumber: number | null; licenseId: string } | null;
  link: string;
};

export type CrashList =
  | { ok: true; crashes: Crash[] }
  | { ok: false; reason: "not_configured" | "unreachable" };

type BugsinkIssue = {
  id: string;
  friendly_id: string;
  first_seen: string;
  last_seen: string;
  digested_event_count: number;
  calculated_type: string;
  calculated_value: string;
  is_resolved: boolean;
};

type BugsinkEvent = { id: string };

type BugsinkEventDetail = {
  data?: { release?: string; environment?: string; tags?: BugsinkTags };
};

function collectorBase() {
  return env.CRASH_COLLECTOR_URL.replace(/\/$/, "");
}

async function read<T>(path: string): Promise<T> {
  const response = await fetch(`${collectorBase()}/api/canonical/0/${path}`, {
    headers: { authorization: `Bearer ${env.CRASH_COLLECTOR_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`The crash collector answered ${response.status} for ${path}`);
  return (await response.json()) as T;
}

type BugsinkTags = Record<string, string> | [string, string][] | undefined;

/** The device tag, whichever of the two shapes the collector gives tags in; null when absent or empty. */
function deviceTag(tags: BugsinkTags): string | null {
  const value = Array.isArray(tags) ? tags.find(([key]) => key === "device")?.[1] : tags?.device;
  if (!value) return null;
  return value;
}

/** The newest occurrence of one issue: its version, whether it came from a debug build, and which till sent it. */
async function newestOccurrence(issueId: string) {
  try {
    const events = await read<{ results: BugsinkEvent[] }>(`events/?issue=${issueId}&order=desc`);
    const newest = events.results[0];
    if (!newest) return null;
    const detail = await read<BugsinkEventDetail>(`events/${newest.id}/`);
    const release = detail.data?.release ?? null;
    return {
      version: release?.startsWith("epos365@") ? release.slice("epos365@".length) : release,
      debugBuild: detail.data?.environment === "debug",
      deviceId: deviceTag(detail.data?.tags),
    };
  } catch {
    // The list is still worth showing without one issue's details.
    return null;
  }
}

/** The most recently seen crashes, newest first. */
export async function listRecentCrashes(): Promise<CrashList> {
  if (!env.CRASH_COLLECTOR_TOKEN) return { ok: false, reason: "not_configured" };

  let issues: BugsinkIssue[];
  try {
    const page = await read<{ results: BugsinkIssue[] }>(
      `issues/?project=${PROJECT_ID}&sort=last_seen&order=desc`,
    );
    issues = page.results.slice(0, ISSUES_SHOWN);
  } catch (error) {
    console.error("[crashes] Could not read the crash collector:", error);
    return { ok: false, reason: "unreachable" };
  }

  const details = await Promise.all(issues.map((issue) => newestOccurrence(issue.id)));

  const deviceIds = [...new Set(details.map((detail) => detail?.deviceId).filter((id): id is string => !!id))];
  const devices = deviceIds.length
    ? await db.device.findMany({
        where: { deviceId: { in: deviceIds } },
        select: { deviceId: true, terminalNumber: true, licenseId: true, license: { select: { shop: { select: { name: true } } } } },
      })
    : [];
  const byDeviceId = new Map(devices.map((device) => [device.deviceId, device]));

  return {
    ok: true,
    crashes: issues.map((issue, index) => {
      const detail = details[index];
      const device = detail?.deviceId ? byDeviceId.get(detail.deviceId) : undefined;
      // The till sends a problem report as a message whose text starts with this.
      const isProblemReport = issue.calculated_value.startsWith(PROBLEM_REPORT_PREFIX);
      return {
        id: issue.id,
        reference: issue.friendly_id,
        isProblemReport,
        type: isProblemReport ? "Problem report" : issue.calculated_type,
        message: isProblemReport ? issue.calculated_value.slice(PROBLEM_REPORT_PREFIX.length) : issue.calculated_value,
        firstSeen: new Date(issue.first_seen),
        lastSeen: new Date(issue.last_seen),
        count: issue.digested_event_count,
        resolved: issue.is_resolved,
        version: detail?.version ?? null,
        debugBuild: detail?.debugBuild ?? false,
        till: device
          ? { shopName: device.license.shop.name, terminalNumber: device.terminalNumber, licenseId: device.licenseId }
          : null,
        link: `${collectorBase()}/issues/issue/${issue.id}/event/last/`,
      };
    }),
  };
}
