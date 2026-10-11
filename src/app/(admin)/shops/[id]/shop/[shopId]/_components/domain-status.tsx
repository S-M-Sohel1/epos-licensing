"use client";

import { useCallback, useEffect, useState, useTransition } from "react";

import { domainStatusAction } from "~/server/actions/shops";
import type { DnsRecord, DomainSetup } from "~/server/custom-domain";

const STATUS: Record<DomainSetup["status"] | DnsRecord["state"], { text: string; mark: string }> = {
  live: { text: "Valid", mark: "approved" },
  starting: { text: "Valid, starting up", mark: "pending" },
  waiting: { text: "Waiting for DNS", mark: "pending" },
  valid: { text: "Valid", mark: "approved" },
  missing: { text: "Waiting for DNS", mark: "pending" },
  proxied: { text: "Proxy detected", mark: "blocked" },
  elsewhere: { text: "Points somewhere else", mark: "blocked" },
  unknown: { text: "Could not be checked", mark: "none" },
};

const HELP: Partial<Record<DnsRecord["state"], string>> = {
  missing: "Add this record where the domain's DNS is managed. It can take from a few minutes to a few hours to be found.",
  proxied: "The domain goes through Cloudflare. In Cloudflare, set this record to “DNS only” (grey cloud).",
  elsewhere: "The domain exists but leads somewhere else. Change its record to this one.",
};

/** One word for the whole domain: how the website is doing if the record is right, the record's own state if not. */
function overall(setup: DomainSetup) {
  return STATUS[setup.record.state === "valid" ? setup.status : setup.record.state];
}

function Copy({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="vbg-custom-link-action"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied" : "Copy"}
      <span className="vbg-visually-hidden"> {value}</span>
    </button>
  );
}

function Record({ record }: { record: DnsRecord }) {
  return (
    <div className="vbg-table-wrap">
      <table>
        <caption className="vbg-visually-hidden">DNS record for {record.host}</caption>
        <thead>
          <tr>
            <th scope="col">Type</th>
            <th scope="col">Name</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{record.type}</td>
            <td>
              <span className="vbg-mono">{record.name}</span> <Copy value={record.name} />
            </td>
            <td>
              <span className="vbg-mono">{record.value || "not known yet"}</span>{" "}
              {record.value && <Copy value={record.value} />}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * The status of a shop's own domain, and the DNS record behind it: two pieces of the domain's
 * row (`.vbg-custom-domain`), the second laid under it. Asked for after the page
 * has loaded (the check takes seconds), and again on "Check again".
 *
 * The record is tucked away once it is right: nobody needs it then. Until it is, it is open,
 * with one sentence saying what to do about the state it is in.
 */
export function DomainStatus({ shopId }: { shopId: string }) {
  const [setup, setSetup] = useState<DomainSetup | null>(null);
  const [failed, setFailed] = useState(false);
  const [checking, startChecking] = useTransition();

  const check = useCallback(() => {
    startChecking(async () => {
      try {
        setSetup(await domainStatusAction(shopId));
        setFailed(false);
      } catch {
        setFailed(true);
      }
    });
  }, [shopId]);

  useEffect(check, [check]);

  if (!setup) {
    return (
      <span className="vbg-custom-domain-state" role="status">
        <span className="vbg-custom-status" data-state="none">
          {failed ? "Could not be checked" : "Checking…"}
        </span>
        {failed && (
          <button type="button" className="vbg-custom-link-action" onClick={check} disabled={checking}>
            Check again
          </button>
        )}
      </span>
    );
  }

  const state = overall(setup);
  const right = setup.record.state === "valid";
  const help = setup.status === "starting" && right
    ? "The record is right. The website takes a minute or two to start answering on a new domain."
    : HELP[setup.record.state];

  return (
    <>
      <span className="vbg-custom-domain-state" role="status">
        <span className="vbg-custom-status" data-state={state.mark}>
          {checking ? "Checking…" : state.text}
        </span>
        <button type="button" className="vbg-custom-link-action" onClick={check} disabled={checking}>
          Check again
        </button>
      </span>
      <details className="vbg-custom-domain-record" open={!right}>
        <summary>DNS record</summary>
        {help && <p className="vbg-helper">{help}</p>}
        <Record record={setup.record} />
        {setup.optional && setup.optional.state !== "valid" && (
          <>
            <p className="vbg-helper">
              Optional: this second record makes {setup.optional.host} lead to {setup.record.host} too.
            </p>
            <Record record={setup.optional} />
          </>
        )}
      </details>
    </>
  );
}
