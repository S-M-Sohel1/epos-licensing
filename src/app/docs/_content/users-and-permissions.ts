import { type Guide } from "./types";

/**
 * Sourced from UserEditViewModel/SecurityKey/User/ManagementViewModel: access
 * level is a number (Staff 10, Manager 50, Administrator 100) with the Staff/
 * Manager/Administrator buttons just presets onto it, a user can never grant
 * a level above their own, PINs are globally unique since sign-in is PIN-only
 * with no username, and sandbox mode is a SecurityKey row seeded at Manager
 * (migration 0077 — it was hardcoded when this guide was first written, which
 * is why an earlier draft said so). The level each action needs is itself
 * editable on the Security sub-tab (steppers per action, not fixed). Seeded
 * levels, checked against the migrations rather than assumed: Management.Access
 * 50, Settings.Access 90, License.Release 50, Sandbox.Mode 50, Database.Reset
 * 90. Administering a peer at
 * the SAME level (edit, delete, reset PIN) is blocked unless the acting user
 * holds the shop's single top rank (ManagementViewModel.CanAdministerAsync).
 * Deactivating a user has no open-orders guard; that guard exists only on
 * hard delete, which the earlier draft had backwards. Staff hours is a third,
 * separate Manager-gated tab (clock-in/out sessions with correction), and the
 * user editor also has an hourly pay rate with an effective-from date and a
 * history of past rates, neither mentioned before.
 */
export const usersAndPermissions: Guide = {
  slug: "users-and-permissions",
  title: "Users and permissions",
  lede: "Give each member of staff their own PIN, and decide what it lets them do.",
  summary: "Setting up staff logins, PIN resets, pay rates, and what each access level unlocks.",
  sections: [
    {
      heading: "Change the default PIN first",
      blocks: [
        {
          kind: "p",
          text: "A new till starts with one Admin user and PIN `1234`. Change it before the till goes live. Go to Management -> Users & security -> Users, edit Admin, and set a new PIN.",
        },
      ],
    },
    {
      heading: "Adding a staff member",
      blocks: [
        {
          kind: "p",
          text: "Go to Management -> Users & security -> Users and add a user. Give them a name and a PIN, then pick Staff, Manager or Administrator. That fills in an access level for you. You will not see the number day to day, but everything else in this section checks against it.",
        },
        {
          kind: "p",
          text: "Signing in is PIN only, with no separate username. So every PIN on the till has to be different from every other one. The till rejects a PIN already in use.",
        },
        {
          kind: "p",
          text: "The same screen sets an hourly pay rate, with a date it takes effect from and an optional note. Change it later and the old rate stays in a short history underneath, rather than getting overwritten.",
        },
      ],
    },
    {
      heading: "What each level unlocks",
      blocks: [
        {
          kind: "p",
          text: "Higher numbers can do more, and include everything a lower level can. A Manager can do anything a Staff member can. An Administrator can do anything a Manager can.",
        },
        {
          kind: "table",
          caption: "Examples of what each level gates, out of the box",
          head: ["Action", "Needs at least"],
          rows: [
            ["Voiding an order", "Manager"],
            ["Opening Management", "Manager"],
            ["Opening Settings", "Administrator"],
            ["Turning on sandbox (training) mode", "Manager"],
            ["Releasing this till's licence", "Manager"],
            ["Resetting the database", "Administrator"],
          ],
        },
        {
          kind: "p",
          text: "These are starting points, not fixed rules. Go to Management -> Users & security -> Security to raise or lower the level each action needs, one by one, if the defaults do not suit your shop.",
        },
        {
          kind: "p",
          text: "You cannot hand out more than you hold yourself. A Manager setting up a new user cannot make them an Administrator; only an Administrator can create another Administrator.",
        },
        {
          kind: "p",
          text: "Two people at the same level cannot edit each other, delete each other, or reset each other's PIN. Only whoever holds the single highest level in the shop can administer a peer at that same level.",
        },
      ],
    },
    {
      heading: "Resetting a forgotten PIN",
      blocks: [
        {
          kind: "p",
          text: "Go to Management -> Staff passwords for the quick path: pick the user and set a new PIN, no old one needed. It only changes PINs, so use Users & security instead if you also need to change someone's access level.",
        },
        {
          kind: "p",
          text: "There is no remote or self-service reset. If every Manager and Administrator PIN on a till is lost at once, contact support and quote the till's reference shown on the sign-in screen.",
        },
      ],
    },
    {
      heading: "Staff hours",
      blocks: [
        {
          kind: "p",
          text: "Go to Management -> Staff hours, next to Users & security, to see every clock-in and clock-out on the till. A manager can correct one that was missed or wrong here. It needs the same Manager level or above as the rest of this section.",
        },
      ],
    },
    {
      heading: "Worth knowing",
      blocks: [
        {
          kind: "ul",
          items: [
            "Deactivating a user works even with orders in their history; there is nothing to clear first. Deleting a user outright is the one blocked while they have orders on file. Deactivating is the usual way to retire an account instead.",
            "Sandbox mode is deliberately not something you can grant or take away here. It always needs Manager level or above, fixed in the till itself, unlike the other actions in the table above.",
          ],
        },
      ],
    },
  ],
};
