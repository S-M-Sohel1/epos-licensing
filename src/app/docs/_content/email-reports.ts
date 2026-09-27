import { type Guide } from "./types";

/**
 * Sourced from ScheduledReportEmailService/EmailReportScheduler/
 * SettingsViewModel: recipients are one shared list for every report type
 * (not per-report), periodic sends only run while the app itself is open (an
 * in-process timer, not a Windows service), a failed periodic send is silent
 * and simply retried next minute, "Send if empty" off means a quiet period
 * sends nothing at all rather than an empty report, the attachment formats
 * are PDF and Excel (there is no CSV option), and Email -> General also has
 * a Bcc field plus default Subject/Message text used as a fallback for
 * customer-facing emails, separate from Reporting's own Subject/Message pair
 * used for the scheduled report emails specifically.
 */
export const emailReports: Guide = {
  slug: "email-reports",
  title: "Email and scheduled reports",
  lede: "Have reports and your end of day emailed to you automatically, instead of only ever printed.",
  summary: "Setting up outgoing email, and choosing which reports get sent and how often.",
  sections: [
    {
      heading: "Setting up outgoing email",
      blocks: [
        {
          kind: "p",
          text: "Settings -> Email -> General asks for a mail server: host, port, whether it uses SSL, and a username and password to send through. It works with any ordinary SMTP provider, not just one. Some, Gmail included, need an app password rather than your normal one before they accept a login like this.",
        },
        {
          kind: "p",
          text: "The same screen has a Bcc field for anyone who should quietly get a copy of every email the till sends. It also has default Subject and Message text, used to fill customer-facing emails like a receipt when nothing more specific is set for them.",
        },
        {
          kind: "p",
          text: "Click Send test email to save what you have entered and send a message to that same address, so you can check it works before relying on it.",
        },
      ],
    },
    {
      heading: "Choosing what gets sent",
      blocks: [
        {
          kind: "p",
          text: "Settings -> Email -> Reporting has a Report selection list covering most reports on the till: daily sales, best sellers, stock movement and more. Tick whichever ones you want emailed. Its own Subject and Message fields are just for these scheduled report emails, separate from the general ones on the previous screen.",
        },
        {
          kind: "p",
          text: "Those two boxes come filled in with wording that already uses placeholders, so you can see the syntax rather than guess at it. Edit around them: %shop%, %address%, %phone%, %taxnumber%, %user%, %date%, %time%, %datetime%, %reportnumber% and %attachments% are each replaced when the email goes out. Anything else you type between percent signs is left exactly as typed, so a stray one is harmless. Clear a box entirely and the till falls back to its own wording.",
        },
        {
          kind: "p",
          text: "The Z report (end of day) and X report have their own toggles alongside it. Turn on the Z report and every register close emails it to you, on top of anything you print by hand.",
        },
        {
          kind: "p",
          text: "Reports go out as PDF, Excel, or both, whichever you tick. There is no plain summary in the email body; reports are always attachments.",
        },
      ],
    },
    {
      heading: "Sending on a schedule",
      blocks: [
        {
          kind: "p",
          text: "Turn on Send email periodically and set an interval in minutes to send reports through the day, not just when the register closes, restricted to whatever business hours you set.",
        },
        {
          kind: "p",
          text: "A period with nothing new to report sends nothing at all, unless you turn on Send if empty. A quiet morning with no email is normal there, not a sign something is broken.",
        },
      ],
    },
    {
      heading: "Who receives them",
      blocks: [
        {
          kind: "p",
          text: "One list of recipients covers everything you have selected. You cannot send different reports to different people; whoever is on the list gets whatever is ticked.",
        },
      ],
    },
    {
      heading: "Worth knowing",
      blocks: [
        {
          kind: "ul",
          items: [
            "Scheduled sending only runs while the till's app is open. Close it and nothing goes out until it runs again.",
            "The till needs to be online when a report is due. If it is not, that send is simply missed, with no catching up later.",
            "A failed send in the background shows nowhere. It quietly tries again next time. Send test email is the only place a failure shows directly.",
          ],
        },
      ],
    },
  ],
};
