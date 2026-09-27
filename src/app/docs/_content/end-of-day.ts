import { type Guide } from "./types";

/**
 * Sourced from EndOfDayViewModel/EndOfDayService: closing sweeps every open
 * Payments/CashEntries row for the terminal by stamping a ZReportId, expected
 * cash is computed (not typed), a short count asks for confirmation but does
 * not block, "Print selected report" in History is a real reprint (despite an
 * older note in this project's CLAUDE.md), the open-orders check runs for all
 * three tiles (not only Close register), the shared-drawer notice is an
 * informational banner rather than a gate on Continue, and X REPORT is a
 * separate always-visible tile that prints a live snapshot at any time without
 * closing anything.
 *
 * Closing PRINTS THE Z-REPORT ITSELF (EndOfDayViewModel.ContinueAsync), through
 * the customer-receipt printer — there is no separate report-printer setting.
 * The print is best-effort and never fatal: the register is already closed and
 * the row committed by then, so an unassigned or broken printer appends a line
 * to the confirmation telling the operator to reprint from History rather than
 * making the close look like it failed. This guide said the opposite until
 * v3.6.0's automatic print landed.
 */
export const endOfDay: Guide = {
  slug: "end-of-day",
  title: "End of day",
  lede: "Close the register at the end of a shift and get a Z-report of the day's cash.",
  summary: "How to close the register, count the drawer, and find past reports.",
  sections: [
    {
      heading: "What it does",
      blocks: [
        {
          kind: "p",
          text: "Closing the register locks in every sale, cash movement and payment since the last close. You get a numbered Z-report of the totals. Once closed, that period cannot be reopened or edited.",
        },
      ],
    },
    {
      heading: "Opening it",
      blocks: [
        {
          kind: "p",
          text: "Open the hamburger menu and choose End of day. If you are not already signed in as a manager, enter a PIN with access to it.",
        },
      ],
    },
    {
      heading: "A quick totals check, without closing anything",
      blocks: [
        {
          kind: "p",
          text: "Press X REPORT to print today's totals so far. It does not close the register. Use it any time you just want to see where things stand.",
        },
      ],
    },
    {
      heading: "Counting the cash",
      blocks: [
        {
          kind: "p",
          text: "Choose Cash out (yourself), Cash out all users, or Close register. The till works out how much cash it expects in the drawer, from sales, cash paid in and cash paid out. Type what you actually counted, and it shows the difference.",
        },
        {
          kind: "p",
          text: "Close register also shows a breakdown of open transactions and each user's own totals, so you can see where the day's figure comes from before going ahead.",
        },
        {
          kind: "ul",
          items: [
            "A shortfall asks you to confirm. It does not block you.",
            "Extra cash does not ask anything.",
            "Leave the count blank and it still closes, just with no comparison shown.",
            "Cash out only records the count. It does not close the register, so use it as often as you like through the day.",
          ],
        },
      ],
    },
    {
      heading: "Before you can continue",
      blocks: [
        {
          kind: "p",
          text: "Finish or cancel any open order first. A parked, unpaid order blocks all three options: Cash out, Cash out all users, and Close register.",
        },
        {
          kind: "p",
          text: "If you are closing only your own cash and a colleague still has sales in the same drawer, a notice tells you so. It just lets you know; you do not need to clear it before continuing.",
        },
      ],
    },
    {
      heading: "After closing",
      blocks: [
        {
          kind: "p",
          text: "The Z-report prints itself, on the same printer your receipts come out of. You also get a confirmation on screen with the report number. There is no print button on it because the paper is already coming.",
        },
        {
          kind: "p",
          text: "If the printer is off, out of paper or not set up, the confirmation says so and tells you to print it later. The register is still closed either way. Nothing is lost, and the count is not affected.",
        },
        {
          kind: "p",
          text: "To print one again, open the History tab on the same screen, find it in the list, and choose Print selected report. That works for any past report, any time, not just the one you have closed.",
        },
        {
          kind: "p",
          text: "Turn on the Z report (end of day) toggle in Settings -> Email -> Reporting to have it emailed too. Every close then emails you a copy as well as printing the slip, which is worth having if the till's printer is the only other record.",
        },
      ],
    },
    {
      heading: "Worth knowing",
      startsNewPage: true,
      blocks: [
        {
          kind: "ul",
          items: [
            "Closing cannot be undone. There is no reopen.",
            "Only sales rung on this till get swept in. A shop running more than one till closes each one separately.",
            "Credit and on-account payments get swept in too, whether or not the customer has actually paid you back yet.",
          ],
        },
      ],
    },
  ],
};
