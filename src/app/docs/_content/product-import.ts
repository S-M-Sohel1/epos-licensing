import { type Guide } from "./types";

/**
 * Sourced from ProductCsvService/ManagementViewModel: matching for an update
 * is by Code first, then by Name plus group, so a re-run of the same file is
 * safe rather than creating duplicates. The user-facing preview step exists
 * in code but is switched off (search ManagementViewModel.cs for "parked until
 * it has been tried on a real catalogue"), so there is no preview to confirm —
 * BUT ImportAsync now runs the same dry-run pass itself before writing, and
 * refuses the whole file, writing nothing, if a barcode would sink it part-way
 * (scientific notation from a spreadsheet, a barcode another product owns, or
 * two rows claiming one). It used to write row by row and stop at the first
 * failure, leaving every row above it applied while reporting only "Import
 * failed" — which is how a shop ended up with junk barcodes after an Excel edit.
 * The product file's Group column DOES build nested groups from a slash path;
 * an earlier version of this guide said it could not. The separate "Import
 * groups" button imports a group tree on its own, with no products.
 * (Aronium migration is intentionally not covered here — it has no menu or
 * button anywhere in Pos.App and is only ever run from the dev harness, so
 * it isn't a self-service task this guide can walk through.)
 */
export const productImport: Guide = {
  slug: "product-import",
  title: "Importing products",
  lede: "Bring a product list in from a spreadsheet instead of typing every item by hand.",
  summary: "Building a CSV file, importing it, and what happens with items you already have.",
  sections: [
    {
      heading: "Getting a starting file",
      blocks: [
        {
          kind: "p",
          text: "Export first, it is the easiest way to get a file in the right shape. Go to Management -> Products -> Export for a spreadsheet of what is already on the till, in the layout Import expects. Add your new products to it, or clear the rows out and start from a copy.",
        },
      ],
    },
    {
      heading: "What the file needs",
      blocks: [
        {
          kind: "p",
          text: "Name and Price are the only required columns. Everything else, code, barcode, group, cost, tax, stock quantity and a few more, is optional, filled in only where you have it. Columns can be in any order; the till matches them by header name.",
        },
        {
          kind: "p",
          text: "Write a group as a path, such as Drinks/Cola for a subgroup. If a group's own name has a slash in it, write it as \\/ so it does not read as a path separator.",
        },
        {
          kind: "p",
          text: "Price is the shelf price, tax included, unless you say otherwise. Put a 0 in the IsTaxInclusivePrice column and the till reads that row's price as the figure before tax and adds the tax on for you. Get this the wrong way round and every price in the file lands wrong by the tax rate, which is the one mistake here worth checking a couple of rows for after importing.",
        },
      ],
    },
    {
      heading: "Importing it",
      blocks: [
        {
          kind: "p",
          text: "Go to Management -> Products -> Import and pick the file. The till reads the whole file first, before changing anything. If it finds a problem that would stop the import part-way, it changes nothing at all and lists exactly which rows to fix, so you never end up with half a file applied.",
        },
        {
          kind: "p",
          text: "If the file is fine, it imports and you get a report: rows it could not use, notes such as a tax rate that got created or defaulted, any new groups, and which stock quantities changed.",
        },
      ],
    },
    {
      heading: "Editing the file in a spreadsheet",
      blocks: [
        {
          kind: "p",
          text: "Be careful opening the file straight into Excel. It treats a long barcode as a number and shortens it: 2607071908099 turns into 2.60707E+12, and when you save, the real digits are gone. Two different barcodes can end up looking identical. Excel also drops leading zeros, so a code like 00123 becomes 123.",
        },
        {
          kind: "p",
          text: "To avoid it, open Excel first and use Data -> From Text/CSV instead of double-clicking the file. Before loading, set the Barcode and SKU columns to Text. LibreOffice asks the same question when it opens a CSV, and a plain text editor never changes anything.",
        },
        {
          kind: "p",
          text: "If a barcode has already been damaged this way, the till refuses the import and tells you which rows. Export a fresh copy and make your changes again with the columns set to Text.",
        },
      ],
    },
    {
      heading: "Building a nested group tree",
      blocks: [
        {
          kind: "p",
          text: "The Group column builds nested groups for you. Write Drinks/Cola and you get a Drinks group with Cola inside it, created if they are not there already. If you want the group tree set up on its own, with no products in it yet, use the separate Import groups button next to Import and Export. It reads a file of group names with their parents.",
        },
      ],
    },
    {
      heading: "What happens to items you already have",
      blocks: [
        {
          kind: "p",
          text: "The till matches a row to an existing product by its code first, then by its name and group together. A match updates that product instead of creating a second one, so running the same file again is safe and will not duplicate anything.",
        },
        {
          kind: "p",
          text: "Leave the tax column blank and the product gets your default tax rate from Settings, falling back to a zero rate if there is not one.",
        },
        {
          kind: "p",
          text: "Each barcode can belong to only one product. A barcode already on a different product, or the same barcode on two rows in the file, stops the import before anything changes, with the rows named so you can fix them. A barcode added to a product that already has it is simply left as it is.",
        },
      ],
    },
    {
      heading: "Worth knowing",
      blocks: [
        {
          kind: "ul",
          items: [
            "There is no undo once an import has gone through. A file the till refuses changes nothing, but a file it accepts updates real products, so check the prices and tax rates in it before importing.",
            "You do not need an empty product list first. Import adds and updates alongside whatever is already there.",
          ],
        },
      ],
    },
  ],
};
