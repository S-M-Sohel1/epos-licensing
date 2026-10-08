import { z } from "zod";

import {
  currentUpdateAnnouncement,
  type UpdateAnnouncement,
} from "./releases";
import type { LicenseServerResponseBody, LicenseServerResult } from "./service";
import { canonicalPayloadJson, signServerTime } from "./signing";

/**
 * The WPF client posts `System.Text.Json`'s default output, which is PascalCase.
 * `Licensing_Design.md` writes the same contract in camelCase. Rather than pick
 * a winner and leave the other silently binding to nothing, read either: the
 * body is normalised to lower case keys before validation, so `LicenseKey`,
 * `licenseKey` and `licensekey` all land in the same place.
 */
function normalizeKeys(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) return {};

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

const nonEmpty = z.string().trim().min(1);

export const activateRequestSchema = z.object({
  licensekey: nonEmpty,
  deviceid: nonEmpty,
  hardwarefingerprint: nonEmpty,
  businessname: z.string().nullish(),
});

export const checkInRequestSchema = z.object({
  licensekey: nonEmpty,
  deviceid: nonEmpty,
  hardwarefingerprint: nonEmpty,
});

export const deviceDeleteRequestSchema = z.object({
  licensekey: nonEmpty,
  deviceid: nonEmpty,
});

/**
 * Same shape as a check-in, and deliberately so: a till releasing its own slot
 * is proving it holds that device's identity, which is exactly what a check-in
 * body carries.
 */
export const releaseRequestSchema = checkInRequestSchema;

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return normalizeKeys(await request.json());
  } catch {
    return {};
  }
}

/**
 * Serializes with the canonical writer rather than `JSON.stringify`.
 *
 * Only the bytes inside `Payload` are covered by the signature, and the client
 * re-serializes the parsed payload before verifying, so a standard encoder
 * would in fact verify correctly. Using the same writer anyway means the blob
 * on the wire, the blob in a generated `.lic` file, and the blob the client
 * writes back out through "Copy license to file" are byte-identical, which
 * turns a support question about a mismatched license into a diff.
 */
export async function licenseResponse(
  result: LicenseServerResult,
): Promise<Response> {
  // Emitted on every response, including refusals — the same reasoning as the
  // signed server time below. A till whose licence is in trouble is if anything
  // more likely to be running an old build, and a shop that is blocked for being
  // out of date has to be told so on the very response that blocks it.
  const update = await currentUpdateAnnouncement();

  return new Response(serializeResponseBody(result.body, update), {
    status: result.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Activation state is per-device and changes; nothing here may be cached
      // by an intermediary.
      "cache-control": "no-store",
    },
  });
}

export function serializeResponseBody(
  body: LicenseServerResponseBody,
  update: UpdateAnnouncement | null = null,
): string {
  const parts: string[] = [];

  parts.push(
    `"License":${
      body.License === null
        ? "null"
        : `{"Payload":${canonicalPayloadJson(body.License.Payload)},"Signature":${JSON.stringify(body.License.Signature)}}`
    }`,
  );
  parts.push(`"ApprovalState":${JSON.stringify(body.ApprovalState)}`);
  parts.push(
    `"Error":${body.Error === null ? "null" : JSON.stringify(body.Error)}`,
  );

  // Signed server time, for the till's staff clock-in/out records. Emitted on
  // every response, including "pending" and "blocked" ones: a shop whose license
  // is in trouble still has staff whose hours have to be right, and this costs
  // one signature. See `signServerTime` for why it is signed separately from the
  // license blob rather than added to it.
  const serverTime = signServerTime();
  parts.push(`"ServerTimeUtc":${JSON.stringify(serverTime.ServerTimeUtc)}`);
  parts.push(
    `"ServerTimeSignature":${JSON.stringify(serverTime.ServerTimeSignature)}`,
  );

  // Signed independently of the licence blob, so a client that predates this
  // simply ignores the extra fields and no licence already issued is affected.
  // Omitted entirely when nothing is published, which is what a client reads as
  // "no update exists" rather than "an update of version ''".
  if (update) {
    parts.push(`"UpdateVersion":${JSON.stringify(update.UpdateVersion)}`);
    parts.push(
      `"UpdateMinimumVersion":${JSON.stringify(update.UpdateMinimumVersion)}`,
    );
    parts.push(`"UpdateUrl":${JSON.stringify(update.UpdateUrl)}`);
    parts.push(`"UpdateSha256":${JSON.stringify(update.UpdateSha256)}`);
    parts.push(`"UpdateSignature":${JSON.stringify(update.UpdateSignature)}`);
  }

  // Additive, exactly like the update fields above: a client that predates this
  // ignores them and goes on using the number typed in at Settings > Database.
  if (body.TerminalNumber !== undefined) {
    parts.push(`"TerminalNumber":${body.TerminalNumber}`);
    parts.push(
      `"TerminalNumberSignature":${JSON.stringify(body.TerminalNumberSignature)}`,
    );
  }

  // Additive too: a client that predates this ignores it.
  if (body.Website !== undefined) parts.push(`"Website":${JSON.stringify(body.Website)}`);

  if (body.MaxDevices !== undefined)
    parts.push(`"MaxDevices":${body.MaxDevices}`);
  if (body.ApprovedCount !== undefined) {
    parts.push(`"ApprovedCount":${body.ApprovedCount}`);
  }

  return `{${parts.join(",")}}`;
}

/** A malformed body never reaches the licensing logic. */
export function badRequest(message: string): Response {
  return new Response(
    serializeResponseBody({
      License: null,
      ApprovalState: "invalid_request",
      Error: message,
    }),
    {
      status: 400,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}
