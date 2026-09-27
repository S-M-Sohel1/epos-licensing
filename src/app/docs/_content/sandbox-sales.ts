import { type Guide } from "./types";

/**
 * The sandbox sales guide. Single source for both the /docs page and the PDF.
 *
 * Two claims here have already been wrong once in the product's own dialogs, so
 * they are worth checking against the code before anyone edits them:
 *
 *  - Stock IS deducted by a practice sale. CheckoutService adjusts stock for
 *    every sale with no sandbox condition.
 *  - Promoting a sandbox sale to live does NOT move stock again, because
 *    checkout already did. It only reissues the document number.
 */
export const sandboxSales: Guide = {
  slug: "sandbox-sales",
  title: "Sandbox sales",
  lede: "A practice till for training staff. Sales rung on it never reach your books, though the stock still comes off the shelf.",
  summary:
    "The practice till for training staff, what it holds back, and what it does not.",
  sections: [
    {
      heading: "What it is",
      blocks: [
        {
          kind: "p",
          text: "Sandbox mode turns the till into a practice machine. A new starter can ring sales, take payment and print receipts exactly as they would for a real customer, and none of it touches your figures. No money is recorded, and nothing shows up in your reports or End of day. Stock is the one thing it does not hold back.",
        },
      ],
    },
    {
      heading: "Turning it on and off",
      blocks: [
        {
          kind: "p",
          text: "Open the menu from the button at the top right of the sales screen and choose Sandbox mode. `Ctrl` + `Shift` + `S` does the same thing if you would rather use the keyboard.",
        },
        {
          kind: "ul",
          items: [
            "Turning it on needs Manager level or above out of the box, and you will be asked for your PIN even though you are already signed in.",
            "That level is yours to set. Management -> Users & security -> Security has a line called Enable sandbox mode: lower it if you want a particular member of staff to run practice sessions themselves.",
            "Anyone below the level does not see the menu entry at all, and the shortcut does nothing for them. There is no way for a manager to approve it for them on the spot, unlike most other restricted actions.",
            "Turning it off is not restricted at all: no PIN, and any user can do it.",
            "A sale already on screen comes with you, whichever way you are going. The till asks first and says plainly what the sale becomes, so an order rung on the wrong till does not have to be typed again.",
          ],
        },
        {
          kind: "p",
          text: "While sandbox mode is on, a SANDBOX MODE badge sits at the top of the sales screen, next to the menu button. Tap the badge to go back to the live till. No badge means you are already on it.",
        },
        {
          kind: "p",
          text: "The way out is the badge rather than the menu because the menu is closed while sandbox mode is on. The badge is on screen for exactly as long as there is a practice till to leave, so it is always there when you need it.",
        },
        {
          kind: "p",
          text: "If your shop has no use for a practice till, turn the whole feature off under Settings -> Order & payment -> Enable sandbox (training) mode. The menu entry disappears and the shortcut stops working for everyone, including administrators. It is on when the till is installed.",
        },
      ],
    },
    {
      heading: "What changes",
      blocks: [
        {
          kind: "table",
          caption: "What behaves differently on the practice till, and why",
          head: ["On the practice till", "Why"],
          rows: [
            [
              "Cash is the only payment method",
              "Card and account payments would pull in real terminals and real customer balances.",
            ],
            [
              "Stock is deducted, as normal",
              "Goods handed to a trainee have left the shelf. A count that ignored them would drift away from what is actually in the shop.",
            ],
            [
              "Receipt numbers start with `SBX-`",
              "Practice sales never use up one of your real receipt numbers, so there are no gaps in them.",
            ],
            [
              "The main menu is blocked",
              "Management, Settings and End of day cannot be reached from a practice till.",
            ],
            [
              "A Sandbox sales button appears in the top bar",
              "With the menu blocked, this is the only way to review practice sales.",
            ],
          ],
        },
      ],
    },
    {
      heading: "Where practice sales show up",
      blocks: [
        {
          kind: "table",
          caption: "Which screens and totals include practice sales",
          head: ["Location", "Practice sales included?"],
          rows: [
            ["Sales history", "No"],
            ["Reports", "No"],
            ["End of day / Z-report", "No"],
            ["Stock levels", "Yes, deducted like any sale"],
            ["Sandbox sales screen", "Yes, and only here"],
          ],
        },
      ],
    },
    {
      heading: "Stock still comes off the shelf",
      blocks: [
        {
          kind: "p",
          text: "Ring up six bottles and hand them over, and six bottles have left the shop. The count drops by six, and your low-stock warnings react exactly as they would to a real sale. If training did not take stock off, your counts would drift further from the shelf every time somebody practised.",
        },
        {
          kind: "p",
          text: "If nothing actually left the shop, say a trainee just tapping through the screens, put the count back in Management -> Stock afterwards.",
        },
        {
          kind: "p",
          text: "The till also assumes whatever expires soonest goes out first. When it works out what is left on the shelf it counts the batches dated furthest ahead as the ones remaining, so an expiry warning always points at the nearest date. What matters is the expiry date, not when the delivery arrived. A later delivery with a shorter shelf life is used up before an earlier one that keeps longer. Practice sales count towards this the same as real ones.",
        },
        {
          kind: "p",
          text: "The till is assuming, not checking. It has no way of knowing which pack a member of staff actually reached for, so the warnings are only as good as the rotation on the shelf.",
        },
      ],
    },
    {
      heading: "Reviewing and clearing practice sales",
      blocks: [
        {
          kind: "p",
          text: "Tap Sandbox sales in the top bar. Two buttons live there that you will not find anywhere else.",
        },
        {
          kind: "p",
          text: "Delete all sandbox sales clears the practice sales in the period currently on screen, not everything ever rung. Your real sales are never touched, and it cannot be undone.",
        },
        {
          kind: "p",
          text: "Add this sale to live DB moves one practice sale into your real books. You want this only when a genuine customer sale was rung by mistake while the till was in sandbox mode.",
        },
      ],
    },
    {
      heading: "What happens to the receipt number",
      blocks: [
        {
          kind: "p",
          text: "Adding a practice sale to live gives it a fresh number from your real receipt numbering, and the old one is written over. Nothing keeps a copy of it. Someone holding `SBX-26-200-000001` is holding a number that no longer exists on the till, and searching for it finds nothing. The sale might now be `26-200-000002`. The digits moved as well, so it is not the old number with the `SBX-` stripped off.",
        },
        {
          kind: "p",
          text: "Reprint the receipt and give the customer the new one. Stock does not change, because it came off when the sale was originally rung. None of this can be undone.",
        },
      ],
    },
    {
      heading: "Finding a sale after you have added it to live",
      blocks: [
        {
          kind: "p",
          text: "It disappears from the Sandbox sales screen as soon as you add it, because it is not a sandbox sale any more. Look for it in Management -> Documents, alongside your real sales.",
        },
        {
          kind: "p",
          text: "The number is the only thing that changed, so there is plenty left to go on. If the sale had a customer on it, the quickest way in is the Customer filter: pick the name and the list drops to that customer's sales. A walk-in sale has no customer attached, so that filter will not help there.",
        },
        {
          kind: "p",
          text: "Otherwise go by date. Set the Period to the day the sale was originally rung rather than the day you added it, since the sale keeps its own date and time. The time, the total and the ID column are all untouched as well.",
        },
        {
          kind: "p",
          text: "Watch the dates while you look. The new number is issued against today, but the sale is still dated when it happened. A sale rung on Monday and added to live on Friday gets a Friday-style number while sitting under Monday in the list. Search Monday.",
        },
      ],
    },
    {
      heading: "Everyday use",
      blocks: [
        {
          kind: "ul",
          items: [
            "Turn it on for training and off again as soon as you are done. A till left in sandbox mode takes no real money, and every sale rung on it is thrown away.",
            "Look for the SANDBOX MODE badge before serving a customer.",
            "Clear practice sales now and then so the Sandbox sales screen stays readable.",
            "The two tills share one product list, one price list and one set of staff, so changing a price changes it for both.",
          ],
        },
      ],
    },
  ],
};
